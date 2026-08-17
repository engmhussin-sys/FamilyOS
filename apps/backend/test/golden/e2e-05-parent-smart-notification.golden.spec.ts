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
 * THE TWO ANSWERS DISAGREE, AND THAT DISAGREEMENT IS THIS PHASE'S PRINCIPAL
 * FINDING — recorded as PF-E-001, measured here rather than argued. Nothing in
 * this file is weakened to make it pass: every expectation below is what the
 * product does today, pinned exactly, so that wiring the producer to the engine
 * turns these assertions red and forces a deliberate update.
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
     * PF-E-001, HALF ONE — THE COPY.
     *
     * `NotificationRewardConsumer` composes the parent's sentence itself, inline,
     * as two constant strings. It cannot say the child's name and it cannot say
     * the goal, because it has neither: it holds a `REWARD_GRANTED` envelope and
     * calls `notifyEvent` with literals.
     *
     * The engine's `COPY_CATALOGUE` DOES contain a `REWARD_GRANTED` entry that
     * interpolates `{childName}`, and `GOAL_COMPLETED_PARENT` contains the
     * «ثالث مرة هذا الأسبوع» sentence the Phase F report advertises — and no
     * producer in the codebase emits either. See ACT II.
     */
    it('MEASURED — the sentence the parent receives is a CONSTANT: no child, no goal, no number', async () => {
      const [row] = await notificationRows();

      // Pinned to the byte. If somebody wires the engine, this fails, and it
      // SHOULD fail — the copy changing is the whole point of wiring it.
      expect(row.title).toBe('مكافأة جديدة');
      expect(row.body).toBe('حصل طفلك على مكافأة جديدة اليوم. افتح التطبيق لرؤية التفاصيل.');

      // «طفلك» — "your child" — in a household with three children.
      expect(row.body).not.toContain(home.childName);
      expect(row.body).not.toContain('الملك');
      expect(row.body).not.toMatch(/\d/);
    });

    /**
     * PF-E-001, HALF TWO — THE EXPLANATION.
     *
     * Phase F built `notification_decisions` so that «why did / did not this
     * notification arrive» is answerable, and so that the suppression rate is
     * computable at all (`notifications` only holds what WAS sent). Every real
     * notification the product sends bypasses that ledger, so both numbers
     * describe an empty set in production.
     */
    it('MEASURED — the product wrote a notification and recorded NO decision: the explainability ledger is empty', async () => {
      expect(await decisionRows()).toHaveLength(0);

      // And the parent-facing read of that ledger is therefore an empty list —
      // the endpoint works; there is simply nothing for the product to show.
      const decisions = await request(world.http)
        .get(`${P}/notifications/decisions`)
        .set(asParent(home));
      expect(decisions.status).toBe(200);
      expect(decisions.body).toHaveLength(0);
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
     * PF-E-003 — MEASURED, PINNED, AND NOT WEAKENED.
     *
     * The sentence above is the one the Phase F report puts forward as the
     * example of a meaningful parent notification. Driven through the real
     * engine it is composed correctly and then SUPPRESSED, because
     * `GOAL_COMPLETED_PARENT` is a copy key with no entries anywhere else:
     * not in `notification-class.ts` (so its category is the raw type string
     * and its quiet-hours class is the default), not in `URGENCY_BY_TYPE` (so
     * it takes `DEFAULT_URGENCY`), and not in `ACHIEVEMENT_BASELINE_BY_TYPE`
     * (so «a child completed a goal» is worth ZERO on the achievement axis).
     *
     * The arithmetic lands around 23 against a floor of 25. The scenario asserts
     * the SUPPRESS rather than tolerating it, so that adding the three missing
     * table entries — the fix — turns this red and is noticed.
     */
    it('PF-E-003 — and that advertised sentence is then SUPPRESSED, because its type is in no scoring table', async () => {
      const rows = (await decisionRows(lab.familyId)).filter(
        (row) => row.event_type === 'GOAL_COMPLETED_PARENT',
      );
      expect(rows).toHaveLength(2);

      for (const row of rows) {
        expect(row.decision).toBe('SUPPRESS');
        expect(row.reason).toBe('SCORE_BELOW_FLOOR');
        expect(Number(row.score)).toBeLessThan(25);
        assertTheArithmeticReconciles(row);

        // The engine suppressed, so the pipeline was never called and there is
        // NO outcome — which is itself the honest record, not a missing value.
        expect(row.outcome).toBeNull();

        // The three absent table entries, visible in the stored arithmetic.
        const byName = new Map(componentsOf(row).map((c) => [c.name, c]));
        expect(Number(byName.get('ACHIEVEMENT_VALUE').contribution)).toBe(0);
      }

      // And the parent received nothing for either of them.
      const notifications = await notificationRows(lab.familyId);
      expect(notifications).toHaveLength(1); // the REWARD_GRANTED one only
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

      // The household from ACT I has no decisions at all — PF-E-001 again, and
      // proof that this read is tenant-scoped rather than global.
      const theirs = await request(world.http).get(`${P}/notifications/decisions`).set(asParent(home));
      expect(theirs.body).toHaveLength(0);
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
