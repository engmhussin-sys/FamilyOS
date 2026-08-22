/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-var-requires */
/**
 * B4 (PA-B-015) — THE SEVERED CHAINS, CONNECTED, PROVEN BY EXECUTION.
 *
 * WHAT WAS BROKEN. `RewardRule` had one writer in the entire backend — F4's
 * companion-row materialiser — and zero controllers, zero seeds and zero
 * INSERTs in migrations 0001..0006. Every production completion from Habits,
 * Health, Hydration, Activity, Faith, Education and Learning reached
 * `evaluateRewardRules([], event)` and got nothing back. `REWARD_GRANTED` is
 * emitted only inside `if (granted > 0)`, so the ledger, the timeline and the
 * notification behind it were unreachable too. Seven domains were fully wired
 * and paid nothing.
 *
 * WHAT THIS FILE PROVES, against a REAL PostgreSQL, a REAL Redis and the REAL
 * application — real guards, real tenant extension, real outbox relay, real
 * `RewardsEngineService`, nothing stubbed:
 *
 *   THE DEFAULTS      a family that configures NOTHING earns, in five domains,
 *                     end to end: ONE ledger row, ONE `REWARDS` timeline entry,
 *                     ONE notification. Each.
 *   THE VERIFICATION  a completion whose verification condition FAILS produces
 *                     zero of all three — not a smaller reward, zero.
 *   THE REPLAY        the same completion again -> zero new of all three.
 *   THE RACE          8 concurrent identical completions -> exactly one reward.
 *   THE CAP           `maxPerDay` counted on the FAMILY's business day.
 *   THE NEXT DAY      a legitimate completion on the next business day -> a
 *                     SECOND reward. The fix must not become "one reward ever".
 *   THE CHILD         a device token cannot author a rule and cannot complete a
 *                     goal — the two newly-connected write paths.
 *   THE TENANT        family A's rules are invisible to family B, and family
 *                     A's parent cannot reach family B's rule by id.
 *   THE OVERRIDE      a family rule shadows the platform default for its
 *                     engine, and a deactivated family rule pays nothing at all.
 *
 * ON THE CLOCK: only `Date` is faked, and the fake day is one day BEHIND the
 * real clock — the same two constraints F3, F4 and B1 established, for the same
 * reasons (quiet hours, and Prisma's client-side `@default(now())` versus
 * PostgreSQL's `now()` in the relay's raw SQL).
 */
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request = require('supertest');

import { AppModule } from '../../src/app.module';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { createTenantExtension } from '../../src/common/tenancy/tenant.extension';
import { runAsSystemAsync } from '../../src/common/tenancy/system-context';
import { runWithTenant } from '../../src/common/tenancy/tenant-context';
import { TokenService } from '../../src/modules/auth/application/services/token.service';
import { OutboxRelay } from '../../src/modules/events/application/outbox.relay';
import {
  PLATFORM_DEFAULT_REWARD_RULES,
  RETIRED_PLATFORM_RULES,
  crossingCollisions,
  ruleRewardValue,
} from '../../src/shared/rewards/reward-rule-catalogue';
import { integrationDatabaseUrl } from '../tenancy/prisma-test-client';

const describeIfDb = integrationDatabaseUrl() ? describe : describe.skip;

const DAY_MS = 24 * 60 * 60 * 1000;
const FAKE_DAY = new Date(Date.now() - DAY_MS).toISOString().slice(0, 10);
const NEXT_DAY = new Date(Date.now()).toISOString().slice(0, 10);
const at = (day: string, hhmm: string): Date => new Date(`${day}T${hhmm}:00.000Z`);
const NOON = at(FAKE_DAY, '12:00');

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

interface Tenant {
  familyId: string;
  userId: string;
  parentToken: string;
  childId: string;
  habitId: string;
  practiceId: string;
  goalId: string;
  deviceToken: string;
  deviceId: string;
}

describeIfDb('B4 — the severed reward chains, connected (real PostgreSQL, real Redis, real app)', () => {
  let app: INestApplication;
  let http: any;
  let prisma: any;
  let relay: OutboxRelay;
  let tokens: TokenService;

  const stamp = Date.now();
  /** The family under test. Configures NOTHING — it must earn from the
   * platform defaults alone. */
  const A = {} as Tenant;
  /** The neighbour. Every isolation assertion is made against this family. */
  const B = {} as Tenant;
  const createdFamilies: string[] = [];
  const createdUsers: string[] = [];
  const createdDevices: string[] = [];

  const sys = (what: string, fn: () => Promise<any>): Promise<any> =>
    runAsSystemAsync('TEST_FIXTURE', `B4 connection suite: ${what}`, async () => await fn());

  // -------------------------------------------------------------------------
  // fixtures
  // -------------------------------------------------------------------------

  async function registerTenant(label: string, target: Tenant, timezone: string): Promise<void> {
    const email = `b4.${label}.${stamp}@example.com`;
    const password = 'B4-Connect-Passw0rd!23';

    const reg = await request(http).post('/auth/register').send({
      email,
      password,
      fullName: `B4 Parent ${label}`,
      familyName: `B4 Family ${label}`,
      timezone,
      acceptedTerms: true,
    });
    if (![200, 201].includes(reg.status)) {
      throw new Error(`register(${label}) -> ${reg.status} ${JSON.stringify(reg.body)}`);
    }

    const login = await request(http).post('/auth/login').send({ email, password });
    target.parentToken = login.body.tokens?.accessToken ?? login.body.accessToken;
    const claims = JSON.parse(Buffer.from(target.parentToken.split('.')[1], 'base64').toString());
    target.familyId = claims.familyId;
    target.userId = claims.sub;
    createdFamilies.push(target.familyId);
    createdUsers.push(target.userId);

    const child = await request(http)
      .post('/children')
      .set(auth(target))
      .send({ firstName: `B4 Kid ${label}`, dateOfBirth: '2015-04-01' });
    target.childId = child.body.id;

    const habit = await request(http)
      .post(`/life-intelligence/habits/${target.childId}`)
      .set(auth(target))
      .send({ title: `B4 Habit ${label}`, category: 'LEARNING' });
    target.habitId = habit.body.id;

    const practice = await request(http)
      .post(`/life-intelligence/faith/${target.childId}/practices`)
      .set(auth(target))
      .send({ title: `B4 Salah ${label}`, type: 'SALAH' });
    if (![200, 201].includes(practice.status)) {
      throw new Error(`practice(${label}) -> ${practice.status} ${JSON.stringify(practice.body)}`);
    }
    target.practiceId = practice.body.id;

    const goal = await request(http)
      .post(`/life-intelligence/learning/${target.childId}/goals`)
      .set(auth(target))
      .send({ subject: 'MATH', title: `B4 Goal ${label}` });
    target.goalId = goal.body.id;

    const device = await newDevice(target);
    target.deviceId = device.deviceId;
    target.deviceToken = device.token;

    // DELIBERATELY NO `prisma.rewardRule.create` HERE. Every other e2e suite in
    // this repository seeds a rule by hand, which is exactly how PA-B-015 stayed
    // invisible: the tests supplied the one thing production never had. This
    // family configures nothing.
  }

  const auth = (t: Tenant) => ({ Authorization: `Bearer ${t.parentToken}` });
  const deviceAuth = (t: Tenant) => ({ Authorization: `Bearer ${t.deviceToken}` });

  async function newDevice(t: Tenant) {
    const device = await sys('seed device', () =>
      prisma.device.create({
        data: {
          familyId: t.familyId,
          ownerType: 'CHILD',
          childId: t.childId,
          platform: 'ANDROID',
          status: 'ACTIVE',
          pairedAt: new Date(),
        },
        select: { id: true },
      }),
    );
    createdDevices.push(device.id);
    const pair = await runWithTenant(
      { familyId: t.familyId, actorType: 'DEVICE', actorId: device.id },
      () => tokens.issueTokenPair({ subjectId: device.id, actorType: 'DEVICE', familyId: t.familyId }),
    );
    return { deviceId: device.id, token: pair.accessToken };
  }

  async function drainOutbox(maxPasses = 8): Promise<void> {
    for (let i = 0; i < maxPasses; i++) {
      const result = await relay.tick(50);
      if (result.claimed === 0) break;
    }
  }

  // --- the three counters every domain assertion uses ----------------------

  const ledgerCount = (t: Tenant): Promise<number> =>
    sys('ledger count', () => prisma.rewardsLedgerEntry.count({ where: { familyId: t.familyId, type: 'EARN' } }));

  /** The REWARDS-category entry the reward itself writes. Domain engines write
   * their own domain-category entries (`first_habit_completion`,
   * `hydration_target_reached`); those are separate curated moments and are not
   * what "one timeline entry per reward" is about. */
  const rewardTimelineCount = (t: Tenant): Promise<number> =>
    sys('timeline count', () =>
      prisma.lifeTimelineEvent.count({ where: { familyId: t.familyId, eventType: 'reward_granted' } }),
    );

  const notificationCount = (t: Tenant): Promise<number> =>
    sys('notification count', () =>
      prisma.notification.count({ where: { familyId: t.familyId, type: 'REWARD_GRANTED' } }),
    );

  /** All three at once — the shape every domain test asserts on.
   *
   * 0026 CHANGED WHAT `ledger` COUNTS ON A FIRST COMPLETION, and the tests
   * below say so out loud rather than being loosened. Migration 0026 seeded the
   * badge catalogue AND the platform BADGE rules that ask for it, so a child's
   * FIRST habit / faith / study completion now pays twice: the XP or COINS the
   * domain always paid, plus a once-ever badge. Both are EARN rows in the same
   * ledger. The second one is refused by `child_badge_awards (child_id,
   * badge_id)` on every later completion, which is why only the first is 2.
   * `resetTenant` clears the awards so the count does not depend on test order. */
  async function chain(t: Tenant): Promise<{ ledger: number; timeline: number; notification: number }> {
    return {
      ledger: await ledgerCount(t),
      timeline: await rewardTimelineCount(t),
      notification: await notificationCount(t),
    };
  }

  /**
   * ONE CROSSING, ONE PAYMENT — READ OUT OF THE LEDGER AND THE ACCOUNT.
   *
   * `chain().ledger` counts rows and cannot answer this: a badge row and a
   * duplicate XP row both make it 2. The doubling that migration 0030 closed
   * was two XP rows of 15 for one glass of water, and the assertion that would
   * have caught it on the day it was seeded is this one — how many XP rows, for
   * how much, and does `rewards_accounts.xp` agree.
   *
   * The expected amount comes from `PLATFORM_DEFAULT_REWARD_RULES` rather than a
   * literal, so a deliberate re-pricing of a default is one edit and an
   * accidental second payment is still a failure.
   *
   * It also names the RETIRED rule ids explicitly: re-activating `…0005` in some
   * future migration would put the second row back, and the failure should say
   * which rule put it there rather than just «2, expected 1».
   */
  async function assertPaidExactlyOnce(t: Tenant, ruleKey: string): Promise<void> {
    const expected = PLATFORM_DEFAULT_REWARD_RULES.find((r) => r.key === ruleKey);
    if (!expected || expected.rewardType === 'BADGE') throw new Error(`not an amount rule: ${ruleKey}`);

    const rows = await sys('xp ledger', () =>
      prisma.rewardsLedgerEntry.findMany({
        where: { familyId: t.familyId, childId: t.childId, type: 'EARN', rewardType: 'XP' },
      }),
    );

    expect(rows.map((r: any) => ({ amount: r.amount, delta: r.delta }))).toEqual([
      { amount: expected.amount, delta: expected.amount },
    ]);

    // Not paid by a rule 0030 retired.
    const retiredSources = RETIRED_PLATFORM_RULES.map((r) => `reward_rule:${r.id}`);
    expect(rows.filter((r: any) => retiredSources.includes(r.source))).toEqual([]);

    // And the account is the reconcilable cache of that one row, not of two.
    const account = await sys('account', () =>
      prisma.rewardsAccount.findFirst({ where: { familyId: t.familyId, childId: t.childId } }),
    );
    expect(account.xp).toBe(expected.amount);
  }

  /** The badges this child holds right now, by key. */
  const badgeKeys = (t: Tenant): Promise<string[]> =>
    sys('badge keys', async () =>
      (
        await prisma.childBadgeAward.findMany({ where: { childId: t.childId }, include: { badge: true } })
      ).map((a: any) => a.badge.key).sort(),
    );

  async function resetTenant(t: Tenant): Promise<void> {
    await sys('reset', async () => {
      await prisma.notification.deleteMany({ where: { familyId: t.familyId } });
      // 0026: a badge is once-ever per (child, badge), so leaving awards behind
      // would make "the first completion pays twice" true for whichever test
      // ran first and false for every later one — an order-dependent suite.
      await prisma.childBadgeAward.deleteMany({ where: { familyId: t.familyId } });
      await prisma.rewardsLedgerEntry.deleteMany({ where: { familyId: t.familyId } });
      await prisma.rewardsAccount.deleteMany({ where: { familyId: t.familyId } });
      await prisma.lifeTimelineEvent.deleteMany({ where: { familyId: t.familyId } });
      await prisma.consumedMessage.deleteMany({ where: { familyId: t.familyId } });
      await prisma.outboxMessage.deleteMany({ where: { familyId: t.familyId } });
      await prisma.domainEvent.deleteMany({ where: { familyId: t.familyId } });
      await prisma.habitCompletion.deleteMany({ where: { familyId: t.familyId } });
      await prisma.hydrationLog.deleteMany({ where: { familyId: t.familyId } });
      await prisma.activityLog.deleteMany({ where: { familyId: t.familyId } });
      await prisma.faithPracticeLog.deleteMany({ where: { familyId: t.familyId } });
      await prisma.learningSession.deleteMany({ where: { familyId: t.familyId } });
      await prisma.rewardRule.deleteMany({ where: { familyId: t.familyId } });
      await prisma.learningGoal.updateMany({ where: { familyId: t.familyId }, data: { status: 'ACTIVE' } });
    });
  }

  // -------------------------------------------------------------------------
  // lifecycle
  // -------------------------------------------------------------------------

  beforeAll(async () => {
    jest.useFakeTimers({
      doNotFake: [
        'hrtime', 'nextTick', 'performance', 'queueMicrotask',
        'requestAnimationFrame', 'cancelAnimationFrame',
        'requestIdleCallback', 'cancelIdleCallback',
        'setImmediate', 'clearImmediate',
        'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout',
      ],
    });
    jest.setSystemTime(NOON);

    {
      const Redis = require('ioredis');
      const client = new Redis(process.env.REDIS_URL as string);
      const keys = await client.keys('throttle:*');
      if (keys.length > 0) await client.del(...keys);
      await client.quit();
    }

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue(offlinePrismaService())
      .compile();

    app = moduleRef.createNestApplication();
    const { ValidationPipe } = require('@nestjs/common');
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();

    http = app.getHttpServer();
    prisma = app.get(PrismaService);
    relay = app.get(OutboxRelay);
    tokens = app.get(TokenService);

    await registerTenant('a', A, 'UTC');
    await registerTenant('b', B, 'Africa/Cairo');
  }, 180_000);

  afterAll(async () => {
    if (prisma) {
      await sys('teardown', async () => {
        await prisma.device.deleteMany({ where: { id: { in: createdDevices } } });
        await prisma.family.deleteMany({ where: { id: { in: createdFamilies } } });
        await prisma.user.deleteMany({ where: { id: { in: createdUsers } } });
      });
    }
    jest.setSystemTime(NOON);
    jest.useRealTimers();
    await app?.close();
  });

  beforeEach(async () => {
    jest.setSystemTime(NOON);
    await resetTenant(A);
    await resetTenant(B);
  });

  // =========================================================================
  // 0. THE DEFECT ITSELF
  // =========================================================================

  describe('the platform defaults exist and reach a family that configured nothing', () => {
    /** Every platform row PostgreSQL actually holds, retired ones included. */
    const platformRows = (): Promise<any[]> =>
      sys('platform rules', () => prisma.rewardRule.findMany({ where: { familyId: null, programId: null } }));

    it('migration 0007 seeded every rule in the code catalogue, with family_id NULL', async () => {
      // ACTIVE rows only, and 0030 is why. The retired pair below is still on
      // disk — deliberately, so the ledger rows that name it stay resolvable —
      // so the code catalogue is the set of rules that can still PAY, which is
      // what `is_active` means and what the next assertion pins independently.
      const rows = (await platformRows()).filter((r: any) => r.isActive);
      expect(rows).toHaveLength(PLATFORM_DEFAULT_REWARD_RULES.length);

      // Row for row against the code copy — two copies of a constant only stay
      // in agreement if something fails when they diverge.
      for (const expected of PLATFORM_DEFAULT_REWARD_RULES) {
        const row = rows.find(
          (r: any) =>
            r.triggerEngine === expected.triggerEngine &&
            r.eventType === expected.eventType &&
            r.rewardType === expected.rewardType &&
            // Trigger condition is part of the identity because two rules on one
            // engine and one event name may still be two different rules — which
            // is precisely why the unique index hashes the condition.
            JSON.stringify(r.triggerCondition) === JSON.stringify(expected.triggerCondition),
        );
        expect(row).toBeDefined();
        // 0026: `reward_amount_or_badge_id` holds a NUMBER on an XP/COINS rule
        // and a `badge_definitions.key` on a BADGE one, so the comparison goes
        // through the catalogue's own accessor rather than reading `.amount`,
        // which does not exist on a badge rule.
        expect(row.rewardAmountOrBadgeId).toBe(ruleRewardValue(expected));
        expect(row.maxPerDay).toBe(expected.maxPerDay);
        expect(row.isActive).toBe(true);
      }
    });

    /**
     * 0030 — THE RETIRED PAIR IS STILL ON DISK, AND SWITCHED OFF.
     *
     * Both halves matter and neither is decoration. The row SURVIVES because
     * every ledger entry it ever paid records `source = 'reward_rule:<id>'` and
     * there is no foreign key to make that resolvable for us — deleting it would
     * orphan the audit trail of a real child's real XP. It is INACTIVE because
     * `evaluateRewardRules` skips an inactive rule on its first line, which is
     * the actual full stop on the double payment.
     *
     * A `DELETE` in some future tidy-up trips the first assertion; a
     * `is_active = true` resurrection trips the second AND every count in §1.
     */
    it('0030 RETIRED the duplicate DAILY_GOAL_COMPLETED health rules without deleting them', async () => {
      const rows = await platformRows();
      for (const retired of RETIRED_PLATFORM_RULES) {
        const row = rows.find((r: any) => r.id === retired.id);
        expect(row).toBeDefined();
        expect(row.isActive).toBe(false);
        expect(row.triggerEngine).toBe('health');
        expect(row.eventType).toBe('DAILY_GOAL_COMPLETED');
      }

      // No ACTIVE health rule answers `DAILY_GOAL_COMPLETED` any more — the
      // condition the doubling needed, stated against the database rather than
      // against the TypeScript list.
      const activeHealthDailyGoal = rows.filter(
        (r: any) => r.isActive && r.triggerEngine === 'health' && r.eventType === 'DAILY_GOAL_COMPLETED',
      );
      expect(activeHealthDailyGoal).toEqual([]);
    });

    /**
     * THE INVARIANT, AGAINST THE ROWS POSTGRESQL HOLDS — not against the
     * TypeScript list. `reward-rule-collision.spec.ts` checks the code copy in
     * milliseconds; this checks the SEEDED copy, because a migration can insert a
     * paying rule that `reward-rule-catalogue.ts` never mentions and the code-side
     * check would never see it. That is the exact shape of this repository's
     * recurring defect class — «a rule nobody notices» — so it is checked on both
     * sides of the wire.
     */
    it('no seeded rule pays any producer crossing twice — checked on the DATABASE copy', async () => {
      const rows = (await platformRows()).filter((r: any) => r.isActive);

      // The DB rows, in the catalogue's own shape, so the SAME pure function
      // decides the question here as decides it in the unit spec. `key` is the
      // rule id: seeded rows have no key column, and the id is what a failure
      // message needs to point at anyway.
      const asDefaults = rows.map((r: any) =>
        r.rewardType === 'BADGE'
          ? {
              key: `${r.id} (${r.labelAr})`,
              triggerEngine: r.triggerEngine,
              eventType: r.eventType,
              triggerCondition: r.triggerCondition ?? {},
              rewardType: 'BADGE' as const,
              badgeKey: r.rewardAmountOrBadgeId,
              maxPerDay: null,
              maxPerWeek: null,
              category: r.category,
              labelAr: r.labelAr,
            }
          : {
              key: `${r.id} (${r.labelAr})`,
              triggerEngine: r.triggerEngine,
              eventType: r.eventType,
              triggerCondition: r.triggerCondition ?? {},
              rewardType: r.rewardType,
              amount: Number(r.rewardAmountOrBadgeId),
              maxPerDay: r.maxPerDay,
              maxPerWeek: r.maxPerWeek,
              category: r.category,
              labelAr: r.labelAr,
            },
      );

      expect(crossingCollisions(asDefaults as any)).toEqual([]);
    });

    it('EVERY managed rule names an event type — a wildcard rule would pay twice (PA-B-013)', async () => {
      const rows = await platformRows();
      expect(rows.every((r: any) => r.eventType !== null)).toBe(true);
    });

    it('the parent can SEE what the family inherits without having configured anything', async () => {
      const res = await request(http).get('/reward-rules').set(auth(A));
      expect(res.status).toBe(200);

      const platform = res.body.filter((r: any) => r.tier === 'PLATFORM');
      // The retired rows are listed too — `listRewardRulesForFamily` returns
      // every platform row and does not filter on `is_active`. That is the
      // honest rendering: a parent sees the rule and sees `isInEffect: false`
      // beside it, the same way they already see their own deactivated rule.
      expect(platform.length).toBe(PLATFORM_DEFAULT_REWARD_RULES.length + RETIRED_PLATFORM_RULES.length);

      const retiredIds = RETIRED_PLATFORM_RULES.map((r) => r.id);
      const inEffect = platform.filter((r: any) => !retiredIds.includes(r.id));
      expect(inEffect).toHaveLength(PLATFORM_DEFAULT_REWARD_RULES.length);
      expect(inEffect.every((r: any) => r.isInEffect)).toBe(true);
      expect(platform.filter((r: any) => retiredIds.includes(r.id)).every((r: any) => r.isInEffect === false)).toBe(true);

      expect(res.body.filter((r: any) => r.tier === 'FAMILY')).toHaveLength(0);
    });
  });

  // =========================================================================
  // 1. EACH DOMAIN, END TO END, ON THE PATH A REAL CLIENT USES
  // =========================================================================

  describe('a completion grants exactly one reward, one timeline entry and one notification', () => {
    it('HABIT — POST /self/habits/:id/complete', async () => {
      const res = await request(http)
        .post(`/life-intelligence/self/habits/${A.habitId}/complete`)
        .set(deviceAuth(A))
        .send({});
      expect([200, 201]).toContain(res.status);

      // TWO ledger rows, ONE timeline entry, ONE `REWARD_GRANTED` notification.
      // The second ledger row is the `first_habit` badge migration 0026 seeded;
      // it is a once-ever grant, so this is 2 only because `resetTenant` cleared
      // the award. The timeline and notification counters are unchanged: a
      // trigger writes one `reward_granted` entry and one `REWARD_GRANTED`
      // notification no matter how many rules matched it.
      expect(await chain(A)).toEqual({ ledger: 2, timeline: 1, notification: 1 });
      expect(await badgeKeys(A)).toEqual(['first_habit']);
    });

    /**
     * ======================================================================
     * THE TRIPWIRE THAT TRIPPED, AND WHAT IT NOW GUARDS.
     * ======================================================================
     *
     * THIS TEST USED TO ASSERT `ledger: 1` AND `badgeKeys: []`, with a comment
     * saying the absence was pinned «so a future badge rule on this trigger
     * cannot change the count silently». It was doing exactly its job when it
     * went red: `HealthEngineService.logHydration` began firing the contract
     * name `HYDRATION_GOAL_COMPLETED` beside its `DAILY_GOAL_COMPLETED`, which
     * made 0026's `first_hydration_goal` badge earnable through the app's own
     * button for the first time — a real fix — and the counts moved.
     *
     * THE MEASUREMENT THE MOVE EXPOSED. `ledger` did not go 1 -> 2 (XP + badge).
     * It went 1 -> 3, and `rewards_accounts.xp` read 30 for one glass of water:
     * migration 0007 had seeded a paying rule for BOTH names — `…0005`
     * (`DAILY_GOAL_COMPLETED {metric: hydration}`, 15 XP) and `…0003`
     * (`HYDRATION_GOAL_COMPLETED`, 15 XP) — with byte-identical `label_ar`.
     * Different rule ids mean different ledger keys, so the UNIQUE constraint
     * could not collapse them. Migration 0030 retired `…0005`.
     *
     * SO THE NUMBERS ARE UPDATED AND THE TEETH ARE SHARPER, not blunter. It now
     * asserts the XP AMOUNT and the ledger row COUNT per currency, which is the
     * assertion that would have caught the doubling on the day it was seeded —
     * `ledger: 2` alone would have passed while a child was paid twice, because
     * the badge row also counts as 2.
     */
    it('HYDRATION / HEALTH — POST /self/health/hydration-logs, once the goal is actually reached', async () => {
      // BELOW the target: a log is written, the goal is not met, nothing pays.
      await request(http).post('/life-intelligence/self/health/hydration-logs').set(deviceAuth(A)).send({ amountMl: 100 });
      expect(await chain(A)).toEqual({ ledger: 0, timeline: 0, notification: 0 });

      // Crossing the target is the VERIFICATION CONDITION, computed server-side
      // from the child's age and the stored logs on the family's business day.
      await request(http).post('/life-intelligence/self/health/hydration-logs').set(deviceAuth(A)).send({ amountMl: 3000 });

      // XP + the once-ever `first_hydration_goal` badge — the same shape HABIT
      // and FAITH have had since 0026, and the shape this door could not reach
      // until the contract name was fired.
      expect(await chain(A)).toEqual({ ledger: 2, timeline: 1, notification: 1 });
      expect(await badgeKeys(A)).toEqual(['first_hydration_goal']);

      // AND THE CHILD WAS PAID ONCE. This is the assertion the count alone
      // cannot make: EXACTLY ONE XP row, for EXACTLY the catalogue's amount, and
      // an account balance that agrees with it.
      await assertPaidExactlyOnce(A, 'default:hydration:goal');
    });

    it('ACTIVITY — POST /self/health/activity-logs, once the daily minutes are actually reached', async () => {
      await request(http).post('/life-intelligence/self/health/activity-logs').set(deviceAuth(A)).send({ date: FAKE_DAY, activityType: 'WALKING', durationMinutes: 10 });
      expect(await chain(A)).toEqual({ ledger: 0, timeline: 0, notification: 0 });

      await request(http).post('/life-intelligence/self/health/activity-logs').set(deviceAuth(A)).send({ date: FAKE_DAY, activityType: 'WALKING', durationMinutes: 90 });

      // Same as hydration above, and for the same two reasons: the contract name
      // `ACTIVITY_GOAL_COMPLETED` is what `first_activity_goal` is seeded
      // against, and 0030 retired the second XP rule that was paying alongside.
      expect(await chain(A)).toEqual({ ledger: 2, timeline: 1, notification: 1 });
      expect(await badgeKeys(A)).toEqual(['first_activity_goal']);
      await assertPaidExactlyOnce(A, 'default:activity:goal');
    });

    it('FAITH — POST /self/faith/:practiceId/log', async () => {
      const res = await request(http)
        .post(`/life-intelligence/self/faith/${A.practiceId}/log`)
        .set(deviceAuth(A))
        .send({});
      expect([200, 201]).toContain(res.status);

      // XP + the once-ever `first_faith_practice` badge (0026).
      expect(await chain(A)).toEqual({ ledger: 2, timeline: 1, notification: 1 });
      expect(await badgeKeys(A)).toEqual(['first_faith_practice']);
    });

    it('LEARNING / EDUCATION — POST /self/learning/sessions', async () => {
      const res = await request(http)
        .post('/life-intelligence/self/learning/sessions')
        .set(deviceAuth(A))
        .send({ subject: 'MATH', durationMinutes: 30, date: FAKE_DAY });
      expect([200, 201]).toContain(res.status);

      // XP + the once-ever `first_study_session` badge (0026).
      expect(await chain(A)).toEqual({ ledger: 2, timeline: 1, notification: 1 });
      expect(await badgeKeys(A)).toEqual(['first_study_session']);
    });

    it('EDUCATION through the OUTBOX path — POST /events/batch reaches the same three', async () => {
      const res = await request(http)
        .post('/events/batch')
        .set(deviceAuth(A))
        .send({
          deviceTime: new Date().toISOString(),
          events: [
            {
              clientEventId: 'b4:edu:1',
              type: 'EDUCATION_PROGRESS',
              occurredAt: new Date().toISOString(),
              payload: { goalId: A.goalId, milestone: 1 },
            },
          ],
        });
      expect(res.body.data.accepted).toBe(1);

      await drainOutbox();

      // The timeline entry is the half this path NEVER had before B4:
      // `/events/batch` runs no domain service, so no domain `timeline.record`
      // is reached. The engine writes it now, on both paths.
      expect(await chain(A)).toEqual({ ledger: 1, timeline: 1, notification: 1 });
    });
  });

  // =========================================================================
  // 2. VERIFICATION IS NOT OPTIONAL
  // =========================================================================

  describe('a reward is granted only after the real verification condition succeeds', () => {
    it('GOALS — a goal with fewer than two logged sessions cannot be completed, and pays nothing', async () => {
      const res = await request(http)
        .post(`/life-intelligence/learning/${A.childId}/goals/${A.goalId}/complete`)
        .set(auth(A))
        .send({});

      expect(res.status).toBe(409);
      expect(res.body.code).toBe('LEARNING_GOAL_NOT_VERIFIED');
      expect(await chain(A)).toEqual({ ledger: 0, timeline: 0, notification: 0 });

      const goal = await sys('goal', () => prisma.learningGoal.findFirst({ where: { id: A.goalId } }));
      expect(goal.status).toBe('ACTIVE');
    });

    it('GOALS — with the sessions really logged, it completes and pays exactly once', async () => {
      for (const subject of ['MATH', 'SCIENCE']) {
        await request(http)
          .post(`/life-intelligence/learning/${A.childId}/sessions`)
          .set(auth(A))
          .send({ subject, durationMinutes: 25, goalId: A.goalId, date: FAKE_DAY });
      }
      // Two sessions have themselves paid (the learning default), so measure the
      // DELTA the goal completion adds rather than the absolute.
      const before = await chain(A);

      const res = await request(http)
        .post(`/life-intelligence/learning/${A.childId}/goals/${A.goalId}/complete`)
        .set(auth(A))
        .send({});
      expect([200, 201]).toContain(res.status);
      expect(res.body.status).toBe('COMPLETED');

      const after = await chain(A);
      // COINS for the goal, plus the once-ever `first_learning_goal` badge
      // (0026). `first_study_session` was already earned by the two sessions
      // above and is therefore inside `before`, not in the delta — which is the
      // once-ever property, measured rather than assumed.
      expect(after.ledger - before.ledger).toBe(2);
      expect(after.timeline - before.timeline).toBe(1);
      expect(await badgeKeys(A)).toEqual(['first_learning_goal', 'first_study_session']);
    });

    it('a rule that demands PARENT verification pays nothing for a SELF-asserted completion', async () => {
      // The family takes ownership of the habit engine with a stricter rule.
      const created = await request(http).post('/reward-rules').set(auth(A)).send({
        triggerEngine: 'habit-builder',
        eventType: 'HABIT_COMPLETED',
        rewardType: 'XP',
        amount: 30,
        minVerifiedBy: 'PARENT',
        category: 'HABITS',
        labelAr: 'عادة بموافقة الوالد',
      });
      expect([200, 201]).toContain(created.status);

      // The CHILD's own device: `verifiedBy = SELF`. Below the floor.
      await request(http).post(`/life-intelligence/self/habits/${A.habitId}/complete`).set(deviceAuth(A)).send({});
      expect(await chain(A)).toEqual({ ledger: 0, timeline: 0, notification: 0 });

      // The PARENT's own session on a different day: `verifiedBy = PARENT`.
      await request(http)
        .post(`/life-intelligence/habits/${A.childId}/${A.habitId}/complete`)
        .set(auth(A))
        .send({ date: FAKE_DAY });
      const after = await chain(A);
      expect(after.ledger).toBe(1);
    });
  });

  // =========================================================================
  // 3. IDEMPOTENCY: REPLAY, REDELIVERY, CONCURRENCY
  // =========================================================================

  describe('one business event produces one reward, under replay and under concurrency', () => {
    it('THE REPLAY — the same habit completed again on the same business day adds nothing', async () => {
      await request(http).post(`/life-intelligence/self/habits/${A.habitId}/complete`).set(deviceAuth(A)).send({});
      // XP + the once-ever `first_habit` badge (0026).
      expect(await chain(A)).toEqual({ ledger: 2, timeline: 1, notification: 1 });

      for (let i = 0; i < 5; i++) {
        await request(http).post(`/life-intelligence/self/habits/${A.habitId}/complete`).set(deviceAuth(A)).send({});
      }
      // Unchanged after five replays — the XP row by its idempotency key, the
      // badge row by `child_badge_awards (child_id, badge_id)`.
      expect(await chain(A)).toEqual({ ledger: 2, timeline: 1, notification: 1 });
      expect(await badgeKeys(A)).toEqual(['first_habit']);
    });

    it('THE RACE — 8 concurrent identical completions produce exactly one reward', async () => {
      const results = await Promise.all(
        Array.from({ length: 8 }, () =>
          request(http).post(`/life-intelligence/self/habits/${A.habitId}/complete`).set(deviceAuth(A)).send({}),
        ),
      );
      expect(results.filter((r) => [200, 201].includes(r.status)).length).toBeGreaterThan(0);

      const seen = await chain(A);
      // ONE XP row and ONE badge row out of eight concurrent attempts. The
      // badge half is the stronger statement: eight racing INSERTs into
      // `child_badge_awards` and the UNIQUE constraint admits exactly one.
      expect(seen.ledger).toBe(2);
      expect(seen.timeline).toBe(1);
      expect(await badgeKeys(A)).toEqual(['first_habit']);
    });

    it('THE RACE — 6 concurrent completions of ONE learning goal complete it once and pay once', async () => {
      for (const subject of ['MATH', 'SCIENCE']) {
        await request(http)
          .post(`/life-intelligence/learning/${A.childId}/sessions`)
          .set(auth(A))
          .send({ subject, durationMinutes: 25, goalId: A.goalId, date: FAKE_DAY });
      }
      const before = await chain(A);

      const results = await Promise.all(
        Array.from({ length: 6 }, () =>
          request(http)
            .post(`/life-intelligence/learning/${A.childId}/goals/${A.goalId}/complete`)
            .set(auth(A))
            .send({}),
        ),
      );
      // The conditional UPDATE (`WHERE status = 'ACTIVE'`) is the single
      // serialisation point: exactly one request moves the row.
      expect(results.filter((r) => [200, 201].includes(r.status))).toHaveLength(1);
      expect(results.filter((r) => r.status === 409)).toHaveLength(5);

      const after = await chain(A);
      // COINS + the once-ever `first_learning_goal` badge (0026), from the ONE
      // request that moved the row; the other five paid nothing at all.
      expect(after.ledger - before.ledger).toBe(2);
    });

    it('THE REDELIVERY — replaying the outbox does not add a second reward', async () => {
      await request(http)
        .post('/events/batch')
        .set(deviceAuth(A))
        .send({
          deviceTime: new Date().toISOString(),
          events: [
            {
              clientEventId: 'b4:redeliver:1',
              type: 'EDUCATION_PROGRESS',
              occurredAt: new Date().toISOString(),
              payload: { goalId: A.goalId, milestone: 3 },
            },
          ],
        });
      await drainOutbox();
      expect(await chain(A)).toEqual({ ledger: 1, timeline: 1, notification: 1 });

      // Force every PUBLISHED message back to PENDING and drain again — an
      // at-least-once delivery, exactly as the relay would produce after a crash
      // between the handler and the acknowledgement.
      await sys('force redelivery', () =>
        prisma.outboxMessage.updateMany({
          where: { familyId: A.familyId },
          data: { status: 'PENDING', attemptCount: 0, lockedBy: null, lockedAt: null, publishedAt: null },
        }),
      );
      await drainOutbox();

      expect(await chain(A)).toEqual({ ledger: 1, timeline: 1, notification: 1 });
    });
  });

  // =========================================================================
  // 4. CAPS, ON THE FAMILY'S BUSINESS DAY
  // =========================================================================

  describe('maxPerDay and maxPerWeek are counted on the family calendar', () => {
    it('a maxPerDay of 1 stops the second DIFFERENT habit on the same business day', async () => {
      await request(http).post('/reward-rules').set(auth(A)).send({
        triggerEngine: 'habit-builder',
        eventType: 'HABIT_COMPLETED',
        rewardType: 'XP',
        amount: 25,
        maxPerDay: 1,
        category: 'HABITS',
      });

      const second = await request(http)
        .post(`/life-intelligence/habits/${A.childId}`)
        .set(auth(A))
        .send({ title: 'B4 Second Habit', category: 'LEARNING' });

      // Two DIFFERENT habits: two different idempotency keys, both legitimate.
      // Only the cap can stop the second one.
      await request(http).post(`/life-intelligence/self/habits/${A.habitId}/complete`).set(deviceAuth(A)).send({});
      await request(http).post(`/life-intelligence/self/habits/${second.body.id}/complete`).set(deviceAuth(A)).send({});

      expect((await chain(A)).ledger).toBe(1);
    });

    it('THE NEXT BUSINESS DAY — a legitimate completion tomorrow earns a SECOND reward', async () => {
      await request(http).post('/reward-rules').set(auth(A)).send({
        triggerEngine: 'habit-builder',
        eventType: 'HABIT_COMPLETED',
        rewardType: 'XP',
        amount: 25,
        maxPerDay: 1,
        category: 'HABITS',
      });

      await request(http).post(`/life-intelligence/self/habits/${A.habitId}/complete`).set(deviceAuth(A)).send({});
      expect((await chain(A)).ledger).toBe(1);

      // Tomorrow, on the family's calendar. The idempotency key carries the
      // business date, so this is a genuinely different key AND a fresh cap
      // window. The fix for the replay exploit must not have become "one reward
      // per habit, ever".
      jest.setSystemTime(at(NEXT_DAY, '09:00'));
      // A 15-minute access token does not survive a 21-hour jump, so the device
      // re-authenticates exactly as a real one would the next morning.
      const tomorrowToken = (await runWithTenant(
        { familyId: A.familyId, actorType: 'DEVICE', actorId: A.deviceId },
        () => tokens.issueTokenPair({ subjectId: A.deviceId, actorType: 'DEVICE', familyId: A.familyId }),
      )).accessToken;

      const second = await request(http)
        .post(`/life-intelligence/self/habits/${A.habitId}/complete`)
        .set({ Authorization: `Bearer ${tomorrowToken}` })
        .send({});
      expect([200, 201]).toContain(second.status);

      // TWO rows, on two different business dates — the B1 fix bounded the
      // exploit without turning a habit into a once-in-a-lifetime reward.
      const entries = await sys('ledger', () =>
        prisma.rewardsLedgerEntry.findMany({ where: { familyId: A.familyId, type: 'EARN' }, orderBy: { businessDate: 'asc' } }),
      );
      expect(entries).toHaveLength(2);
      expect(entries.map((e: any) => new Date(e.businessDate).toISOString().slice(0, 10))).toEqual([FAKE_DAY, NEXT_DAY]);
      jest.setSystemTime(NOON);
    });

    it('the cap is enforced under CONCURRENCY, not just sequentially', async () => {
      await request(http).post('/reward-rules').set(auth(A)).send({
        triggerEngine: 'habit-builder',
        eventType: 'HABIT_COMPLETED',
        rewardType: 'XP',
        amount: 25,
        maxPerDay: 1,
        category: 'HABITS',
      });

      const extra: string[] = [];
      for (let i = 0; i < 4; i++) {
        const h = await request(http)
          .post(`/life-intelligence/habits/${A.childId}`)
          .set(auth(A))
          .send({ title: `B4 Race Habit ${i}`, category: 'LEARNING' });
        extra.push(h.body.id);
      }

      // Four DIFFERENT habits completed at once. Four different, perfectly
      // valid idempotency keys — the unique index cannot help here, only the
      // advisory lock around the cap count can.
      await Promise.all(
        extra.map((id) =>
          request(http).post(`/life-intelligence/self/habits/${id}/complete`).set(deviceAuth(A)).send({}),
        ),
      );

      expect((await chain(A)).ledger).toBe(1);
    });
  });

  // =========================================================================
  // 5. THE CHILD CANNOT SELF-GRANT ON ANY NEWLY CONNECTED PATH
  // =========================================================================

  describe('a child device cannot grant itself anything on the paths B4 connected', () => {
    it('cannot author a reward rule', async () => {
      const res = await request(http).post('/reward-rules').set(deviceAuth(A)).send({
        triggerEngine: 'habit-builder',
        eventType: 'HABIT_COMPLETED',
        rewardType: 'XP',
        amount: 1000,
      });
      expect(res.status).toBe(401);

      const rules = await sys('rules', () =>
        prisma.rewardRule.count({ where: { familyId: A.familyId } }),
      );
      expect(rules).toBe(0);
    });

    it('cannot list, patch, deactivate or delete a reward rule', async () => {
      const created = await request(http).post('/reward-rules').set(auth(A)).send({
        triggerEngine: 'faith', eventType: 'FAITH_PRACTICE_COMPLETED', rewardType: 'XP', amount: 5,
      });
      const id = created.body.id;

      // Each call is built AND awaited one at a time: supertest opens its own
      // ephemeral listener per request, so pre-building several into an array
      // races them against each other's ports.
      const calls: Array<() => Promise<any>> = [
        () => request(http).get('/reward-rules').set(deviceAuth(A)),
        () => request(http).get('/reward-rules/catalogue').set(deviceAuth(A)),
        () => request(http).patch(`/reward-rules/${id}`).set(deviceAuth(A)).send({ amount: 999 }),
        () => request(http).post(`/reward-rules/${id}/deactivate`).set(deviceAuth(A)).send({}),
        () => request(http).delete(`/reward-rules/${id}`).set(deviceAuth(A)),
      ];
      for (const call of calls) {
        expect((await call()).status).toBe(401);
      }

      const row = await sys('rule', () => prisma.rewardRule.findFirst({ where: { id } }));
      expect(row.rewardAmountOrBadgeId).toBe('5');
      expect(row.isActive).toBe(true);
    });

    it('cannot complete a learning goal — the highest-value single payout in the domain', async () => {
      for (const subject of ['MATH', 'SCIENCE']) {
        await request(http)
          .post(`/life-intelligence/learning/${A.childId}/sessions`)
          .set(auth(A))
          .send({ subject, durationMinutes: 25, goalId: A.goalId, date: FAKE_DAY });
      }
      const before = await chain(A);

      const res = await request(http)
        .post(`/life-intelligence/learning/${A.childId}/goals/${A.goalId}/complete`)
        .set(deviceAuth(A))
        .send({});
      expect(res.status).toBe(401);

      expect(await chain(A)).toEqual(before);
      const goal = await sys('goal', () => prisma.learningGoal.findFirst({ where: { id: A.goalId } }));
      expect(goal.status).toBe('ACTIVE');
    });

    it('cannot choose the business day on the faith path — the key is server-composed', async () => {
      // PA-B-004's shape, closed for Faith in the same commit that made Faith
      // pay. A device sending a date gets it ignored; six attempts with six
      // different dates are one reward, not six.
      for (const date of ['2001-01-01', '2002-02-02', '2003-03-03', '2004-04-04', '2005-05-05', '2006-06-06']) {
        await request(http)
          .post(`/life-intelligence/self/faith/${A.practiceId}/log`)
          .set(deviceAuth(A))
          .send({ date });
      }
      // ONE XP row and ONE badge row for the whole six — not six of each.
      expect((await chain(A)).ledger).toBe(2);
      expect(await badgeKeys(A)).toEqual(['first_faith_practice']);
    });
  });

  // =========================================================================
  // 6. CROSS-FAMILY ISOLATION ON EVERY NEW PATH
  // =========================================================================

  describe('cross-family isolation', () => {
    it("family A's rule is invisible to family B and does not pay family B", async () => {
      await request(http).post('/reward-rules').set(auth(A)).send({
        triggerEngine: 'habit-builder', eventType: 'HABIT_COMPLETED', rewardType: 'XP', amount: 500,
      });

      const bList = await request(http).get('/reward-rules').set(auth(B));
      expect(bList.body.filter((r: any) => r.tier === 'FAMILY')).toHaveLength(0);

      await request(http).post(`/life-intelligence/self/habits/${B.habitId}/complete`).set(deviceAuth(B)).send({});

      // B earns the PLATFORM defaults — 10 XP, never A's 500 — plus the
      // once-ever `first_habit` badge 0026 seeded for the same trigger.
      const entries = await sys('B ledger', () =>
        prisma.rewardsLedgerEntry.findMany({ where: { familyId: B.familyId, type: 'EARN' } }),
      );
      expect(entries).toHaveLength(2);
      const xp = entries.filter((e: any) => e.rewardType === 'XP');
      expect(xp).toHaveLength(1);
      expect(xp[0].amount).toBe(10);
      expect(entries.filter((e: any) => e.rewardType === 'BADGE')).toHaveLength(1);
      expect(await badgeKeys(B)).toEqual(['first_habit']);
    });

    it("family A's parent cannot read, patch, deactivate or delete family B's rule — 404, never 403", async () => {
      const created = await request(http).post('/reward-rules').set(auth(B)).send({
        triggerEngine: 'health', eventType: 'HYDRATION_GOAL_COMPLETED', rewardType: 'XP', amount: 42,
      });
      const bRuleId = created.body.id;

      const calls: Array<() => Promise<any>> = [
        () => request(http).patch(`/reward-rules/${bRuleId}`).set(auth(A)).send({ amount: 999 }),
        () => request(http).post(`/reward-rules/${bRuleId}/deactivate`).set(auth(A)).send({}),
        () => request(http).delete(`/reward-rules/${bRuleId}`).set(auth(A)),
      ];
      for (const call of calls) {
        // 404 and not 403: a 403 would CONFIRM the row exists, which is an
        // oracle an attacker can enumerate with (F2 / BA-016).
        expect((await call()).status).toBe(404);
      }

      const row = await sys('B rule', () => prisma.rewardRule.findFirst({ where: { id: bRuleId } }));
      expect(row.rewardAmountOrBadgeId).toBe('42');
      expect(row.isActive).toBe(true);
    });

    it('a PLATFORM rule cannot be edited or deleted by any family', async () => {
      const platform = await sys('platform rule', () =>
        prisma.rewardRule.findFirst({ where: { familyId: null, programId: null } }),
      );

      expect((await request(http).patch(`/reward-rules/${platform.id}`).set(auth(A)).send({ amount: 999 })).status).toBe(404);
      expect((await request(http).delete(`/reward-rules/${platform.id}`).set(auth(A))).status).toBe(404);

      const still = await sys('platform rule again', () =>
        prisma.rewardRule.findFirst({ where: { id: platform.id } }),
      );
      expect(still.rewardAmountOrBadgeId).toBe(platform.rewardAmountOrBadgeId);
    });
  });

  // =========================================================================
  // 7. PRECEDENCE — OPT IN AND OPT OUT
  // =========================================================================

  describe('a family that configures an engine takes it over completely', () => {
    it("one family rule shadows ALL the platform defaults for that engine — the family's amount is paid, once", async () => {
      await request(http).post('/reward-rules').set(auth(A)).send({
        triggerEngine: 'habit-builder', eventType: 'HABIT_COMPLETED', rewardType: 'XP', amount: 77,
      });

      await request(http).post(`/life-intelligence/self/habits/${A.habitId}/complete`).set(deviceAuth(A)).send({});

      const entries = await sys('ledger', () =>
        prisma.rewardsLedgerEntry.findMany({ where: { familyId: A.familyId, type: 'EARN' } }),
      );
      // ONE row, and it is the family's 77 — not the family's 77 AND the
      // platform's 10, which is what a naive two-tier read would have paid.
      expect(entries).toHaveLength(1);
      expect(entries[0].amount).toBe(77);
    });

    it('deactivating the rule turns the engine OFF rather than reverting to the default', async () => {
      const created = await request(http).post('/reward-rules').set(auth(A)).send({
        triggerEngine: 'habit-builder', eventType: 'HABIT_COMPLETED', rewardType: 'XP', amount: 77,
      });
      expect((await request(http).post(`/reward-rules/${created.body.id}/deactivate`).set(auth(A)).send({})).status).toBe(204);

      await request(http).post(`/life-intelligence/self/habits/${A.habitId}/complete`).set(deviceAuth(A)).send({});

      expect(await chain(A)).toEqual({ ledger: 0, timeline: 0, notification: 0 });
    });

    it('DELETING the rule hands the engine back to the platform defaults', async () => {
      const created = await request(http).post('/reward-rules').set(auth(A)).send({
        triggerEngine: 'habit-builder', eventType: 'HABIT_COMPLETED', rewardType: 'XP', amount: 77,
      });
      expect((await request(http).delete(`/reward-rules/${created.body.id}`).set(auth(A))).status).toBe(204);

      await request(http).post(`/life-intelligence/self/habits/${A.habitId}/complete`).set(deviceAuth(A)).send({});

      const entries = await sys('ledger', () =>
        prisma.rewardsLedgerEntry.findMany({ where: { familyId: A.familyId, type: 'EARN' } }),
      );
      // BOTH platform defaults for this engine are back in force — the 10 XP
      // and the `first_habit` badge 0026 seeded against the same trigger.
      expect(entries).toHaveLength(2);
      const xp = entries.filter((e: any) => e.rewardType === 'XP');
      expect(xp).toHaveLength(1);
      expect(xp[0].amount).toBe(10); // the platform default, back in force
      expect(await badgeKeys(A)).toEqual(['first_habit']);
    });
  });

  // =========================================================================
  // 8. VALIDATION AND CONFIGURABLE CATEGORIES
  // =========================================================================

  describe('rule validation, and categories that stay configurable', () => {
    it('the catalogue serves the category list from the TABLE, including the four B4 added', async () => {
      const res = await request(http).get('/reward-rules/catalogue').set(auth(A));
      expect(res.status).toBe(200);

      const codes = res.body.categories.map((c: any) => c.code);
      for (const required of ['RELIGION', 'QURAN', 'HADITH', 'FIQH', 'MANNERS', 'STUDY', 'SCIENCE', 'PROGRAMMING', 'MATH', 'READING', 'SPORT', 'FITNESS', 'HEALTH', 'HABITS', 'FAMILY_CONTRIBUTION', 'CUSTOM']) {
        expect(codes).toContain(required);
      }
    });

    it('a category added to the TABLE is immediately usable, with no deploy and no enum change', async () => {
      await sys('operator adds a category', () =>
        prisma.rewardProgramCategory.upsert({
          where: { code: 'B4_OPERATOR_ADDED' },
          create: { code: 'B4_OPERATOR_ADDED', labelAr: 'تصنيف مُضاف', streakKind: 'learning', sortOrder: 999 },
          update: {},
        }),
      );

      const res = await request(http).post('/reward-rules').set(auth(A)).send({
        triggerEngine: 'faith', eventType: 'FAITH_PRACTICE_COMPLETED', rewardType: 'XP', amount: 5,
        category: 'B4_OPERATOR_ADDED',
      });
      expect([200, 201]).toContain(res.status);
      expect(res.body.category).toBe('B4_OPERATOR_ADDED');

      await sys('cleanup category', async () => {
        await prisma.rewardRule.deleteMany({ where: { familyId: A.familyId } });
        await prisma.rewardProgramCategory.delete({ where: { code: 'B4_OPERATOR_ADDED' } });
      });
    });

    it('rejects an unknown category, an unknown event type, an unknown engine and an out-of-range amount', async () => {
      const base = { triggerEngine: 'habit-builder', eventType: 'HABIT_COMPLETED', rewardType: 'XP', amount: 10 };

      expect((await request(http).post('/reward-rules').set(auth(A)).send({ ...base, category: 'NOPE' })).status).toBe(400);
      expect((await request(http).post('/reward-rules').set(auth(A)).send({ ...base, eventType: 'habit_completed' })).status).toBe(400);
      expect((await request(http).post('/reward-rules').set(auth(A)).send({ ...base, triggerEngine: 'not-an-engine' })).status).toBe(400);
      expect((await request(http).post('/reward-rules').set(auth(A)).send({ ...base, amount: 100000 })).status).toBe(400);
      expect((await request(http).post('/reward-rules').set(auth(A)).send({ ...base, amount: 0 })).status).toBe(400);

      expect(await sys('rules', () => prisma.rewardRule.count({ where: { familyId: A.familyId } }))).toBe(0);
    });

    it('rejects a second identical active rule, with a readable Arabic code', async () => {
      const body = { triggerEngine: 'habit-builder', eventType: 'HABIT_COMPLETED', rewardType: 'XP', amount: 10 };
      expect([200, 201]).toContain((await request(http).post('/reward-rules').set(auth(A)).send(body)).status);

      const dup = await request(http).post('/reward-rules').set(auth(A)).send(body);
      expect(dup.status).toBe(409);
      expect(dup.body.code).toBe('RULE_ALREADY_EXISTS');
      expect(typeof dup.body.messageAr).toBe('string');
    });

    it('the legacy KEYLESS trigger names cannot be written into a rule at all (PA-B-013)', async () => {
      for (const eventType of ['habit_completed', 'practice_logged', 'hydration_event']) {
        const res = await request(http).post('/reward-rules').set(auth(A)).send({
          triggerEngine: 'habit-builder', eventType, rewardType: 'XP', amount: 10,
        });
        expect(res.status).toBe(400);
      }
    });
  });
});
