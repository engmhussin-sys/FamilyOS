/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * ============================================================================
 * GOLDEN E2E-14 — THE MISSED GOAL. THE ONE THE PRODUCT CLAIMS TO BE A COACH ON.
 * ============================================================================
 *
 * WHAT THIS SCENARIO IS FOR. Every other golden file walks a SUCCESS: a child
 * earns something and the household is told. The commercial claim of ABNY is
 * about the other day — «مدرب لا مراقب» (CONTEXT §1) — and nothing in this
 * repository proves what happens when a child simply does not do the thing.
 * A monitor nags. A broken product goes silent. A coach says what happened,
 * says what might help, says it ONCE, and lets the parent make the goal
 * smaller. This file is that sentence, executed.
 *
 *   PART 1  A parent creates a goal. The child STARTS it and never finishes.
 *   PART 2  The engine's missed-goal answer, and it does not spam: the same
 *           business day cannot produce a second one, by two independent
 *           mechanisms, and quiet hours are honoured.
 *   PART 3  The words are NON-PUNITIVE (CONTEXT §3 principle 7) — measured on
 *           the row the parent actually reads, not on a returned object.
 *   PART 4  The parent ADJUSTS the goal to something lighter.
 *   PART 5  The child's own app shows the ADJUSTED goal.
 *
 * ---------------------------------------------------------------------------
 * THE PRINCIPAL FINDING, MEASURED IN ACT I AND ACT II AND NOT ARGUED:
 *
 *   `GOAL_STALLED_PARENT` — «بدأ محمد هدف … ولم يكمله» — is a COMPLETE
 *   notification type. It has a sentence (`notification-copy.ts:448`), a
 *   quiet-hours classification with a written justification
 *   (`notification-class.ts:219`), an urgency weight
 *   (`notification-scoring.ts:86`) and an achievement baseline
 *   (`notification-scoring.ts:154`). Four tables, four deliberate rows.
 *
 *   AND IT HAS NO PRODUCER. Nothing in `src/` ever emits it. The three callers
 *   of `SmartNotificationEngineService.handleEvent` are the reward consumer,
 *   the rewards engine and the digital-wellbeing engine; none of them looks at
 *   an abandoned `achievement_requests` row, and no scheduled job does either
 *   (`FamilyDailyRolloverJob` rolls HABITS over, not reward programs).
 *
 *   So ACT I measures the product: a goal is started, the day passes, and
 *   `notification_decisions` — the table whose entire purpose is to record why
 *   a household was or was not told something — has ZERO ROWS. And ACT II
 *   measures the engine on the SAME household through its real public entry
 *   point, and gets a complete, scored, explained, delivered coaching
 *   notification. The gap between the two acts IS the finding, and it is the
 *   same shape as `PF-E-001`, which this suite recorded and F6-003 closed: a
 *   capability that exists and is not wired.
 *
 *   THE ASSERTIONS BELOW PIN BOTH SIDES. If a producer is ever wired, ACT I
 *   turns red and forces a deliberate update — which is exactly what happened
 *   to `e2e-05` and is why that file's history is readable.
 *
 * A SECOND FINDING, IN ACT V. `PATCH /reward-programs/:id`
 * (`UpdateRewardProgramDto`) accepts `status`, `maxPerDay`, `maxPerWeek`,
 * `requiresParentApproval`, `expiresAt` and `difficulty` — and NOT
 * `targetSpec` and NOT `durationMinutes`. A parent whose child could not
 * memorise five ayahs in twenty minutes CANNOT make the target four ayahs or
 * the duration ten minutes in place; `forbidNonWhitelisted` refuses the
 * request with a 400. The adaptive loop is still reachable — archive the heavy
 * goal, author a lighter one — and that is the path this scenario walks,
 * because it is the path a parent actually has today.
 * ---------------------------------------------------------------------------
 *
 * Real PostgreSQL, real Redis, real booted app, real HTTP. Nothing stubbed.
 * Every count and every row is read OUT OF THE DATABASE with `world.raw`.
 */
import {
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
import { hasEnumOrPlaceholderLeak } from '../../src/modules/notifications/domain/engine/notification-copy';
import {
  forEntity,
  forRecurringSignal,
} from '../../src/shared/notifications/notification-source-key';
import { getBusinessDate, getBusinessTimeHHMM } from '../../src/common/time/family-date';
import { describeTargetSpec } from '../../src/shared/rewards/target-spec';

import request = require('supertest');

const CAIRO = 'Africa/Cairo';

/**
 * THE UTC INSTANT AT WHICH CAIRO'S CLOCK READS `hhmm` — SEARCHED, NOT ASSUMED.
 *
 * The same helper, for the same reason, as `e2e-09`: the golden day is DERIVED
 * FROM THE REAL CLOCK, so Cairo is UTC+2 in winter and UTC+3 in summer, and a
 * quiet-hours test that hard-codes an offset is testing the tester's
 * arithmetic. The instant is found by asking the PRODUCTION function
 * `getBusinessTimeHHMM` — the same one `evaluateAndDeliver` uses to decide the
 * window — which makes the premise true by construction in any month.
 */
function utcWhenLocalIs(hhmm: string, timeZone: string, dayOffset = 0): Date {
  const base = goldenAt('00:00').getTime() + dayOffset * 24 * 60 * 60 * 1000;
  for (let minutes = -24 * 60; minutes < 48 * 60; minutes += 5) {
    const candidate = new Date(base + minutes * 60 * 1000);
    if (getBusinessTimeHHMM(candidate, timeZone) === hhmm) return candidate;
  }
  throw new Error(`no instant near the golden day has local time ${hhmm} in ${timeZone}`);
}

/** 14:00 in Cairo: comfortably outside the default 21:00–07:00 window, and
 * stated as a LOCAL time because that is the only clock quiet hours has. */
const MIDDAY = utcWhenLocalIs('14:00', CAIRO);
const MIDDAY_PLUS_3_MIN = new Date(MIDDAY.getTime() + 3 * 60 * 1000);
const MIDDAY_PLUS_45_MIN = new Date(MIDDAY.getTime() + 45 * 60 * 1000);
/** 22:30 Cairo — inside quiet hours, on the same golden day. */
const LATE_NIGHT = utcWhenLocalIs('22:30', CAIRO);

/** The heavy goal, and the light one it becomes. Five ayahs in twenty minutes
 * is a real ask for a twelve-year-old; one ayah in five is the adjustment a
 * coach makes rather than the judgement a monitor delivers. */
const HEAVY_GOAL = {
  category: 'QURAN',
  activity: 'QURAN_MEMORIZE_AYAH_RANGE',
  targetSpec: { surahNumber: 67, fromAyah: 1, toAyah: 5 },
  durationMinutes: 20,
  verificationLevel: 'PARENT_CONFIRMATION',
  rewardSpec: { type: 'POINTS', amount: 20 },
};

const LIGHT_GOAL = {
  category: 'QURAN',
  activity: 'QURAN_MEMORIZE_AYAH_RANGE',
  targetSpec: { surahNumber: 67, fromAyah: 1, toAyah: 1 },
  durationMinutes: 5,
  verificationLevel: 'PARENT_CONFIRMATION',
  rewardSpec: { type: 'POINTS', amount: 10 },
};

/**
 * THE WORDS A COACH DOES NOT USE, as data.
 *
 * CONTEXT §3 principle 7 (NO PUNITIVE UX) is a product rule and a test that
 * asserted it as «the body is a nice sentence» would assert nothing. These are
 * the four families of punitive language, each with the Arabic the product
 * would actually reach for and the English a future locale could, and the
 * scenario checks the PARENT's sentence against all of them — principle 7
 * applies to the parent surface too (`notification-copy.ts` §5).
 */
const BLAME_WORDS = ['فشل', 'كسول', 'مقصر', 'تقصير', 'إهمال', 'ضعيف', 'سيء', 'خيبة', 'failed', 'lazy', 'bad'];
const COMPARISON_WORDS = ['أفضل من', 'أسوأ من', 'أقل من', 'مقارنة', 'أخيه', 'أخته', 'إخوته', 'زملائه', 'أقرانه', 'compared', 'better than', 'worse than'];
const THREAT_WORDS = ['عقاب', 'سنمنع', 'سنحذف', 'سنوقف', 'ستفقد', 'حرمان', 'سنسحب', 'punish', 'we will remove', 'you will lose'];

describeGolden('GOLDEN E2E-14 — the goal that was missed, and whether the product coaches or nags', () => {
  let world: GoldenWorld;
  /** The household the whole story happens to. */
  let home: GoldenHousehold;
  /**
   * A SECOND household, for ACT VI only. Stated rather than hidden: the engine
   * SCORES against the household's own notification history, so evaluating the
   * quiet-hours case inside the household that has already been notified once
   * would entangle the quiet-hours arithmetic with ACT II's fatigue term. Same
   * app, same PostgreSQL, same registration over real HTTP.
   */
  let night: GoldenHousehold;
  let engine: SmartNotificationEngineService;

  /** Filled by ACT I and read by every act after it. */
  let heavyProgramId = '';
  let heavyGoalTitle = '';
  let lightProgramId = '';
  /** The business day the whole of ACTs I–V happens on, on the FAMILY's
   * calendar — the axis every «same day» claim below is made on. */
  let businessDate = '';

  beforeAll(async () => {
    freezeGoldenClock(MIDDAY);
    world = await bootGoldenWorld('golden E2E-14 (missed goal, adaptive)');
    const year = Number(MIDDAY.toISOString().slice(0, 4));
    home = await world.register('e2e14', {
      childName: 'محمد',
      childDateOfBirth: `${year - 12}-04-01`,
      familyTimeZone: CAIRO,
    });
    night = await world.register('e2e14night', {
      childName: 'سلمى',
      childDateOfBirth: `${year - 12}-04-01`,
      familyTimeZone: CAIRO,
    });
    // Six hours of household history, so `evaluateActivation` GATE 3 does not
    // read this family as somebody demonstrating the app.
    await ageTheHousehold(world, home, utcWhenLocalIs('08:00', CAIRO));
    await ageTheHousehold(world, night, utcWhenLocalIs('08:00', CAIRO));
    engine = world.app.get(SmartNotificationEngineService);
    businessDate = getBusinessDate(MIDDAY, CAIRO);
  }, 240_000);

  afterAll(async () => {
    jest.useRealTimers();
    if (world) await world.close();
  });

  // ------------------------------------------------------------- table reads

  const rows = (sql: string, ...params: unknown[]): Promise<any[]> => world.raw<any[]>(sql, ...params);

  const countOf = async (table: string, familyId: string, extra = ''): Promise<number> =>
    Number(
      (
        await rows(
          `SELECT COUNT(*)::int AS n FROM "${table}" WHERE "family_id" = $1::uuid ${extra}`,
          familyId,
        )
      )[0].n,
    );

  const notificationRows = (h: GoldenHousehold = home): Promise<any[]> =>
    rows(
      `SELECT * FROM "notifications" WHERE "family_id" = $1::uuid ORDER BY "created_at", "id"`,
      h.familyId,
    );

  const decisionRows = (h: GoldenHousehold = home): Promise<any[]> =>
    rows(
      `SELECT * FROM "notification_decisions" WHERE "family_id" = $1::uuid ORDER BY "created_at", "id"`,
      h.familyId,
    );

  const programRow = (programId: string): Promise<any[]> =>
    rows(`SELECT * FROM "reward_programs" WHERE "id" = $1::uuid`, programId);

  const attemptRows = (): Promise<any[]> =>
    rows(
      `SELECT * FROM "achievement_requests" WHERE "family_id" = $1::uuid ORDER BY "created_at", "id"`,
      home.familyId,
    );

  /**
   * THE FOUR NUMBERS THIS SCENARIO'S «IT DID NOT SPAM» CLAIM IS MADE OF,
   * counted together so that «zero additional» is ONE comparison rather than
   * four that can drift apart. Family-wide on purpose: a duplicate written
   * under a DIFFERENT source key is exactly what a broken dedup produces, and
   * a cause-scoped count cannot see it.
   */
  interface Silence {
    readonly decisions: number;
    readonly notifications: number;
    readonly childMessages: number;
    readonly deliveries: number;
  }

  const countTheHousehold = async (h: GoldenHousehold = home): Promise<Silence> => ({
    decisions: await countOf('notification_decisions', h.familyId),
    notifications: await countOf('notifications', h.familyId),
    childMessages: await countOf('child_messages', h.familyId),
    deliveries: await countOf('notification_deliveries', h.familyId),
  });

  /** `explanation` is jsonb and the driver may hand it back parsed or as text;
   * both are read, so the assertion is about the stored arithmetic and not
   * about the driver. Same helper, same reason, as `e2e-05`. */
  function componentsOf(row: any): any[] {
    const parsed = typeof row.explanation === 'string' ? JSON.parse(row.explanation) : row.explanation;
    return Array.isArray(parsed) ? parsed : (parsed?.components ?? []);
  }

  function componentMap(row: any): Map<string, any> {
    return new Map(componentsOf(row).map((c) => [c.name, c]));
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
    runWithTenant({ familyId: input.familyId, actorType: 'SYSTEM', actorId: 'golden-e2e-14' }, () =>
      engine.handleEvent(input),
    );

  /**
   * THE MISSED-GOAL EVENT, composed ONCE so that every act fires the same
   * thing and only the KEY and the INSTANT differ.
   *
   * `trigger: 'PERIODIC_SIGNAL'` is a CHOICE THIS TEST MAKES AND SAYS SO. The
   * trigger is a producer-supplied field and this type has no producer, so
   * there is nothing to read it off. `PERIODIC_SIGNAL` is the member of
   * `NOTIFICATION_TRIGGERS` whose own comment reads «a periodic signal scan
   * produced a candidate», which is what a stalled-goal sweep would be — it is
   * not a DOMAIN_EVENT, because a goal NOT being finished emits no event, and
   * that absence is half of why this path was never built.
   *
   * The goal is passed with `completedUnits: 0` of `totalUnits: 5` and NO
   * deadline, which is the truth of the row ACT I leaves behind: the child
   * opened the attempt and stopped. Those two facts are what
   * `ACHIEVEMENT_VALUE` and `DEADLINE_PROXIMITY` read.
   */
  const missedGoalEvent = (sourceEventId: string, now: Date): NotificationEventInput => ({
    familyId: home.familyId,
    childId: home.childId,
    eventType: 'GOAL_STALLED_PARENT',
    sourceEventId,
    trigger: 'PERIODIC_SIGNAL',
    goal: { title: heavyGoalTitle, completedUnits: 0, totalUnits: 5, minutesRemaining: null },
    now,
  });

  // =========================================================================
  // PART 1 — ACT I: THE GOAL NOBODY FINISHED
  // =========================================================================

  describe('ACT I — a parent sets a goal, the child starts it, and the day passes', () => {
    it('the premise, measured: the family clock reads 14:00, which is NOT quiet hours', () => {
      expect(getBusinessTimeHHMM(MIDDAY, CAIRO)).toBe('14:00');
      expect(getBusinessTimeHHMM(LATE_NIGHT, CAIRO)).toBe('22:30');
    });

    it('the parent creates the goal over real HTTP, and the row carries the target the parent typed', async () => {
      const created = await request(world.http)
        .post(`${P}/reward-programs`)
        .set(asParent(home))
        .send({ childId: home.childId, ...HEAVY_GOAL });
      expect([200, 201]).toContain(created.status);
      heavyProgramId = created.body.id;

      // READ BACK FROM THE TABLE, not from the response body.
      const [program] = await programRow(heavyProgramId);
      expect(program.status).toBe('ACTIVE');
      expect(program.duration_minutes).toBe(20);
      expect(program.child_id).toBe(home.childId);
      // The Arabic summary is composed by the PRODUCER's own function rather
      // than restated as a literal here, so a change to it moves this test
      // instead of breaking it dishonestly.
      expect(program.target_summary_ar).toBe(
        describeTargetSpec(HEAVY_GOAL.activity, HEAVY_GOAL.targetSpec as any),
      );
      heavyGoalTitle = program.target_summary_ar;
    });

    it('the child STARTS it on their own device — and never submits anything', async () => {
      const started = await request(world.http)
        .post(`${P}/self/achievements/start`)
        .set(asChild(home))
        .send({ programId: heavyProgramId });
      expect([200, 201]).toContain(started.status);

      // The attempt is real, it is open, and NOTHING was ever submitted. This
      // is «بدأ ولم يكمل» as a database row rather than as a premise the test
      // asserts about itself.
      const attempts = await attemptRows();
      expect(attempts).toHaveLength(1);
      expect(attempts[0].program_id).toBe(heavyProgramId);
      expect(attempts[0].child_id).toBe(home.childId);
      expect(['REQUESTED', 'IN_PROGRESS']).toContain(attempts[0].status);
      expect(attempts[0].submitted_at).toBeNull();
      expect(attempts[0].decided_at).toBeNull();
      expect(attempts[0].granted_amount).toBeNull();
    });

    it('the child\'s own app already says why the goal is not tappable, and says it kindly', async () => {
      const today = await request(world.http).get(`${P}/self/achievements/today`).set(asChild(home));
      expect(today.status).toBe(200);
      const heavy = today.body.find((p: any) => p.id === heavyProgramId);
      expect(heavy).toBeDefined();
      // An OPEN attempt, not a failure: the child is told to finish the one
      // they have, which is `MAX_OPEN_ATTEMPTS_PER_DAY` doing its job.
      expect(heavy.available).toBe(false);
      expect(heavy.unavailableReason.code).toBe('ATTEMPT_ALREADY_OPEN');
      expect(heavy.unavailableReason.messageAr).toMatch(/[؀-ۿ]/);
      for (const word of [...BLAME_WORDS, ...THREAT_WORDS, ...COMPARISON_WORDS]) {
        expect(heavy.unavailableReason.messageAr).not.toContain(word);
      }
    });

    it('nothing was earned: the ledger, the timeline and the reward tables are empty', async () => {
      const drain = await world.drainOutbox();
      expect(drain.failed).toBe(0);

      expect(await countOf('rewards_ledger_entries', home.familyId)).toBe(0);
      expect(await countOf('verification_attempts', home.familyId)).toBe(0);
      expect(
        await countOf('life_timeline_events', home.familyId, `AND "event_type" = 'reward_granted'`),
      ).toBe(0);
    });

    /**
     * THE FINDING, AS A NUMBER.
     *
     * The goal was created, started and abandoned; every domain event this
     * produced has been relayed and consumed. `notification_decisions` exists
     * so that «why was this household told / not told something» is answerable
     * from a column. For the one day in this product's life that its own
     * marketing is about, the answer is: there is no row, because nothing
     * asked the question.
     *
     * PINNED AT ZERO ON PURPOSE. The day a stalled-goal producer is wired,
     * this assertion turns red and its author has to come here and say what
     * the product now does — the same mechanism that made `PF-E-001`'s closure
     * visible in `e2e-05`'s diff.
     */
    it('THE FINDING — no missed-goal notification, and no DECISION explaining the silence', async () => {
      expect(await countTheHousehold()).toEqual({
        decisions: 0,
        notifications: 0,
        childMessages: 0,
        deliveries: 0,
      });

      // Not «no rows for this type» — NO ROWS AT ALL for this family, so the
      // number cannot be explained away by a key mismatch.
      const stalled = await rows(
        `SELECT COUNT(*)::int AS n FROM "notification_decisions"
           WHERE "family_id" = $1::uuid AND "event_type" = 'GOAL_STALLED_PARENT'`,
        home.familyId,
      );
      expect(Number(stalled[0].n)).toBe(0);

      // And the parent's own read of the ledger agrees, over HTTP.
      const decisions = await request(world.http)
        .get(`${P}/notifications/decisions`)
        .set(asParent(home));
      expect(decisions.status).toBe(200);
      expect(decisions.body).toHaveLength(0);
    });
  });

  // =========================================================================
  // PART 2 — ACT II: THE ENGINE DOES HAVE AN ANSWER
  // =========================================================================

  describe('ACT II — the same household, the same day, through the engine\'s real entry point', () => {
    /**
     * THE KEY, AND IT IS THE STRONGEST FORM AVAILABLE TO THIS CAUSE.
     *
     * A stalled goal has no `domain_events.id` — that is the whole reason it
     * has no producer — but it does have a stable business identity: THIS
     * child, THIS program, THIS business day. `forEntity` composes exactly
     * that, so «the scan ran twice today» recomputes the SAME string and the
     * ledger's own `ON CONFLICT (family_id, source_event_id, target_audience)`
     * refuses the second row. The deduplication key is a decision made at the
     * call site, which is what `notification-source-key.ts` exists to force.
     */
    const key = (): string => forEntity('signal', home.childId, heavyProgramId, businessDate);

    let firstScore = 0;

    it('the missed goal produces a SEND decision, delivered, and the arithmetic reconciles', async () => {
      const result = await fire(missedGoalEvent(key(), MIDDAY));

      expect(result.decision.verdict).toBe('SEND');
      expect(result.decision.targetAudience).toBe('PARENT');
      expect(result.decisionId).not.toBeNull();
      expect(result.outcome?.decision).toBe('SEND');

      const decisions = await decisionRows();
      expect(decisions).toHaveLength(1);
      const [row] = decisions;

      // THE FOUR COLUMNS THE LEDGER EXISTS FOR — trigger, score, reason,
      // decision — plus the outcome, which is what makes «the engine agreed
      // with the pipeline» a fact rather than an assumption.
      expect(row.trigger).toBe('PERIODIC_SIGNAL');
      expect(row.event_type).toBe('GOAL_STALLED_PARENT');
      expect(row.notification_type).toBe('GOAL_STALLED_PARENT');
      expect(row.category).toBe('GOAL');
      expect(row.target_audience).toBe('PARENT');
      expect(row.decision).toBe('SEND');
      expect(row.outcome).toBe('SEND');
      expect(row.source_event_id).toBe(key());
      expect(row.business_date.toISOString().slice(0, 10)).toBe(businessDate);
      expect(row.locale).toBe('ar');
      // The sentence came from the CATALOGUE, not from a stub and not from a
      // model: `copy_key` is how a dashboard finds a type nobody wrote copy
      // for, and `GENERIC` here would mean the parent read «لديك تحديث جديد».
      expect(row.copy_key).toBe('GOAL_STALLED_PARENT');
      expect(row.ai_rewritten).toBe(false);

      /**
       * THE SCORE, PINNED TO THE NUMBER, with the arithmetic written out so
       * that a deliberate re-tune moves this line rather than deleting it:
       *
       *   URGENCY            0.25 × 30 = +7.5   (`URGENCY_BY_TYPE`)
       *   RELEVANCE          0.35 × 20 = +7     (not engaged, no activity today,
       *                                          no completions — a missed goal
       *                                          IS a quiet day, by definition)
       *   ACHIEVEMENT_VALUE  0.3  × 20 = +6     (`ACHIEVEMENT_BASELINE_BY_TYPE`;
       *                                          NOT zero — `PF-E-003`'s lesson)
       *   DEADLINE_PROXIMITY 0    × 15 =  0     (no deadline on this goal)
       *   PARENT_PREFERENCE  0.6  × 15 = +9     (default appetite)
       *   three penalties               =  0    (a household with no history)
       *                                  -----
       *                                   29.5  -> 30
       *
       * 30 is above the floor of 25 and below `thresholdMedium` of 45, so the
       * band is LOW and the reason names the branch: a missed goal is worth
       * telling a parent about, and it is not an alarm.
       */
      expect(Number(row.score)).toBe(30);
      expect(row.priority_band).toBe('LOW');
      expect(row.reason).toBe('SCORE_IN_DEFER_BAND');
      assertTheArithmeticReconciles(row);
      firstScore = Number(row.score);

      // It really arrived: one row, to the family OWNER, read from the table.
      const notifications = await notificationRows();
      expect(notifications).toHaveLength(1);
      expect(notifications[0].type).toBe('GOAL_STALLED_PARENT');
      expect(notifications[0].user_id).toBe(home.ownerUserId);
      expect(notifications[0].child_id).toBe(home.childId);
      expect(notifications[0].source_event_id).toBe(key());
    });

    /**
     * PART 2, THE ANTI-SPAM CLAIM, MECHANISM ONE: THE DEDUPLICATION KEY.
     *
     * A stalled-goal sweep that ran twice in one business day — an operator
     * pressing «Run now», two replicas ticking, a retry — recomputes the same
     * `forEntity` string. The ledger's `ON CONFLICT ... DO NOTHING` refuses the
     * insert and `record` returns no id, which is how the caller learns «this
     * cause was already decided» without a second query.
     *
     * WOULD THIS FAIL IF IT BROKE? Yes, and by row count rather than by a
     * returned flag: without the conflict clause a SECOND decision row would
     * exist (carrying whatever verdict the second evaluation reached), and the
     * `toEqual` below counts the table.
     */
    it('MECHANISM ONE — the same scan again, same day: no second decision, no second notification', async () => {
      const before = await countTheHousehold();

      const replay = await fire(missedGoalEvent(key(), MIDDAY_PLUS_3_MIN));

      expect(replay.decisionId).toBeNull();
      expect(await countTheHousehold()).toEqual(before);
      expect(await countTheHousehold()).toEqual({
        decisions: 1,
        notifications: 1,
        childMessages: 0,
        deliveries: 0,
      });
    });

    /**
     * MECHANISM TWO: THE SCORE, WHICH DOES NOT NEED THE KEY TO BE RIGHT.
     *
     * `notification-source-key.ts` states the honest limit of its own weakest
     * form: a bucketed recurring-signal key does NOT collide across bucket
     * edges, so a producer that chose it could legitimately present the same
     * fact under a new string later the same day. This act does exactly that —
     * forty-five minutes later, past the five-minute duplicate window AND past
     * the thirty-minute default cooldown, so neither of the two mechanisms
     * that would trivially catch it applies.
     *
     * IT IS STILL REFUSED, and by a NAMED reason: the household has now had
     * one GOAL notification today, `categoryMaxPerDay` is 2, so the fatigue
     * term reads 0.5 and subtracts 12.5 from a score whose margin over the
     * floor was 5. The anti-spam property therefore does not rest on the
     * producer having chosen a good key.
     *
     * WOULD THIS FAIL IF IT BROKE? Yes, three ways: the verdict would be SEND,
     * the notifications count would be 2, and the score would not have fallen.
     * All three are asserted, and the positive axes are compared row-to-row so
     * that «suppressed» cannot quietly become «suppressed for a different
     * reason» — which is exactly how `PF-E-003` stayed invisible.
     */
    it('MECHANISM TWO — a WEAKER key 45 minutes later is still refused, and the row says why', async () => {
      const weakKey = forRecurringSignal('signal', home.childId, 'GOAL_STALLED', MIDDAY_PLUS_45_MIN);
      expect(weakKey).not.toBe(key()); // the premise: a genuinely different key

      const second = await fire(missedGoalEvent(weakKey, MIDDAY_PLUS_45_MIN));
      expect(second.decision.verdict).toBe('SUPPRESS');
      // The engine suppressed, so the pipeline was never called — which is the
      // honest record, not a missing value.
      expect(second.outcome).toBeNull();

      const decisions = await decisionRows();
      expect(decisions).toHaveLength(2);
      /**
       * THE TWO ROWS ARE FOUND BY THEIR OWN KEYS, NOT BY POSITION.
       *
       * `notification_decisions.created_at` defaults to PostgreSQL's `NOW()`,
       * which is the TRANSACTION timestamp — so two inserts a few milliseconds
       * apart normally differ, and on a fast host they can tie. An ordered
       * `[first, second]` destructure would then silently degrade to
       * `gen_random_uuid()` order, and this test would compare the rows the
       * wrong way round at random. The keys are unique by construction; the
       * timestamps are not.
       */
      const first = decisions.find((r) => r.source_event_id === key());
      const refused = decisions.find((r) => r.source_event_id === weakKey);
      expect(first).toBeDefined();
      expect(refused).toBeDefined();
      expect(refused.decision).toBe('SUPPRESS');
      expect(refused.reason).toBe('SCORE_BELOW_FLOOR');
      expect(refused.outcome).toBeNull();
      assertTheArithmeticReconciles(refused);

      // 29.5 − 12.5 (fatigue) = 17, against a floor of 25. Pinned, because
      // «below the floor» with an unpinned number would still pass if the
      // margin vanished.
      expect(Number(refused.score)).toBe(17);
      expect(Number(refused.score)).toBeLessThan(firstScore);

      const before = componentMap(first);
      const after = componentMap(refused);
      // NOT A HOLE: every positive axis is identical — same type, same tables,
      // same answer. What differs is one penalty, and it is a fact about this
      // household rather than about this type.
      for (const axis of ['URGENCY', 'RELEVANCE', 'ACHIEVEMENT_VALUE', 'DEADLINE_PROXIMITY', 'PARENT_PREFERENCE']) {
        expect(Number(after.get(axis).contribution)).toBe(Number(before.get(axis).contribution));
      }
      expect(Number(after.get('FATIGUE_PENALTY').contribution)).toBeLessThan(0);
      expect(Number(before.get('FATIGUE_PENALTY').contribution)).toBe(0);
      // The note names the load, so «why did the second one not arrive» is
      // answerable from the row without this file open.
      expect(after.get('FATIGUE_PENALTY').note).toContain('category=1/2');
      // And NOT by the duplicate rule: 45 minutes is outside both windows, so
      // the refusal really is the household's load and not a near-duplicate.
      expect(Number(after.get('DUPLICATE_PENALTY').contribution)).toBe(0);
      expect(after.get('DUPLICATE_PENALTY').note).toContain('no recent notification of this type');

      // THE PARENT'S PHONE, WHICH IS THE ONLY NUMBER THAT MATTERS: still one.
      expect(await countTheHousehold()).toEqual({
        decisions: 2,
        notifications: 1,
        childMessages: 0,
        deliveries: 0,
      });
    });
  });

  // =========================================================================
  // PART 3 — ACT III: THE WORDS
  // =========================================================================

  describe('ACT III — non-punitive, measured on the row the parent actually reads', () => {
    it('the sentence names the child and the goal, and comes from the catalogue', async () => {
      const [row] = await notificationRows();

      // PINNED TO THE BYTE, in the house style, so the next change to this
      // product's most delicate sentence is a deliberate one. Both halves of
      // the expectation are derived from the database — the child's name from
      // registration, the goal's title from `reward_programs.target_summary_ar`
      // — so the literal here is the SHAPE of the sentence, not its data.
      expect(row.title).toBe('هدف بدأ ولم يكتمل');
      expect(row.body).toBe(
        `بدأ ${home.childName} هدف ${heavyGoalTitle} ولم يكمله — ربما يحتاج دفعة اليوم`,
      );
      expect(row.body).toContain(home.childName);
      expect(row.body).toContain(heavyGoalTitle);
    });

    it('it is Arabic, and no raw enum or unresolved placeholder reached the parent', async () => {
      const [row] = await notificationRows();
      expect(row.body).toMatch(/[؀-ۿ]/);
      expect(row.body).not.toMatch(/[{}]/);
      expect(row.body).not.toMatch(/[A-Z]{3,}_[A-Z_]+/);
      expect(row.title).not.toMatch(/[A-Z]{3,}_[A-Z_]+/);
      // And against the PRODUCT's own leak detector, not only against this
      // file's regex — the two must agree.
      expect(hasEnumOrPlaceholderLeak(row.title)).toBe(false);
      expect(hasEnumOrPlaceholderLeak(row.body)).toBe(false);
    });

    /**
     * CONTEXT §3 PRINCIPLE 7, AS AN ASSERTION.
     *
     * No blame, no comparison to a sibling or a peer, no threat. Checked on
     * the concatenation of title and body, because a punitive title with a
     * gentle body is still a punitive notification.
     */
    it('there is no blame, no comparison and no threat anywhere in it', async () => {
      const [row] = await notificationRows();
      const text = `${row.title} ${row.body}`;
      for (const word of BLAME_WORDS) expect(text).not.toContain(word);
      for (const word of COMPARISON_WORDS) expect(text).not.toContain(word);
      for (const word of THREAT_WORDS) expect(text).not.toContain(word);
      // Nor does it invoke the reward as leverage — «you will not get your
      // points» is the punitive version of this exact message.
      expect(text).not.toContain('النقاط');
      expect(text).not.toContain('المكافأة');
    });

    /**
     * THE HALF THAT MAKES IT COACHING RATHER THAN REPORTING.
     *
     * A monitor's notification ends at «did not finish». The product's claim
     * is that the parent is also told what they might do, and the two clauses
     * are pinned separately so that losing the second one — the likeliest
     * regression, because it is the one a shorter sentence would drop — fails
     * on its own line.
     */
    it('it says WHAT HAPPENED and WHAT THE PARENT MIGHT DO — both clauses, separately pinned', async () => {
      const [row] = await notificationRows();
      // What happened: the goal was started and not completed.
      expect(row.body).toContain('بدأ');
      expect(row.body).toContain('ولم يكمله');
      // What to do: a nudge, today. Suggested («ربما»), never instructed.
      expect(row.body).toContain('ربما');
      expect(row.body).toContain('دفعة');
      expect(row.body).toContain('اليوم');
    });

    /**
     * AND THE CHILD IS TOLD NOTHING — WHICH IS THE DESIGN, NOT AN OMISSION.
     *
     * `coaching-rules.ts:63` states it in words: «No rule here ever criticizes
     * a missed goal directly to the child; that stays a PARENT-track concern.»
     * The notification layer enforces it STRUCTURALLY rather than by trusting
     * every producer to remember: `COPY_CATALOGUE.GOAL_STALLED_PARENT` declares
     * `audience: 'PARENT'`, and `RuleBasedNotificationDecisionProvider`
     * resolves the audience from that declaration — so this event, fired WITH
     * a `childId`, still resolves to the parent and cannot reach
     * `child_messages` at all.
     *
     * That is the strongest available form of «the child is not nagged»: not a
     * copy review, a routing property. The child's own channel for this fact
     * is their goal list, which ACT V changes.
     */
    it('the child receives NOTHING about the missed goal, and that is structural', async () => {
      expect(await countOf('child_messages', home.familyId)).toBe(0);

      const audiences = (await decisionRows()).map((r) => r.target_audience);
      expect(audiences).toEqual(['PARENT', 'PARENT']);
      // Fired with a child id, every time, and still never routed to the child.
      for (const row of await decisionRows()) {
        expect(row.child_id).toBe(home.childId);
        expect(row.target_audience).toBe('PARENT');
      }
    });
  });

  // =========================================================================
  // PART 4 — ACT IV: THE PARENT ADJUSTS
  // =========================================================================

  describe('ACT IV — the parent makes the goal lighter', () => {
    /**
     * THE SECOND FINDING, AND IT IS A 400 RATHER THAN AN ARGUMENT.
     *
     * «ربما يحتاج دفعة اليوم» invites the parent to act. The most obvious act
     * — make it smaller — cannot be performed on the goal that exists:
     * `UpdateRewardProgramDto` has no `targetSpec` and no `durationMinutes`,
     * and `forbidNonWhitelisted` turns the attempt into a 400 naming the
     * offending property. Asserted rather than described, and asserted for
     * BOTH fields, so that adding either one to the DTO turns this red and
     * forces the acts below to be rewritten to the better path.
     */
    it('THE FINDING — the target and the duration CANNOT be adjusted in place', async () => {
      const lighterTarget = await request(world.http)
        .patch(`${P}/reward-programs/${heavyProgramId}`)
        .set(asParent(home))
        .send({ targetSpec: { surahNumber: 67, fromAyah: 1, toAyah: 2 } });
      expect(lighterTarget.status).toBe(400);

      const shorterDuration = await request(world.http)
        .patch(`${P}/reward-programs/${heavyProgramId}`)
        .set(asParent(home))
        .send({ durationMinutes: 10 });
      expect(shorterDuration.status).toBe(400);

      // AND THE PROGRAM IS UNCHANGED IN THE TABLE — a 400 that had already
      // written half the update would be worse than the missing field.
      const [program] = await programRow(heavyProgramId);
      expect(program.duration_minutes).toBe(20);
      expect(program.target_summary_ar).toBe(heavyGoalTitle);
    });

    it('the adjustment a parent CAN make: retire the heavy goal and author a lighter one', async () => {
      const archived = await request(world.http)
        .patch(`${P}/reward-programs/${heavyProgramId}`)
        .set(asParent(home))
        .send({ status: 'ARCHIVED' });
      expect([200, 201]).toContain(archived.status);

      const lighter = await request(world.http)
        .post(`${P}/reward-programs`)
        .set(asParent(home))
        .send({ childId: home.childId, ...LIGHT_GOAL });
      expect([200, 201]).toContain(lighter.status);
      lightProgramId = lighter.body.id;

      // BOTH ROWS, READ FROM THE TABLE.
      const [heavy] = await programRow(heavyProgramId);
      expect(heavy.status).toBe('ARCHIVED');
      expect(heavy.archived_at).not.toBeNull();

      const [light] = await programRow(lightProgramId);
      expect(light.status).toBe('ACTIVE');
      expect(light.child_id).toBe(home.childId);
      // LIGHTER ON BOTH AXES, compared against the heavy row rather than
      // against a remembered literal.
      expect(light.duration_minutes).toBeLessThan(heavy.duration_minutes);
      expect(light.duration_minutes).toBe(5);
      expect(light.target_summary_ar).not.toBe(heavy.target_summary_ar);
      expect(light.target_summary_ar).toBe(
        describeTargetSpec(LIGHT_GOAL.activity, LIGHT_GOAL.targetSpec as any),
      );
    });

    it('archiving the heavy goal did not delete the evidence that it was attempted', async () => {
      // The abandoned attempt is still there, untouched: ARCHIVED, never
      // deleted, because a deleted program would orphan the history a coach
      // reasons from. The child's stalled attempt is part of that history.
      const attempts = await attemptRows();
      expect(attempts).toHaveLength(1);
      expect(attempts[0].program_id).toBe(heavyProgramId);
      expect(attempts[0].submitted_at).toBeNull();
    });

    it('adjusting the goal did not itself notify anybody — the parent acted, they do not need telling', async () => {
      await world.drainOutbox();
      expect(await countTheHousehold()).toEqual({
        decisions: 2,
        notifications: 1,
        childMessages: 0,
        deliveries: 0,
      });
    });
  });

  // =========================================================================
  // PART 5 — ACT V: THE CHILD SEES THE ADJUSTED GOAL
  // =========================================================================

  describe('ACT V — the child opens their own app and the goal has changed', () => {
    it('GET /self/achievements/today shows the LIGHTER goal, and shows it as available', async () => {
      const today = await request(world.http).get(`${P}/self/achievements/today`).set(asChild(home));
      expect(today.status).toBe(200);

      // EXACTLY ONE goal, and it is the new one: the archived program is gone
      // from the child's surface entirely rather than sitting there greyed out
      // as a record of yesterday's failure.
      expect(today.body).toHaveLength(1);
      const [goal] = today.body;
      expect(goal.id).toBe(lightProgramId);
      expect(today.body.map((p: any) => p.id)).not.toContain(heavyProgramId);

      // The numbers the child reads are the ADJUSTED ones, and they match the
      // row the parent's edit wrote.
      const [light] = await programRow(lightProgramId);
      expect(goal.durationMinutes).toBe(light.duration_minutes);
      expect(goal.targetSummaryAr).toBe(light.target_summary_ar);
      expect(goal.durationMinutes).toBe(5);

      // AND IT IS TAPPABLE. The whole point of the adjustment: the child's
      // open attempt was against the archived program, so the new one starts
      // clean rather than inheriting yesterday's block.
      expect(goal.available).toBe(true);
      expect(goal.unavailableReason).toBeNull();
    });

    it('the child can actually START the adjusted goal — the loop is open again', async () => {
      const started = await request(world.http)
        .post(`${P}/self/achievements/start`)
        .set(asChild(home))
        .send({ programId: lightProgramId });
      expect([200, 201]).toContain(started.status);

      const attempts = await attemptRows();
      expect(attempts).toHaveLength(2);
      const forLight = attempts.filter((a) => a.program_id === lightProgramId);
      expect(forLight).toHaveLength(1);
      expect(['REQUESTED', 'IN_PROGRESS']).toContain(forLight[0].status);
    });
  });

  // =========================================================================
  // PART 2 (CONTINUED) — ACT VI: THE SAME MISSED GOAL AT 22:30
  // =========================================================================

  /**
   * DECLARED LAST, AND EXECUTED LAST, ON PURPOSE. This act moves the system
   * clock into the night; every act above it depends on the family's local
   * clock reading 14:00, and an act that changed the clock in the middle would
   * make the acts after it assert something nobody chose. Its household is its
   * own for the same reason ACT II's arithmetic needed a clean history.
   */
  describe('ACT VI — quiet hours: what the engine ACTUALLY does with a missed goal at 22:30', () => {
    const nightKey = (): string => forEntity('signal', night.childId, 'night-goal', businessDate);

    it('the premise: the household is inside the default 21:00–07:00 window, and it starts silent', async () => {
      jest.setSystemTime(LATE_NIGHT);
      expect(getBusinessTimeHHMM(LATE_NIGHT, CAIRO)).toBe('22:30');
      expect(await countTheHousehold(night)).toEqual({
        decisions: 0,
        notifications: 0,
        childMessages: 0,
        deliveries: 0,
      });
    });

    /**
     * DEFER — NOT SUPPRESS, AND NOT DELIVER. Read out of the code rather than
     * assumed: `notification-class.ts:219` classifies `GOAL_STALLED_PARENT` as
     * DEFER with a written justification («the ACTION it invites — a nudge —
     * belongs to the next morning»), and the provider's `verdictFor` therefore
     * bands it on the score it WILL HAVE ON ARRIVAL rather than on the
     * penalised one (`F6-003`).
     *
     * So the stored score is BELOW the floor and the verdict is still DEFER,
     * and those two facts together are the whole of that fix. A test that
     * asserted only «DEFER» would pass against the pre-`F6-003` code too, for
     * a household with a smaller penalty; asserting the pair cannot.
     */
    it('the DECISION is DEFER, on the score it will have in the morning — not SUPPRESS', async () => {
      const result = await fire({
        familyId: night.familyId,
        childId: night.childId,
        eventType: 'GOAL_STALLED_PARENT',
        sourceEventId: nightKey(),
        trigger: 'PERIODIC_SIGNAL',
        goal: { title: 'سورة الملك', completedUnits: 0, totalUnits: 5, minutesRemaining: null },
        now: LATE_NIGHT,
      });

      expect(result.decision.verdict).toBe('DEFER');

      const [row] = await decisionRows(night);
      expect(row.decision).toBe('DEFER');
      expect(row.reason).toBe('QUIET_HOURS_ACTIVE');
      // 29.5 − 20 (quiet-hours penalty) = 9.5 -> 10, which is UNDER the floor
      // of 25 — and the verdict is DEFER anyway, because the penalty describes
      // the hour and not the fact.
      expect(Number(row.score)).toBe(10);
      expect(row.priority_band).toBe('LOW');
      assertTheArithmeticReconciles(row);

      // The reconstruction the provider itself performs: total minus the
      // quiet-hours penalty is the score on arrival, and it clears the floor.
      const quietPenalty = Number(componentMap(row).get('QUIET_HOURS_PENALTY').contribution);
      expect(quietPenalty).toBe(-20);
      expect(Number(row.score) - quietPenalty).toBeGreaterThanOrEqual(25);

      // AND THE PIPELINE AGREED — recorded beside the engine's verdict, so a
      // disagreement would be legible rather than hidden.
      expect(row.outcome).toBe('DEFER');
      expect(row.outcome_reason).toBe('QUIET_HOURS');
    });

    it('nothing was delivered at 22:30, and nothing was lost either', async () => {
      // NOT DELIVERED.
      expect(await countOf('notifications', night.familyId)).toBe(0);
      expect(await countOf('child_messages', night.familyId)).toBe(0);

      // AND NOT LOST — `PC-D-005` was the defect where DEFER wrote no row and
      // the notification simply ceased to exist. There is a durable row, held
      // for 07:00 on the FAMILY's clock rather than on UTC's.
      const deliveries = await rows(
        `SELECT * FROM "notification_deliveries" WHERE "family_id" = $1::uuid`,
        night.familyId,
      );
      expect(deliveries).toHaveLength(1);
      expect(deliveries[0].type).toBe('GOAL_STALLED_PARENT');
      expect(deliveries[0].target_audience).toBe('PARENT');
      expect(deliveries[0].state).toBe('PENDING');
      expect(deliveries[0].defer_reason).toBe('QUIET_HOURS');
      expect(deliveries[0].attempt_count).toBe(0);
      expect(getBusinessTimeHHMM(new Date(deliveries[0].scheduled_for), CAIRO)).toBe('07:00');
      // THE CAUSAL KEY, CARRIED ACROSS THE DEFERRAL — which is what makes the
      // held notification still idempotent when 07:00 comes.
      expect(deliveries[0].source_event_id).toBe(nightKey());

      // And the deferred body is the same non-punitive sentence, so a message
      // held overnight is not a different message when it lands.
      const text = `${deliveries[0].title} ${deliveries[0].body}`;
      for (const word of [...BLAME_WORDS, ...COMPARISON_WORDS, ...THREAT_WORDS]) {
        expect(text).not.toContain(word);
      }
      expect(hasEnumOrPlaceholderLeak(deliveries[0].body)).toBe(false);
    });

    it('and the night scan running twice writes nothing more — the same key, the same day', async () => {
      const before = await countTheHousehold(night);
      const replay = await fire({
        familyId: night.familyId,
        childId: night.childId,
        eventType: 'GOAL_STALLED_PARENT',
        sourceEventId: nightKey(),
        trigger: 'PERIODIC_SIGNAL',
        goal: { title: 'سورة الملك', completedUnits: 0, totalUnits: 5, minutesRemaining: null },
        now: new Date(LATE_NIGHT.getTime() + 10 * 60 * 1000),
      });
      expect(replay.decisionId).toBeNull();
      expect(await countTheHousehold(night)).toEqual(before);
      expect(await countTheHousehold(night)).toEqual({
        decisions: 1,
        notifications: 0,
        childMessages: 0,
        deliveries: 1,
      });
    });
  });
});
