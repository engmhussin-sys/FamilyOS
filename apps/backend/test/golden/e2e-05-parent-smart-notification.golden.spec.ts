/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * ============================================================================
 * GOLDEN E2E-05 — THE PARENT'S NOTIFICATION. IS IT A MESSAGE, OR A TEMPLATE?
 * ============================================================================
 *
 * THE PRODUCT LOOP THIS PROTECTS. J8 of the fifteen critical journeys is «الوالد
 * يستقبل إشعارًا ذا معنى» — the parent receives a MEANINGFUL notification. That
 * word is the whole commercial argument of ABNY: the competitors (Qustodio,
 * Bark, Family Link) already send notifications, and they sell fear. ABNY's
 * claim is that its notification is worth reading — that it says «محمد أكمل هدفه
 * في سورة الملك، وهذه ثالث مرة هذا الأسبوع» rather than «you have a new alert».
 *
 * So this scenario asks exactly one question, in two places, and it is a
 * question that cannot be answered by reading code:
 *
 *   WHAT DOES A PARENT ACTUALLY RECEIVE WHEN THEIR CHILD EARNS A REWARD, and is
 *   the reasoning behind it recorded anywhere a human can read?
 *
 *   ACT I asks it of THE PRODUCT — the real HTTP loop, from goal to approval.
 *   ACT II asks it of THE ENGINE — `SmartNotificationEngineService.handleEvent`,
 *          the public entry point Phase F shipped, in the same booted app,
 *          against the same PostgreSQL.
 *
 * THE TWO ANSWERS DISAGREED, AND THAT DISAGREEMENT WAS THIS SUITE'S PRINCIPAL
 * FINDING — recorded as PF-E-001, measured here rather than argued. Every
 * expectation was pinned exactly, so that wiring the producer to the engine
 * would turn these assertions red and force a deliberate update.
 *
 * ---------------------------------------------------------------------------
 * `F6-003` — THE PRODUCER IS WIRED, AND THIS FILE IS THE UPDATE IT FORCED.
 *
 * ACT I is unchanged as a SCENARIO — the same six HTTP calls, the same outbox
 * drain, no test double anywhere — and its assertions are rewritten to the new
 * answer, each one carrying the line it replaced so the diff is the evidence:
 *
 *   BEFORE  body = «حصل طفلك على مكافأة جديدة اليوم…»   ·  decisions = 0 rows
 *   AFTER   body = «حصل محمد على مكافأة جديدة اليوم…»   ·  decisions = 1 row,
 *           trigger DOMAIN_EVENT, decision SEND, outcome SEND, score ≥ 25, and
 *           the eight components reconciling to the stored total.
 *
 * ACT I AND ACT II NOW AGREE, which is the whole point: the product path and
 * the engine's public entry point produce the same shape of row, because they
 * are the same code. Two households are still used so the two acts' scoring
 * histories stay separate.
 * ---------------------------------------------------------------------------
 *
 * WHAT «CONTEXTUAL, NOT A GENERIC TEMPLATE» IS ASSERTED TO MEAN, so it is not a
 * matter of taste:
 *   1. the persisted `trigger`, `score`, `reason` and `decision` RECONCILE —
 *      the eight scored components sum to the stored score, the penalties
 *      subtract, and the reason names the branch the verdict came from;
 *   2. the copy carries FACTS about this household — the child's name and the
 *      goal's title — and no raw `ALL_CAPS_SNAKE` enum and no unresolved
 *      `{placeholder}`;
 *   3. the copy for a FIRST completion and a THIRD-THIS-WEEK differ.
 *
 * Real PostgreSQL, real Redis, real booted app, real HTTP. Nothing stubbed.
 */
import {
  GOLDEN_NOON,
  P,
  ageTheHousehold,
  asChild,
  asParent,
  bootGoldenWorld,
  describeGolden,
  freezeGoldenClock,
  goldenAt,
  type GoldenHousehold,
  type GoldenWorld,
} from './golden-world';
import { SmartNotificationEngineService } from '../../src/modules/notification-engine/application/services/smart-notification-engine.service';
import type { NotificationEventInput } from '../../src/modules/notification-engine/application/services/notification-context.assembler';
import { runWithTenant } from '../../src/common/tenancy/tenant-context';
import { NOTIFICATION_PENALTY_COMPONENTS } from '../../src/modules/notifications/domain/engine/notification-decision.types';

import request = require('supertest');

const THE_QURAN_GOAL = {
  category: 'QURAN',
  activity: 'QURAN_MEMORIZE_AYAH_RANGE',
  targetSpec: { surahNumber: 67, fromAyah: 1, toAyah: 5 },
  durationMinutes: 20,
  verificationLevel: 'PARENT_CONFIRMATION',
  rewardSpec: { type: 'POINTS', amount: 20 },
};

describeGolden('GOLDEN E2E-05 — what the parent is actually told, and whether anyone recorded why', () => {
  let world: GoldenWorld;
  let home: GoldenHousehold;
  /**
   * A SECOND household, in the same database and the same booted app, used by
   * ACT II. Stated rather than hidden: the engine SCORES against the household's
   * own notification history, so running it inside the household ACT I has just
   * notified would entangle the arithmetic under test with ACT I's row (a
   * FATIGUE term and a DUPLICATE term that belong to the product path, not to
   * the engine). Two households isolate the measurement. Nothing else differs —
   * same app, same PostgreSQL, same registration path over real HTTP.
   */
  let lab: GoldenHousehold;
  let engine: SmartNotificationEngineService;

  beforeAll(async () => {
    freezeGoldenClock(GOLDEN_NOON);
    world = await bootGoldenWorld('golden E2E-05 (parent notification)');
    home = await world.register('e2e05', { childName: 'محمد' });
    lab = await world.register('e2e05b', { childName: 'سلمى' });
    await ageTheHousehold(world, home, goldenAt('08:00'));
    await ageTheHousehold(world, lab, goldenAt('08:00'));
    engine = world.app.get(SmartNotificationEngineService);
  }, 180_000);

  afterAll(async () => {
    jest.useRealTimers();
    if (world) await world.close();
  });

  const notificationRows = (familyId: string = home.familyId): Promise<any[]> =>
    world.raw<any[]>(
      `SELECT * FROM "notifications" WHERE "family_id" = $1::uuid ORDER BY "created_at", "id"`,
      familyId,
    );

  const decisionRows = (familyId: string = home.familyId): Promise<any[]> =>
    world.raw<any[]>(
      `SELECT * FROM "notification_decisions" WHERE "family_id" = $1::uuid ORDER BY "created_at", "id"`,
      familyId,
    );

  /** The eight scored components must sum to the stored score, the three
   * penalties must subtract, and every line must carry the fact that produced
   * it. Asserted on EVERY decision row this scenario writes, not on one. */
  function componentsOf(row: any): any[] {
    // `explanation` is a jsonb column and the driver may hand it back either
    // parsed or as text; both are read here so the assertion is about the
    // stored arithmetic and not about the driver.
    const parsed = typeof row.explanation === 'string' ? JSON.parse(row.explanation) : row.explanation;
    return Array.isArray(parsed) ? parsed : (parsed?.components ?? []);
  }

  function assertTheArithmeticReconciles(row: any): void {
    const components = componentsOf(row);
    expect(components).toHaveLength(8);
    const summed = components.reduce((total, c) => total + Number(c.contribution), 0);
    expect(Math.round(Math.max(0, Math.min(100, summed)))).toBe(Number(row.score));
    for (const component of components) {
      if (NOTIFICATION_PENALTY_COMPONENTS.has(component.name)) {
        expect(Number(component.contribution)).toBeLessThanOrEqual(0);
      } else {
        expect(Number(component.contribution)).toBeGreaterThanOrEqual(0);
      }
      expect(component.note).toBeTruthy();
    }
  }

  /** The engine's REAL public entry point, at an explicit instant, inside the
   * tenant context every producer already runs in. */
  const fire = (input: NotificationEventInput) =>
    runWithTenant({ familyId: input.familyId, actorType: 'SYSTEM', actorId: 'golden-e2e-05' }, () =>
      engine.handleEvent(input),
    );

  // =========================================================================
  // ACT I — WHAT THE PRODUCT SENDS TODAY
  // =========================================================================

  describe('ACT I — the real HTTP loop: a child earns a reward and the parent is notified', () => {
    it('the loop runs end to end and the parent receives exactly one notification', async () => {
      const program = await request(world.http)
        .post(`${P}/reward-programs`)
        .set(asParent(home))
        .send({ childId: home.childId, ...THE_QURAN_GOAL });
      expect([200, 201]).toContain(program.status);

      const started = await request(world.http)
        .post(`${P}/self/achievements/start`)
        .set(asChild(home))
        .send({ programId: program.body.id });
      await request(world.http)
        .post(`${P}/self/achievements/${started.body.id}/submit`)
        .set(asChild(home))
        .send({ foregroundMinutes: 21 });
      const approved = await request(world.http)
        .post(`${P}/reward-programs/achievements/${started.body.id}/approve`)
        .set(asParent(home))
        .send({});
      expect([200, 201]).toContain(approved.status);

      await world.drainOutbox();

      const rows = await notificationRows();
      expect(rows).toHaveLength(1);
      expect(rows[0].type).toBe('REWARD_GRANTED');
    });

    /**
     * PF-E-001, HALF ONE — THE COPY. **CLOSED BY `F6-003`, AND THIS IS THE
     * PROOF, FROM THE PRODUCTION PATH.**
     *
     * WHAT THIS TEST SAID BEFORE, VERBATIM:
     *
     *     expect(row.body).toBe('حصل طفلك على مكافأة جديدة اليوم. …');
     *     expect(row.body).not.toContain(home.childName);
     *
     * `NotificationRewardConsumer` composed the parent's sentence itself,
     * inline, as two constant strings. It could not say the child's name and it
     * could not say the goal, because it had neither: it held a
     * `REWARD_GRANTED` envelope and called `notifyEvent` with literals. The
     * assertion was pinned to the byte on purpose, with a note saying that
     * wiring the engine SHOULD turn it red and force a deliberate update. It
     * did, and this is that update.
     *
     * NOTHING ABOVE THIS TEST CHANGED. The loop is the same HTTP loop — goal,
     * start, submit, approve, drain — and no test double is involved. What
     * changed is one call inside the consumer, from `notifyEvent` to
     * `handleEvent`, and the sentence is now rendered from `COPY_CATALOGUE`
     * with `{childName}` resolved by the context assembler.
     *
     * ------------------------------------------------------------------------
     * SPRINT F1 — THE SAME PIN, TURNED RED A SECOND TIME AND UPDATED AGAIN.
     *
     * WHAT THIS TEST SAID BEFORE THIS UPDATE, VERBATIM:
     *
     *     expect(row.body).toBe('حصل محمد على مكافأة جديدة اليوم. افتح التطبيق لرؤية التفاصيل.');
     *
     * That sentence NAMED THE CHILD and still did not name the WORK: this
     * household's chain begins at «حفظ سورة الملك، الآيات ١–٥» and the parent was
     * told only that something had been earned. `e2e-13 STEP 14` measured the
     * same gap on its own household and pinned it from the other side —
     * `notifications.data` was NULL, so the goal was unreachable by any field at
     * all. `NotificationRewardConsumer` now carries the goal and the points, the
     * decision provider selects `COPY_CATALOGUE.REWARD_GRANTED_WITH_GOAL`, and
     * this pin moves with it.
     *
     * THE NOTIFICATION TYPE DID NOT MOVE. The row above is still asserted to be
     * a `REWARD_GRANTED` — only the COPY KEY differs, which is what keeps the
     * scorer, the quiet-hours matrix and the analytics reading the same
     * vocabulary they always have.
     */
    it('the sentence the parent receives NAMES THE CHILD AND THE ACHIEVEMENT, and comes from the catalogue', async () => {
      const [row] = await notificationRows();

      expect(row.title).toBe('مكافأة جديدة');
      // «🌟 محمد أكمل الآيات ١–٥ من سورة الملك اليوم…» rather than «حصل محمد
      // على مكافأة جديدة». Pinned to the byte again, in the new state, so the
      // NEXT change to the product's copy is also deliberate.
      //
      // `F1-003` — WHAT THIS PIN ASSERTED BEFORE, VERBATIM:
      //
      //   `🌟 ${home.childName} أكمل الآيات 1–5 من سورة الملك اليوم وحصل على ٢٠ نقطة. افتح التطبيق لتشجيعه.`
      //
      // ONE SENTENCE IN TWO NUMERAL SYSTEMS: «الآيات 1–5» came from
      // `describeTargetSpec` in Latin digits and «٢٠ نقطة» from `formatNumber`
      // in Arabic-Indic. `substitute` now localises STRING variables on the
      // parent surface too, exactly as it already did on the child's, so the
      // sentence is in one script. `PF-E-002` is about the reader of Arabic,
      // not about the reader's age.
      expect(row.body).toBe(
        `🌟 ${home.childName} أكمل الآيات ١–٥ من سورة الملك اليوم وحصل على ٢٠ نقطة. افتح التطبيق لتشجيعه.`,
      );
      expect(row.body).toContain(home.childName);
      // THE ACHIEVEMENT, by the name `RewardProgram.targetSummaryAr` gave it —
      // derived once by `describeTargetSpec`, never re-assembled from
      // `THE_QURAN_GOAL.targetSpec` in a notification layer.
      expect(row.body).toContain('سورة الملك');
      // AND THE POINTS, which the parent can now read without opening the app.
      expect(row.body).toContain('٢٠ نقطة');

      // Still Arabic, still no raw enum, still no unresolved placeholder — the
      // three properties that were true of the literal and must stay true of
      // the rendered sentence.
      expect(row.body).toMatch(/[؀-ۿ]/);
      expect(row.body).not.toMatch(/[A-Z]{3,}_[A-Z_]+/);
      expect(row.body).not.toMatch(/[{}]/);
    });

    /**
     * PF-E-001, HALF TWO — THE EXPLANATION. **CLOSED BY `F6-003`.**
     *
     * WHAT THIS TEST SAID BEFORE: `expect(await decisionRows()).toHaveLength(0)`
     * and an empty `GET /notifications/decisions`. Phase F built
     * `notification_decisions` so that «why did / did not this notification
     * arrive» is answerable and so that the suppression rate is computable at
     * all — `notifications` only holds what WAS sent — and every real
     * notification the product sent bypassed that ledger, so both numbers
     * described an empty set in production.
     *
     * The row below is written by the PRODUCTION PATH: no engine call appears
     * anywhere in ACT I. The only thing this scenario did was approve an
     * achievement over HTTP and drain the outbox.
     */
    it('the product wrote a notification AND recorded the decision behind it — the ledger is populated from production', async () => {
      // The PARENT's row. The same cause also writes the CHILD's — `F6-006`,
      // asserted by the next test — and this one is about what the PARENT was
      // told and why.
      const rows = (await decisionRows()).filter((r) => r.target_audience === 'PARENT');
      expect(rows).toHaveLength(1);

      const [row] = rows;
      expect(row.event_type).toBe('REWARD_GRANTED');
      expect(row.target_audience).toBe('PARENT');
      // The four columns the brief names, from a path no test called directly.
      expect(row.trigger).toBe('DOMAIN_EVENT');
      expect(row.decision).toBe('SEND');
      expect(['SCORE_ABOVE_SEND_THRESHOLD', 'SCORE_IN_DEFER_BAND']).toContain(row.reason);
      expect(Number(row.score)).toBeGreaterThanOrEqual(25);
      expect(row.priority_band).toBeTruthy();
      // And the ENGINE's verdict and the PIPELINE's outcome agree, which is
      // what «the notification actually arrived» looks like in this table.
      expect(row.outcome).toBe('SEND');
      assertTheArithmeticReconciles(row);

      // And the parent-facing read of that ledger now returns it.
      const decisions = await request(world.http)
        .get(`${P}/notifications/decisions`)
        .set(asParent(home));
      expect(decisions.status).toBe(200);
      expect(decisions.body.length).toBeGreaterThanOrEqual(1);
      expect(decisions.body.every((d: any) => d.decision === 'SEND')).toBe(true);
    });

    /**
     * PF-E-006 — THE CHILD'S HALF, MEASURED ON THE SAME PRODUCTION LOOP.
     *
     * ACT I is a PARENT scenario and this assertion is deliberately narrow: the
     * child's own sentence, tone band and safety ceiling are `e2e-06`'s
     * subject. What belongs here is the fact that ONE cause now produces TWO
     * decisions and that they do not collide — the audience facet in
     * `(family_id, source_event_id, target_audience)` doing its job on a real
     * outbox event rather than on an engine call written by a test.
     */
    it('one cause, two audiences: the child is decided for too, on the same source event', async () => {
      const rows = await decisionRows();
      expect(rows.map((r) => r.target_audience).sort()).toEqual(['CHILD', 'PARENT']);
      // ONE cause. The keys are identical and the AUDIENCE is what separates
      // the two rows — not two source events invented per audience.
      expect(new Set(rows.map((r) => r.source_event_id)).size).toBe(1);
      // Two types, two copy keys, two independent scores: the parent's load
      // cannot suppress the child's news about their own work.
      expect(rows.map((r) => r.event_type).sort()).toEqual(['REWARD_GRANTED', 'REWARD_GRANTED_CHILD']);
      for (const row of rows) {
        expect(row.decision).toBe('SEND');
        expect(row.outcome).toBe('SEND');
        assertTheArithmeticReconciles(row);
      }
    });
  });

  // =========================================================================
  // ACT II — WHAT THE ENGINE PRODUCES, THROUGH ITS REAL PUBLIC ENTRY POINT
  // =========================================================================

  describe('ACT II — the same app and the same database, through SmartNotificationEngineService', () => {
    /** Captured in one test and compared in the next: two `it`s, one story. */
    let firstBody = '';

    it('a REWARD_GRANTED through the ENGINE says the child\'s name — the same event, a different sentence', async () => {
      const result = await fire({
        familyId: lab.familyId,
        childId: lab.childId,
        eventType: 'REWARD_GRANTED',
        sourceEventId: 'golden:e2e05:reward',
        trigger: 'DOMAIN_EVENT',
        reward: { kind: 'POINTS', amount: 20, isMilestone: false },
        now: goldenAt('12:05'),
      });

      expect(result.decision.verdict).toBe('SEND');
      expect(result.decision.targetAudience).toBe('PARENT');

      // THE CONTRAST WITH ACT I, in one line. Same event type, same product,
      // and the household is addressed by name instead of as «طفلك».
      expect(result.body).toContain(lab.childName);
      expect(result.body).not.toMatch(/[A-Z]{3,}_[A-Z_]+/); // no raw enum
      expect(result.body).not.toMatch(/[{}]/); // no unresolved placeholder

      // ARABIC — the product's first language, for a household registered
      // exactly as the mobile app registers one, with no `locale` sent.
      // (PF-E-002: this line was ENGLISH until migration 0019.)
      const [row] = await decisionRows(lab.familyId);
      expect(row.locale).toBe('ar');
      expect(result.body).toMatch(/[\u0600-\u06FF]/);

      // THE FOUR COLUMNS THE BRIEF NAMES, and they reconcile.
      expect(row.trigger).toBe('DOMAIN_EVENT');
      expect(row.decision).toBe('SEND');
      // The two reasons a SEND may carry, both naming the branch the verdict
      // came from. Which one it is depends on the household's own load, so the
      // scenario pins the SET rather than inventing a quiet household.
      expect(['SCORE_ABOVE_SEND_THRESHOLD', 'SCORE_IN_DEFER_BAND']).toContain(row.reason);
      expect(Number(row.score)).toBeGreaterThanOrEqual(25);
      expect(row.priority_band).toBeTruthy();
      assertTheArithmeticReconciles(row);

      // AND THE PIPELINE'S OWN VERDICT IS RECORDED BESIDE THE ENGINE'S. Two
      // columns on purpose: «engine said SEND, pipeline said SUPPRESS/DAILY_MAX»
      // is a complete explanation for a notification that never arrived.
      expect(row.outcome).toBe('SEND');

      // It really was delivered — the sentence is a row a client can fetch.
      const notifications = await notificationRows(lab.familyId);
      expect(notifications).toHaveLength(1);
      expect(notifications[0].body).toContain(lab.childName);
    });

    it('a FIRST goal completion and a THIRD-THIS-WEEK produce DIFFERENT Arabic sentences', async () => {
      const first = await fire({
        familyId: lab.familyId,
        childId: lab.childId,
        eventType: 'GOAL_COMPLETED_PARENT',
        sourceEventId: 'golden:e2e05:first',
        trigger: 'DOMAIN_EVENT',
        variables: { goalTitle: 'سورة الملك', weekCount: 1 },
        now: goldenAt('12:20'),
      });
      firstBody = first.body;

      const third = await fire({
        familyId: lab.familyId,
        childId: lab.childId,
        eventType: 'GOAL_COMPLETED_PARENT',
        sourceEventId: 'golden:e2e05:third',
        trigger: 'DOMAIN_EVENT',
        variables: { goalTitle: 'سورة الملك', weekCount: 3 },
        now: goldenAt('12:35'),
      });

      // THE ASSERTION THE BRIEF ASKS FOR: not the same sentence.
      expect(third.body).not.toBe(firstBody);

      // Both name the household and the goal. Neither is a template.
      for (const body of [firstBody, third.body]) {
        expect(body).toContain(lab.childName);
        expect(body).toContain('سورة الملك');
        expect(body).not.toMatch(/[{}]/);
      }

      // «ثالث», not «3rd» and not «3». Arabic ordinals below ten are irregular
      // and a template cannot inflect them, which is why the provider renders
      // the ordinal in the locale before the composer ever sees the variable.
      expect(third.body).toContain('ثالث');
      expect(third.body).toContain('هذا الأسبوع');
      expect(firstBody).not.toContain('ثالث');
    });

    /**
     * PF-E-003 — **CLOSED BY `F6-003`**, and the two rows now tell two
     * DIFFERENT stories, which is the whole distinction the defect erased.
     *
     * WHAT THIS TEST ASSERTED BEFORE: both rows `SUPPRESS` / `SCORE_BELOW_FLOOR`
     * with `score < 25` and `ACHIEVEMENT_VALUE = 0`. The sentence the Phase F
     * report puts forward as ITS example of a meaningful parent notification was
     * composed correctly and then dropped, every time, because
     * `GOAL_COMPLETED_PARENT` was a copy key with no row anywhere else: not in
     * `notification-class.ts` (so its category was the raw type string), not in
     * `URGENCY_BY_TYPE` (so it took `DEFAULT_URGENCY`), and not in
     * `ACHIEVEMENT_BASELINE_BY_TYPE` (so «a child completed a goal» was worth
     * ZERO on the achievement axis). ≈23 against a floor of 25.
     *
     * THE FIX IS THREE DATA ROWS and it is asserted here in the only way that
     * matters — by what the household actually receives:
     *
     *   THE FIRST completion is now SENT. Same event, same household, same
     *   instant; the achievement axis is no longer zero and the score clears
     *   the floor.
     *
     *   THE SECOND, fifteen minutes later, is still SUPPRESSED — and the
     *   scenario asserts WHY, because «suppressed» meaning two different things
     *   is exactly what made the defect invisible. It is refused by the
     *   FATIGUE_PENALTY: this household has now had two notifications in one
     *   hour against a cap of three, and the ACHIEVEMENT axis is IDENTICAL to
     *   the first row's. That is the guard working as designed on a real load,
     *   not a table with a hole in it, and the stored components say which.
     */
    it('PF-E-003 — the advertised sentence now ARRIVES, and a second one is refused by the household load, not by a missing table', async () => {
      const rows = (await decisionRows(lab.familyId)).filter(
        (row) => row.event_type === 'GOAL_COMPLETED_PARENT',
      );
      expect(rows).toHaveLength(2);

      // THE ROW THAT COULD NOT EXIST BEFORE.
      const [first, second] = rows;
      expect(first.decision).toBe('SEND');
      expect(Number(first.score)).toBeGreaterThanOrEqual(25);
      expect(first.outcome).toBe('SEND');
      assertTheArithmeticReconciles(first);

      // THE MISSING TABLE ROW, now visible as a POSITIVE contribution in the
      // stored arithmetic. This is the byte-level proof of the fix: the axis
      // that read 0 for «a child completed a goal» now reads the same baseline
      // the child's own `DAILY_GOAL_COMPLETED` carries.
      const firstComponents = new Map(componentsOf(first).map((c) => [c.name, c]));
      expect(Number(firstComponents.get('ACHIEVEMENT_VALUE').contribution)).toBeGreaterThan(0);
      expect(firstComponents.get('URGENCY').note).toContain('GOAL_COMPLETED_PARENT');

      // THE SECOND — suppressed, and suppressed for a NAMED, DIFFERENT reason.
      expect(second.decision).toBe('SUPPRESS');
      expect(second.reason).toBe('SCORE_BELOW_FLOOR');
      // The engine suppressed, so the pipeline was never called and there is
      // NO outcome — which is itself the honest record, not a missing value.
      expect(second.outcome).toBeNull();
      assertTheArithmeticReconciles(second);

      const secondComponents = new Map(componentsOf(second).map((c) => [c.name, c]));
      // NOT A HOLE: every positive axis is identical to the first row's — same
      // type, same tables, same answer. What differs is one penalty, and it is
      // a fact about this household rather than about this type.
      for (const axis of ['URGENCY', 'ACHIEVEMENT_VALUE', 'PARENT_PREFERENCE']) {
        expect(Number(secondComponents.get(axis).contribution)).toBe(
          Number(firstComponents.get(axis).contribution),
        );
      }
      expect(Number(secondComponents.get('FATIGUE_PENALTY').contribution)).toBeLessThan(
        Number(firstComponents.get('FATIGUE_PENALTY').contribution),
      );
      // And the penalty names the load in its own note, so «why did the second
      // one not arrive» is answerable from the row without this file open.
      expect(secondComponents.get('FATIGUE_PENALTY').note).toContain('hour=2/3');

      // And the parent received the first one and not the second.
      const notifications = await notificationRows(lab.familyId);
      expect(notifications).toHaveLength(2); // REWARD_GRANTED + the first goal
      expect(notifications.map((n) => n.type)).toContain('GOAL_COMPLETED_PARENT');
    });

    it('the ledger cannot leak a child: no title column, no body column, and no name in any stored value', async () => {
      const columns = await world.raw<any[]>(
        `SELECT column_name::text AS column_name FROM information_schema.columns WHERE table_name = 'notification_decisions'`,
      );
      const names = columns.map((c) => c.column_name);
      expect(names).toContain('score');
      expect(names).toContain('reason');
      expect(names).not.toContain('title');
      expect(names).not.toContain('body');

      for (const row of await decisionRows(lab.familyId)) {
        expect(JSON.stringify(row)).not.toContain(lab.childName);
      }
    });

    it('the parent can READ the explanation over HTTP, and sees only their own household', async () => {
      const mine = await request(world.http).get(`${P}/notifications/decisions`).set(asParent(lab));
      expect(mine.status).toBe(200);
      expect(mine.body).toHaveLength(3);
      for (const decision of mine.body) {
        expect(decision.trigger).toBeTruthy();
        expect(decision.reason).toBeTruthy();
        expect(decision.decision).toBeTruthy();
        expect(typeof decision.score).toBe('number');
      }

      // AND THE TENANT SCOPE, restated on the new state. This line used to read
      // `toHaveLength(0)` and prove two things at once — that the read is
      // tenant-scoped, and PF-E-001's «the product records nothing». The second
      // is closed, so the assertion now proves only the first: ACT I's
      // household has its OWN decisions, written by the production path, and
      // none of ACT II's appear in them.
      const theirs = await request(world.http).get(`${P}/notifications/decisions`).set(asParent(home));
      expect(theirs.status).toBe(200);
      expect(theirs.body.length).toBeGreaterThanOrEqual(1);
      const mineIds = new Set(mine.body.map((d: any) => d.id));
      for (const decision of theirs.body) {
        expect(mineIds.has(decision.id)).toBe(false);
      }
    });

    it('the same cause fired again writes NO second decision and NO second notification', async () => {
      const before = {
        decisions: (await decisionRows(lab.familyId)).length,
        notifications: (await notificationRows(lab.familyId)).length,
      };

      const replay = await fire({
        familyId: lab.familyId,
        childId: lab.childId,
        eventType: 'REWARD_GRANTED',
        sourceEventId: 'golden:e2e05:reward',
        trigger: 'DOMAIN_EVENT',
        reward: { kind: 'POINTS', amount: 20, isMilestone: false },
        now: goldenAt('12:50'),
      });

      // `null` decisionId means the ledger refused the row because this cause
      // was already decided — a redelivery, correctly ignored. The uniqueness is
      // `(family_id, source_event_id, target_audience)`, a constraint.
      expect(replay.decisionId).toBeNull();
      expect((await decisionRows(lab.familyId)).length).toBe(before.decisions);
      expect((await notificationRows(lab.familyId)).length).toBe(before.notifications);
    });
  });
});
