/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-var-requires */
/**
 * ============================================================================
 * ENGINE QUALITY — THE SIX INVARIANTS, AGAINST A REAL POSTGRESQL AND A REAL APP.
 * ============================================================================
 *
 * WHAT THIS SUITE IS FOR, AND WHY IT IS NOT A SECOND COPY OF
 * `smart-notification-engine.e2e.spec.ts`. That suite proves the PIPELINE is
 * wired: one event becomes one row, a retry becomes none, a child event reaches
 * `child_messages`. This one asks the question after that — «is what the
 * pipeline produced any GOOD?» — and the answers it demands are:
 *
 *   1. THE SAME EVENT, REPLAYED, IS ONE NOTIFICATION. Proved by REPLAYING it:
 *      the real consumer, the real envelope, twice — and then a third time with
 *      the consumer's own idempotency marker DELETED, so the work actually runs
 *      again and the DATABASE has to be the thing that refuses.
 *   2. DIFFERENT EVENTS ARE DIFFERENT NOTIFICATIONS, in the `copy_key` the
 *      decision row records AND in the Arabic sentence the reader gets. An
 *      engine that sends one generic line for every occurrence is a broadcast,
 *      not a coach, and `copy_key` alone would not catch it — two keys can
 *      render the same string.
 *   3. THE CHILD AND THE PARENT ARE TOLD DIFFERENT THINGS about ONE occurrence,
 *      each in their own register.
 *   4. QUIET HOURS DEFER, AND MIDDAY DOES NOT. Both outcomes, both asserted,
 *      from the same producer with the same facts and nothing different but the
 *      instant.
 *   5. A SAFETY NOTIFICATION BYPASSES SUPPRESSION WHERE THE RULES SAY IT DOES —
 *      and the rules were read first. See §5's header for exactly which rule is
 *      asserted and which one is NOT.
 *   6. A DECISION-LOG ROW EXISTS FOR EVERY PRODUCTION NOTIFICATION and carries
 *      the thirteen things an operator needs. This suite opened three findings
 *      against that list and two of them have since been CLOSED BY A FIX rather
 *      than by an edit here — the cooldown is enforced (§6.10, §6.11) and AI
 *      rewriting is observable (§6.14) — so those assertions now measure the
 *      fix in the same experiment that measured the defect. ONE remains open:
 *      CHANNEL has no column and no value anywhere, and §6.13 keeps it named
 *      rather than inventing a column to assert against.
 *
 * ---------------------------------------------------------------------------
 * THE CLOCK IS FROZEN, AND THAT IS LOAD-BEARING RATHER THAN TIDY.
 *
 * `NotificationRewardConsumer` and `RewardsEngineService` pass NO instant to the
 * notification door, so `NotificationContextAssembler` falls to
 * `input.now ?? new Date()` — THE WALL CLOCK. A quiet-hours assertion written
 * without a frozen clock therefore passes by day and fails by night, gets
 * re-run in the morning, and passes; that has happened in this directory
 * before. `freezeGoldenClock` fakes `Date` ONLY — every timer stays real,
 * because the PostgreSQL driver needs working ones — and the suite then MOVES
 * the frozen clock deliberately, to named instants, with `atInstant`.
 *
 * AND THE INSTANTS ARE IN JANUARY. Africa/Cairo and Asia/Riyadh are BOTH UTC+3
 * in August, so a timezone assertion written in August asserts nothing. In
 * January they are UTC+2 and UTC+3 and the two households genuinely differ.
 *
 * ---------------------------------------------------------------------------
 * ONE HOUSEHOLD PER SCENARIO, AND THAT IS NOT ISOLATION HYGIENE — IT IS THE
 * FATIGUE POLICY. `DEFAULT_NOTIFICATION_POLICY` allows six notifications a day,
 * two of any one TYPE, three an hour, and none within thirty minutes of the
 * last of its type. Two scenarios sharing a household would be two scenarios
 * sharing a budget, and the second would fail for a reason the first caused.
 * Where a scenario genuinely needs several notifications to one child — §7's
 * anti-genericness proof — they are spaced across THREE DAYS, which is what the
 * policy is for.
 */
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'crypto';

import { AppModule } from '../../src/app.module';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { createTenantExtension } from '../../src/common/tenancy/tenant.extension';
import { runAsSystemAsync } from '../../src/common/tenancy/system-context';
import { runWithTenant } from '../../src/common/tenancy/tenant-context';
import { getBusinessDate, getBusinessTimeHHMM } from '../../src/common/time/family-date';
import { AI_PROVIDER, type IAIProvider } from '../../src/modules/ai-core/domain/ai-provider.port';
import { ChildSafetyFilterService } from '../../src/modules/ai-core/application/services/child-safety-filter.service';
import { ageBandFor } from '../../src/modules/ai-core/domain/age-band';
import { NotificationRewardConsumer } from '../../src/modules/events/application/consumers/notification-reward.consumer';
import { DigitalWellbeingEngineService } from '../../src/modules/life-intelligence/application/services/digital-wellbeing-engine.service';
import { SmartNotificationEngineService } from '../../src/modules/notification-engine/application/services/smart-notification-engine.service';
import { COPY_CATALOGUE, GENERIC_COPY_KEY } from '../../src/modules/notifications/domain/engine/notification-copy';
import {
  isValidDeepLink,
  resolveNotificationDestination,
} from '../../src/modules/notifications/domain/engine/notification-destination';
import { DEFAULT_NOTIFICATION_POLICY } from '../../src/modules/notifications/domain/engine/notification-policy';
import {
  NOTIFICATION_DECISION_REASONS,
  NOTIFICATION_SCORE_COMPONENTS,
  NOTIFICATION_TRIGGERS,
} from '../../src/modules/notifications/domain/engine/notification-decision.types';
import {
  NOTIFICATION_CLASSES,
  quietHoursClassOf,
} from '../../src/shared/notifications/notification-class';
import { freezeGoldenClock } from '../golden/golden-world';
import { integrationDatabaseUrl } from '../tenancy/prisma-test-client';

const describeIfDb = integrationDatabaseUrl() ? describe : describe.skip;

const CAIRO = 'Africa/Cairo';
const RIYADH = 'Asia/Riyadh';

/**
 * THE INSTANTS, ALL IN JANUARY (see the header) AND ALL NAMED BY WHAT THEY MEAN
 * ON A HOUSEHOLD'S OWN CLOCK RATHER THAN BY THEIR UTC OFFSET.
 *
 * `MIDDAY` is on a five-minute boundary on purpose: `forRecurringSignal` buckets
 * a causal key by `floor(epochMs / 5min)`, so §5's duplicate and cooldown proofs
 * need to know exactly where the bucket edges are.
 */
const MIDDAY = new Date('2026-01-15T10:00:00.000Z'); // 12:00 Cairo · 13:00 Riyadh
const DEEP_NIGHT = new Date('2026-01-15T19:30:00.000Z'); // 21:30 Cairo — inside quiet hours
const MINUTE = 60_000;

/** Three achievements, three days apart, for §7. 25 hours between each, so the
 * 24-hour fatigue history window is genuinely empty at every one of them. */
const DAY_1 = new Date('2026-01-15T10:00:00.000Z'); // 12:00 Cairo
const DAY_2 = new Date('2026-01-16T11:00:00.000Z'); // 13:00 Cairo
const DAY_3 = new Date('2026-01-17T12:00:00.000Z'); // 14:00 Cairo

/**
 * THE INSTANT THE CLOCK IS FROZEN TO AT BOOT — MIDDAY unless a run says
 * otherwise. It exists so this suite can be RUN AGAINST A QUIET-HOURS INSTANT
 * and prove that nothing in it depends on the ambient one: every section that
 * cares pins its own instant with `atInstant`, and a CI job that happens to
 * start at 23:00 must produce byte-identical outcomes to one that starts at
 * noon. That is the property, and a knob is the only way to demonstrate it
 * without moving the machine's clock out from under PostgreSQL.
 *
 *     ENGINE_QUALITY_BOOT_INSTANT=2026-01-15T19:30:00.000Z npx jest ...
 */
const BOOT_INSTANT = process.env.ENGINE_QUALITY_BOOT_INSTANT
  ? new Date(process.env.ENGINE_QUALITY_BOOT_INSTANT)
  : MIDDAY;

const QUIET_START = DEFAULT_NOTIFICATION_POLICY.quietHoursStart;
const QUIET_END = DEFAULT_NOTIFICATION_POLICY.quietHoursEnd;

const ARABIC_LETTER = /[؀-ۿ]/;
const LATIN_DIGIT = /[0-9]/;
const ENUM_TOKEN = /(?:^|[\s(])[A-Z][A-Z0-9]*_[A-Z0-9_]+/;

/** The generic sentence, read from the catalogue rather than quoted, so a
 * reworded fallback does not silently stop being detected. */
const GENERIC_PARENT_BODY = COPY_CATALOGUE[GENERIC_COPY_KEY].variants.PARENT?.ar.body as string;

/**
 * A CONTROLLABLE AI. `mode` is flipped per test, and `calls` is what makes §6's
 * second finding provable: it is the only way to know whether the model was
 * INVOKED, because the persisted row cannot say.
 */
const aiStub: { mode: 'ok' | 'rejected'; calls: number; provider: IAIProvider } = {
  mode: 'ok',
  calls: 0,
  provider: {
    async complete() {
      aiStub.calls += 1;
      // A rewrite that leaks a raw backend enum — one of the six failure modes
      // `NotificationComposerService`'s own header lists, refused by
      // `hasEnumOrPlaceholderLeak` for BOTH audiences, so the rejection is
      // deterministic rather than a function of which safety service ran.
      if (aiStub.mode === 'rejected') return 'صياغة بديلة REWARD_GRANTED_CHILD من النموذج';
      return 'صياغة بديلة من النموذج لهذا الإشعار';
    },
  },
};

function offlinePrismaService(): any {
  const url = process.env.INTEGRATION_DATABASE_URL as string;
  if (process.env.PRISMA_DRIVER_ADAPTER === 'pg') {
    const { PrismaClient } = require('@prisma/client');
    const { PrismaPg } = require('@prisma/adapter-pg');
    const { Pool } = require('pg');
    const pool = new Pool({ connectionString: url });
    const base = new PrismaClient({ adapter: new PrismaPg(pool) });
    const extended = base.$extends(createTenantExtension());
    extended.onModuleInit = async () => undefined;
    extended.onModuleDestroy = async () => {
      await base.$disconnect();
      await pool.end();
    };
    return extended;
  }
  const { PrismaClient } = require('@prisma/client');
  const base = new PrismaClient({
    // PRISMA 7: `datasources` was removed from the constructor — driver
    // adapters are the only mode, so the adapter IS the connection. This
    // branch used to exist to AVOID the adapter; it now builds the same
    // client the branch above does, which is the honest end state: a test
    // must not reach the database through a different engine than
    // production does.
    adapter: new (require('@prisma/adapter-pg').PrismaPg)(
      new (require('pg').Pool)({ connectionString: url }),
    ),
  });
  const extended = base.$extends(createTenantExtension());
  extended.onModuleInit = async () => base.$connect();
  extended.onModuleDestroy = async () => base.$disconnect();
  return extended;
}

interface Household {
  readonly familyId: string;
  readonly childId: string;
  readonly userId: string;
  readonly timeZone: string;
}

describeIfDb('ENGINE QUALITY — the six invariants (real PostgreSQL, real app, frozen clock)', () => {
  let app: INestApplication;
  let prisma: any;
  let engine: SmartNotificationEngineService;
  let rewardConsumer: NotificationRewardConsumer;
  let wellbeing: DigitalWellbeingEngineService;
  let childSafety: ChildSafetyFilterService;
  let bootReading = '';

  const stamp = Date.now();
  const createdFamilies: string[] = [];
  const createdUsers: string[] = [];

  const sys = (what: string, fn: () => Promise<any>): Promise<any> =>
    runAsSystemAsync('TEST_FIXTURE', `engine-quality: ${what}`, async () => await fn());

  const raw = <T>(sql: string, ...params: unknown[]): Promise<T> =>
    sys('raw sql', () => prisma.$queryRawUnsafe(sql, ...params)) as Promise<T>;

  const notificationRows = (familyId: string): Promise<any[]> =>
    raw<any[]>(
      `SELECT * FROM "notifications" WHERE "family_id" = $1::uuid ORDER BY "created_at", "id"`,
      familyId,
    );

  const childMessageRows = (familyId: string): Promise<any[]> =>
    raw<any[]>(
      `SELECT * FROM "child_messages" WHERE "family_id" = $1::uuid ORDER BY "created_at", "id"`,
      familyId,
    );

  const decisionRows = (familyId: string): Promise<any[]> =>
    raw<any[]>(
      `SELECT * FROM "notification_decisions" WHERE "family_id" = $1::uuid ORDER BY "created_at", "id"`,
      familyId,
    );

  const deferredRows = (familyId: string): Promise<any[]> =>
    raw<any[]>(
      `SELECT * FROM "notification_deliveries" WHERE "family_id" = $1::uuid ORDER BY "created_at", "id"`,
      familyId,
    );

  const consumedRows = (familyId: string): Promise<any[]> =>
    raw<any[]>(`SELECT * FROM "consumed_messages" WHERE "family_id" = $1::uuid`, familyId);

  /** Every column the decision ledger actually has, read from PostgreSQL rather
   * than from the Prisma schema — §6 reports on the DATABASE. */
  const decisionColumns = async (): Promise<string[]> => {
    const rows = await raw<Array<{ column_name: string }>>(
      `SELECT column_name::text AS column_name FROM information_schema.columns WHERE table_name = 'notification_decisions'`,
    );
    return rows.map((r) => r.column_name).sort();
  };

  const jsonOf = (value: unknown): any =>
    typeof value === 'string' ? JSON.parse(value) : (value as any);

  /** MOVE THE FROZEN CLOCK. Not `useFakeTimers` again — the freeze is
   * established once in `beforeAll`, and this only says which instant it reads. */
  const atInstant = (instant: Date): void => {
    jest.setSystemTime(instant);
  };

  async function createHousehold(label: string, timeZone = CAIRO, dob = '2013-06-01'): Promise<Household> {
    const family = await sys('create family', () =>
      prisma.family.create({ data: { name: `EQ ${label} ${stamp}`, timezone: timeZone }, select: { id: true } }),
    );
    createdFamilies.push(family.id);

    const user = await sys('create user', () =>
      prisma.user.create({
        data: {
          email: `eq.${label}.${stamp}@example.test`,
          passwordHash: 'x',
          fullName: 'EQ Parent',
          locale: 'ar',
        },
        select: { id: true },
      }),
    );
    createdUsers.push(user.id);
    await sys('create membership', () =>
      prisma.familyMember.create({ data: { familyId: family.id, userId: user.id, role: 'OWNER' } }),
    );

    const child = await sys('create child', () =>
      prisma.child.create({
        data: {
          familyId: family.id,
          firstName: 'محمد',
          dateOfBirth: new Date(`${dob}T00:00:00.000Z`),
        },
        select: { id: true },
      }),
    );
    return { familyId: family.id, childId: child.id, userId: user.id, timeZone };
  }

  /**
   * A REAL `REWARD_GRANTED` ENVELOPE, in the shape `RewardsCompletionConsumer`
   * publishes and the outbox relay hands to `NotificationRewardConsumer`. The
   * id is the `domain_events` id, which is the thing a redelivery repeats.
   */
  const rewardEnvelope = (
    h: Household,
    payload: Record<string, unknown>,
    id: string = randomUUID(),
  ): any => ({
    envelopeVersion: '1',
    id,
    type: 'REWARD_GRANTED',
    schemaVersion: 1,
    familyId: h.familyId,
    childId: h.childId,
    deviceId: null,
    aggregateType: 'RewardGrant',
    aggregateId: randomUUID(),
    occurredAt: new Date().toISOString(),
    receivedAt: new Date().toISOString(),
    idempotencyKey: `eq:${id}`,
    clientEventId: null,
    traceId: null,
    payload: { childId: h.childId, grantCount: 1, ...payload },
  });

  /** THE REAL CONSUMER, in the tenant scope the relay establishes. */
  const deliver = (h: Household, envelope: any): Promise<void> =>
    runWithTenant(
      { familyId: h.familyId, actorType: 'SYSTEM', actorId: 'engine-quality-test' },
      () => rewardConsumer.handle(envelope),
    );

  /** THE REAL WELLBEING PRODUCER — a paired device reporting a critical event. */
  const criticalEvent = (
    h: Household,
    eventType: 'ACCESSIBILITY_DISABLED' | 'SCREEN_TIME_EXCEEDED' | 'PROTECTION_BYPASS_ATTEMPT',
    now: Date,
  ): Promise<void> =>
    runWithTenant({ familyId: h.familyId, actorType: 'SYSTEM', actorId: 'engine-quality-test' }, () =>
      wellbeing.recordCriticalEvent(
        h.childId,
        h.familyId,
        {
          eventType,
          title: 'device report',
          body: 'device report body',
        } as any,
        now,
      ),
    );

  beforeAll(async () => {
    // BEFORE THE APP IS BUILT, so every `@default(now())` this suite writes is
    // stamped with the instant the notification door will read back.
    freezeGoldenClock(BOOT_INSTANT);
    bootReading = new Date().toISOString();

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue(offlinePrismaService())
      .overrideProvider(AI_PROVIDER)
      .useValue(aiStub.provider)
      .compile();

    app = moduleRef.createNestApplication();
    await app.init();

    prisma = app.get(PrismaService);
    engine = app.get(SmartNotificationEngineService);
    rewardConsumer = app.get(NotificationRewardConsumer);
    wellbeing = app.get(DigitalWellbeingEngineService);
    childSafety = app.get(ChildSafetyFilterService);
  }, 180_000);

  afterAll(async () => {
    delete process.env.NOTIFICATION_AI_REPHRASE_ENABLED;
    if (prisma) {
      for (const id of createdFamilies) {
        await sys('cleanup family', () => prisma.family.deleteMany({ where: { id } })).catch(
          () => undefined,
        );
      }
      for (const id of createdUsers) {
        await sys('cleanup user', () => prisma.user.deleteMany({ where: { id } })).catch(() => undefined);
      }
    }
    await app?.close();
    jest.useRealTimers();
  }, 180_000);

  beforeEach(() => {
    aiStub.mode = 'ok';
    aiStub.calls = 0;
    delete process.env.NOTIFICATION_AI_REPHRASE_ENABLED;
    atInstant(MIDDAY);
  });

  // ==========================================================================
  // 0. THE PREMISES — every later assertion stands on these
  // ==========================================================================
  describe('0. the premises', () => {
    /**
     * THE TIME-BOMB GUARD. The two producers this suite drives read the WALL
     * CLOCK, so without the freeze §4 would pass at 12:00 and fail at 22:00 —
     * the failure mode that gets re-run in the morning and forgotten.
     */
    it('0.1 the wall clock the engine will read is the frozen instant, and it moves only on request', () => {
      expect(new Date().toISOString()).toBe(MIDDAY.toISOString());
      atInstant(DEEP_NIGHT);
      expect(Date.now()).toBe(DEEP_NIGHT.getTime());
      atInstant(MIDDAY);
      expect(Date.now()).toBe(MIDDAY.getTime());
    });

    it('0.2 MIDDAY is outside quiet hours and DEEP_NIGHT is inside, on the households’ own clocks', () => {
      // Measured through the SAME function production uses, so moving the
      // default window fails HERE with a readable message.
      expect(getBusinessTimeHHMM(MIDDAY, CAIRO)).toBe('12:00');
      expect(getBusinessTimeHHMM(MIDDAY, RIYADH)).toBe('13:00');
      expect(getBusinessTimeHHMM(MIDDAY, CAIRO) > QUIET_END).toBe(true);
      expect(getBusinessTimeHHMM(MIDDAY, CAIRO) < QUIET_START).toBe(true);

      expect(getBusinessTimeHHMM(DEEP_NIGHT, CAIRO)).toBe('21:30');
      expect(getBusinessTimeHHMM(DEEP_NIGHT, CAIRO) > QUIET_START).toBe(true);

      // AND JANUARY IS WHY THE TWO MARKETS DIFFER AT ALL. In August both are
      // UTC+3 and this assertion would be vacuous.
      expect(getBusinessTimeHHMM(MIDDAY, CAIRO)).not.toBe(getBusinessTimeHHMM(MIDDAY, RIYADH));
    });

    it('0.3 the three anti-genericness days are >24h apart and all outside quiet hours', () => {
      expect(DAY_2.getTime() - DAY_1.getTime()).toBeGreaterThan(24 * 60 * 60 * 1000);
      expect(DAY_3.getTime() - DAY_2.getTime()).toBeGreaterThan(24 * 60 * 60 * 1000);
      for (const day of [DAY_1, DAY_2, DAY_3]) {
        const local = getBusinessTimeHHMM(day, CAIRO);
        expect(`${local}:${local > QUIET_END && local < QUIET_START}`).toBe(`${local}:true`);
      }
      // Three different business days, which is what resets the per-type cap.
      expect(new Set([DAY_1, DAY_2, DAY_3].map((d) => getBusinessDate(d, CAIRO))).size).toBe(3);
    });

    it('0.5 the BOOT instant is whatever the run was given, and nothing below depends on it', () => {
      // A run started inside quiet hours reads a quiet-hours instant HERE and
      // still reaches every named instant below, because every section pins its
      // own. `ENGINE_QUALITY_BOOT_INSTANT` is how that is demonstrated rather
      // than asserted in prose.
      expect(bootReading).toBe(BOOT_INSTANT.toISOString());
      // And the moment a test body runs, the clock is back at the suite's own
      // baseline — set by `beforeEach`, not inherited from the run.
      expect(new Date().toISOString()).toBe(MIDDAY.toISOString());
    });

    it('0.4 the fatigue policy this suite is written against is the shipped default', () => {
      // Every spacing decision below is derived from these five numbers. If one
      // moves, this fails first and says which.
      expect(DEFAULT_NOTIFICATION_POLICY.maxPerDay).toBe(6);
      expect(DEFAULT_NOTIFICATION_POLICY.categoryMaxPerDay).toBe(2);
      expect(DEFAULT_NOTIFICATION_POLICY.defaultCooldownMinutes).toBe(30);
      expect(DEFAULT_NOTIFICATION_POLICY.duplicateWindowMinutes).toBe(5);
      expect(DEFAULT_NOTIFICATION_POLICY.maxPerHour).toBe(3);
    });
  });

  // ==========================================================================
  // 1. THE SAME EVENT, REPLAYED, IS ONE NOTIFICATION
  // ==========================================================================
  describe('1. one occurrence, replayed, is one notification', () => {
    let h: Household;
    let envelope: any;

    beforeAll(async () => {
      atInstant(MIDDAY);
      h = await createHousehold('replay');
      envelope = rewardEnvelope(h, {
        sourceEventType: 'ACHIEVEMENT_VERIFIED',
        verifiedBy: 'PARENT',
        achievementSummaryAr: 'الآيات ١–٥ من سورة الملك',
        pointsGranted: 20,
        completionKind: 'QURAN',
      });
      await deliver(h, envelope);
    }, 120_000);

    it('1.1 the first delivery writes ONE parent notification, ONE child message and TWO decisions', async () => {
      const notifications = await notificationRows(h.familyId);
      const messages = await childMessageRows(h.familyId);
      const decisions = await decisionRows(h.familyId);

      expect(notifications).toHaveLength(1);
      expect(messages).toHaveLength(1);
      // TWO decisions for ONE cause, because two people are being told two
      // different things and each is scored on its own inbox.
      expect(decisions).toHaveLength(2);
      expect(decisions.map((d) => d.target_audience).sort()).toEqual(['CHILD', 'PARENT']);
      expect(new Set(decisions.map((d) => d.source_event_id)).size).toBe(1);
    });

    it('1.2 the row the engine wrote carries the FROZEN instant — the freeze reaches the database', async () => {
      // Without this the spacing every later section depends on would be a
      // fiction: the rows would carry the real wall clock and the 24-hour
      // history window would never be empty.
      const [notification] = await notificationRows(h.familyId);
      expect(new Date(notification.created_at).toISOString()).toBe(MIDDAY.toISOString());
      const [decision] = await decisionRows(h.familyId);
      expect(new Date(decision.business_date).toISOString().slice(0, 10)).toBe(
        getBusinessDate(MIDDAY, CAIRO),
      );
    });

    it('1.3 REPLAYING the identical envelope writes NOTHING new', async () => {
      await deliver(h, envelope);

      expect(await notificationRows(h.familyId)).toHaveLength(1);
      expect(await childMessageRows(h.familyId)).toHaveLength(1);
      expect(await decisionRows(h.familyId)).toHaveLength(2);
    });

    /**
     * THE REPLAY THAT ACTUALLY TESTS SOMETHING.
     *
     * §1.3 is answered by `ConsumerIdempotency`: the marker exists, the work is
     * skipped, and nothing downstream is exercised at all. That is a real
     * production behaviour and it is also the WEAK half — a marker is one row
     * in one table, and a restore, a partition move or a manual cleanup loses
     * it. So the marker is DELETED and the same envelope is delivered again:
     * the consumer now runs the whole chain a second time, the engine assembles
     * a second context, the provider decides a second time, and the only things
     * standing between that and a duplicate notification are
     * `notification_decisions (family_id, source_event_id, target_audience)`
     * and `notifications (family_id, source_event_id, user_id)`.
     *
     * That is the difference between «we remembered» and «it cannot happen».
     */
    it('1.4 with the consumer marker DELETED the work RUNS again — and the database still refuses', async () => {
      const before = await consumedRows(h.familyId);
      expect(before.length).toBeGreaterThanOrEqual(1);

      await sys('delete the consumer marker', () =>
        prisma.$executeRawUnsafe(
          `DELETE FROM "consumed_messages" WHERE "family_id" = $1::uuid`,
          h.familyId,
        ),
      );
      expect(await consumedRows(h.familyId)).toHaveLength(0);

      await deliver(h, envelope);

      // The work RAN: the marker was written again.
      expect((await consumedRows(h.familyId)).length).toBeGreaterThanOrEqual(1);
      // And produced nothing.
      expect(await notificationRows(h.familyId)).toHaveLength(1);
      expect(await childMessageRows(h.familyId)).toHaveLength(1);
      expect(await decisionRows(h.familyId)).toHaveLength(2);
    });

    it('1.5 a DIFFERENT occurrence of the same kind is NOT collapsed into the first', async () => {
      // The control that makes §1.4 mean something: if the engine simply
      // refused every second reward, §1.4 would pass for the wrong reason.
      // A new `domain_events` id is a new cause, and it is told — one day
      // later, because the same TYPE twice inside thirty minutes is a cooldown.
      atInstant(new Date(MIDDAY.getTime() + 25 * 60 * 60 * 1000));
      await deliver(
        h,
        rewardEnvelope(h, { sourceEventType: 'STREAK_ACHIEVED', streakDays: 7, pointsGranted: 5 }),
      );
      atInstant(MIDDAY);

      expect(await notificationRows(h.familyId)).toHaveLength(2);
      expect(await decisionRows(h.familyId)).toHaveLength(4);
    });
  });

  // ==========================================================================
  // 2. DIFFERENT EVENTS ARE DIFFERENT DECISIONS AND DIFFERENT SENTENCES
  // ==========================================================================
  describe('2. different occurrences are told differently', () => {
    /**
     * THREE HOUSEHOLDS, ONE OCCURRENCE EACH, ONE INSTANT. The households are
     * separate so the fatigue policy cannot make the second and third
     * occurrence's outcome a function of the first — this section is about
     * WORDING, and a suppressed notification has none.
     */
    const causes = [
      {
        label: 'verified',
        payload: {
          sourceEventType: 'ACHIEVEMENT_VERIFIED',
          verifiedBy: 'PARENT',
          achievementSummaryAr: 'الآيات ١–٥ من سورة الملك',
          pointsGranted: 20,
        },
        childKey: 'ACHIEVEMENT_VERIFIED',
        parentKey: 'REWARD_GRANTED_WITH_GOAL',
      },
      {
        label: 'streak',
        payload: { sourceEventType: 'STREAK_ACHIEVED', streakDays: 7 },
        childKey: 'STREAK_ACHIEVED',
        parentKey: 'REWARD_GRANTED',
      },
      {
        label: 'habit',
        payload: { sourceEventType: 'HABIT_COMPLETED' },
        childKey: 'REWARD_GRANTED_CHILD',
        parentKey: 'REWARD_GRANTED',
      },
    ] as const;

    const seen: Array<{
      label: string;
      childKey: string;
      parentKey: string;
      childBody: string;
      parentBody: string;
    }> = [];

    beforeAll(async () => {
      atInstant(MIDDAY);
      for (const cause of causes) {
        const h = await createHousehold(`copy-${cause.label}`);
        await deliver(h, rewardEnvelope(h, cause.payload as Record<string, unknown>));
        const decisions = await decisionRows(h.familyId);
        const [notification] = await notificationRows(h.familyId);
        const [message] = await childMessageRows(h.familyId);
        seen.push({
          label: cause.label,
          childKey: decisions.find((d) => d.target_audience === 'CHILD')?.copy_key,
          parentKey: decisions.find((d) => d.target_audience === 'PARENT')?.copy_key,
          childBody: message?.body,
          parentBody: notification?.body,
        });
      }
    }, 180_000);

    it('2.1 each occurrence selected the copy key its facts earn — PERSISTED, not returned', () => {
      for (let i = 0; i < causes.length; i += 1) {
        expect(`${causes[i].label}:child:${seen[i].childKey}`).toBe(
          `${causes[i].label}:child:${causes[i].childKey}`,
        );
        expect(`${causes[i].label}:parent:${seen[i].parentKey}`).toBe(
          `${causes[i].label}:parent:${causes[i].parentKey}`,
        );
      }
    });

    it('2.2 THE SENTENCES DIFFER — three occurrences, three distinct Arabic bodies, per audience', () => {
      // THE ASSERTION THIS SECTION EXISTS FOR. `copy_key` differing is not
      // enough: two keys can render the same string, and the failure being
      // guarded against is «the engine says one generic thing every time».
      const childBodies = seen.map((s) => s.childBody);
      expect(new Set(childBodies).size).toBe(causes.length);

      // The parent's two distinct keys give two distinct sentences; the third
      // occurrence legitimately shares `REWARD_GRANTED` with the second,
      // because a streak and a habit tick are the same fact to a parent.
      const parentBodies = seen.map((s) => s.parentBody);
      expect(new Set(parentBodies).size).toBe(2);
      expect(parentBodies[0]).not.toBe(parentBodies[1]);
    });

    it('2.3 no occurrence fell through to the GENERIC sentence', () => {
      for (const s of seen) {
        expect(`${s.label}:${s.parentKey}`).not.toBe(`${s.label}:${GENERIC_COPY_KEY}`);
        expect(`${s.label}:${s.childKey}`).not.toBe(`${s.label}:${GENERIC_COPY_KEY}`);
        expect(s.parentBody).not.toBe(GENERIC_PARENT_BODY);
      }
    });

    it('2.4 the specific sentence carries the specific fact — the goal, the points, the streak', () => {
      const verified = seen[0];
      // The parent is told WHAT happened and WHETHER to act: the goal by name,
      // the points from the ledger, and an invitation.
      expect(verified.parentBody).toContain('الآيات');
      expect(verified.parentBody).toContain('محمد');
      // «٢٠ نقطة» — Arabic-Indic, because a parent's sentence in Arabic prose
      // does not mix numeral systems (`F1-003`).
      expect(verified.parentBody).not.toMatch(LATIN_DIGIT);

      // The child is told about THEIR OWN work, confirmed by their family.
      expect(verified.childBody).toContain('الآيات');
      // The streak child sentence names the streak, and nothing else does.
      expect(seen[1].childBody).toContain('سلسلتك');
      expect(seen[0].childBody).not.toContain('سلسلتك');
    });
  });

  // ==========================================================================
  // 3. ONE OCCURRENCE, TWO AUDIENCES, TWO REGISTERS
  // ==========================================================================
  describe('3. the child and the parent are told different, audience-appropriate things', () => {
    let h: Household;
    let notification: any;
    let message: any;
    let decisions: any[];

    beforeAll(async () => {
      atInstant(MIDDAY);
      // Born June 2013 — twelve years old at every instant in this file, so the
      // tone band is `11-13` and the safety band is `age-band.ts`'s own.
      h = await createHousehold('two-audiences');
      await deliver(
        h,
        rewardEnvelope(h, {
          sourceEventType: 'ACHIEVEMENT_VERIFIED',
          verifiedBy: 'PARENT',
          achievementSummaryAr: 'الآيات ١–٥ من سورة الملك',
          pointsGranted: 20,
        }),
      );
      [notification] = await notificationRows(h.familyId);
      [message] = await childMessageRows(h.familyId);
      decisions = await decisionRows(h.familyId);
    }, 120_000);

    it('3.1 both surfaces were written, from ONE cause, and the ledger records both decisions', () => {
      expect(notification).toBeTruthy();
      expect(message).toBeTruthy();
      expect(decisions).toHaveLength(2);
      // ONE cause, two rows, separated by audience and by nothing else.
      expect(new Set(decisions.map((d) => d.source_event_id)).size).toBe(1);
      // The child's ROW carries the `:child` facet the delivery layer appends,
      // so neither audience can deduplicate the other away.
      expect(message.source_event_id).toBe(`${decisions[0].source_event_id}:child`);
    });

    it('3.2 THE TWO SENTENCES ARE DIFFERENT SENTENCES', () => {
      expect(message.body).not.toBe(notification.body);
      expect(message.title).not.toBe(notification.title);
    });

    it('3.3 the PARENT’s sentence is contextual and actionable — what happened, and what to do', () => {
      // It names the child, names the work, and ends in an action rather than a
      // dead end. Read from the row, not from the return value.
      expect(notification.body).toContain('محمد');
      expect(notification.body).toContain('الآيات');
      expect(notification.body).toContain('افتح التطبيق');
      expect(notification.body).not.toMatch(ENUM_TOKEN);
      expect(notification.body).toMatch(ARABIC_LETTER);
    });

    it('3.4 the CHILD’s sentence is age-aware, supportive, and never about somebody else', () => {
      expect(message.body).toMatch(ARABIC_LETTER);
      // A child's sentence is about THEIR work. It does not name them in the
      // third person — that is how a parent's message reads.
      expect(message.body).not.toContain('محمد');
      // No raw enum, no Latin digit (`e2e-06`/`e2e-10`/`e2e-13` pin this).
      expect(message.body).not.toMatch(ENUM_TOKEN);
      expect(message.body).not.toMatch(LATIN_DIGIT);

      // AND IT PASSES THE PRODUCT'S OWN CHILD SAFETY FILTER, at the band this
      // child's age maps to — banned content, injection echo and the §11.3
      // length ceiling. Asserted through the service rather than against a copy
      // of its numbers.
      const verdict = childSafety.validate(message.body, ageBandFor(12));
      expect(`${verdict.reasons.join(',')}|${verdict.isSafe}`).toBe('|true');
    });

    it('3.5 the child’s row is behind the approval gate and carries only a destination', () => {
      // The gate is INTACT — this suite adds a proof about copy, not an
      // exemption from `PE-N-001`'s guard.
      expect(message.approval_status).toBe('PENDING');
      expect(message.delivered_at).toBeNull();
      // The child-readable payload is a WHITELIST of one key. Never a tenant id.
      const payload = jsonOf(message.data);
      expect(Object.keys(payload ?? {})).toEqual(['deepLink']);
      expect(isValidDeepLink(payload.deepLink)).toBe(true);
      expect(JSON.stringify(payload)).not.toContain(h.familyId);
      expect(JSON.stringify(payload)).not.toContain(h.childId);
    });
  });

  // ==========================================================================
  // 4. QUIET HOURS — BOTH OUTCOMES, ONE PRODUCER, ONE DIFFERENCE
  // ==========================================================================
  describe('4. quiet hours defer, and midday does not', () => {
    let night: Household;
    let day: Household;

    beforeAll(async () => {
      night = await createHousehold('quiet-night');
      atInstant(DEEP_NIGHT);
      await deliver(night, rewardEnvelope(night, { sourceEventType: 'HABIT_COMPLETED' }));

      atInstant(MIDDAY);
      day = await createHousehold('quiet-day');
      await deliver(day, rewardEnvelope(day, { sourceEventType: 'HABIT_COMPLETED' }));
    }, 120_000);

    it('4.1 at 21:30 Cairo the reward is HELD, not sent and not dropped', async () => {
      const decisions = await decisionRows(night.familyId);
      const parent = decisions.find((d) => d.target_audience === 'PARENT');

      expect(parent.decision).toBe('DEFER');
      expect(parent.reason).toBe('QUIET_HOURS_ACTIVE');
      expect(parent.outcome).toBe('DEFER');
      expect(parent.outcome_reason).toBe('QUIET_HOURS');

      // NOT DELIVERED — the row a parent would read does not exist yet.
      expect(await notificationRows(night.familyId)).toHaveLength(0);

      // AND NOT LOST, which is the whole of `PC-D-005`: it is a real queued row.
      const deferred = await deferredRows(night.familyId);
      expect(deferred.length).toBeGreaterThanOrEqual(1);
      const parentRow = deferred.find((r) => r.target_audience === 'PARENT');
      expect(parentRow.state).toBe('PENDING');
      expect(parentRow.defer_reason).toBe('QUIET_HOURS');
      // Released at the next instant THIS FAMILY'S wall clock reads 07:00 —
      // read back through the same function that computes local time, so the
      // assertion is about the family's calendar and not about a UTC offset.
      expect(getBusinessTimeHHMM(new Date(parentRow.scheduled_for), CAIRO)).toBe(QUIET_END);
      expect(new Date(parentRow.scheduled_for).getTime()).toBeGreaterThan(DEEP_NIGHT.getTime());
      // The message travels with the row — a queue that reconstructed the text
      // at release would be a second composer.
      expect(parentRow.body).toMatch(ARABIC_LETTER);
    });

    it('4.2 BOTH audiences are held — the child’s half is not silently dropped by the queue’s key', async () => {
      const deferred = await deferredRows(night.familyId);
      expect(deferred.map((r) => r.target_audience).sort()).toEqual(['CHILD', 'PARENT']);
      // Two rows, two keys, because `notification_deliveries (family_id,
      // source_event_id)` has no audience column and the facet is what keeps
      // the child's reward from being refused as the parent's duplicate.
      expect(new Set(deferred.map((r) => r.source_event_id)).size).toBe(2);
      expect(await childMessageRows(night.familyId)).toHaveLength(0);
    });

    it('4.3 at 12:00 Cairo the SAME occurrence with the SAME facts is delivered immediately', async () => {
      const decisions = await decisionRows(day.familyId);
      const parent = decisions.find((d) => d.target_audience === 'PARENT');

      expect(parent.decision).toBe('SEND');
      expect(parent.reason).not.toBe('QUIET_HOURS_ACTIVE');
      expect(parent.outcome).toBe('SEND');

      expect(await notificationRows(day.familyId)).toHaveLength(1);
      expect(await childMessageRows(day.familyId)).toHaveLength(1);
      expect(await deferredRows(day.familyId)).toHaveLength(0);
    });

    it('4.4 the only difference between the two households is the instant', async () => {
      // Stated as an assertion rather than as a comment: same type, same
      // audience, same producer, same facts — opposite outcomes.
      const nightParent = (await decisionRows(night.familyId)).find((d) => d.target_audience === 'PARENT');
      const dayParent = (await decisionRows(day.familyId)).find((d) => d.target_audience === 'PARENT');
      expect(nightParent.notification_type).toBe(dayParent.notification_type);
      expect(nightParent.copy_key).toBe(dayParent.copy_key);
      expect(nightParent.trigger).toBe(dayParent.trigger);
      expect(nightParent.decision).not.toBe(dayParent.decision);
    });
  });

  // ==========================================================================
  // 5. THE SAFETY BYPASS — THE RULE THAT EXISTS, NOT THE ONE ONE WOULD ASSUME
  // ==========================================================================
  /**
   * WHAT THE RULES ACTUALLY SAY, read before anything here was written, from
   * the two places that implement them:
   *
   *   `RuleBasedNotificationDecisionProvider.decide` step 2 — if
   *   `quietHoursClassOf(type) === 'DELIVER'` (or the type is on the family's
   *   `priorityOverrideTypes`), the engine returns SEND with reason
   *   `SAFETY_CRITICAL_OVERRIDE`, band HIGH, priority CRITICAL, and a score
   *   floored at `thresholdHigh` — CHECKED BEFORE SCORING, so no arithmetic
   *   penalty can refuse it.
   *
   *   `SmartNotificationIntegrationService.evaluateAndDeliver` — the same test,
   *   before `evaluateFatigue` is called at all, so a DELIVER-class alert is
   *   not refused by DAILY_MAX, CATEGORY_MAX, COOLDOWN or the five-minute
   *   DUPLICATE window either. Its own comment states the limit of that
   *   bypass: «Duplicate suppression is NOT lost with it: the unique index
   *   still collapses a redelivered cause to one row.»
   *
   * SO THE RULE IS «DELIVER-CLASS BYPASSES THE FATIGUE GUARD AND QUIET HOURS,
   * AND DOES NOT BYPASS THE DATABASE». That is what is asserted. What is NOT
   * asserted, because it is not the rule: that `priority: 'CRITICAL'` bypasses
   * anything — `quietHoursClassOf` takes a priority argument and deliberately
   * lets the TABLE win, and `POLICY_VIOLATION` is the SAFETY-category type that
   * proves the difference by being DEFER.
   */
  describe('5. a DELIVER-class safety alert bypasses suppression; a DEFER-class one does not', () => {
    let h: Household;

    beforeAll(async () => {
      h = await createHousehold('safety');
      atInstant(DEEP_NIGHT);
      // A DEFER-class safety type and a DELIVER-class one, from the SAME
      // producer, in the SAME household, at the SAME instant, inside quiet
      // hours. The classification is the only difference between them.
      await criticalEvent(h, 'SCREEN_TIME_EXCEEDED', DEEP_NIGHT);
      await criticalEvent(h, 'ACCESSIBILITY_DISABLED', DEEP_NIGHT);
    }, 120_000);

    it('5.0 the two types really are classified differently, and it is not a priority difference', () => {
      expect(quietHoursClassOf('ACCESSIBILITY_DISABLED')).toBe('DELIVER');
      expect(quietHoursClassOf('SCREEN_TIME_EXCEEDED')).toBe('DEFER');
      // Both are SAFETY. «Safety» is not the axis; the written class is.
      expect(NOTIFICATION_CLASSES.ACCESSIBILITY_DISABLED.category).toBe('SAFETY');
      expect(NOTIFICATION_CLASSES.SCREEN_TIME_EXCEEDED.category).toBe('SAFETY');
      // And a CRITICAL priority cannot promote the deferred one — the table wins.
      expect(quietHoursClassOf('SCREEN_TIME_EXCEEDED', 'CRITICAL')).toBe('DEFER');
    });

    it('5.1 the DELIVER-class alert is SENT at 21:30, with the reason and the priority the rule states', async () => {
      const decisions = await decisionRows(h.familyId);
      const alert = decisions.find((d) => d.notification_type === 'ACCESSIBILITY_DISABLED');

      expect(alert.decision).toBe('SEND');
      expect(alert.reason).toBe('SAFETY_CRITICAL_OVERRIDE');
      expect(alert.priority_band).toBe('HIGH');
      // The score is FLOORED at the high threshold rather than computed — the
      // override happens before scoring, which is the point of it.
      expect(alert.score).toBeGreaterThanOrEqual(DEFAULT_NOTIFICATION_POLICY.scoring.thresholdHigh);
      expect(alert.outcome).toBe('SEND');

      const rows = await notificationRows(h.familyId);
      const written = rows.filter((r) => r.type === 'ACCESSIBILITY_DISABLED');
      expect(written).toHaveLength(1);
      // CRITICAL BY CONSTRUCTION, not by arithmetic: `deliverNow` folds HIGH
      // down to NORMAL, so a band-derived priority would have stored this at a
      // badge's loudness.
      expect(written[0].priority).toBe('CRITICAL');
    });

    it('5.2 the DEFER-class alert, same household, same instant, is HELD', async () => {
      const decisions = await decisionRows(h.familyId);
      const held = decisions.find((d) => d.notification_type === 'SCREEN_TIME_EXCEEDED');

      expect(held.decision).toBe('DEFER');
      expect(held.reason).toBe('QUIET_HOURS_ACTIVE');
      expect(held.outcome).toBe('DEFER');

      expect((await notificationRows(h.familyId)).filter((r) => r.type === 'SCREEN_TIME_EXCEEDED')).toHaveLength(0);
      const deferred = await deferredRows(h.familyId);
      expect(deferred.map((r) => r.type)).toEqual(['SCREEN_TIME_EXCEEDED']);
    });

    it('5.3 the bypass reaches the FATIGUE GUARD too — a cooldown that would refuse a normal type does not refuse this one', async () => {
      // Six minutes later: a different causal-key bucket, outside the
      // five-minute duplicate window, and well inside the thirty-minute
      // cooldown that `ACCESSIBILITY_DISABLED` would otherwise be subject to.
      const later = new Date(DEEP_NIGHT.getTime() + 6 * MINUTE);
      atInstant(later);
      await criticalEvent(h, 'ACCESSIBILITY_DISABLED', later);
      atInstant(MIDDAY);

      const written = (await notificationRows(h.familyId)).filter(
        (r) => r.type === 'ACCESSIBILITY_DISABLED',
      );
      expect(written).toHaveLength(2);
      const decisions = (await decisionRows(h.familyId)).filter(
        (d) => d.notification_type === 'ACCESSIBILITY_DISABLED',
      );
      expect(decisions.map((d) => d.outcome)).toEqual(['SEND', 'SEND']);
    });

    it('5.4 and the bypass does NOT reach the database — the same cause twice is still one row', async () => {
      // The limit the pipeline's own comment claims. Inside the same five-minute
      // bucket `forRecurringSignal` composes the SAME key, and the unique index
      // refuses the second row — which is stricter than the window it replaced,
      // because it never forgets.
      const before = (await notificationRows(h.familyId)).filter(
        (r) => r.type === 'ACCESSIBILITY_DISABLED',
      ).length;

      const sameBucket = new Date(DEEP_NIGHT.getTime() + MINUTE);
      atInstant(sameBucket);
      await criticalEvent(h, 'ACCESSIBILITY_DISABLED', sameBucket);
      atInstant(MIDDAY);

      const after = (await notificationRows(h.familyId)).filter(
        (r) => r.type === 'ACCESSIBILITY_DISABLED',
      ).length;
      expect(after).toBe(before);
    });
  });

  // ==========================================================================
  // 6. THE DECISION LOG — WHAT IT CARRIES, AND WHAT IT DOES NOT
  // ==========================================================================
  describe('6. a decision-log row is written for every production notification', () => {
    let h: Household;
    let decision: any;
    let notification: any;
    let columns: string[];

    beforeAll(async () => {
      atInstant(MIDDAY);
      h = await createHousehold('decision-log');
      await deliver(
        h,
        rewardEnvelope(h, {
          sourceEventType: 'ACHIEVEMENT_VERIFIED',
          verifiedBy: 'PARENT',
          achievementSummaryAr: 'الآيات ١–٥ من سورة الملك',
          pointsGranted: 20,
          completionKind: 'QURAN',
        }),
      );
      decision = (await decisionRows(h.familyId)).find((d) => d.target_audience === 'PARENT');
      [notification] = await notificationRows(h.familyId);
      columns = await decisionColumns();
    }, 120_000);

    it('6.1 EVERY notification has a decision row, and every decision row has an outcome', async () => {
      const notifications = await notificationRows(h.familyId);
      const messages = await childMessageRows(h.familyId);
      const decisions = await decisionRows(h.familyId);
      expect(decisions).toHaveLength(notifications.length + messages.length);
      for (const d of decisions) {
        expect(`${d.target_audience}:${typeof d.outcome}`).toBe(`${d.target_audience}:string`);
      }
    });

    it('6.2 RECIPIENT — who is being told, and about whom', () => {
      expect(decision.target_audience).toBe('PARENT');
      expect(decision.child_id).toBe(h.childId);
      expect(decision.family_id).toBe(h.familyId);
      // And the row it produced names the actual person: the family owner.
      expect(notification.user_id).toBe(h.userId);
    });

    it('6.3 REASON — from the closed vocabulary, never free text', () => {
      expect(NOTIFICATION_DECISION_REASONS).toContain(decision.reason);
    });

    it('6.4 WHY-NOW — the trigger that set it off, plus arithmetic that reconciles', () => {
      expect(NOTIFICATION_TRIGGERS).toContain(decision.trigger);
      expect(decision.trigger).toBe('DOMAIN_EVENT');

      // The explanation is the «why now» in numbers: eight named components,
      // each with the raw reading, the weight, the contribution and an English
      // note naming the fact that produced it.
      const explanation = jsonOf(decision.explanation);
      expect(Array.isArray(explanation)).toBe(true);
      expect(explanation.map((c: any) => c.name).sort()).toEqual([...NOTIFICATION_SCORE_COMPONENTS].sort());
      for (const component of explanation) {
        expect(typeof component.note).toBe('string');
        expect(component.note.length).toBeGreaterThan(0);
      }
      // STORED RATHER THAN RECOMPUTED — it still adds up to the stored score.
      const total = explanation.reduce((sum: number, c: any) => sum + Number(c.contribution), 0);
      expect(Math.max(0, Math.min(100, Math.round(total)))).toBe(decision.score);
    });

    it('6.5 PRIORITY — the band the engine concluded, and the loudness the row carries', () => {
      expect(['HIGH', 'MEDIUM', 'LOW', 'SUPPRESS']).toContain(decision.priority_band);
      expect(['CRITICAL', 'HIGH', 'NORMAL', 'LOW']).toContain(notification.priority);
    });

    it('6.6 DESTINATION — on the payload, and it agrees with the key the decision recorded', () => {
      const payload = jsonOf(notification.data);
      expect(isValidDeepLink(payload.deepLink)).toBe(true);
      // DERIVED, not hardcoded: the persisted link is exactly what the server's
      // own resolver answers for the key this row names.
      expect(payload.deepLink).toBe(
        resolveNotificationDestination({ copyKey: decision.copy_key, audience: 'PARENT' }),
      );
      // NOTE: `notification-producer-chain.guard.spec.ts` RULE P11 reports
      // separately that two PARENT keys resolve to `abny://progress`, which the
      // parent app answers with no screen. This assertion is about the link
      // being CARRIED and CONSISTENT; whether the app opens it is that guard's
      // question and it is on its DEAD_DESTINATION_LEDGER.
    });

    it('6.7 THE ARABIC MESSAGE — on the row a human reads, in Arabic, with no enum', () => {
      expect(notification.title).toMatch(ARABIC_LETTER);
      expect(notification.body).toMatch(ARABIC_LETTER);
      expect(notification.body).not.toMatch(ENUM_TOKEN);
      expect(decision.locale).toBe('ar');
    });

    it('6.8 QUIET-HOURS HANDLING — the field carries the answer, and §4 shows it carrying the other one', () => {
      expect(['SEND', 'DEFER', 'SUPPRESS']).toContain(decision.decision);
      expect(decision.decision).toBe('SEND');
      expect(decision.outcome).toBe('SEND');
      // The DEFER/QUIET_HOURS_ACTIVE/QUIET_HOURS triple is asserted on a real
      // held row in §4.1; this is the same three columns saying «not tonight's
      // problem».
    });

    it('6.9 DUPLICATE SUPPRESSION — the ledger refuses a repeat, and the penalty is in the explanation', async () => {
      const before = await decisionRows(h.familyId);
      // The same cause, replayed at the door, with the consumer marker gone:
      // the unique key `(family_id, source_event_id, target_audience)` refuses
      // it, and the refusal is visible as the absence of a second row.
      const result = await runWithTenant(
        { familyId: h.familyId, actorType: 'SYSTEM', actorId: 'engine-quality-test' },
        () =>
          engine.handleEvent({
            familyId: h.familyId,
            childId: h.childId,
            eventType: 'REWARD_GRANTED',
            sourceEventId: decision.source_event_id,
            trigger: 'DOMAIN_EVENT',
            variables: {},
          }),
      );
      expect(result.decisionId).toBeNull();
      expect(await decisionRows(h.familyId)).toHaveLength(before.length);

      const penalty = jsonOf(decision.explanation).find((c: any) => c.name === 'DUPLICATE_PENALTY');
      expect(penalty).toBeTruthy();
      expect(typeof penalty.note).toBe('string');
    });

    /**
     * ========================================================================
     * THE COOLDOWN, DRIVEN FOR REAL AND READ BACK — IN BOTH DIRECTIONS.
     * ========================================================================
     *
     * THIS BLOCK USED TO PIN A DEFECT AND NOW PINS THE FIX. Until `7abe440`,
     * `toFatiguePolicy` — the documented bridge from a household's
     * `notification_policy_settings` to the guard — had NO CALL SITE ANYWHERE
     * IN `src/`, so `evaluateFatigue` ran on `DEFAULT_FATIGUE_POLICY` with
     * `defaultCooldownMinutes` and `hourlyMax` both `undefined`. Measured here,
     * from persisted rows: two `REWARD_GRANTED` twenty minutes apart both
     * delivered, `outcome = SEND`, `outcome_reason = NULL`. Every per-family
     * anti-spam knob was validated, stored and inert.
     *
     * `SmartNotificationEngineService` now makes that call, over the
     * AUDIENCE-SCOPED history the assembler already produces. So the same three
     * occurrences are re-measured below and the expectations are re-derived
     * from what the engine now decides — not relaxed, and not deleted.
     *
     * FOUR OCCURRENCES, FOUR DIFFERENT CAUSAL KEYS, ONE HOUSEHOLD. Different
     * keys are the point: with the SAME key the database refuses and no outcome
     * is ever recorded (that is §6.9's proof), so the only way to see the
     * GUARD's own vocabulary in `outcome_reason` is to give it causes it has to
     * judge on their merits.
     *
     *   +4 min   the first — delivered.
     *   +11 min  seven minutes later. OUTSIDE the five-minute window the
     *            pipeline's type-proxy duplicate rule uses, INSIDE the
     *            configured thirty-minute cooldown.
     *   +40 min  thirty-six minutes after the delivered one — past the cooldown,
     *            so the rule has to RELEASE as well as bite.
     */
    const cooldownRun: {
      strict: any[];
      strictNotifications: any[];
      relaxed: any[];
      relaxedNotifications: any[];
    } = { strict: [], strictNotifications: [], relaxed: [], relaxedNotifications: [] };

    /** +4, +11, +40 minutes past MIDDAY. Named once, used by both households, so
     * the ONLY difference between them is the policy row. */
    const FIRST = new Date(MIDDAY.getTime() + 4 * MINUTE);
    const SEVEN_MINUTES_LATER = new Date(MIDDAY.getTime() + 11 * MINUTE);
    const THIRTY_SIX_MINUTES_LATER = new Date(MIDDAY.getTime() + 40 * MINUTE);

    beforeAll(async () => {
      const strict = await createHousehold('cooldown-default');

      /**
       * AND A SECOND HOUSEHOLD THAT SAYS OTHERWISE, IN THE SUPPORTED WAY.
       *
       * `notification.cooldown.defaultMinutes = 0` is a per-family setting
       * (migration 0018), validated against `NOTIFICATION_POLICY_SCHEMAS` and
       * resolved by `resolveNotificationPolicy` — the same mechanism
       * `e2e-10-notification-locale` uses. It is here as the CONTROL that makes
       * the assertion above mean something: two households, the same producer,
       * the same facts, the same instants, and one row in
       * `notification_policy_settings` between them. If the knob were still
       * inert both would behave identically and §6.11 would go red.
       */
      const relaxed = await createHousehold('cooldown-off');
      await sys('the second household turns its cooldown off', () =>
        prisma.notificationPolicySetting.create({
          data: {
            familyId: relaxed.familyId,
            key: 'notification.cooldown.defaultMinutes',
            value: '0',
          },
        }),
      );

      atInstant(FIRST);
      await deliver(strict, rewardEnvelope(strict, { sourceEventType: 'HABIT_COMPLETED' }));
      await deliver(relaxed, rewardEnvelope(relaxed, { sourceEventType: 'HABIT_COMPLETED' }));

      atInstant(SEVEN_MINUTES_LATER);
      await deliver(strict, rewardEnvelope(strict, { sourceEventType: 'HABIT_COMPLETED' }));
      await deliver(relaxed, rewardEnvelope(relaxed, { sourceEventType: 'HABIT_COMPLETED' }));

      atInstant(THIRTY_SIX_MINUTES_LATER);
      await deliver(strict, rewardEnvelope(strict, { sourceEventType: 'HABIT_COMPLETED' }));

      atInstant(MIDDAY);

      const parentRows = async (familyId: string) =>
        (await decisionRows(familyId)).filter((d) => d.target_audience === 'PARENT');
      const rewardRows = async (familyId: string) =>
        (await notificationRows(familyId)).filter((n) => n.type === 'REWARD_GRANTED');

      cooldownRun.strict = await parentRows(strict.familyId);
      cooldownRun.strictNotifications = await rewardRows(strict.familyId);
      cooldownRun.relaxed = await parentRows(relaxed.familyId);
      cooldownRun.relaxedNotifications = await rewardRows(relaxed.familyId);
    }, 180_000);

    /**
     * WHY `COOLDOWN` AND NOT `DUPLICATE`, WHICH IS WHAT THIS ASSERTION USED TO
     * READ AND WHAT AN OPERATOR MIGHT EXPECT.
     *
     * The three occurrences here are three DIFFERENT causes — three
     * `domain_events` ids, three `sourceEventId`s. They are not one event
     * arriving three times.
     *
     * «Duplicate» in this product means THE SAME OCCURRENCE, and it is decided
     * by CAUSAL IDENTITY: `notifications (family_id, source_event_id, user_id)`
     * and `child_messages (family_id, source_event_id)` refuse a repeat and
     * never forget, and `DUPLICATE_PENALTY` compares causes — its own header's
     * «THIS EXACT THING» IS A CAUSE, NOT A TYPE», which is the principle the
     * audience-scoping work established when a child who crossed their hydration
     * goal AND their activity goal in one afternoon had the second declared a
     * duplicate of the first.
     *
     * «Cooldown» means A SECOND REAL EVENT TOO SOON AFTER THE FIRST. That is
     * exactly what a second habit completion seven minutes after the first is,
     * and it is the honest word for it. The engine's gate therefore hands the
     * guard `duplicateWindowMs: 0` — disabling the guard's TYPE-as-proxy
     * duplicate rule at that gate only — so the answer this row carries is the
     * one that is true.
     *
     * The old expectation (`DUPLICATE`) came from the PIPELINE's own pass, whose
     * type-proxy rule fired first only because the engine's cooldown did not
     * exist yet. It was the right assertion about the wrong gate.
     */
    it('6.10 a second DISTINCT occurrence too soon is COOLDOWN — «duplicate» is a question about CAUSE', () => {
      const [, second] = cooldownRun.strict;

      // The ENGINE decided to send — the arithmetic did not refuse this one —
      // and a GATE refused it. That disagreement is exactly what `outcome`
      // exists to make legible, and it is the row a support engineer reads.
      expect(second.decision).toBe('SEND');
      expect(second.outcome).toBe('SUPPRESS');
      expect(second.outcome_reason).toBe('COOLDOWN');

      // SEVEN minutes: past the five-minute window the type-proxy duplicate rule
      // uses, so `COOLDOWN` is not merely winning a race with `DUPLICATE`.
      expect(DEFAULT_NOTIFICATION_POLICY.duplicateWindowMinutes).toBe(5);
      expect((SEVEN_MINUTES_LATER.getTime() - FIRST.getTime()) / MINUTE).toBe(7);

      // …and it really was a different occurrence, not the same one twice.
      expect(new Set(cooldownRun.strict.map((d) => d.source_event_id)).size).toBe(3);
    });

    /**
     * ========================================================================
     * THE CONFIGURED COOLDOWN REACHES THE GUARD — THE FINDING, CLOSED.
     * ========================================================================
     *
     * This assertion measured the defect and now measures the fix, in the three
     * directions that together mean «enforced» rather than «sometimes says no»:
     *
     *   IT BITES     a second occurrence inside the window is refused (§6.10).
     *   IT RELEASES  one past the window is delivered — a cooldown that never
     *                let go would be a silent per-type daily cap of one.
     *   IT IS THE HOUSEHOLD'S  a family that sets the knob to zero gets a
     *                different answer at the SAME spacing. That is the half
     *                that could not have passed before `7abe440`: the setting
     *                was validated, stored, and read by nothing.
     */
    it('6.11 the configured cooldown is enforced — it bites, it releases, and the household owns it', () => {
      const [, , third] = cooldownRun.strict;

      // The product's configured answer for this type, from the shipped policy.
      expect(DEFAULT_NOTIFICATION_POLICY.defaultCooldownMinutes).toBe(30);
      expect(Object.keys(DEFAULT_NOTIFICATION_POLICY.cooldownMinutesByType)).not.toContain(
        'REWARD_GRANTED',
      );

      // IT RELEASES. Thirty-six minutes after the delivered one, past thirty.
      expect((THIRTY_SIX_MINUTES_LATER.getTime() - FIRST.getTime()) / MINUTE).toBe(36);
      expect(third.outcome).toBe('SEND');
      expect(third.outcome_reason).toBeNull();
      expect(cooldownRun.strictNotifications).toHaveLength(2);

      // IT IS THE HOUSEHOLD'S. Same producer, same facts, same two instants —
      // and the household that set `notification.cooldown.defaultMinutes = 0`
      // is told both times.
      expect(cooldownRun.relaxed.map((d) => `${d.outcome}/${d.outcome_reason ?? ''}`)).toEqual([
        'SEND/',
        'SEND/',
      ]);
      expect(cooldownRun.relaxedNotifications).toHaveLength(2);

      // And the throttling the ENGINE does on its own is still on the row, by
      // name, so the two mechanisms remain separable in the log.
      const penalty = jsonOf(third.explanation).find((c: any) => c.name === 'FATIGUE_PENALTY');
      expect(Number(penalty.contribution)).toBeLessThan(0);
      expect(penalty.note).toContain('today=1/6');
    });

    it('6.12 PROVENANCE and SOURCE EVENT — which provider decided, from what, about which occurrence', () => {
      expect(decision.provider_id).toBe('rule-based');
      expect(decision.event_type).toBe('REWARD_GRANTED');
      expect(decision.notification_type).toBe('REWARD_GRANTED');
      expect(typeof decision.source_event_id).toBe('string');
      expect(decision.source_event_id.length).toBeGreaterThan(0);
      // The causal key is the domain event's id, composed by `forDomainEvent`,
      // so the notification is traceable to the row that caused it.
      expect(decision.source_event_id.startsWith('evt:')).toBe(true);
      // And the same key is on the notification the parent reads, which is what
      // makes the join possible at all.
      expect(notification.source_event_id).toBe(decision.source_event_id);
    });

    // ------------------------------------------------------------------------
    // THE ONE FINDING STILL OPEN. Reported by name, proved against the real
    // schema and a real run, rather than asserted against a column somebody
    // invented here. The other two this suite opened — the inert cooldown and
    // the unobservable AI rewrite — were closed by `7abe440` / `bcf66cc` and
    // are measured as fixes in §6.10, §6.11 and §6.14.
    // ------------------------------------------------------------------------
    /**
     * FINDING — «CHANNEL» HAS NO COLUMN AND NO VALUE ANYWHERE.
     *
     * There is no channel concept in this product's notification pipeline.
     * `deliverNow` routes on AUDIENCE — a PARENT candidate becomes a
     * `notifications` row, a CHILD candidate a `child_messages` row — and
     * `PrismaRuntimeAlertRepository` additionally fans a best-effort FCM push
     * out to every registered device of the recipient. That fan-out returns a
     * `PushFanoutOutcome` (`SENT` / `SKIPPED` / `NONE` / `RETRYABLE` /
     * `PERMANENT` / `NO_RECIPIENT`) which is used for retry decisions and then
     * DISCARDED. So «which channels did this notification actually go out on»
     * is not answerable from any row in this database.
     *
     * IT IS NOT INVENTED HERE, AND IT WAS DELIBERATELY NOT ADDED. A `channel`
     * column written today would be NULL forever: the fan-out outcome is
     * computed inside `PrismaRuntimeAlertRepository.createForFamilyOwner`, below
     * the layer that writes the decision, and there is no plumbing between them.
     * A column that no writer fills is worse than an honest gap, because a
     * dashboard would report it as «no push problems».
     *
     * SO THIS STAYS OPEN, and stays visible: the test pins the ABSENCE, so the
     * day a channel really is recorded this goes red and the finding is closed
     * deliberately rather than forgotten. It is a real gap, not a closed one.
     */
    it('6.13 FINDING — CHANNEL: no column on notification_decisions, and no value anywhere', () => {
      expect(columns.filter((c) => c.includes('channel'))).toEqual([]);
      expect(Object.keys(decision).filter((k) => k.toLowerCase().includes('channel'))).toEqual([]);
      expect(Object.keys(notification).filter((k) => k.toLowerCase().includes('channel'))).toEqual([]);
      // The columns that DO exist, listed, so «what is actually there» is in the
      // report next to «what is not».
      expect(columns).toEqual(
        expect.arrayContaining([
          'ai_allowed',
          'ai_failed',
          'ai_invoked',
          'ai_rewritten',
          'ai_safety_rejection',
          'copy_key',
          'decision',
          'event_type',
          'explanation',
          'outcome',
          'outcome_reason',
          'priority_band',
          'provider_id',
          'reason',
          'source_event_id',
          'target_audience',
          'trigger',
        ]),
      );
    });

    /**
     * ========================================================================
     * AI REWRITING IS OBSERVABLE — THE FINDING, CLOSED, AND RE-MEASURED.
     * ========================================================================
     *
     * WHAT THIS ASSERTION USED TO REPORT. `notification_decisions` had
     * `ai_rewritten` and `ai_failed`, and those are OUTCOMES rather than
     * permissions: `both false` carried four different histories — the feature
     * OFF, the model called and refused by the safety gate, the model called and
     * answering the same sentence back, and the TEMPLATE itself failing safety
     * before a model was ever offered one. This suite PROVED the ambiguity by
     * running the composer with the model provably called zero times and
     * provably called once, and reading back two byte-identical rows.
     *
     * Migration `0029` adds `ai_allowed`, `ai_invoked` and `ai_safety_rejection`,
     * populated from `NotificationComposerService`, which had always computed
     * all three and thrown them away. The same two runs are re-measured below
     * and must now be DISTINGUISHABLE — the assertion is the same experiment
     * with the opposite expected answer, which is what closing a finding looks
     * like.
     *
     * THREE RUNS, NOT TWO, because the three columns only mean something if the
     * middle case is separable from BOTH ends: off · called-and-refused ·
     * called-and-accepted.
     */
    it('6.14 AI REWRITING — «allowed», «invoked» and the refusal are all on the row, and they separate three histories', async () => {
      const read = async (household: Household) =>
        (await decisionRows(household.familyId)).find((d) => d.target_audience === 'PARENT');

      // ---- 1. THE FEATURE IS OFF. No permission, no call, nothing refused.
      const off = await createHousehold('ai-off');
      delete process.env.NOTIFICATION_AI_REPHRASE_ENABLED;
      aiStub.calls = 0;
      atInstant(MIDDAY);
      await deliver(off, rewardEnvelope(off, { sourceEventType: 'HABIT_COMPLETED' }));
      const callsWhenOff = aiStub.calls;
      const offRow = await read(off);

      // ---- 2. ALLOWED, CALLED, AND REFUSED BY SAFETY. The model answers with a
      //         raw backend enum in it — one of the six failure modes the
      //         composer's own header lists — so the template ships.
      const refused = await createHousehold('ai-refused');
      process.env.NOTIFICATION_AI_REPHRASE_ENABLED = 'true';
      aiStub.mode = 'rejected';
      aiStub.calls = 0;
      await deliver(refused, rewardEnvelope(refused, { sourceEventType: 'HABIT_COMPLETED' }));
      const callsWhenRefused = aiStub.calls;
      const refusedRow = await read(refused);

      // ---- 3. ALLOWED, CALLED, AND ACCEPTED. The model's sentence ships.
      const accepted = await createHousehold('ai-accepted');
      aiStub.mode = 'ok';
      aiStub.calls = 0;
      await deliver(accepted, rewardEnvelope(accepted, { sourceEventType: 'HABIT_COMPLETED' }));
      const callsWhenAccepted = aiStub.calls;
      const acceptedRow = await read(accepted);

      delete process.env.NOTIFICATION_AI_REPHRASE_ENABLED;
      aiStub.mode = 'ok';

      // THE MODEL GENUINELY RAN IN TWO CASES AND NOT IN THE THIRD — measured at
      // the stub, which is the only witness outside the database.
      expect(callsWhenOff).toBe(0);
      expect(callsWhenRefused).toBeGreaterThan(0);
      expect(callsWhenAccepted).toBeGreaterThan(0);

      // THE COLUMNS EXIST.
      expect(columns).toEqual(
        expect.arrayContaining(['ai_allowed', 'ai_invoked', 'ai_safety_rejection']),
      );

      // AND THE THREE ROWS ARE NOW THREE DIFFERENT ROWS. This is the exact
      // comparison that used to prove the ambiguity; it now proves the fix.
      const shape = (row: any) =>
        `allowed=${row.ai_allowed} invoked=${row.ai_invoked} rewritten=${row.ai_rewritten} ` +
        `failed=${row.ai_failed} rejection=${row.ai_safety_rejection ?? 'none'}`;

      expect(shape(offRow)).toBe(
        'allowed=false invoked=false rewritten=false failed=false rejection=none',
      );
      expect(shape(refusedRow)).toBe(
        'allowed=true invoked=true rewritten=false failed=false rejection=ENUM_OR_PLACEHOLDER_LEAK',
      );
      expect(shape(acceptedRow)).toBe(
        'allowed=true invoked=true rewritten=true failed=false rejection=none',
      );
      expect(new Set([shape(offRow), shape(refusedRow), shape(acceptedRow)]).size).toBe(3);

      // `ai_rewritten` AND `ai_failed` ALONE STILL CANNOT SEPARATE THEM — which
      // is why the three columns were needed and is the finding this assertion
      // used to carry, kept here as the reason rather than as a complaint.
      const oldShape = (row: any) => `${row.ai_rewritten}/${row.ai_failed}`;
      expect(oldShape(offRow)).toBe(oldShape(refusedRow));

      // THE BEHAVIOUR IS UNCHANGED AND WAS NEVER IN QUESTION: the refused
      // household reads the deterministic template, the accepted one reads the
      // model's sentence, and neither reads an enum.
      const [refusedNotification] = await notificationRows(refused.familyId);
      expect(refusedNotification.body).toMatch(ARABIC_LETTER);
      expect(refusedNotification.body).not.toContain('REWARD_GRANTED');

      const [acceptedNotification] = await notificationRows(accepted.familyId);
      expect(acceptedNotification.body).toBe('صياغة بديلة من النموذج لهذا الإشعار');
    });
  });

  // ==========================================================================
  // 7. ANTI-GENERICNESS — one child, several achievements, several sentences
  // ==========================================================================
  /**
   * THE FAILURE THIS SECTION IS ABOUT is the one `F1-002` measured: four domain
   * causes reached the notification door as one word, and a child who kept a
   * seven-day streak and a child whose parent confirmed «الآيات ١–٥ من سورة
   * الملك» read the identical sentence. Four copy variants — each in four tone
   * bands, in two languages, each with a scoring row and a destination — could
   * not be selected by any production path.
   *
   * SO: ONE CHILD, THREE ACHIEVEMENTS, THREE DAYS. The days are the fatigue
   * policy's, not a convenience: two notifications of one type inside thirty
   * minutes is a cooldown and three in a day is over the per-type cap, so a
   * child who really did three different things gets told about them on three
   * different days — and must be told three different things.
   */
  describe('7. the child does not read the same sentence every time', () => {
    let h: Household;
    const messages: any[] = [];

    beforeAll(async () => {
      h = await createHousehold('anti-generic');

      atInstant(DAY_1);
      await deliver(h, rewardEnvelope(h, { sourceEventType: 'STREAK_ACHIEVED', streakDays: 7 }));

      atInstant(DAY_2);
      await deliver(
        h,
        rewardEnvelope(h, {
          sourceEventType: 'ACHIEVEMENT_VERIFIED',
          verifiedBy: 'PARENT',
          achievementSummaryAr: 'الآيات ١–٥ من سورة الملك',
          pointsGranted: 20,
        }),
      );

      atInstant(DAY_3);
      await deliver(h, rewardEnvelope(h, { sourceEventType: 'HABIT_COMPLETED' }));

      atInstant(MIDDAY);
      messages.push(...(await childMessageRows(h.familyId)));
    }, 180_000);

    it('7.1 all three achievements reached the child — none was suppressed', () => {
      expect(messages).toHaveLength(3);
    });

    it('7.2 THREE ACHIEVEMENTS, THREE DIFFERENT SENTENCES', () => {
      const bodies = messages.map((m) => m.body);
      expect(new Set(bodies).size).toBe(3);
      // And three different titles, so the difference is not one word deep.
      expect(new Set(messages.map((m) => m.title)).size).toBeGreaterThanOrEqual(2);
    });

    it('7.3 each sentence is the one its own fact earns, recorded on the decision row', async () => {
      const childDecisions = (await decisionRows(h.familyId))
        .filter((d) => d.target_audience === 'CHILD')
        .map((d) => d.copy_key);
      expect(childDecisions).toEqual(['STREAK_ACHIEVED', 'ACHIEVEMENT_VERIFIED', 'REWARD_GRANTED_CHILD']);
      expect(new Set(childDecisions).size).toBe(3);
    });

    it('7.4 none of them is the generic fallback, and every one of them is safe Arabic for this child', () => {
      for (const message of messages) {
        expect(message.body).toMatch(ARABIC_LETTER);
        expect(message.body).not.toMatch(ENUM_TOKEN);
        expect(message.body).not.toMatch(LATIN_DIGIT);
        const verdict = childSafety.validate(message.body, ageBandFor(12));
        expect(`${message.body}|${verdict.isSafe}`).toBe(`${message.body}|true`);
      }
      // The generic child sentence, read from the catalogue, appears nowhere.
      const generic = COPY_CATALOGUE[GENERIC_COPY_KEY].variants['11-13']?.ar.body as string;
      expect(messages.map((m) => m.body)).not.toContain(generic);
    });

    it('7.5 the three sentences each name their own fact and not each other’s', () => {
      const [streak, verified, habit] = messages.map((m) => m.body);
      expect(streak).toContain('سلسلتك');
      expect(verified).toContain('الآيات');
      // The fallback sentence is a whole sentence — never a half-filled template
      // and never a placeholder.
      expect(habit).not.toContain('سلسلتك');
      expect(habit).not.toContain('الآيات');
      expect(habit).not.toMatch(/\{[a-zA-Z0-9_]+\}/);
    });
  });
});
