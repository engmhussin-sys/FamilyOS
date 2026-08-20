/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-var-requires */
/**
 * THE BADGE CATALOGUE, PROVEN BY EXECUTION — 0026.
 *
 * ===========================================================================
 * WHAT WAS BROKEN, AND HOW IT WAS MEASURED RATHER THAN READ.
 * ===========================================================================
 *
 * `badge_definitions` had no writer anywhere: no seed, no INSERT in migrations
 * 0001..0025, no admin route. `findBadgeByKey` returned NULL for every key, so
 * the live `awardBadgeIfNotAlready` below it could never be reached with a real
 * badge id and `child_badge_awards` was empty in every environment.
 *
 * The hole was twice the size the audit stated. The ONLY path that awards a
 * badge is a `RewardRule` with `reward_type = 'BADGE'` flowing through
 * `RewardsEngineService.processTriggerEvent`, and there were zero such rules
 * and no way to author one (`CreateRewardRuleDto` is `@IsIn(['XP','COINS'])`,
 * `PROGRAM_REWARD_TYPES` has no BADGE member, and 0007's sixteen defaults are
 * all XP or COINS). Definitions alone would have been a catalogue nobody looks
 * up. 0026 writes both halves from one list.
 *
 * ===========================================================================
 * WHAT THIS FILE PROVES, against a REAL PostgreSQL, a REAL Redis and the REAL
 * application — real guards, real tenant extension, real `RewardsEngineService`,
 * nothing stubbed.
 * ===========================================================================
 *
 *   THE SEED       every badge in `PLATFORM_BADGES` resolves through the REAL
 *                  `findBadgeByKey`, with the Arabic copy and the criteria the
 *                  code catalogue declares. Red before 0026 is applied.
 *   THE EARNING    a child who completes a habit — through the device route a
 *                  real Child App calls, with a family that configured NOTHING
 *                  — ends up with a `child_badge_awards` row, and can read it
 *                  back from their own `/self/achievements/badges` with an
 *                  Arabic title. Red before 0026: the award path was silent.
 *   THE REPLAY     the same action again, twice more, on two business days:
 *                  still exactly ONE badge. Proven by REPLAYING the HTTP call,
 *                  not by asserting that some branch was taken.
 *   THE RATCHET    every badge key the code asks for resolves to a definition,
 *                  AND every seeded definition is asked for by something. Both
 *                  directions, because a definition nobody looks up is the same
 *                  dormancy as a lookup with no definition. A future
 *                  `findBadgeByKey('new_thing')` with no seed turns this red.
 */
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as fs from 'fs';
import * as path from 'path';
import request = require('supertest');

import { AppModule } from '../../src/app.module';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { createTenantExtension } from '../../src/common/tenancy/tenant.extension';
import { runAsSystemAsync } from '../../src/common/tenancy/system-context';
import { runWithTenant } from '../../src/common/tenancy/tenant-context';
import { TokenService } from '../../src/modules/auth/application/services/token.service';
import { PrismaRewardsRepository } from '../../src/modules/life-intelligence/infrastructure/repositories/prisma-rewards.repository';
import { PLATFORM_BADGES } from '../../src/shared/rewards/badge-catalogue';
import {
  PLATFORM_DEFAULT_BADGE_RULES,
  PLATFORM_DEFAULT_REWARD_RULES,
  RETIRED_PLATFORM_RULES,
  ruleRewardValue,
} from '../../src/shared/rewards/reward-rule-catalogue';
import { integrationDatabaseUrl } from '../tenancy/prisma-test-client';

const describeIfDb = integrationDatabaseUrl() ? describe : describe.skip;

const DAY_MS = 24 * 60 * 60 * 1000;
const FAKE_DAY = new Date(Date.now() - DAY_MS).toISOString().slice(0, 10);
const NOON = new Date(`${FAKE_DAY}T12:00:00.000Z`);

function offlinePrismaService(): any {
  const url = process.env.INTEGRATION_DATABASE_URL as string;
  if (process.env.PRISMA_DRIVER_ADAPTER === 'pg') {
    const { PrismaClient } = require('@prisma/client/wasm');
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
  const base = new PrismaClient({ datasources: { db: { url } } });
  const extended = base.$extends(createTenantExtension());
  extended.onModuleInit = async () => base.$connect();
  extended.onModuleDestroy = async () => base.$disconnect();
  return extended;
}

/** Every `.ts` file under `src/`, for the static half of the ratchet. */
function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(full, out);
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

describeIfDb('0026 — the badge catalogue (real PostgreSQL, real Redis, real app)', () => {
  let app: INestApplication;
  let http: any;
  let prisma: any;
  let tokens: TokenService;
  /** The REAL repository the engine uses — not a re-implementation of it. */
  let rewards: PrismaRewardsRepository;

  const stamp = Date.now();
  const T = {} as {
    familyId: string;
    userId: string;
    parentToken: string;
    childId: string;
    habitId: string;
    practiceId: string;
    deviceToken: string;
    deviceId: string;
  };

  const sys = (what: string, fn: () => Promise<any>): Promise<any> =>
    runAsSystemAsync('TEST_FIXTURE', `badge catalogue suite: ${what}`, async () => await fn());

  const auth = () => ({ Authorization: `Bearer ${T.parentToken}` });
  const deviceAuth = () => ({ Authorization: `Bearer ${T.deviceToken}` });

  const badgeAwards = (): Promise<any[]> =>
    sys('badge awards', () =>
      prisma.childBadgeAward.findMany({ where: { childId: T.childId }, include: { badge: true } }),
    );

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
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();

    http = app.getHttpServer();
    prisma = app.get(PrismaService);
    tokens = app.get(TokenService);
    rewards = app.get(PrismaRewardsRepository);

    // --- the family under test. It configures NOTHING: no rule is created by
    // hand anywhere in this file, because supplying the one thing production
    // never had is exactly how this defect stayed invisible. ---------------
    const email = `badge.${stamp}@example.com`;
    const password = 'Badge-Catalogue-Passw0rd!23';
    const reg = await request(http).post('/auth/register').send({
      email,
      password,
      fullName: 'Badge Parent',
      familyName: 'Badge Family',
      timezone: 'UTC',
      acceptedTerms: true,
    });
    if (![200, 201].includes(reg.status)) {
      throw new Error(`register -> ${reg.status} ${JSON.stringify(reg.body)}`);
    }
    const login = await request(http).post('/auth/login').send({ email, password });
    T.parentToken = login.body.tokens?.accessToken ?? login.body.accessToken;
    const claims = JSON.parse(Buffer.from(T.parentToken.split('.')[1], 'base64').toString());
    T.familyId = claims.familyId;
    T.userId = claims.sub;

    const child = await request(http)
      .post('/children')
      .set(auth())
      .send({ firstName: 'Badge Kid', dateOfBirth: '2015-04-01' });
    T.childId = child.body.id;

    const habit = await request(http)
      .post(`/life-intelligence/habits/${T.childId}`)
      .set(auth())
      .send({ title: 'Badge Habit', category: 'LEARNING' });
    T.habitId = habit.body.id;

    const practice = await request(http)
      .post(`/life-intelligence/faith/${T.childId}/practices`)
      .set(auth())
      .send({ title: 'Badge Salah', type: 'SALAH' });
    T.practiceId = practice.body.id;

    const device = await sys('seed device', () =>
      prisma.device.create({
        data: {
          familyId: T.familyId,
          ownerType: 'CHILD',
          childId: T.childId,
          platform: 'ANDROID',
          status: 'ACTIVE',
          pairedAt: new Date(),
        },
        select: { id: true },
      }),
    );
    T.deviceId = device.id;
    const pair = await runWithTenant(
      { familyId: T.familyId, actorType: 'DEVICE', actorId: T.deviceId },
      () => tokens.issueTokenPair({ subjectId: T.deviceId, actorType: 'DEVICE', familyId: T.familyId }),
    );
    T.deviceToken = pair.accessToken;
  }, 180_000);

  afterAll(async () => {
    if (prisma) {
      await sys('teardown', async () => {
        await prisma.device.deleteMany({ where: { id: T.deviceId } });
        await prisma.family.deleteMany({ where: { id: T.familyId } });
        await prisma.user.deleteMany({ where: { id: T.userId } });
      });
    }
    jest.setSystemTime(NOON);
    jest.useRealTimers();
    await app?.close();
  });

  // =========================================================================
  // 1. THE SEED — the catalogue exists, and it is the one the code declares
  // =========================================================================

  describe('the catalogue is seeded, through the reader the engine actually uses', () => {
    it('EVERY badge in PLATFORM_BADGES resolves through the real findBadgeByKey', async () => {
      expect(PLATFORM_BADGES.length).toBeGreaterThan(0);

      for (const badge of PLATFORM_BADGES) {
        const row = await sys(`findBadgeByKey ${badge.key}`, () => rewards.findBadgeByKey(badge.key));

        // THE ASSERTION THAT WAS RED BEFORE 0026: this returned null, every
        // time, for every key, in every environment.
        expect(row).not.toBeNull();
        expect(row!.key).toBe(badge.key);
        expect(row!.title).toBe(badge.copy.ar.title);
        expect(row!.description).toBe(badge.copy.ar.description);
        expect(row!.isGroupAchievement).toBe(badge.isGroupAchievement);
        expect(row!.criteria).toEqual(badge.criteria);
      }
    });

    it('the seeded copy is ARABIC in the columns a child actually reads, and English exists beside it', () => {
      // `title`/`description` are rendered verbatim to a child by
      // `/self/achievements/badges` and injected into the Arabic
      // `BADGE_EARNED` sentence as `{badgeTitle}`. A Latin-script title there
      // would ship English into an Arabic sentence.
      const arabic = /[؀-ۿ]/;
      for (const badge of PLATFORM_BADGES) {
        expect(badge.copy.ar.title).toMatch(arabic);
        expect(badge.copy.ar.description).toMatch(arabic);
        expect(badge.copy.ar.title.trim()).toBe(badge.copy.ar.title);
        // English is secondary, but it is not optional.
        expect(badge.copy.en.title.length).toBeGreaterThan(0);
        expect(badge.copy.en.description.length).toBeGreaterThan(0);
        expect(badge.copy.en.title).not.toMatch(arabic);
      }
    });

    it('no seeded definition carries a placeholder criteria object', async () => {
      const rows = await sys('definitions', () =>
        prisma.badgeDefinition.findMany({ where: { key: { in: PLATFORM_BADGES.map((b) => b.key) } } }),
      );
      expect(rows).toHaveLength(PLATFORM_BADGES.length);
      for (const row of rows) {
        expect(Object.keys(row.criteria as any).length).toBeGreaterThan(0);
        expect((row.criteria as any).occurrence).toBe('FIRST');
        expect((row.criteria as any).awardedBy).toBe('platform_reward_rule');
      }
    });
  });

  // =========================================================================
  // 2. THE RATCHET — both directions
  // =========================================================================

  describe('every badge key the code asks for resolves, and every seeded badge is asked for', () => {
    /**
     * THE FORWARD DIRECTION, from the DATABASE's demand. Any `reward_rules` row
     * with `reward_type = 'BADGE'` names a key in `reward_amount_or_badge_id`;
     * the engine looks it up and silently `continue`s when it misses. Every one
     * of them must resolve — including rows a future migration adds without
     * touching this file.
     */
    it('every BADGE reward rule in the database names a key that resolves', async () => {
      const rules = await sys('badge rules', () =>
        prisma.rewardRule.findMany({ where: { rewardType: 'BADGE' } }),
      );
      expect(rules.length).toBeGreaterThanOrEqual(PLATFORM_DEFAULT_BADGE_RULES.length);

      for (const rule of rules) {
        const badge = await sys('resolve', () => rewards.findBadgeByKey(rule.rewardAmountOrBadgeId));
        expect(badge).not.toBeNull();
      }
    });

    /**
     * THE FORWARD DIRECTION, from the SOURCE's demand. Today the codebase calls
     * `findBadgeByKey` only with a value read from a rule, so this scan finds
     * nothing — and that is exactly why it is here. The moment somebody writes
     * `findBadgeByKey('reading_champion')` without seeding it, this goes red
     * instead of shipping a lookup that always misses.
     */
    it('every literal badge key passed to findBadgeByKey in src/ resolves', async () => {
      const literalCall = /findBadgeByKey\(\s*['"`]([^'"`]+)['"`]/g;
      const found = new Set<string>();
      for (const file of sourceFiles(path.join(__dirname, '..', '..', 'src'))) {
        const text = fs.readFileSync(file, 'utf8');
        for (const match of text.matchAll(literalCall)) found.add(match[1]);
      }
      for (const key of found) {
        const badge = await sys(`literal ${key}`, () => rewards.findBadgeByKey(key));
        expect(badge).not.toBeNull();
      }
    });

    /**
     * THE REVERSE DIRECTION. A definition nobody looks up is the same dormancy
     * as a lookup with no definition — it is how `badge_definitions` got here.
     * Every seeded badge must be demanded by exactly one active platform rule,
     * and that rule's trigger must be the one the badge's own `criteria` claim.
     */
    it('every seeded badge is demanded by exactly one active platform rule, matching its own criteria', async () => {
      const rules = await sys('platform badge rules', () =>
        prisma.rewardRule.findMany({ where: { familyId: null, programId: null, rewardType: 'BADGE' } }),
      );

      for (const badge of PLATFORM_BADGES) {
        const matching = rules.filter((r: any) => r.rewardAmountOrBadgeId === badge.key && r.isActive);
        expect(matching).toHaveLength(1);
        expect(matching[0].triggerEngine).toBe(badge.criteria.triggerEngine);
        expect(matching[0].eventType).toBe(badge.criteria.eventType);
        expect(matching[0].triggerCondition).toEqual(badge.criteria.triggerCondition);
        // A cap on a once-ever grant is a number nothing can read: the award is
        // refused by the unique constraint before `applyEarn` is reached.
        expect(matching[0].maxPerDay).toBeNull();
        expect(matching[0].maxPerWeek).toBeNull();
      }

      // No platform badge rule points at a key this catalogue does not define.
      const seeded = new Set(PLATFORM_BADGES.map((b) => b.key));
      for (const rule of rules) expect(seeded.has(rule.rewardAmountOrBadgeId)).toBe(true);
    });

    it('the code catalogue and the seeded platform rules agree row for row', async () => {
      const all = await sys('platform rules', () =>
        prisma.rewardRule.findMany({ where: { familyId: null, programId: null } }),
      );

      /**
       * ACTIVE ROWS ONLY, AND MIGRATION 0030 IS WHY.
       *
       * 0030 retired the two `DAILY_GOAL_COMPLETED {metric}` health rules that
       * were paying a SECOND 15 XP / 20 XP for the same crossing as
       * `default:hydration:goal` / `default:activity:goal` — measured at
       * `rewards_accounts.xp = 30` for one glass of water. It DEACTIVATED them
       * rather than deleting them, because every ledger row they ever paid
       * records `source = 'reward_rule:<id>'` and no foreign key exists to make
       * that resolvable for us: deleting the rule would orphan the audit trail
       * of a real child's real XP.
       *
       * So «the rules that can still pay» is what this catalogue describes, and
       * the retired rows are pinned separately BY ID right below. The count is
       * not loosened — it is split in two, and both halves are asserted.
       */
      const rows = all.filter((r: any) => r.isActive);
      expect(rows).toHaveLength(PLATFORM_DEFAULT_REWARD_RULES.length);
      expect(all).toHaveLength(PLATFORM_DEFAULT_REWARD_RULES.length + RETIRED_PLATFORM_RULES.length);

      for (const retired of RETIRED_PLATFORM_RULES) {
        const row = all.find((r: any) => r.id === retired.id);
        expect(row).toBeDefined();
        expect(row.isActive).toBe(false);
      }

      for (const expected of PLATFORM_DEFAULT_REWARD_RULES) {
        const row = rows.find(
          (r: any) =>
            r.triggerEngine === expected.triggerEngine &&
            r.eventType === expected.eventType &&
            r.rewardType === expected.rewardType &&
            JSON.stringify(r.triggerCondition) === JSON.stringify(expected.triggerCondition),
        );
        expect(row).toBeDefined();
        expect(row.rewardAmountOrBadgeId).toBe(ruleRewardValue(expected));
      }
    });
  });

  // =========================================================================
  // 3. THE EARNING — the defect's actual consequence, closed
  // =========================================================================

  describe('a child who does the qualifying thing ends up holding the badge', () => {
    it('HABIT — POST /self/habits/:id/complete awards first_habit, and the child can read it back', async () => {
      expect(await badgeAwards()).toHaveLength(0);

      const res = await request(http)
        .post(`/life-intelligence/self/habits/${T.habitId}/complete`)
        .set(deviceAuth())
        .send({});
      expect([200, 201]).toContain(res.status);

      // THE ROW. Before 0026 this array stayed empty no matter what the child
      // did, because `findBadgeByKey` missed and the engine `continue`d.
      const awards = await badgeAwards();
      expect(awards).toHaveLength(1);
      expect(awards[0].badge.key).toBe('first_habit');
      expect(awards[0].familyId).toBe(T.familyId);

      // AND THE LEDGER, because a badge is a grant like any other: one BADGE
      // row, delta 1, so `computeBalanceFromLedger` counts it as a star.
      const badgeLedger = await sys('badge ledger', () =>
        prisma.rewardsLedgerEntry.count({ where: { childId: T.childId, rewardType: 'BADGE', type: 'EARN' } }),
      );
      expect(badgeLedger).toBe(1);

      // AND THE CHILD'S OWN READ PATH — the one the Child App calls. The title
      // it renders is the Arabic one, because the client has no catalogue.
      const mine = await request(http).get('/self/achievements/badges').set(deviceAuth());
      expect(mine.status).toBe(200);
      expect(mine.body).toHaveLength(1);
      expect(mine.body[0].key).toBe('first_habit');
      expect(mine.body[0].title).toBe('أول عادة');
      expect(mine.body[0].description).toMatch(/[؀-ۿ]/);
      expect(mine.body[0].isGroupAchievement).toBe(false);
    });

    it('FAITH — a second domain awards its own badge, so this is not one wired path', async () => {
      const before = await badgeAwards();

      const res = await request(http)
        .post(`/life-intelligence/self/faith/${T.practiceId}/log`)
        .set(deviceAuth())
        .send({});
      expect([200, 201]).toContain(res.status);

      const after = await badgeAwards();
      expect(after.map((a: any) => a.badge.key).sort()).toEqual(
        [...before.map((a: any) => a.badge.key), 'first_faith_practice'].sort(),
      );
    });
  });

  // =========================================================================
  // 4. THE REPLAY — idempotency proved by replaying, not by reading code
  // =========================================================================

  describe('the award is idempotent under replay', () => {
    it('the same action three more times, across two business days, still leaves ONE first_habit row', async () => {
      const firstAward = (await badgeAwards()).find((a: any) => a.badge.key === 'first_habit');
      expect(firstAward).toBeDefined();

      // Replay 1 and 2: the identical HTTP call, same business day. The domain
      // service may refuse a duplicate completion; the point of this loop is
      // that whatever it does, no second badge appears.
      for (let i = 0; i < 2; i++) {
        await request(http)
          .post(`/life-intelligence/self/habits/${T.habitId}/complete`)
          .set(deviceAuth())
          .send({});
      }

      // Replay 3: the NEXT business day, which defeats every idempotency key
      // derived from the day and drives a genuinely new, payable completion
      // through the same rule. This is the replay that matters — a "one badge
      // ever" that only holds because the second attempt was deduplicated
      // upstream would not have been proved by the two above.
      jest.setSystemTime(new Date(NOON.getTime() + DAY_MS));
      // The device's access token was minted on the previous day and a day of
      // fake clock outlives it; re-issue rather than widen the assertion, so a
      // real 401 would still be a failure.
      const nextDayPair = await runWithTenant(
        { familyId: T.familyId, actorType: 'DEVICE', actorId: T.deviceId },
        () => tokens.issueTokenPair({ subjectId: T.deviceId, actorType: 'DEVICE', familyId: T.familyId }),
      );
      const nextDay = await request(http)
        .post(`/life-intelligence/self/habits/${T.habitId}/complete`)
        .set({ Authorization: `Bearer ${nextDayPair.accessToken}` })
        .send({});
      expect([200, 201]).toContain(nextDay.status);

      // A NEW XP grant proves the trigger really did reach the rules engine on
      // the second day — otherwise "still one badge" would be vacuous.
      const xpRows = await sys('xp ledger', () =>
        prisma.rewardsLedgerEntry.count({ where: { childId: T.childId, rewardType: 'XP', type: 'EARN' } }),
      );
      expect(xpRows).toBeGreaterThan(1);

      const awards = await badgeAwards();
      expect(awards.filter((a: any) => a.badge.key === 'first_habit')).toHaveLength(1);
      // Same row, not a replaced one.
      expect(awards.find((a: any) => a.badge.key === 'first_habit').id).toBe(firstAward.id);

      // And the ledger holds exactly one BADGE row for it — the second attempt
      // never reached `applyEarn`, because `awardBadgeIfNotAlready` returned
      // false from the UNIQUE constraint rather than from an `if`.
      const badgeLedger = await sys('badge ledger', () =>
        prisma.rewardsLedgerEntry.count({
          where: { childId: T.childId, rewardType: 'BADGE', type: 'EARN', source: { contains: 'reward_rule:' } },
        }),
      );
      expect(badgeLedger).toBe(awards.length);

      jest.setSystemTime(NOON);
    });

    it('the idempotency is the DATABASE constraint, not a code-level check', async () => {
      const badge = await sys('badge', () => rewards.findBadgeByKey('first_habit'));
      expect(badge).not.toBeNull();

      // Call the repository method directly, twice, concurrently — no rules
      // engine, no HTTP, nothing that could have remembered the first call.
      const results = await runWithTenant(
        { familyId: T.familyId, actorType: 'USER', actorId: T.userId },
        () =>
          Promise.all([
            rewards.awardBadgeIfNotAlready(T.childId, badge!.id),
            rewards.awardBadgeIfNotAlready(T.childId, badge!.id),
          ]),
      );
      expect(results).toEqual([false, false]);

      const awards = await badgeAwards();
      expect(awards.filter((a: any) => a.badge.key === 'first_habit')).toHaveLength(1);
    });
  });
});
