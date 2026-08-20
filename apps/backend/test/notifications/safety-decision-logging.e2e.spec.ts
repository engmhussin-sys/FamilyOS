/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * ============================================================================
 * THE SAFETY ESCALATION IS IN THE DECISION LEDGER — MEASURED, NOT ASSUMED.
 * ============================================================================
 *
 * WHAT WAS MEASURED BEFORE THIS SUITE EXISTED, on real PostgreSQL, driving a
 * real distress check-in through the real HTTP route: ONE `ai_alerts` row, ONE
 * `notifications` row for the parent, and **ZERO** `notification_decisions`
 * rows. `e2e-16 ACT IV` pinned that zero deliberately and said in its own
 * docstring that the day somebody closed it, its expectation was what would tell
 * them the chain had changed. It has changed, and this file is the other half:
 * it says what the chain does NOW.
 *
 * ---------------------------------------------------------------------------
 * THE THING THIS SUITE MUST NOT LET ANYBODY BREAK WHILE FIXING IT.
 *
 * The bypass is CORRECT and it is load-bearing. A critical safety escalation
 * must never be scored, deferred, fatigue-suppressed or quiet-hours-delayed, so
 * the fix is emphatically NOT «route it through the engine to get a ledger
 * row». Every assertion below therefore comes in a pair: the row exists, AND
 * the parent was still told at the same frozen instant, with nothing held, and
 * with no deferral row anywhere.
 *
 * ---------------------------------------------------------------------------
 * EVERY MEMBER OF `ENGINE_BYPASS_ALLOWLIST`, COVERED OR EXCLUDED WITH A REASON.
 * The allow-list lives in `test/architecture/notification-engine-bypass.guard.spec.ts`
 * and has eight entries. They are not eight instances of one problem:
 *
 *   SYSTEM — «this reaches the parent WITHOUT the engine». These are the ones
 *   with the hole, and both are covered here by DRIVING them:
 *     · `ai-core/…/distress-escalation.service.ts`   ACT I–IV (the real route)
 *     · `pairing/…/runtime-alert.service.ts`         ACT V (both of its alerts)
 *
 *   TRANSACTIONAL — «below or beside the decision, never instead of it». These
 *   are EXCLUDED, and the exclusion is a conclusion rather than an omission:
 *     · `smart-notification-integration.service.ts` IS the pipeline the engine
 *       calls — the engine has already written the row before it is entered.
 *     · `prisma-runtime-alert.repository.ts` is the single writer, and is now
 *       where the receipt is written FROM; it is not a producer.
 *     · `prisma-communication.repository.ts` + `family-communication.service.ts`
 *       write `child_messages`, whose audience is CHILD; no bypass producer
 *       reaches them, and `PrismaRuntimeAlertRepository` — the only place a
 *       receipt is written — cannot see that table at all.
 *     · `quiet-hours-release.service.ts` releases a row the engine already
 *       DEFERRED and already recorded; a second row for the same cause is
 *       exactly what the ledger's unique key exists to refuse.
 *     · `life-intelligence.controller.ts` is a parent typing their own message
 *       over HTTP — a human-initiated transaction, not a notification anything
 *       decided about.
 *   ACT VI proves the first two of those exclusions are SOUND rather than
 *   merely argued: an engine-decided PARENT notification travels through the
 *   very same single writer and still ends with exactly one row, stamped
 *   `rule-based`. The receipt cannot mislabel a scored SEND.
 *
 * ---------------------------------------------------------------------------
 * THE CLOCK IS FROZEN, AND ACT II FREEZES IT AT 22:00 IN CAIRO. The quiet-hours
 * question is the whole of ACT II and it is a question about the family's LOCAL
 * time, so a suite on the wall clock would prove the property in the afternoon
 * and prove nothing at night — which is the hour the product rule was written
 * for.
 */
import request = require('supertest');

import {
  GOLDEN_DAY,
  GOLDEN_NOON,
  P,
  bootGoldenWorld,
  describeGolden,
  freezeGoldenClock,
  goldenAt,
  type GoldenHousehold,
  type GoldenWorld,
} from '../golden/golden-world';
import { runWithTenant } from '../../src/common/tenancy/tenant-context';
import { RuntimeAlertService } from '../../src/modules/pairing/application/services/runtime-alert.service';
import { SmartNotificationEngineService } from '../../src/modules/notification-engine/application/services/smart-notification-engine.service';
import {
  ENGINE_BYPASS_BAND,
  ENGINE_BYPASS_PROVENANCE,
  ENGINE_BYPASS_REASON,
  ENGINE_BYPASS_SCORE,
  ENGINE_BYPASS_TRIGGER,
  engineBypassDecision,
} from '../../src/modules/notifications/domain/engine/notification-bypass';
import { quietHoursClassOf } from '../../src/shared/notifications/notification-class';
import { DEFAULT_FATIGUE_POLICY } from '../../src/modules/life-intelligence/application/services/notification-fatigue-guard';
import { getBusinessTimeHHMM } from '../../src/common/time/family-date';

/** The type the distress escalation travels under. */
const DISTRESS_TYPE = 'CHILD_WELLBEING_CHECKIN';
/** The type `RuntimeAlertService` travels under — it names none, so the single
 * writer's own fallback applies. */
const RUNTIME_TYPE = 'RUNTIME_ALERT';

/**
 * THE CHILD'S OWN WORDS, stamped so that a match in a persisted column cannot
 * be a leftover from another suite on the same database. ACT IV asserts these
 * fragments appear in NO decision row this chain writes — the ledger is a
 * platform-operator surface and must not become the back door to a child's
 * sentence.
 */
const RUN = `${Date.now()}${Math.floor(Math.random() * 1e6)}`;
const CHILD_WORDS = `أنا تعبان جدا ولا أريد أن أعيش بعد اليوم ${RUN}`;
const CHILD_FRAGMENTS = ['أريد أن أعيش', 'تعبان', RUN];
/** The classification codes. §11.4 forbids handing anyone this product's
 * severity judgement, and the ledger is «anyone». */
const CODES = ['SELF_HARM', 'HOPELESSNESS', 'ABUSE_OR_FEAR', 'BULLYING', 'SEVERE_SADNESS'];

/** 22:00 in Africa/Cairo — asserted to be inside quiet hours from the family's
 * own timezone in ACT II rather than by arithmetic here. */
const CAIRO_NIGHT = goldenAt('19:00');

const ADMIN_KEY = process.env.INTERNAL_ADMIN_API_KEY ?? '';

describeGolden('SAFETY DECISION LOGGING — the engine bypass leaves a receipt', () => {
  let world: GoldenWorld;
  /** The household the distress chain is measured on, at noon. */
  let ESC: GoldenHousehold;
  /** A household that signals distress at 22:00 local. */
  let NIGHT: GoldenHousehold;
  /** A household whose runtime-integrity alert is driven directly. */
  let RUNTIME: GoldenHousehold;
  /** A household whose notification is decided by the ENGINE — the control. */
  let SCORED: GoldenHousehold;

  const families: string[] = [];
  const users: string[] = [];

  const asChild = (h: GoldenHousehold) => ({ Authorization: `Bearer ${h.deviceToken}` });

  const checkin = (h: GoldenHousehold, feeling: string) =>
    request(world.http).post(`${P}/self/coach/checkin`).set(asChild(h)).send({ feeling });

  const notificationsOf = (h: GoldenHousehold): Promise<any[]> =>
    world.sys('read notifications', () =>
      world.prisma.notification.findMany({
        where: { familyId: h.familyId },
        orderBy: { createdAt: 'asc' },
      }),
    );

  const decisionsOf = (h: GoldenHousehold): Promise<any[]> =>
    world.sys('read notification_decisions', () =>
      world.prisma.notificationDecision.findMany({
        where: { familyId: h.familyId },
        orderBy: { createdAt: 'asc' },
      }),
    );

  /** The DEFERRAL queue. A safety escalation must never appear in it. */
  const deliveriesOf = (h: GoldenHousehold): Promise<any[]> =>
    world.sys('read notification_deliveries', () =>
      world.prisma.notificationDelivery.findMany({ where: { familyId: h.familyId } }),
    );

  beforeAll(async () => {
    freezeGoldenClock(GOLDEN_NOON);
    world = await bootGoldenWorld('safety-decision-logging');
    ESC = await world.register('sdl-esc', { familyTimeZone: 'Africa/Cairo', childName: 'محمد' });
    RUNTIME = await world.register('sdl-rt', { familyTimeZone: 'Africa/Cairo', childName: 'سارة' });
    SCORED = await world.register('sdl-eng', { familyTimeZone: 'Africa/Cairo', childName: 'أنس' });
    /**
     * REGISTERED AT NIGHT, for `e2e-16`'s reason: `TokenService` mints a
     * short-lived access token against a frozen clock, so a device paired at
     * noon holds a token that the real `DeviceJwtAuthGuard` answers 401 to at
     * 22:00 — and the suite would be measuring token lifetime instead of quiet
     * hours.
     */
    jest.setSystemTime(CAIRO_NIGHT);
    NIGHT = await world.register('sdl-night', { familyTimeZone: 'Africa/Cairo', childName: 'ليان' });
    jest.setSystemTime(GOLDEN_NOON);

    for (const h of [ESC, NIGHT, RUNTIME, SCORED]) {
      families.push(h.familyId);
      users.push(h.ownerUserId);
    }
  }, 300_000);

  afterAll(async () => {
    if (world) {
      await world.sys('teardown', async () => {
        const where = { where: { familyId: { in: families } } };
        await world.prisma.growthAlert.deleteMany(where);
        await world.prisma.aiAlert.deleteMany(where);
        await world.prisma.aiMemoryEntry.deleteMany(where);
        await world.prisma.notificationDecision.deleteMany(where);
        await world.prisma.notificationDelivery.deleteMany(where);
        await world.prisma.notification.deleteMany(where);
        await world.prisma.childMessage.deleteMany(where);
        await world.prisma.family.deleteMany({ where: { id: { in: families } } });
        await world.prisma.user.deleteMany({ where: { id: { in: users } } });
      });
      await world.close();
    }
    jest.useRealTimers();
  }, 120_000);

  beforeEach(() => {
    jest.setSystemTime(GOLDEN_NOON);
  });

  // =======================================================================
  // ACT 0 — THE PREMISES
  // =======================================================================

  it('every household starts with an empty ledger — nothing here inherits a previous run', async () => {
    for (const h of [ESC, NIGHT, RUNTIME, SCORED]) {
      expect(await decisionsOf(h)).toHaveLength(0);
      expect(await notificationsOf(h)).toHaveLength(0);
    }
  });

  it('the bypass row shape is a pure value, and it carries no arithmetic', () => {
    // Asserted on the FUNCTION as well as on the row, so the reason a column
    // holds what it holds is pinned where the argument for it lives.
    const d = engineBypassDecision({ notificationType: DISTRESS_TYPE, priority: 'CRITICAL' });
    expect(d.providerId).toBe(ENGINE_BYPASS_PROVENANCE);
    expect(d.verdict).toBe('SEND');
    expect(d.band).toBe(ENGINE_BYPASS_BAND);
    expect(d.reason).toBe(ENGINE_BYPASS_REASON);
    expect(d.trigger).toBe(ENGINE_BYPASS_TRIGGER);
    expect(d.score).toBe(ENGINE_BYPASS_SCORE);
    expect(d.targetAudience).toBe('PARENT');
    // THE PROOF THAT NOTHING WAS WEIGHED. An empty explanation is not a missing
    // value: it is the statement that no term was ever scored, and it is what
    // stops `score` being read as the output of a calculation.
    expect(d.components).toEqual([]);
    // The SAME category the engine would have written, from the same map.
    expect(d.category).toBe('SAFETY');
  });

  // =======================================================================
  // ACT I — ONE ROW, WITH BYPASS PROVENANCE, AND THE PARENT STILL TOLD
  // =======================================================================

  it('a real distress check-in writes EXACTLY ONE decision row, and the parent is told at the same instant', async () => {
    const res = await checkin(ESC, CHILD_WORDS);
    expect(res.status).toBe(201);
    expect(res.body.escalated).toBe(true);

    const notifications = await notificationsOf(ESC);
    const decisions = await decisionsOf(ESC);

    // BOTH HALVES, TOGETHER. A row in the ledger is worth nothing if the price
    // was the notification, so the parent's row is asserted in the same breath.
    expect(notifications).toHaveLength(1);
    expect(decisions).toHaveLength(1);

    /**
     * AT THE SAME INSTANT — not «eventually», and asserted against the FROZEN
     * CLOCK rather than against the other row.
     *
     * THE TWO COLUMNS DO NOT SHARE A CLOCK, and that is a fact about the
     * infrastructure rather than about this change: `notifications.created_at`
     * is Prisma's `@default(now())`, evaluated in THIS process and therefore
     * fake-timed, while `notification_decisions.created_at` is PostgreSQL's own
     * `now()`, reached through raw SQL and therefore real. Comparing them to
     * each other would measure the difference between the two clocks. So the
     * notification — the row the parent's phone reads — is pinned to the exact
     * instant the check-in happened, and the receipt is pinned to the family's
     * business date instead (below, and in ACT II where it matters most).
     */
    expect(notifications[0].createdAt).toEqual(GOLDEN_NOON);
    expect(new Date(decisions[0].businessDate).toISOString().slice(0, 10)).toBe(GOLDEN_DAY);

    // AND THEY ARE THE SAME EVENT: joined on the causal key, which is the only
    // thing that ties a decision to its notification.
    expect(decisions[0].sourceEventId).toBe(notifications[0].sourceEventId);
    expect(notifications[0].userId).toBe(ESC.ownerUserId);
  });

  it('the row says BYPASS at a glance — provenance, verdict, reason, and an empty explanation', async () => {
    const [row] = await decisionsOf(ESC);

    // THE DISCRIMINATOR AN OPERATOR SEES WITHOUT READING A SECOND COLUMN.
    // `provider_id` is the PROVENANCE dimension of the breakdown endpoint, so
    // this value is what separates a bypass from a scored SEND in a table.
    expect(row.providerId).toBe(ENGINE_BYPASS_PROVENANCE);
    expect(row.providerId).not.toBe('rule-based-v1');

    // WHAT HAPPENED: it was sent.
    expect(row.decision).toBe('SEND');
    expect(row.outcome).toBe('SEND');
    expect(row.outcomeReason).toBeNull();

    // WHY: the same word `RuleBasedNotificationDecisionProvider`'s own override
    // branch writes for the same class of notification. One vocabulary, so the
    // ledger can be grouped on it.
    expect(row.reason).toBe('SAFETY_CRITICAL_OVERRIDE');
    expect(row.priorityBand).toBe('HIGH');
    expect(row.trigger).toBe('SAFETY_SIGNAL');

    // NOTHING WAS SCORED, and this is where that is legible.
    expect(row.explanation).toEqual([]);
    expect(row.score).toBe(ENGINE_BYPASS_SCORE);

    // THE COLUMNS THAT MEAN WHAT THEY MEAN ON THE ENGINE'S PATH, unchanged.
    expect(row.notificationType).toBe(DISTRESS_TYPE);
    expect(row.category).toBe('SAFETY');
    expect(row.targetAudience).toBe('PARENT');
    expect(row.copyKey).toBe(DISTRESS_TYPE);
    expect(row.childId).toBe(ESC.childId);

    // NO MODEL PARTICIPATED AND NONE COULD HAVE — §11.4's first sentence, as a
    // persisted fact rather than as a comment.
    expect(row.aiRewritten).toBe(false);
    expect(row.aiFailed).toBe(false);
    expect(row.aiAllowed).toBe(false);
    expect(row.aiInvoked).toBe(false);
    expect(row.aiSafetyRejection).toBeNull();

    // THE ANALYTICS AXES ARE REAL, not nulled out: a bypass row that dropped
    // out of an age-band-filtered dashboard would be half-visible, which is the
    // failure mode this whole change exists to remove. The child registered by
    // `golden-world` is twelve.
    expect(row.ageBand).not.toBeNull();
    expect(typeof row.locale).toBe('string');
  });

  it('and the household can read it back on its own surface — the parent’s «why» question, answerable', async () => {
    const res = await request(world.http)
      .get(`${P}/notifications/decisions`)
      .set({ Authorization: `Bearer ${ESC.parentToken}` });
    expect(res.status).toBe(200);
    const rows: any[] = res.body;
    expect(Array.isArray(rows)).toBe(true);
    const mine = rows.filter((r) => r.notificationType === DISTRESS_TYPE);
    expect(mine).toHaveLength(1);
    expect(mine[0].providerId).toBe(ENGINE_BYPASS_PROVENANCE);
  });

  // =======================================================================
  // ACT II — FROZEN INSIDE QUIET HOURS
  // =======================================================================

  it('the clock really is inside the family’s quiet hours — the premise, not an assumption', () => {
    jest.setSystemTime(CAIRO_NIGHT);
    const local = getBusinessTimeHHMM(CAIRO_NIGHT, 'Africa/Cairo');
    expect(local).toBe('22:00');
    expect(DEFAULT_FATIGUE_POLICY.quietHoursStart).toBe('21:00');
    expect(local >= DEFAULT_FATIGUE_POLICY.quietHoursStart).toBe(true);
    // And the type really is the one the matrix says outranks the night.
    expect(quietHoursClassOf(DISTRESS_TYPE, 'CRITICAL')).toBe('DELIVER');
  });

  it('AT 22:00 LOCAL: still delivered, still exactly one row, and NOTHING was held', async () => {
    jest.setSystemTime(CAIRO_NIGHT);

    const res = await checkin(NIGHT, CHILD_WORDS);
    expect(res.status).toBe(201);
    expect(res.body.escalated).toBe(true);

    const notifications = await notificationsOf(NIGHT);
    const decisions = await decisionsOf(NIGHT);
    expect(notifications).toHaveLength(1);
    expect(decisions).toHaveLength(1);
    // THE PARENT WAS TOLD NOW — 22:00, not 07:00 the next morning. The
    // notification row carries the frozen instant itself.
    expect(notifications[0].createdAt).toEqual(CAIRO_NIGHT);
    // And the receipt is stamped with the HOUSEHOLD's day, derived from that
    // same frozen instant through the family's own timezone. (Its `created_at`
    // is PostgreSQL's clock, which fake timers do not reach — see ACT I.)
    expect(new Date(decisions[0].businessDate).toISOString().slice(0, 10)).toBe(GOLDEN_DAY);

    // AND NOTHING WAS DEFERRED. `notification_deliveries` is the queue a held
    // notification waits in; an empty one is the strongest statement that quiet
    // hours did not touch this.
    expect(await deliveriesOf(NIGHT)).toHaveLength(0);
  });

  it('and the row SAYS why it was not deferred — in the ledger, not only in a log line', async () => {
    const [row] = await decisionsOf(NIGHT);

    // `SAFETY_CRITICAL_OVERRIDE` is the stored form of «this outranks the
    // night». It is the same word the engine's own DELIVER-class branch writes,
    // so «why was this not deferred» has ONE answer across both paths.
    expect(row.reason).toBe('SAFETY_CRITICAL_OVERRIDE');
    expect(row.decision).toBe('SEND');
    // NOT `DEFER`, and no quiet-hours outcome reason — the two ways this row
    // could have recorded a delay, both absent.
    expect(row.decision).not.toBe('DEFER');
    expect(row.outcome).toBe('SEND');
    expect(row.outcomeReason).toBeNull();
    // THE BUSINESS DATE IS THE HOUSEHOLD'S, NOT UTC'S. 19:00 UTC is 22:00 in
    // Cairo — still the SAME calendar day there — and the ledger has to agree
    // with the alert's own dedupe key, which buckets by that family's date.
    expect(new Date(row.businessDate).toISOString().slice(0, 10)).toBe(GOLDEN_DAY);
  });

  // =======================================================================
  // ACT III — REPLAY, PROVED BY REPLAYING
  // =======================================================================

  it('replaying the identical escalation produces NO second row — and the first row is untouched', async () => {
    const before = await decisionsOf(ESC);
    expect(before).toHaveLength(1);

    // THREE more times, through the real HTTP route, at the same frozen
    // instant. Not «the code takes the dedupe branch» — the actual input,
    // actually replayed.
    for (let i = 0; i < 3; i += 1) {
      const replay = await checkin(ESC, CHILD_WORDS);
      expect(replay.status).toBe(201);
      expect(replay.body.escalated).toBe(true);
    }

    const after = await decisionsOf(ESC);
    expect(after).toHaveLength(1);
    // THE SAME ROW, not merely the same count — a delete-and-rewrite would pass
    // a count assertion and lose the original `created_at`.
    expect(after[0].id).toBe(before[0].id);
    expect(after[0].createdAt).toEqual(before[0].createdAt);
    expect(after[0].outcome).toBe(before[0].outcome);
  });

  it('the refusal is held by a DATABASE UNIQUE CONSTRAINT, not by a read-before-write', async () => {
    const indexes: any[] = await world.raw(
      `SELECT indexdef::text AS indexdef FROM pg_indexes
        WHERE tablename = 'notification_decisions' AND indexdef ILIKE '%UNIQUE%'`,
    );
    const defs = indexes.map((i) => String(i.indexdef).toLowerCase());
    expect(
      defs.some(
        (d) =>
          d.includes('family_id') && d.includes('source_event_id') && d.includes('target_audience'),
      ),
    ).toBe(true);

    // AND NO CODE PATH READS THE LEDGER BEFORE WRITING TO IT. The recorder is
    // the only new writer and it holds no SELECT at all — asserted on the
    // source, because «we did not add a check-then-insert» is a property of the
    // file rather than of a run.
    const fs = require('fs');
    const path = require('path');
    const source: string = fs.readFileSync(
      path.resolve(
        __dirname,
        '../../src/modules/notifications/application/services/engine-bypass-decision.recorder.ts',
      ),
      'utf8',
    );
    // Comments name the forbidden thing while explaining why it is forbidden,
    // so prose is stripped before the code is searched.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    // The recorder may read the analytics AXES (a country, a date of birth); it
    // must never read the LEDGER, which is the table its idempotency is about.
    expect(code).not.toMatch(/notificationDecision/);
    expect(code).not.toMatch(/notification_decisions/);
    expect(code).not.toMatch(/SQL_LIST_DECISIONS/);
  });

  // =======================================================================
  // ACT IV — THE LEDGER IS NOT A BACK DOOR TO THE CHILD'S WORDS
  // =======================================================================

  it('NO decision row this chain wrote contains the child’s sentence, a fragment of it, or a code', async () => {
    const rows = [...(await decisionsOf(ESC)), ...(await decisionsOf(NIGHT))];
    expect(rows.length).toBeGreaterThanOrEqual(2);

    // THE PERSISTED VALUES, serialised whole — every column, not the three a
    // reviewer thought to check. `notification_decisions` holds no title and no
    // body at all by design, and this is the assertion that keeps it that way.
    const serialised = JSON.stringify(rows);
    for (const fragment of CHILD_FRAGMENTS) expect(serialised).not.toContain(fragment);
    // The severity judgement is not the child's words but it is the product's
    // opinion about them, and §11.4 forbids handing it to anyone.
    for (const code of CODES) expect(serialised).not.toContain(code);
    // The child's own name is not in the ledger either: the sentence that names
    // them lives in `notifications.body`, under the household's tenancy.
    expect(serialised).not.toContain(ESC.childName);
  });

  // =======================================================================
  // ACT V — THE OTHER SYSTEM MEMBER OF THE ALLOW-LIST
  // =======================================================================

  it('the device runtime-integrity alert — the SECOND SYSTEM bypass — also leaves a receipt', async () => {
    const alerts = world.app.get(RuntimeAlertService);

    // DRIVEN THROUGH THE REAL SERVICE, in a real tenant context — the same
    // call `PairingOrchestratorService.recordHeartbeat` makes when a device
    // reports its Accessibility Service has just been switched off.
    await runWithTenant(
      { familyId: RUNTIME.familyId, actorType: 'SYSTEM', actorId: 'safety-decision-logging' },
      () =>
        alerts.evaluateTransition({
          familyId: RUNTIME.familyId,
          childId: RUNTIME.childId,
          previousAccessibilityEnabled: true,
          currentAccessibilityEnabled: false,
        }),
    );

    const notifications = await notificationsOf(RUNTIME);
    const decisions = await decisionsOf(RUNTIME);
    expect(notifications).toHaveLength(1);
    expect(decisions).toHaveLength(1);

    const [row] = decisions;
    expect(row.providerId).toBe(ENGINE_BYPASS_PROVENANCE);
    expect(row.notificationType).toBe(RUNTIME_TYPE);
    expect(row.decision).toBe('SEND');
    expect(row.outcome).toBe('SEND');
    expect(row.reason).toBe('SAFETY_CRITICAL_OVERRIDE');
    expect(row.explanation).toEqual([]);
    expect(row.sourceEventId).toBe(notifications[0].sourceEventId);
  });

  it('and its SECOND alert — a revoked device — is recorded too, as its own cause', async () => {
    const alerts = world.app.get(RuntimeAlertService);

    await runWithTenant(
      { familyId: RUNTIME.familyId, actorType: 'SYSTEM', actorId: 'safety-decision-logging' },
      () =>
        alerts.deviceRevoked({
          familyId: RUNTIME.familyId,
          childId: RUNTIME.childId,
          deviceId: RUNTIME.deviceId,
          reason: 'PARENT_UNLINKED',
        }),
    );

    const decisions = await decisionsOf(RUNTIME);
    // TWO CAUSES, TWO ROWS. `forEntity` and `forRecurringSignal` produce
    // different causal keys, so the ledger's unique key correctly lets both
    // through — «one row per cause», not «one row per type».
    expect(decisions).toHaveLength(2);
    expect(new Set(decisions.map((d) => d.providerId))).toEqual(
      new Set([ENGINE_BYPASS_PROVENANCE]),
    );
    expect(new Set(decisions.map((d) => d.sourceEventId)).size).toBe(2);
  });

  // =======================================================================
  // ACT VI — THE CONTROL: A SCORED SEND IS NOT MISLABELLED
  // =======================================================================

  it('an ENGINE-decided parent notification still gets exactly ONE row, and it is NOT a bypass', async () => {
    const engine = world.app.get(SmartNotificationEngineService);

    const result = await runWithTenant(
      { familyId: SCORED.familyId, actorType: 'SYSTEM', actorId: 'safety-decision-logging' },
      () =>
        engine.handleEvent({
          familyId: SCORED.familyId,
          childId: SCORED.childId,
          eventType: 'SCREEN_TIME_EXCEEDED',
          sourceEventId: `signal:${RUN}:sdl-scored`,
          trigger: 'PERIODIC_SIGNAL',
          now: GOLDEN_NOON,
        }),
    );

    // THE PREMISE: the engine really did send, so this control is not vacuous.
    // A SUPPRESS here would never have reached the single writer and would
    // prove nothing about mislabelling.
    expect(result.decision.verdict).toBe('SEND');
    expect(result.outcome?.decision).toBe('SEND');

    const decisions = await decisionsOf(SCORED);
    expect(decisions).toHaveLength(1);
    // THE POINT: the receipt is written unconditionally at the single writer,
    // and it did NOT produce a second, bypass-labelled row for a notification
    // the engine had already recorded. The DATABASE refused it — the same
    // unique key ACT III proved — and no flag in application code was involved.
    expect(decisions[0].providerId).toBe('rule-based');
    expect(decisions[0].providerId).not.toBe(ENGINE_BYPASS_PROVENANCE);
    // The engine's own arithmetic survived, which is what would have been lost
    // had the bypass row overwritten it.
    expect(Array.isArray(decisions[0].explanation)).toBe(true);
    expect((decisions[0].explanation as any[]).length).toBeGreaterThan(0);
  });

  // =======================================================================
  // ACT VII — THE OPERATOR SURFACES, WHICH IS WHERE THE GAP WAS FELT
  // =======================================================================

  it('the platform roll-up COUNTS the bypass, and names how much of its denominator it is', async () => {
    if (!ADMIN_KEY) throw new Error('INTERNAL_ADMIN_API_KEY must be set for this assertion');
    const today = new Date(GOLDEN_NOON).toISOString().slice(0, 10);
    const from = new Date(GOLDEN_NOON.getTime() - 3 * 86_400_000).toISOString().slice(0, 10);

    const res = await request(world.http)
      .get(`${P}/system/notifications/analytics?from=${from}&to=${today}`)
      .set('x-internal-admin-key', ADMIN_KEY);
    expect(res.status).toBe(200);

    // The escalations this suite wrote are IN the population — which is the
    // whole point, and was a zero before this change.
    expect(res.body.bypassed).toBeGreaterThanOrEqual(3);
    expect(res.body.total).toBeGreaterThanOrEqual(res.body.bypassed);
    // AND THE ANSWER IS EXPLICIT: an operator reading `suppressionRate` can see,
    // on the same object, how much of its denominator was never eligible for
    // suppression. `bypassed` is a COUNT and deliberately not a sixth rate.
    expect(typeof res.body.suppressionRate).toBe('number');
    // Still counts only — no identity leaves this route.
    const serialised = JSON.stringify(res.body);
    for (const id of families) expect(serialised).not.toContain(id);
  });

  it('the operator breakdown gives the bypass its OWN provenance bucket, subtractable from the total', async () => {
    if (!ADMIN_KEY) throw new Error('INTERNAL_ADMIN_API_KEY must be set for this assertion');
    const today = new Date(GOLDEN_NOON).toISOString().slice(0, 10);
    const from = new Date(GOLDEN_NOON.getTime() - 3 * 86_400_000).toISOString().slice(0, 10);

    const res = await request(world.http)
      .get(`${P}/system/notifications/decision-breakdown?from=${from}&to=${today}`)
      .set('x-internal-admin-key', ADMIN_KEY);
    expect(res.status).toBe(200);

    const bucket = (res.body.byProvenance as any[]).find(
      (b) => b.bucket === ENGINE_BYPASS_PROVENANCE,
    );
    expect(bucket).toBeDefined();
    expect(bucket.total).toBeGreaterThanOrEqual(3);
    // A bypass is a SEND and never anything else, which is what makes the
    // bucket subtractable from a suppression count without further thought.
    expect(bucket.decidedSuppress).toBe(0);
    expect(bucket.decidedDefer).toBe(0);
    expect(bucket.decidedSend).toBe(bucket.total);
    // THE SHAPE IS UNCHANGED — the breakdown answers this with a dimension it
    // already had, and gained no field.
    expect(Object.keys(bucket).sort()).toEqual(
      [
        'bucket',
        'decidedDefer',
        'decidedSend',
        'decidedSuppress',
        'delivered',
        'deliveryErrors',
        'total',
      ].sort(),
    );
  });
});
