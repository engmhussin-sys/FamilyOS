/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-var-requires */
/**
 * ============================================================================
 * THE FATIGUE POLICY, ENFORCED — MEASURED FROM PERSISTED ROWS.
 * ============================================================================
 *
 * WHAT WAS BROKEN, AND IT WAS MEASURED BEFORE IT WAS FIXED.
 *
 * `notification.cooldown.defaultMinutes` (30) and `notification.cap.maxPerHour`
 * (3) are validated, bounded, per-family knobs stored in
 * `notification_policy_settings`. Neither of them did anything.
 * `toFatiguePolicy` — the documented bridge from a household's configured
 * `NotificationPolicy` to the guard's `IFatiguePolicy` — had NO CALL SITE
 * ANYWHERE IN `src/`, so `evaluateFatigue` always ran on
 * `DEFAULT_FATIGUE_POLICY`, in which `hourlyMax` and `defaultCooldownMinutes`
 * are both `undefined` («this rule did not exist for you»).
 *
 * THE PRE-FIX MEASUREMENT, from `notification_decisions` and `notifications`
 * against a real PostgreSQL: two `REWARD_GRANTED` occurrences twenty minutes
 * apart — well inside the configured thirty-minute cooldown — produced TWO
 * `notifications` rows, and the second decision row read
 * `outcome = 'SEND', outcome_reason = NULL`. There was no `COOLDOWN` anywhere
 * in the database.
 *
 * THE POST-FIX MEASUREMENT is what this suite asserts, and it asserts it in
 * both directions: the second occurrence is refused AND THE FIRST ONE STILL
 * DELIVERS. A cooldown that silences both is not a cooldown, it is an outage,
 * and «the second one is missing» looks identical to «the feature is broken»
 * unless the first is pinned in the same test.
 *
 * ---------------------------------------------------------------------------
 * THE CLOCK IS FROZEN, AND THAT IS LOAD-BEARING.
 *
 * `NotificationRewardConsumer` passes NO instant to the notification door, so
 * `NotificationContextAssembler` falls to `input.now ?? new Date()` — the WALL
 * CLOCK. Every assertion below is about a WINDOW (twenty minutes inside a
 * thirty-minute cooldown, forty-five minutes inside a rolling hour), so without
 * a frozen clock this suite would depend on how long PostgreSQL took to answer,
 * and its quiet-hours-sensitive sections would pass by day and fail by night.
 * A suite in this very directory has done exactly that before.
 * `freezeGoldenClock` fakes `Date` ONLY — every timer stays real, because the
 * PostgreSQL driver needs working ones — and this suite then MOVES the frozen
 * clock deliberately with `atInstant`.
 *
 * AND THE INSTANTS ARE IN JANUARY, for `engine-quality.e2e.spec.ts`'s reason:
 * Africa/Cairo is UTC+2 in January and UTC+3 in August, and a suite written in
 * August cannot tell a timezone bug from a correct answer.
 *
 * ONE HOUSEHOLD PER SCENARIO. Two scenarios sharing a household would be two
 * scenarios sharing a fatigue budget, and the second would fail for a reason
 * the first caused.
 */
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'crypto';

import { AppModule } from '../../src/app.module';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { createTenantExtension } from '../../src/common/tenancy/tenant.extension';
import { runAsSystemAsync } from '../../src/common/tenancy/system-context';
import { runWithTenant } from '../../src/common/tenancy/tenant-context';
import { getBusinessTimeHHMM } from '../../src/common/time/family-date';
import { NotificationRewardConsumer } from '../../src/modules/events/application/consumers/notification-reward.consumer';
import { DEFAULT_NOTIFICATION_POLICY } from '../../src/modules/notifications/domain/engine/notification-policy';
import { freezeGoldenClock } from '../golden/golden-world';
import { integrationDatabaseUrl } from '../tenancy/prisma-test-client';

const describeIfDb = integrationDatabaseUrl() ? describe : describe.skip;

const CAIRO = 'Africa/Cairo';
const MINUTE = 60_000;

/** 12:00 Cairo — outside quiet hours on the household's own clock, so nothing
 * below is a deferral and every refusal this suite reads is a CAP. */
const MIDDAY = new Date('2026-01-20T10:00:00.000Z');

/**
 * THE THREE INSTANTS THE COOLDOWN SECTIONS USE, and every one of them is
 * derived from the SHIPPED policy rather than from a round number:
 *
 *   T0          the first occurrence.
 *   T_INSIDE    T0 + 20 min. INSIDE the 30-minute cooldown and OUTSIDE the
 *               5-minute duplicate window, which is the only span where the
 *               guard's answer can only be `COOLDOWN`.
 *   T_OUTSIDE   T0 + 40 min. Past the cooldown, and measured from the last
 *               DELIVERED occurrence (T0) rather than from the refused one,
 *               because a refusal writes no row and therefore restarts nothing.
 */
const T0 = new Date(MIDDAY.getTime() + 2 * MINUTE);
const T_INSIDE = new Date(T0.getTime() + 20 * MINUTE);
const T_OUTSIDE = new Date(T0.getTime() + 40 * MINUTE);

/** 45 minutes: past the 30-minute cooldown and inside the rolling hour, so the
 * ONLY rule that can refuse here is the hourly cap. */
const T_SAME_HOUR = new Date(T0.getTime() + 45 * MINUTE);

interface Household {
  readonly familyId: string;
  readonly childId: string;
  readonly userId: string;
}

describeIfDb('FATIGUE POLICY — the household’s own caps, enforced and read back', () => {
  let app: INestApplication;
  let prisma: any;
  let rewardConsumer: NotificationRewardConsumer;

  const stamp = Date.now();
  const createdFamilies: string[] = [];
  const createdUsers: string[] = [];

  const sys = (what: string, fn: () => Promise<any>): Promise<any> =>
    runAsSystemAsync('TEST_FIXTURE', `fatigue-policy: ${what}`, async () => await fn());

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

  const decisionsFor = async (familyId: string, audience: 'PARENT' | 'CHILD'): Promise<any[]> =>
    (
      await raw<any[]>(
        `SELECT * FROM "notification_decisions" WHERE "family_id" = $1::uuid
          AND "target_audience" = $2::text ORDER BY "created_at", "id"`,
        familyId,
        audience,
      )
    ).map((r) => r);

  const atInstant = (instant: Date): void => {
    jest.setSystemTime(instant);
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

  async function createHousehold(label: string): Promise<Household> {
    const family = await sys('create family', () =>
      prisma.family.create({
        data: { name: `FP ${label} ${stamp}`, timezone: CAIRO },
        select: { id: true },
      }),
    );
    createdFamilies.push(family.id);

    const user = await sys('create user', () =>
      prisma.user.create({
        data: {
          email: `fp.${label}.${stamp}@example.test`,
          passwordHash: 'x',
          fullName: 'FP Parent',
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
          dateOfBirth: new Date('2013-06-01T00:00:00.000Z'),
        },
        select: { id: true },
      }),
    );
    return { familyId: family.id, childId: child.id, userId: user.id };
  }

  /** THE HOUSEHOLD'S OWN SETTING, written to the real table the assembler
   * reads. Not a mock and not a monkey-patched constant: `resolveNotificationPolicy`
   * has to read this row back for the assertion below to mean anything. */
  const setPolicy = (familyId: string, key: string, value: string): Promise<any> =>
    sys('write policy setting', () =>
      prisma.$executeRawUnsafe(
        `INSERT INTO "notification_policy_settings" ("family_id", "key", "value")
         VALUES ($1::uuid, $2::text, $3::text)
         ON CONFLICT ("family_id", "key") DO UPDATE SET "value" = EXCLUDED."value"`,
        familyId,
        key,
        value,
      ),
    );

  const rewardEnvelope = (h: Household, id: string = randomUUID()): any => ({
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
    idempotencyKey: `fp:${id}`,
    clientEventId: null,
    traceId: null,
    payload: { childId: h.childId, grantCount: 1, sourceEventType: 'HABIT_COMPLETED' },
  });

  /** THE REAL CONSUMER, in the tenant scope the outbox relay establishes. */
  const deliver = (h: Household, envelope: any): Promise<void> =>
    runWithTenant(
      { familyId: h.familyId, actorType: 'SYSTEM', actorId: 'fatigue-policy-test' },
      () => rewardConsumer.handle(envelope),
    );

  /** One DISTINCT occurrence at a named instant — a fresh `domain_events` id, so
   * the DATABASE's own idempotency (which collapses a REPLAY) cannot be what
   * refuses it. Only the guard can. */
  const occurrenceAt = async (h: Household, instant: Date): Promise<void> => {
    atInstant(instant);
    await deliver(h, rewardEnvelope(h));
    atInstant(MIDDAY);
  };

  beforeAll(async () => {
    // BEFORE the app is built, so every `@default(now())` this suite writes is
    // stamped with the instant the notification door will read back.
    freezeGoldenClock(MIDDAY);

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue(offlinePrismaService())
      .compile();

    app = moduleRef.createNestApplication();
    await app.init();

    prisma = app.get(PrismaService);
    rewardConsumer = app.get(NotificationRewardConsumer);
  }, 180_000);

  afterAll(async () => {
    if (prisma) {
      for (const id of createdFamilies) {
        await sys('cleanup family', () => prisma.family.deleteMany({ where: { id } })).catch(
          () => undefined,
        );
      }
      for (const id of createdUsers) {
        await sys('cleanup user', () => prisma.user.deleteMany({ where: { id } })).catch(
          () => undefined,
        );
      }
    }
    await app?.close();
    jest.useRealTimers();
  }, 180_000);

  beforeEach(() => {
    atInstant(MIDDAY);
  });

  // ==========================================================================
  // 0. THE PREMISES — every later assertion stands on these
  // ==========================================================================
  describe('0. the premises', () => {
    it('0.1 the clock is frozen and moves only on request', () => {
      expect(new Date().toISOString()).toBe(MIDDAY.toISOString());
      atInstant(T_INSIDE);
      expect(Date.now()).toBe(T_INSIDE.getTime());
      atInstant(MIDDAY);
      expect(Date.now()).toBe(MIDDAY.getTime());
    });

    it('0.2 every instant this suite uses is OUTSIDE quiet hours on the household’s clock', () => {
      // Otherwise a DEFER would be read as a suppression and this suite would
      // be measuring the quiet-hours matrix instead of the caps.
      for (const instant of [T0, T_INSIDE, T_OUTSIDE, T_SAME_HOUR]) {
        const local = getBusinessTimeHHMM(instant, CAIRO);
        const outside =
          local >= DEFAULT_NOTIFICATION_POLICY.quietHoursEnd &&
          local < DEFAULT_NOTIFICATION_POLICY.quietHoursStart;
        expect(`${local}:${outside}`).toBe(`${local}:true`);
      }
    });

    it('0.3 the spacing is derived from the SHIPPED policy, not from round numbers', () => {
      const cooldown = DEFAULT_NOTIFICATION_POLICY.defaultCooldownMinutes;
      const duplicate = DEFAULT_NOTIFICATION_POLICY.duplicateWindowMinutes;
      expect(cooldown).toBe(30);
      expect(duplicate).toBe(5);
      // `REWARD_GRANTED` has no per-type cooldown, so it is the DEFAULT that
      // must reach the guard — which is precisely what was inert.
      expect(Object.keys(DEFAULT_NOTIFICATION_POLICY.cooldownMinutesByType)).not.toContain(
        'REWARD_GRANTED',
      );
      expect(Object.keys(DEFAULT_NOTIFICATION_POLICY.cooldownMinutesByType)).not.toContain(
        'REWARD_GRANTED_CHILD',
      );

      const insideMinutes = (T_INSIDE.getTime() - T0.getTime()) / MINUTE;
      expect(insideMinutes).toBeGreaterThan(duplicate); // not a DUPLICATE
      expect(insideMinutes).toBeLessThan(cooldown); // genuinely inside the cooldown

      expect((T_OUTSIDE.getTime() - T0.getTime()) / MINUTE).toBeGreaterThanOrEqual(cooldown);
      // …and still inside the same business day and the same 24h window.
      expect((T_OUTSIDE.getTime() - T0.getTime()) / MINUTE).toBeLessThan(24 * 60);
    });
  });

  // ==========================================================================
  // 1. THE COOLDOWN, PARENT AUDIENCE
  // ==========================================================================
  describe('1. the cooldown reaches the guard — PARENT', () => {
    let h: Household;
    let decisions: any[];
    let notifications: any[];

    beforeAll(async () => {
      h = await createHousehold('cooldown-parent');
      await occurrenceAt(h, T0);
      await occurrenceAt(h, T_INSIDE);
      decisions = await decisionsFor(h.familyId, 'PARENT');
      notifications = (await notificationRows(h.familyId)).filter(
        (n) => n.type === 'REWARD_GRANTED',
      );
    }, 120_000);

    it('1.1 THE FIRST ONE STILL DELIVERS — the cooldown suppresses a repeat, not the feature', () => {
      const [first] = decisions;
      expect(first.outcome).toBe('SEND');
      expect(first.outcome_reason).toBeNull();
      expect(notifications).toHaveLength(1);
      expect(new Date(notifications[0].created_at).toISOString()).toBe(T0.toISOString());
    });

    it('1.2 the second occurrence, 20 minutes later, is REFUSED and the row says COOLDOWN', () => {
      expect(decisions).toHaveLength(2);
      const [, second] = decisions;
      // The ENGINE had no arithmetic objection — the disagreement between the
      // engine's verdict and the pipeline's outcome is exactly what `outcome`
      // exists to make legible.
      expect(second.decision).toBe('SEND');
      expect(second.outcome).toBe('SUPPRESS');
      expect(second.outcome_reason).toBe('COOLDOWN');
      // AND NO SECOND ROW REACHED THE PARENT. The decision ledger saying
      // «suppressed» while a notification row exists would be the worse defect.
      expect(notifications).toHaveLength(1);
    });

    it('1.3 OUTSIDE the window it delivers again — the cooldown expires, it does not latch', async () => {
      await occurrenceAt(h, T_OUTSIDE);
      const after = await decisionsFor(h.familyId, 'PARENT');
      const rows = (await notificationRows(h.familyId)).filter((n) => n.type === 'REWARD_GRANTED');

      expect(after).toHaveLength(3);
      const third = after[2];
      expect(third.outcome).toBe('SEND');
      expect(third.outcome_reason).toBeNull();
      expect(rows).toHaveLength(2);
      expect(new Date(rows[1].created_at).toISOString()).toBe(T_OUTSIDE.toISOString());
    });
  });

  // ==========================================================================
  // 2. THE COOLDOWN, CHILD AUDIENCE — counted over the CHILD'S OWN INBOX
  // ==========================================================================
  /**
   * BOTH AUDIENCES, SEPARATELY, and that is not symmetry for its own sake. The
   * child's fatigue history is `child_messages`, not `notifications` — a fix
   * this repository already made for the SCORER (`NotificationContextAssembler.readHistory`)
   * after measuring a child being silenced by their parent's busy minute. The
   * cap is now computed over that same audience-scoped stream, so this section
   * proves the cooldown applies to the child's own news about their own work
   * and is counted against the child's own inbox.
   */
  describe('2. the cooldown reaches the guard — CHILD', () => {
    let h: Household;
    let decisions: any[];
    let messages: any[];

    beforeAll(async () => {
      h = await createHousehold('cooldown-child');
      await occurrenceAt(h, T0);
      await occurrenceAt(h, T_INSIDE);
      decisions = await decisionsFor(h.familyId, 'CHILD');
      messages = await childMessageRows(h.familyId);
    }, 120_000);

    it('2.1 the first child message is written', () => {
      const [first] = decisions;
      expect(first.notification_type).toBe('REWARD_GRANTED_CHILD');
      expect(first.outcome).toBe('SEND');
      expect(messages).toHaveLength(1);
    });

    it('2.2 the second, 20 minutes later, is refused with COOLDOWN and writes no message', () => {
      expect(decisions).toHaveLength(2);
      const [, second] = decisions;
      expect(second.outcome).toBe('SUPPRESS');
      expect(second.outcome_reason).toBe('COOLDOWN');
      expect(messages).toHaveLength(1);
    });

    it('2.3 outside the window the child is told again', async () => {
      await occurrenceAt(h, T_OUTSIDE);
      const after = await decisionsFor(h.familyId, 'CHILD');
      expect(after).toHaveLength(3);
      expect(after[2].outcome).toBe('SEND');
      expect(after[2].outcome_reason).toBeNull();
      expect(await childMessageRows(h.familyId)).toHaveLength(2);
    });
  });

  // ==========================================================================
  // 3. `maxPerHour` — THE HOUSEHOLD'S OWN VALUE, NOT A HARD-CODED DEFAULT
  // ==========================================================================
  /**
   * THE CONTROL IS THE POINT. One household sets `notification.cap.maxPerHour`
   * to 1; the other sets nothing and therefore has the shipped default of 3.
   * Both receive the identical pair of occurrences at the identical instants,
   * 45 minutes apart — past the 30-minute cooldown, inside the rolling hour.
   * The configured household is refused with `HOURLY_MAX` and the default one
   * is not, which is the only arrangement that can distinguish «the cap is
   * enforced» from «something else refused it» and from «a constant somewhere
   * happens to be 1».
   *
   * ---------------------------------------------------------------------------
   * WHY BOTH HOUSEHOLDS ALSO SET `notification.score.thresholdLow` TO 1, and it
   * is not a workaround — it is what isolates the measurement.
   *
   * `maxPerHour` is read by TWO things: the guard (the refusal this section is
   * about) and `scoreNotification`'s `FATIGUE_PENALTY`, whose `hourLoad` term is
   * `lastHour / maxPerHour`. MEASURED, pre-fix: a household that set
   * `maxPerHour = 1` had its second `REWARD_GRANTED` suppressed by the ENGINE
   * with `SCORE_BELOW_FLOOR` — `hourLoad` saturated at 1.0 and took the full
   * 25-point penalty — while the guard, which was the thing supposed to enforce
   * the cap, was doing nothing at all. Leaving the floor at its default would
   * therefore let this section pass while the cap remained inert, which is
   * exactly the failure it exists to detect.
   *
   * The floor is lowered on BOTH households, identically, so the ONLY difference
   * between them remains `maxPerHour`. Neither the cooldown sections above nor
   * anything else in this suite touches it: they run on the shipped defaults.
   */
  describe('3. maxPerHour is the family’s configured number', () => {
    let capped: Household;
    let uncapped: Household;
    let cappedDecisions: any[];
    let uncappedDecisions: any[];

    beforeAll(async () => {
      capped = await createHousehold('hourly-capped');
      await setPolicy(capped.familyId, 'notification.cap.maxPerHour', '1');
      await setPolicy(capped.familyId, 'notification.score.thresholdLow', '1');
      await occurrenceAt(capped, T0);
      await occurrenceAt(capped, T_SAME_HOUR);
      cappedDecisions = await decisionsFor(capped.familyId, 'PARENT');

      uncapped = await createHousehold('hourly-default');
      await setPolicy(uncapped.familyId, 'notification.score.thresholdLow', '1');
      await occurrenceAt(uncapped, T0);
      await occurrenceAt(uncapped, T_SAME_HOUR);
      uncappedDecisions = await decisionsFor(uncapped.familyId, 'PARENT');
    }, 180_000);

    it('3.1 the configured value is genuinely different from the shipped default', () => {
      // Without this, «1» could be the default and the section would prove
      // nothing about configuration at all.
      expect(DEFAULT_NOTIFICATION_POLICY.maxPerHour).toBe(3);
      expect((T_SAME_HOUR.getTime() - T0.getTime()) / MINUTE).toBe(45);
      // Past the cooldown, so `COOLDOWN` cannot be what refuses the second one.
      expect(45).toBeGreaterThanOrEqual(DEFAULT_NOTIFICATION_POLICY.defaultCooldownMinutes);
      // Inside the rolling hour, so the hourly cap genuinely applies.
      expect(45).toBeLessThan(60);
    });

    it('3.2 a household that configured maxPerHour = 1 has its SECOND notification refused', async () => {
      expect(cappedDecisions).toHaveLength(2);
      expect(cappedDecisions[0].outcome).toBe('SEND');
      // THE GUARD REFUSED IT, NOT THE ARITHMETIC. The engine's own verdict is
      // still SEND, so `HOURLY_MAX` on the outcome cannot be a re-labelling of
      // `SCORE_BELOW_FLOOR` — see this section's header.
      expect(cappedDecisions[1].decision).toBe('SEND');
      expect(cappedDecisions[1].outcome).toBe('SUPPRESS');
      expect(cappedDecisions[1].outcome_reason).toBe('HOURLY_MAX');
      // One row for the parent, not two.
      expect(
        (await notificationRows(capped.familyId)).filter((n) => n.type === 'REWARD_GRANTED'),
      ).toHaveLength(1);
    });

    it('3.3 THE CONTROL — the same two occurrences in a household with no setting BOTH deliver', async () => {
      expect(uncappedDecisions).toHaveLength(2);
      expect(uncappedDecisions[0].outcome).toBe('SEND');
      expect(uncappedDecisions[1].outcome).toBe('SEND');
      expect(uncappedDecisions[1].outcome_reason).toBeNull();
      expect(
        (await notificationRows(uncapped.familyId)).filter((n) => n.type === 'REWARD_GRANTED'),
      ).toHaveLength(2);
    });
  });

  // ==========================================================================
  // 4. REPLAY IDEMPOTENCY STILL HOLDS — PROVED BY REPLAYING
  // ==========================================================================
  /**
   * A NEW SUPPRESSION GATE IS A NEW WAY TO GET IDEMPOTENCY WRONG, in both
   * directions: it could collapse two DISTINCT occurrences into one (§1.3 and
   * §3.3 are the controls for that), and a REPLAY could now be reported as a
   * COOLDOWN — a plausible-looking word for what is actually the database
   * refusing a duplicate cause. Both are asserted here, and the replay is a
   * REAL ONE: the consumer's idempotency marker is DELETED so the whole chain
   * genuinely runs again and the DATABASE has to be the thing that refuses.
   */
  describe('4. the same occurrence, replayed, is still one notification', () => {
    let h: Household;
    let envelope: any;

    beforeAll(async () => {
      h = await createHousehold('replay');
      atInstant(T0);
      envelope = rewardEnvelope(h);
      await deliver(h, envelope);
      atInstant(MIDDAY);
    }, 120_000);

    it('4.1 one occurrence: one parent notification, one child message, two decisions', async () => {
      expect(await notificationRows(h.familyId)).toHaveLength(1);
      expect(await childMessageRows(h.familyId)).toHaveLength(1);
      expect(await decisionsFor(h.familyId, 'PARENT')).toHaveLength(1);
      expect(await decisionsFor(h.familyId, 'CHILD')).toHaveLength(1);
    });

    it('4.2 with the consumer marker DELETED the work RUNS again — and nothing new is written', async () => {
      await sys('delete the consumer marker', () =>
        prisma.$executeRawUnsafe(
          `DELETE FROM "consumed_messages" WHERE "family_id" = $1::uuid`,
          h.familyId,
        ),
      );
      expect(
        await raw<any[]>(
          `SELECT * FROM "consumed_messages" WHERE "family_id" = $1::uuid`,
          h.familyId,
        ),
      ).toHaveLength(0);

      atInstant(T0);
      await deliver(h, envelope);
      atInstant(MIDDAY);

      // The work RAN — the marker is back.
      expect(
        (
          await raw<any[]>(
            `SELECT * FROM "consumed_messages" WHERE "family_id" = $1::uuid`,
            h.familyId,
          )
        ).length,
      ).toBeGreaterThanOrEqual(1);

      // …and produced nothing new.
      expect(await notificationRows(h.familyId)).toHaveLength(1);
      expect(await childMessageRows(h.familyId)).toHaveLength(1);
      const parent = await decisionsFor(h.familyId, 'PARENT');
      expect(parent).toHaveLength(1);

      // AND THE ONE ROW STILL SAYS `SEND`. A replay must not overwrite the
      // original decision's outcome with a suppression: `ON CONFLICT DO
      // NOTHING` returns no id, so `recordOutcome` is never called for the
      // repeat, and the ledger keeps the truth about the delivery that happened.
      expect(parent[0].outcome).toBe('SEND');
      expect(parent[0].outcome_reason).toBeNull();
    });
  });
});
