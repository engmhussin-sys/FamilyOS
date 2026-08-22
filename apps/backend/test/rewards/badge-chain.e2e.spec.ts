/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-var-requires */
/**
 * ============================================================================
 * THE WHOLE BADGE PATH, PROVEN ON PERSISTED ROWS — ONE CHILD ACTION, EIGHT LINKS.
 * ============================================================================
 *
 * WHAT ALREADY EXISTED AND WHAT DID NOT. `badge-catalogue.e2e.spec.ts` proves
 * the SEED and the AWARD (`child_badge_awards` gets a row, the child can read
 * the badge back). `reward-rule-connection.e2e.spec.ts` proves the LEDGER, the
 * `reward_granted` timeline entry and the `REWARD_GRANTED` notification. Neither
 * of them looks at what happens to the BADGE after the award row: no test in
 * `test/rewards/` asserted the `badge_awarded` timeline entry, the child's
 * `BADGE_EARNED` message, or the parent's `BADGE_EARNED_PARENT` notification, and
 * `notificationCount` in the connection suite filters on `type: 'REWARD_GRANTED'`
 * — so the whole badge half of the announcement was structurally invisible to
 * `test/rewards`. This file is that half, joined to the rest, in one chain.
 *
 * THE CHAIN, ASSERTED ON ROWS AT EVERY LINK, driven through the REAL app, the
 * REAL guards, a REAL PostgreSQL and a REAL Redis. Nothing is stubbed and no row
 * is hand-inserted on the causal path — the only fixtures written directly are
 * the paired device (there is no HTTP pairing shortcut) and the household.
 *
 *   1. A LEGITIMATE CHILD ACTION   `POST /life-intelligence/self/habits/:id/complete`
 *                                  on a DEVICE token — the route the Child App
 *                                  actually calls — leaving a `habit_completions`
 *                                  row the server authored.
 *   2. ACHIEVEMENT EVALUATION      the platform `first_habit` BADGE rule matches
 *                                  and `child_badge_awards` gains ONE row that
 *                                  points at the SEEDED `badge_definitions` row.
 *   3. POINTS                      the XP the platform rule declares, in
 *                                  `rewards_ledger_entries` and reconciled
 *                                  against `rewards_accounts` — and the BADGE's
 *                                  own EARN row beside it.
 *   4. THE CHILD IS TOLD           a `child_messages` row of category
 *                                  `BADGE_EARNED`, in ARABIC, carrying the badge
 *                                  title, behind the parent approval gate that
 *                                  every child-facing message goes through.
 *   5. THE PARENT IS TOLD          a `notifications` row of type
 *                                  `BADGE_EARNED_PARENT`. THIS SUITE ANSWERS THE
 *                                  QUESTION RATHER THAN ASSUMING IT: the parent
 *                                  IS notified on this path, and §5 below names
 *                                  the exact call site that does it.
 *   6. THE TIMELINE                `life_timeline_events` gains the
 *                                  `badge_awarded` entry, in Arabic, beside the
 *                                  `reward_granted` one.
 *   7. IDEMPOTENCY                 proven by REPLAYING the same action, twice:
 *                                  once as a plain repeat, and once with the
 *                                  domain-level marker DELETED and the clock
 *                                  moved past every code-level dedupe window, so
 *                                  the chain genuinely re-runs and a DATABASE
 *                                  CONSTRAINT is the thing that refuses. The
 *                                  refusal is observed at the repository call
 *                                  itself, not inferred from a count.
 *   8. AN INVALID CLAIM IS REFUSED a child that names a badge, a point total, a
 *                                  child id or a family id gets nothing, and
 *                                  "nothing" is asserted against the DATABASE
 *                                  rather than against a status code.
 *
 * ON THE CLOCK: frozen with `freezeGoldenClock` at midday on the day BEFORE the
 * real one — outside quiet hours in both launch markets, and behind the real
 * clock because Prisma generates `@default(now())` client-side while the outbox
 * relay's SQL uses PostgreSQL's own `now()`.
 *
 * ============================================================================
 * WHAT THIS FILE FOUND AND DID **NOT** FIX — both are the same defect class,
 * recorded here by name so the next reader does not have to re-derive them.
 * ============================================================================
 *
 *   A WRITER WITH NO READER.  `BADGE_EARNED`, the DOMAIN EVENT. Emitted by
 *   `RewardSideEffectConsumer`, subscribed to by nothing, and behind a branch no
 *   seeded rule can reach. §6b carries the full argument and the falsifiable
 *   form of it. NOT fixed here: the event type lives in `src/shared/events/`,
 *   and choosing between «delete the producer» and «give it a reader» is a
 *   product decision about which of two producers owns the announcement.
 *
 *   A RULE THAT CANNOT FIRE ON THE ROUTE THE CLIENT USES. `first_hydration_goal`
 *   and `first_activity_goal` are seeded against `eventType:
 *   'HYDRATION_GOAL_COMPLETED'` / `'ACTIVITY_GOAL_COMPLETED'`, but
 *   `HealthEngineService.logHydration` / `logActivity` fire
 *   `type: 'DAILY_GOAL_COMPLETED'` at the reward seam — those two names are only
 *   produced as REWARD TRIGGERS by `RewardsCompletionConsumer`, i.e. only for a
 *   completion that arrived through `POST /events/batch`. MEASURED: a child who
 *   crosses their hydration target through `POST
 *   /life-intelligence/self/health/hydration-logs` gets the XP and NO badge; the
 *   same crossing posted as a `HYDRATION_GOAL_COMPLETED` device event awards
 *   `first_hydration_goal`. Compare `first_habit`, which is reachable through
 *   both doors because `HabitEngineService` fires the contract name
 *   `HABIT_COMPLETED` directly. NOT fixed here: the change belongs in
 *   `src/modules/life-intelligence/application/services/health-engine.service.ts`,
 *   which this agent does not own. See the handoff in the sprint report.
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
import { PrismaRewardsRepository } from '../../src/modules/life-intelligence/infrastructure/repositories/prisma-rewards.repository';
import { PLATFORM_BADGES } from '../../src/shared/rewards/badge-catalogue';
import {
  PLATFORM_DEFAULT_REWARD_RULES,
  ruleRewardValue,
} from '../../src/shared/rewards/reward-rule-catalogue';
import { composeIdempotencyKey } from '../../src/shared/events/idempotency';
import { getBusinessDate } from '../../src/common/time/family-date';
import { integrationDatabaseUrl } from '../tenancy/prisma-test-client';
import { freezeGoldenClock, GOLDEN_NOON } from '../golden/golden-world';

const describeIfDb = integrationDatabaseUrl() ? describe : describe.skip;

/** The badge this chain earns, and the XP rule that fires in the same instant. */
const BADGE_KEY = 'first_habit';
const BADGE = PLATFORM_BADGES.find((b) => b.key === BADGE_KEY)!;
const BADGE_TITLE_AR = BADGE.copy.ar.title;
const HABIT_XP_RULE = PLATFORM_DEFAULT_REWARD_RULES.find(
  (r) => r.triggerEngine === 'habit-builder' && r.eventType === 'HABIT_COMPLETED' && r.rewardType === 'XP',
)!;
const HABIT_XP = Number(ruleRewardValue(HABIT_XP_RULE));

/** Arabic letters, so "the child was told in Arabic" is a property of the row
 * and not of a string this file also wrote. */
const ARABIC = /[؀-ۿ]/;
/** Latin letters, to prove the sentence is not an English literal that happens
 * to sit next to an Arabic title. */
const LATIN_WORD = /[A-Za-z]{3,}/;

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
  // PRISMA 7 removed `datasources`, so a driver adapter is the only way to
  // open a connection. The pool is NAMED and kept: `$disconnect()` closes what
  // Prisma opened and never a pool the caller supplied, so an anonymous pool
  // here is a Postgres connection this suite leaks for the rest of the run.
  const fallbackPool = new (require('pg').Pool)({ connectionString: url });
  const base = new PrismaClient({
    adapter: new (require('@prisma/adapter-pg').PrismaPg)(fallbackPool),
  });
  const extended = base.$extends(createTenantExtension());
  extended.onModuleInit = async () => base.$connect();
  extended.onModuleDestroy = async () => {
    await base.$disconnect();
    await fallbackPool.end();
  };
  return extended;
}

describeIfDb('THE BADGE CHAIN — goal → badge → points → child → parent → timeline → replay → forgery', () => {
  let app: INestApplication;
  let http: any;
  let prisma: any;
  let tokens: TokenService;
  let rewardsRepo: PrismaRewardsRepository;

  const stamp = Date.now();

  interface Household {
    familyId: string;
    userId: string;
    parentToken: string;
    childId: string;
    habitId: string;
    deviceId: string;
    deviceToken: string;
  }

  /** The household under test. It configures NOTHING: every rule that fires
   * below is a platform default a real family inherits without acting. */
  const T = {} as Household;

  /**
   * THE FORGER — a SECOND household, and a second one rather than a second
   * child because the free plan entitles a family to one child
   * (`multiple_children`), so a same-family sibling silently fails to be
   * created and every "nothing landed" assertion below would then be querying
   * `childId: undefined`, which Prisma treats as NO FILTER and which would pass
   * against the whole table.
   *
   * Its child NEVER performs a legitimate action, so any row that exists for it
   * is a row a forgery produced — that is what makes "nothing landed" a real
   * assertion rather than a tautology. It also makes §8's identity claims
   * CROSS-TENANT, which is the shape a real attack has.
   */
  const F = {} as Household;

  const sys = (what: string, fn: () => Promise<any>): Promise<any> =>
    runAsSystemAsync('TEST_FIXTURE', `badge chain: ${what}`, async () => await fn());

  const parentAuth = () => ({ Authorization: `Bearer ${T.parentToken}` });
  const deviceAuth = () => ({ Authorization: `Bearer ${T.deviceToken}` });

  // -------------------------------------------------------------------------
  // the readers — every assertion below goes through one of these, so "what the
  // database holds" is one vocabulary rather than a query per test.
  // -------------------------------------------------------------------------

  /**
   * THE COMPLETION'S OWN IDEMPOTENCY KEY, composed the way both doors compose
   * it. Derived — never typed as a literal — from the child, the habit and the
   * family's business day, so this file cannot go on asserting a key shape that
   * `src/` has stopped writing.
   */
  const completionKeyFor = (): string =>
    composeIdempotencyKey('HABIT_COMPLETED', {
      childId: T.childId,
      sourceId: T.habitId,
      localDate: getBusinessDate(new Date(), 'Africa/Cairo'),
    });

  const habitCompletions = (): Promise<any[]> =>
    sys('habit completions', () =>
      prisma.habitCompletion.findMany({ where: { childId: T.childId }, orderBy: { date: 'asc' } }),
    );

  const badgeAwards = (childId = T.childId): Promise<any[]> =>
    sys('badge awards', () =>
      prisma.childBadgeAward.findMany({ where: { childId }, include: { badge: true } }),
    );

  const ledger = (childId = T.childId): Promise<any[]> =>
    sys('ledger', () =>
      prisma.rewardsLedgerEntry.findMany({ where: { childId }, orderBy: { createdAt: 'asc' } }),
    );

  const timeline = (childId = T.childId): Promise<any[]> =>
    sys('timeline', () =>
      prisma.lifeTimelineEvent.findMany({ where: { childId }, orderBy: { occurredAt: 'asc' } }),
    );

  const parentNotifications = (type?: string): Promise<any[]> =>
    sys('notifications', () =>
      prisma.notification.findMany({
        where: { familyId: T.familyId, ...(type ? { type } : {}) },
        orderBy: { createdAt: 'asc' },
      }),
    );

  const childMessages = (childId = T.childId): Promise<any[]> =>
    sys('child messages', () =>
      prisma.childMessage.findMany({ where: { childId }, orderBy: { createdAt: 'asc' } }),
    );

  const decisions = (childId = T.childId): Promise<any[]> =>
    sys('decisions', () =>
      prisma.notificationDecision.findMany({ where: { childId }, orderBy: { createdAt: 'asc' } }),
    );

  /** The five counters the replay section compares before and after. */
  async function chainCounts(): Promise<Record<string, number>> {
    const [b, l, t, n, m] = await Promise.all([
      badgeAwards(),
      ledger(),
      timeline(),
      parentNotifications(),
      childMessages(),
    ]);
    return {
      badges: b.length,
      ledger: l.length,
      badgeTimeline: t.filter((e: any) => e.eventType === 'badge_awarded').length,
      rewardTimeline: t.filter((e: any) => e.eventType === 'reward_granted').length,
      parentNotifications: n.length,
      childMessages: m.length,
    };
  }

  // -------------------------------------------------------------------------
  // fixtures
  // -------------------------------------------------------------------------

  async function pairDevice(familyId: string, childId: string): Promise<{ deviceId: string; token: string }> {
    const device = await sys('seed device', () =>
      prisma.device.create({
        data: {
          familyId,
          ownerType: 'CHILD',
          childId,
          platform: 'ANDROID',
          status: 'ACTIVE',
          pairedAt: new Date(),
        },
        select: { id: true },
      }),
    );
    const pair = await runWithTenant(
      { familyId, actorType: 'DEVICE', actorId: device.id },
      () => tokens.issueTokenPair({ subjectId: device.id, actorType: 'DEVICE', familyId }),
    );
    return { deviceId: device.id, token: pair.accessToken };
  }

  /**
   * EVERY STEP IS CHECKED. A fixture that half-fails hands the assertions an
   * `undefined` id, and `where: { childId: undefined }` is NO FILTER in Prisma
   * — the "nothing landed" tests would then read the entire table and pass or
   * fail for reasons that have nothing to do with the product.
   */
  async function registerHousehold(label: string, target: Household, childName: string): Promise<void> {
    const email = `badge.chain.${label}.${stamp}@example.com`;
    const password = 'Badge-Chain-Passw0rd!23';
    const reg = await request(http).post('/auth/register').send({
      email,
      password,
      fullName: `Badge Chain Parent ${label}`,
      familyName: `Badge Chain Family ${label}`,
      // Cairo: UTC+3, so midday UTC is mid-afternoon locally — well clear of
      // the 21:00–07:00 quiet-hours window at both ends of the suite.
      timezone: 'Africa/Cairo',
      acceptedTerms: true,
    });
    if (![200, 201].includes(reg.status)) {
      throw new Error(`register(${label}) -> ${reg.status} ${JSON.stringify(reg.body)}`);
    }

    const login = await request(http).post('/auth/login').send({ email, password });
    target.parentToken = login.body.tokens?.accessToken ?? login.body.accessToken;
    if (!target.parentToken) throw new Error(`login(${label}) -> ${JSON.stringify(login.body)}`);
    const claims = JSON.parse(Buffer.from(target.parentToken.split('.')[1], 'base64').toString());
    target.familyId = claims.familyId;
    target.userId = claims.sub;

    const child = await request(http)
      .post('/children')
      .set({ Authorization: `Bearer ${target.parentToken}` })
      .send({ firstName: childName, dateOfBirth: '2015-04-01' });
    if (!child.body?.id) throw new Error(`child(${label}) -> ${child.status} ${JSON.stringify(child.body)}`);
    target.childId = child.body.id;

    const habit = await request(http)
      .post(`/life-intelligence/habits/${target.childId}`)
      .set({ Authorization: `Bearer ${target.parentToken}` })
      .send({ title: `Badge Chain Habit ${label}`, category: 'LEARNING' });
    if (!habit.body?.id) throw new Error(`habit(${label}) -> ${habit.status} ${JSON.stringify(habit.body)}`);
    target.habitId = habit.body.id;

    const paired = await pairDevice(target.familyId, target.childId);
    target.deviceId = paired.deviceId;
    target.deviceToken = paired.token;
  }

  beforeAll(async () => {
    freezeGoldenClock(GOLDEN_NOON);

    {
      // The throttle buckets are shared with every other suite on this Redis.
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
    tokens = app.get(TokenService);
    rewardsRepo = app.get(PrismaRewardsRepository);

    await registerHousehold('earner', T, 'Badge Chain Kid');
    await registerHousehold('forger', F, 'Forgery Kid');
  }, 180_000);

  afterAll(async () => {
    if (prisma) {
      await sys('teardown', async () => {
        await prisma.device.deleteMany({ where: { id: { in: [T.deviceId, F.deviceId] } } });
        await prisma.family.deleteMany({ where: { id: { in: [T.familyId, F.familyId] } } });
        await prisma.user.deleteMany({ where: { id: { in: [T.userId, F.userId] } } });
      });
    }
    jest.setSystemTime(GOLDEN_NOON);
    jest.useRealTimers();
    await app?.close();
  });

  // =========================================================================
  // 0. THE CLOCK AND THE FIXTURE — stated, because every count below depends
  //    on the household having configured nothing.
  // =========================================================================

  describe('0. the ground the chain stands on', () => {
    it('the clock is frozen at midday, outside quiet hours — this suite must not depend on when CI runs', () => {
      expect(new Date().toISOString()).toBe(GOLDEN_NOON.toISOString());
    });

    it('the family owns NO reward rules — everything below is a platform default it inherits', async () => {
      const own = await sys('family rules', () =>
        prisma.rewardRule.findMany({ where: { familyId: T.familyId } }),
      );
      expect(own).toHaveLength(0);
    });

    it('the child starts with no badge, no ledger, no timeline, no message and no notification', async () => {
      expect(await chainCounts()).toEqual({
        badges: 0,
        ledger: 0,
        badgeTimeline: 0,
        rewardTimeline: 0,
        parentNotifications: 0,
        childMessages: 0,
      });
    });
  });

  // =========================================================================
  // 1..6 — ONE ACTION, DRIVEN ONCE, AND THEN READ OFF THE DATABASE.
  // =========================================================================

  describe('1. a legitimate child action, through the real route, on a real device token', () => {
    it('the child completes their habit and the SERVER writes the completion row', async () => {
      const res = await request(http)
        .post(`/life-intelligence/self/habits/${T.habitId}/complete`)
        .set(deviceAuth())
        .send({});
      expect([200, 201]).toContain(res.status);

      const rows = await habitCompletions();
      expect(rows).toHaveLength(1);
      expect(rows[0].habitId).toBe(T.habitId);
      // The day is the FAMILY's business day, derived server-side. The device
      // sent no date and there is no field on this route for one.
      expect(rows[0].date).toBeInstanceOf(Date);
      expect(rows[0].status).toBe('COMPLETED');
    });
  });

  describe('2. achievement evaluation ran and granted the badge it should', () => {
    it('exactly ONE award, and it points at the SEEDED definition rather than an invented one', async () => {
      const awards = await badgeAwards();
      expect(awards).toHaveLength(1);
      expect(awards[0].badge.key).toBe(BADGE_KEY);

      // The row the migration seeded, reached through the reader the engine
      // itself uses — so "the badge exists" is not a claim this file makes.
      const definition = await sys('definition', () => rewardsRepo.findBadgeByKey(BADGE_KEY));
      expect(definition).not.toBeNull();
      expect(awards[0].badgeId).toBe(definition!.id);
      expect(awards[0].badge.title).toBe(BADGE_TITLE_AR);
      expect(ARABIC.test(awards[0].badge.title)).toBe(true);
    });

    it('the award is scoped to the family — a child badge is not a global row', async () => {
      const awards = await badgeAwards();
      expect(awards[0].familyId).toBe(T.familyId);
    });
  });

  describe('3. points, exactly as the existing product semantics declare them', () => {
    it('TWO EARN rows: the XP the platform habit rule declares, and the badge itself', async () => {
      const rows = await ledger();
      expect(rows).toHaveLength(2);
      expect(rows.every((r: any) => r.type === 'EARN')).toBe(true);

      const xp = rows.find((r: any) => r.rewardType === 'XP');
      const badge = rows.find((r: any) => r.rewardType === 'BADGE');
      expect(xp).toBeDefined();
      expect(badge).toBeDefined();

      // NOT a number this file chose: the amount comes from the same catalogue
      // migration 0007 seeded the rule from.
      expect(xp.amount).toBe(HABIT_XP);
      expect(xp.delta).toBe(HABIT_XP);
      expect(badge.amount).toBe(1);

      /**
       * Both rows carry the completion's own key, which is what makes the
       * replay in §7 a database question rather than a code question.
       *
       * ASSERTED AGAINST `composeIdempotencyKey`, NOT AGAINST A LITERAL. These
       * two lines used to pin `habit-completion:{habitId}:{day}` — the shape
       * `completeHabit` hand-wrote while `POST /events/batch` composed
       * `child:{c}:habit:{habitId}:{day}` for the SAME tick of the SAME habit on
       * the SAME day, and paid it 10 + 10 XP. The literal was pinning the wrong
       * number; the composed call is the invariant.
       */
      const completionKey = completionKeyFor();
      expect(xp.idempotencyKey).toContain(`${completionKey}:`);
      expect(badge.idempotencyKey).toContain(`${completionKey}:`);
      expect(xp.idempotencyKey).not.toBe(badge.idempotencyKey);
      // Every EARN row belongs to a family day, so the caps count the day the
      // grant actually belongs to.
      expect(xp.businessDate).not.toBeNull();
      expect(badge.businessDate).not.toBeNull();
    });

    it('the account reconciles against the ledger rather than being asserted on its own', async () => {
      const rows = await ledger();
      const account = await sys('account', () =>
        prisma.rewardsAccount.findFirst({ where: { childId: T.childId } }),
      );
      const xpSum = rows
        .filter((r: any) => r.rewardType === 'XP')
        .reduce((sum: number, r: any) => sum + r.delta, 0);
      expect(account.xp).toBe(xpSum);
      expect(account.xp).toBe(HABIT_XP);
    });

    it('and the CHILD can read their own balance back from their own device', async () => {
      const res = await request(http).get('/life-intelligence/self/rewards/account').set(deviceAuth());
      expect(res.status).toBe(200);
      expect(res.body.xp).toBe(HABIT_XP);
    });
  });

  describe('4. the child is actually told — in Arabic, and told BOTH facts', () => {
    it('a BADGE_EARNED message exists for this child, naming the badge, with no English in it', async () => {
      const messages = await childMessages();
      const badgeMessage = messages.find((m: any) => m.category === 'BADGE_EARNED');
      expect(badgeMessage).toBeDefined();

      expect(ARABIC.test(badgeMessage.title)).toBe(true);
      expect(ARABIC.test(badgeMessage.body)).toBe(true);
      expect(LATIN_WORD.test(badgeMessage.body)).toBe(false);
      // The sentence names the badge the child earned, from the seeded Arabic
      // title — not a generic «حصلت على وسام».
      expect(badgeMessage.body).toContain(BADGE_TITLE_AR);

      // The CHILD facet. The parent's row for the same cause carries the bare
      // key (§5), which is what lets one fact reach two audiences without
      // either row deduplicating the other.
      expect(badgeMessage.sourceEventId.endsWith(':child')).toBe(true);
      expect(badgeMessage.sourceEventId).toContain(T.childId);
    });

    it('THE FIRST-EVER COMPLETION IS TWO FACTS AND THE CHILD HOLDS BOTH — the reward and the badge', async () => {
      // THIS IS THE ASSERTION THE COOLDOWN GATE COULD HAVE BROKEN. A first-ever
      // completion pays a reward AND a badge in the same instant, so the child
      // receives two candidates milliseconds apart. `evaluateFatigue` is live on
      // this path (`toFatiguePolicy` is wired into the delivery gate) and it
      // holds a DUPLICATE window, an hourly ceiling and a per-type daily cap. A
      // child left with only one of the two facts would be silently correct by
      // every count in every other suite, because each of those counts only one
      // type.
      const messages = await childMessages();
      const categories = messages.map((m: any) => m.category).sort();
      expect(categories).toEqual(['BADGE_EARNED', 'REWARD_GRANTED_CHILD']);

      // Two DIFFERENT causes, which is the reason the duplicate window does not
      // collapse them: the guard compares causal keys, not types.
      const keys = new Set(messages.map((m: any) => m.sourceEventId));
      expect(keys.size).toBe(2);
    });

    it('the message is behind the parent approval gate, and reaches the child once approved', async () => {
      const before = await request(http).get('/life-intelligence/self/messages').set(deviceAuth());
      expect(before.status).toBe(200);
      // PENDING, `delivered_at` NULL: the gate is not bypassed by the fact that
      // the server composed the sentence.
      expect(before.body).toHaveLength(0);

      const badgeMessage = (await childMessages()).find((m: any) => m.category === 'BADGE_EARNED');
      expect(badgeMessage.approvalStatus).toBe('PENDING');
      expect(badgeMessage.deliveredAt).toBeNull();

      const approve = await request(http)
        .post(`/life-intelligence/communication/${T.childId}/${badgeMessage.id}/approve`)
        .set(parentAuth())
        .send({});
      expect([200, 201]).toContain(approve.status);

      const after = await request(http).get('/life-intelligence/self/messages').set(deviceAuth());
      expect(after.status).toBe(200);
      expect(after.body.map((m: any) => m.id)).toContain(badgeMessage.id);
    });

    it('the decision that produced it is recorded, and it resolved to the CHILD', async () => {
      const rows = await decisions();
      const badgeDecision = rows.find((d: any) => d.notificationType === 'BADGE_EARNED');
      expect(badgeDecision).toBeDefined();
      expect(badgeDecision.targetAudience).toBe('CHILD');
      expect(badgeDecision.copyKey).toBe('BADGE_EARNED');
      // The engine decided to send AND the pipeline agreed — the two verdicts
      // are separate columns precisely so "we decided to" and "it happened"
      // cannot be confused.
      expect(badgeDecision.decision).toBe('SEND');
      expect(badgeDecision.outcome).toBe('SEND');
    });
  });

  describe('5. the parent IS told on this path, and the key that does it is BADGE_EARNED_PARENT', () => {
    /**
     * THE ANSWER, DETERMINED FROM THE CODE AND THEN MEASURED. `BADGE_EARNED_PARENT`
     * is produced on this path. `RewardsEngineService.processTriggerEvent` makes
     * TWO `notifyGrant` calls inside the same `if (granted)` branch that writes
     * the badge's ledger row — `BADGE_EARNED` for the child and
     * `BADGE_EARNED_PARENT` for the parent — sharing ONE causal key because they
     * share one cause. The audience is NOT asserted by the producer: it is read
     * from `COPY_CATALOGUE[type].audience`, which is why the two keys exist at
     * all. The badge branch is reached on BOTH doors — it does not consult
     * `announcedViaOutbox`, which gates only the `REWARD_GRANTED` half.
     */
    it('a BADGE_EARNED_PARENT notification exists, addressed to the family owner', async () => {
      const rows = await parentNotifications('BADGE_EARNED_PARENT');
      expect(rows).toHaveLength(1);
      expect(rows[0].userId).toBe(T.userId);
      expect(rows[0].childId).toBe(T.childId);
    });

    it('it is Arabic, it names the child and the badge, and it is not the child’s sentence', async () => {
      const [row] = await parentNotifications('BADGE_EARNED_PARENT');
      expect(ARABIC.test(row.title)).toBe(true);
      expect(row.body).toContain(BADGE_TITLE_AR);
      expect(row.body).toContain('Badge Chain Kid');

      const childBadgeMessage = (await childMessages()).find((m: any) => m.category === 'BADGE_EARNED');
      expect(row.body).not.toBe(childBadgeMessage.body);
    });

    it('ONE CAUSE, TWO AUDIENCES: the parent row is the child row’s key without the `:child` facet', async () => {
      const [row] = await parentNotifications('BADGE_EARNED_PARENT');
      const childBadgeMessage = (await childMessages()).find((m: any) => m.category === 'BADGE_EARNED');
      expect(childBadgeMessage.sourceEventId).toBe(`${row.sourceEventId}:child`);
    });

    it('the parent also gets the REWARD_GRANTED half — and the two are separate rows, not one', async () => {
      const all = await parentNotifications();
      expect(all.map((n: any) => n.type).sort()).toEqual(['BADGE_EARNED_PARENT', 'REWARD_GRANTED']);
      expect(new Set(all.map((n: any) => n.sourceEventId)).size).toBe(2);
    });

    it('the parent decision is recorded with PARENT as the resolved audience', async () => {
      const badgeParent = (await decisions()).find(
        (d: any) => d.notificationType === 'BADGE_EARNED_PARENT',
      );
      expect(badgeParent).toBeDefined();
      expect(badgeParent.targetAudience).toBe('PARENT');
      expect(badgeParent.decision).toBe('SEND');
      expect(badgeParent.outcome).toBe('SEND');
    });
  });

  describe('6. the unified life timeline holds the event', () => {
    it('a `badge_awarded` entry, in Arabic, naming the badge', async () => {
      const rows = await timeline();
      const badgeEntries = rows.filter((e: any) => e.eventType === 'badge_awarded');
      expect(badgeEntries).toHaveLength(1);
      expect(badgeEntries[0].sourceEngine).toBe('rewards');
      expect(badgeEntries[0].category).toBe('REWARDS');
      expect(ARABIC.test(badgeEntries[0].title)).toBe(true);
      expect(badgeEntries[0].title).toContain(BADGE_TITLE_AR);
    });

    it('beside the `reward_granted` entry, which carries the keyed sourceKey', async () => {
      const rows = await timeline();
      const reward = rows.filter((e: any) => e.eventType === 'reward_granted');
      expect(reward).toHaveLength(1);
      expect(reward[0].metadata?.sourceKey).toContain(completionKeyFor());
      expect(reward[0].metadata?.grantCount).toBe(2);
    });

    it('the timeline is append-only on this path — no row was updated in place', async () => {
      const rows = await timeline();
      // Every entry the chain wrote carries the frozen instant it was written
      // at; there is no `updatedAt` on this model because there is no update.
      expect(rows.length).toBeGreaterThanOrEqual(2);
      expect(Object.keys(rows[0])).not.toContain('updatedAt');
    });
  });

  // =========================================================================
  // 6b. WHERE THE BADGE ANNOUNCEMENT DOES **NOT** COME FROM.
  // =========================================================================

  describe('6b. the whole chain above ran without a single outbox message', () => {
    /**
     * =======================================================================
     * `BADGE_EARNED` THE DOMAIN EVENT IS DORMANT — A WRITER WITH NO READER,
     * BEHIND A BRANCH THAT CANNOT FIRE. RECORDED HERE BECAUSE IT IS EXACTLY
     * THE THING A READER OF THIS FILE WOULD OTHERWISE ASSUME IS LOAD-BEARING.
     * =======================================================================
     *
     * `BADGE_EARNED` is a member of `DOMAIN_EVENT_TYPES`, it has its own rule in
     * `composeIdempotencyKey` (`child:{child}:badge:{source}`), and it has ONE
     * producer in the entire backend: `RewardSideEffectConsumer`, which writes
     * it for every `BADGE` ledger row belonging to a verified achievement.
     *
     * NEITHER HALF OF THAT CHAIN IS LIVE.
     *
     *   NO READER.  `IEventSubscriber` is a typed, per-type registry with no
     *               wildcard (by design — see `event-bus.port.ts`), and no file
     *               calls `register('BADGE_EARNED', …)`. The relay publishes the
     *               message to zero handlers and marks it PUBLISHED.
     *   NO WRITER.  The branch that emits it needs a `BADGE` ledger row under an
     *               achievement's key prefix. A `BADGE` row can only come from a
     *               `RewardRule` with `reward_type = 'BADGE'`; the only such rows
     *               are the nine 0026 seeded from `PLATFORM_BADGES`, and not one
     *               of them names `eventType: 'ACHIEVEMENT_VERIFIED'` — while a
     *               program's own companion rules cannot pay `BADGE` at all
     *               (`PROGRAM_REWARD_TYPES` has no such member, and
     *               `CreateRewardRuleDto` is `@IsIn(['XP','COINS'])`).
     *
     * SO THE PRODUCT'S BADGE ANNOUNCEMENT DOES NOT DEPEND ON IT, AND THIS TEST
     * IS THAT SENTENCE MADE FALSIFIABLE: §4 and §5 already hold, and the outbox
     * relay was never ticked in this file. Both audiences were told by
     * `RewardsEngineService` at grant time, synchronously, on the HTTP request
     * that earned the badge.
     *
     * IT IS DELIBERATELY NOT A LEDGER OF ACCEPTED DORMANCY. If someone wires a
     * `BADGE_EARNED` consumer, or seeds an achievement-triggered badge, this
     * turns red at the one place that carries the whole argument — and the
     * question it forces is the right one: which of the two producers is now the
     * announcement, because two would be two notifications for one badge.
     */
    it('no BADGE_EARNED domain event was written — the engine announced the badge, not the outbox', async () => {
      const events = await sys('domain events', () =>
        prisma.domainEvent.findMany({ where: { familyId: T.familyId }, select: { eventType: true } }),
      );
      expect(events.filter((e: any) => e.eventType === 'BADGE_EARNED')).toHaveLength(0);

      const messages = await sys('outbox', () =>
        prisma.outboxMessage.findMany({ where: { familyId: T.familyId }, select: { eventType: true } }),
      );
      expect(messages.filter((m: any) => m.eventType === 'BADGE_EARNED')).toHaveLength(0);
    });

    it('and yet both audiences hold their badge row — the announcement needed no event at all', async () => {
      expect(await parentNotifications('BADGE_EARNED_PARENT')).toHaveLength(1);
      expect((await childMessages()).filter((m: any) => m.category === 'BADGE_EARNED')).toHaveLength(1);
    });
  });

  // =========================================================================
  // 7. IDEMPOTENCY, PROVEN BY REPLAYING.
  // =========================================================================

  describe('7. the same event, replayed — and then replayed with the marker gone', () => {
    let baseline: Record<string, number>;

    beforeAll(async () => {
      baseline = await chainCounts();
    });

    it('the baseline is exactly one of everything the chain produces', () => {
      expect(baseline).toEqual({
        badges: 1,
        ledger: 2,
        badgeTimeline: 1,
        rewardTimeline: 1,
        parentNotifications: 2,
        childMessages: 2,
      });
    });

    it('THE PLAIN REPLAY: the identical HTTP call again changes nothing', async () => {
      const res = await request(http)
        .post(`/life-intelligence/self/habits/${T.habitId}/complete`)
        .set(deviceAuth())
        .send({});
      expect([200, 201]).toContain(res.status);

      expect(await chainCounts()).toEqual(baseline);
      // And the surviving award is the SAME row, not a replaced one.
      const awards = await badgeAwards();
      expect(awards).toHaveLength(1);
    });

    it('THE HARD REPLAY: marker deleted, dedupe window passed — the DATABASE is what refuses', async () => {
      // The domain-level marker. `habit_completions (habit_id, date)` is what
      // makes the second POST above a no-op at the domain layer; deleting it
      // means the next call really does run `completeHabit` from the top.
      await sys('delete the domain marker', () =>
        prisma.habitCompletion.deleteMany({ where: { childId: T.childId } }),
      );
      expect(await habitCompletions()).toHaveLength(0);

      // And past every CODE-LEVEL dedupe window: the fatigue guard's five
      // minutes and the notification bucket. Still the same business day, so
      // the ledger key and the badge are unchanged and the only thing that can
      // refuse a second row is a constraint.
      jest.setSystemTime(new Date(GOLDEN_NOON.getTime() + 45 * 60 * 1000));
      const freshToken = await runWithTenant(
        { familyId: T.familyId, actorType: 'DEVICE', actorId: T.deviceId },
        () => tokens.issueTokenPair({ subjectId: T.deviceId, actorType: 'DEVICE', familyId: T.familyId }),
      );

      // WATCH THE CONSTRAINT ITSELF. `awardBadgeIfNotAlready` is an INSERT with
      // a `catch` — it returns `false` ONLY because PostgreSQL refused the row.
      // Spying (calling through, mocking nothing) is what turns "the count did
      // not change" into "the database is the thing that said no".
      const spy = jest.spyOn(rewardsRepo, 'awardBadgeIfNotAlready');
      try {
        const res = await request(http)
          .post(`/life-intelligence/self/habits/${T.habitId}/complete`)
          .set({ Authorization: `Bearer ${freshToken.accessToken}` })
          .send({});
        expect([200, 201]).toContain(res.status);

        // The chain genuinely re-ran: a new completion row exists, and the
        // rules engine reached the badge insert.
        expect(await habitCompletions()).toHaveLength(1);
        expect(spy).toHaveBeenCalled();
        for (const result of spy.mock.results) {
          expect(await result.value).toBe(false);
        }
      } finally {
        spy.mockRestore();
        jest.setSystemTime(GOLDEN_NOON);
      }

      // …and every downstream link is still exactly one.
      expect(await chainCounts()).toEqual(baseline);
    });

    it('the ledger, the timeline and both inboxes each still hold exactly one row per cause', async () => {
      const rows = await ledger();
      expect(new Set(rows.map((r: any) => r.idempotencyKey)).size).toBe(rows.length);

      const messages = await childMessages();
      expect(new Set(messages.map((m: any) => m.sourceEventId)).size).toBe(messages.length);

      const notifications = await parentNotifications();
      expect(new Set(notifications.map((n: any) => n.sourceEventId)).size).toBe(notifications.length);
    });
  });

  // =========================================================================
  // 8. THE CLIENT CLAIM.
  // =========================================================================

  describe('8. a child that CLAIMS an award gets nothing, and "nothing" is a database fact', () => {
    /** Everything the forger's household holds. Its child performed no
     * legitimate action, so any non-empty answer here is a real award a forgery
     * produced. Every filter names BOTH ids — `where: { childId: undefined }`
     * is no filter at all in Prisma, and an empty answer read off the whole
     * table would be the exact false green this section exists to prevent. */
    async function forgeryState(): Promise<Record<string, number>> {
      expect(typeof F.childId).toBe('string');
      expect(typeof F.familyId).toBe('string');
      const [b, l, m] = await Promise.all([
        badgeAwards(F.childId),
        ledger(F.childId),
        childMessages(F.childId),
      ]);
      const t = await timeline(F.childId);
      const n = await sys('forgery notifications', () =>
        prisma.notification.findMany({ where: { familyId: F.familyId, childId: F.childId } }),
      );
      return {
        badges: b.length,
        ledger: l.length,
        timeline: t.length,
        childMessages: m.length,
        notifications: n.length,
      };
    }

    it('the forger’s child starts, and must end, holding nothing', async () => {
      expect(await forgeryState()).toEqual({
        badges: 0,
        ledger: 0,
        timeline: 0,
        childMessages: 0,
        notifications: 0,
      });
    });

    it('THE AWARD SURFACE: a device token cannot reach the reward trigger endpoint at all', async () => {
      const res = await request(http)
        .post(`/life-intelligence/rewards/${F.childId}/trigger`)
        .set({ Authorization: `Bearer ${F.deviceToken}` })
        .send({ engine: 'habit-builder', type: 'HABIT_COMPLETED', payload: {} });
      expect([401, 403]).toContain(res.status);
      expect(await forgeryState()).toEqual({
        badges: 0,
        ledger: 0,
        timeline: 0,
        childMessages: 0,
        notifications: 0,
      });
    });

    it('A CLAIMED BADGE: `badgeId` on the completion body is refused, and awards nothing', async () => {
      const definition = await sys('definition', () => rewardsRepo.findBadgeByKey(BADGE_KEY));
      const res = await request(http)
        .post(`/life-intelligence/self/habits/${F.habitId}/complete`)
        .set({ Authorization: `Bearer ${F.deviceToken}` })
        .send({ badgeId: definition!.id, badgeKey: BADGE_KEY });
      expect(res.status).toBe(400);
      expect(await forgeryState()).toEqual({
        badges: 0,
        ledger: 0,
        timeline: 0,
        childMessages: 0,
        notifications: 0,
      });
    });

    it('CLAIMED POINTS: `points` / `amount` / `xp` on the body are refused, and pay nothing', async () => {
      for (const body of [{ points: 9999 }, { amount: 9999 }, { xp: 9999 }]) {
        const res = await request(http)
          .post(`/life-intelligence/self/habits/${F.habitId}/complete`)
          .set({ Authorization: `Bearer ${F.deviceToken}` })
          .send(body);
        expect(res.status).toBe(400);
      }
      expect(await forgeryState()).toEqual({
        badges: 0,
        ledger: 0,
        timeline: 0,
        childMessages: 0,
        notifications: 0,
      });
    });

    it('A CLAIMED IDENTITY: `childId` / `familyId` on the body are refused, and reach no other child', async () => {
      for (const body of [{ childId: T.childId }, { familyId: T.familyId }, { verifiedBy: 'PARENT' }]) {
        const res = await request(http)
          .post(`/life-intelligence/self/habits/${F.habitId}/complete`)
          .set({ Authorization: `Bearer ${F.deviceToken}` })
          .send(body);
        expect(res.status).toBe(400);
      }
      expect(await forgeryState()).toEqual({
        badges: 0,
        ledger: 0,
        timeline: 0,
        childMessages: 0,
        notifications: 0,
      });
    });

    it('AND THE VICTIM IS UNTOUCHED: the legitimate child’s chain is exactly what §7 left it', async () => {
      expect(await chainCounts()).toEqual({
        badges: 1,
        ledger: 2,
        badgeTimeline: 1,
        rewardTimeline: 1,
        parentNotifications: 2,
        childMessages: 2,
      });
    });

    it('a device cannot post BADGE_EARNED on the wire either — the event is not ingestible', async () => {
      const res = await request(http)
        .post('/events/batch')
        .set({ Authorization: `Bearer ${F.deviceToken}` })
        .send({
          deviceTime: new Date().toISOString(),
          events: [
            {
              clientEventId: `forge:badge:${stamp}`,
              type: 'BADGE_EARNED',
              occurredAt: new Date().toISOString(),
              payload: { badgeKey: BADGE_KEY },
            },
          ],
        });
      // Either the DTO refuses the type outright or the ingestion service
      // rejects it — what must never happen is an award.
      const accepted = res.body?.data?.accepted ?? 0;
      expect(accepted).toBe(0);
      expect(await forgeryState()).toEqual({
        badges: 0,
        ledger: 0,
        timeline: 0,
        childMessages: 0,
        notifications: 0,
      });
    });
  });
});
