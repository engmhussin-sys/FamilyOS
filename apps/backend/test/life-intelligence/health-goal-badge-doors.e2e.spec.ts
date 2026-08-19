/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-var-requires */
/**
 * ============================================================================
 * ONE CROSSING, TWO DOORS, ONE BADGE — ON PERSISTED ROWS.
 * ============================================================================
 *
 * THE DEFECT THIS FILE CLOSES, AND HOW IT WAS MEASURED.
 *
 * Migration 0026 seeds `first_hydration_goal` and `first_activity_goal` against
 * `eventType: 'HYDRATION_GOAL_COMPLETED'` / `'ACTIVITY_GOAL_COMPLETED'`.
 * `HealthEngineService.logHydration` / `logActivity` fired only
 * `DAILY_GOAL_COMPLETED` at the reward seam, and those two contract names were
 * produced as REWARD TRIGGERS by exactly one thing —
 * `RewardsCompletionConsumer`, i.e. only for a completion that arrived through
 * `POST /events/batch`. So a child who crossed their hydration target with the
 * Child App's own button was paid the XP and COULD NOT EARN THE BADGE, while
 * the identical crossing posted as a device event did earn it. Two doors onto
 * one business event, one of them badge-blind. `test/rewards/badge-chain.e2e
 * .spec.ts` recorded the measurement; the fix is in `health-engine.service.ts`
 * and this file is the proof and the tripwire.
 *
 * WHAT IS ASSERTED, AND WHERE FROM. Every count below is READ OUT OF
 * POSTGRESQL through Prisma against a family this file created. Nothing on the
 * causal path is stubbed: real app, real guards, real DeviceJwtAuthGuard, real
 * ingestion, real outbox relay, real `RewardsEngineService`, real PostgreSQL,
 * real Redis. The only rows written directly are the paired device (there is no
 * HTTP pairing shortcut) and the household.
 *
 *   1  THE APP DOOR         `POST /life-intelligence/self/health/hydration-logs`
 *                           crosses the target -> the badge EXISTS. This is the
 *                           assertion that was false before the fix.
 *   2  BOTH DOORS, ONE DAY  the same child, the same business day, driven
 *                           through BOTH doors in BOTH orders (two households,
 *                           app-first and device-first). Exactly ONE badge award
 *                           row and exactly ONE `BADGE` ledger row either way.
 *   3  THE SHARED KEY       the reason 2 holds is stated as an assertion rather
 *                           than a comment: both doors compose the SAME
 *                           `child:{child}:hydration:{businessDate}` key, so
 *                           `rewards_ledger_entries (child_id, idempotency_key)`
 *                           is what refuses the second grant.
 *   4  ACTIVITY             the same three things for `first_activity_goal`.
 *   5  REPLAY               plain replay, and then a HARD replay with the
 *                           CODE-LEVEL markers deleted (the hydration rows that
 *                           make the crossing test false, and the
 *                           `consumed_messages` marker that short-circuits the
 *                           consumer) so the chain genuinely re-runs and a
 *                           DATABASE CONSTRAINT is the thing that says no. The
 *                           refusal is watched at `awardBadgeIfNotAlready`
 *                           itself, called through and mocked nowhere.
 *   6  THE BUSINESS DATE    the key carries the FAMILY's day, not UTC's. Driven
 *                           at an instant whose UTC date is the PREVIOUS one.
 *
 * ON THE CLOCK. `freezeGoldenClock` at midday on the day BEHIND the real one —
 * outside quiet hours in both launch markets, and behind the real clock because
 * Prisma generates `@default(now())` client-side while the relay's SQL uses
 * PostgreSQL's own `now()`.
 *
 * ON THE HOUSEHOLD COUNT. One child per family, deliberately: the free plan
 * entitles a family to one child, so a same-family sibling silently fails to be
 * created and every count would then be read with `childId: undefined`, which
 * Prisma treats as NO FILTER.
 */
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request = require('supertest');

import { AppModule } from '../../src/app.module';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { createTenantExtension } from '../../src/common/tenancy/tenant.extension';
import { runAsSystemAsync } from '../../src/common/tenancy/system-context';
import { runWithTenant } from '../../src/common/tenancy/tenant-context';
import { getBusinessDate } from '../../src/common/time/family-date';
import { TokenService } from '../../src/modules/auth/application/services/token.service';
import { OutboxRelay } from '../../src/modules/events/application/outbox.relay';
import { EVENT_PUBLISHER } from '../../src/modules/events/domain/event-bus.port';
import { PrismaRewardsRepository } from '../../src/modules/life-intelligence/infrastructure/repositories/prisma-rewards.repository';
import { ENVELOPE_VERSION } from '../../src/shared/events/event-envelope';
import { composeIdempotencyKey } from '../../src/shared/events/idempotency';
import { integrationDatabaseUrl } from '../tenancy/prisma-test-client';
import { freezeGoldenClock, GOLDEN_NOON } from '../golden/golden-world';

const describeIfDb = integrationDatabaseUrl() ? describe : describe.skip;

/** Cairo, so the family's calendar is a real offset from UTC rather than UTC. */
const CAIRO = 'Africa/Cairo';

/** Comfortably over any age band's target (`HYDRATION_TARGET_ML_BY_AGE` tops
 *  out at 2700) in ONE log, so the crossing is unambiguous and this file does
 *  not have to restate the age table. */
const CROSSING_ML = 3000;
/** The activity goal is 60 minutes/day; 90 crosses it in one log. */
const CROSSING_MINUTES = 90;

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

interface Household {
  familyId: string;
  userId: string;
  parentToken: string;
  childId: string;
  deviceId: string;
  deviceToken: string;
}

describeIfDb('HEALTH GOAL BADGES — the app button and the device event are one door', () => {
  let app: INestApplication;
  let http: any;
  let prisma: any;
  let tokens: TokenService;
  let relay: OutboxRelay;
  let bus: any;
  let rewardsRepo: PrismaRewardsRepository;

  const stamp = Date.now();

  /** APP DOOR FIRST, then the device event — hydration. */
  const APP_FIRST = {} as Household;
  /** DEVICE DOOR FIRST, then the app button — hydration. Order independence is
   *  a property of a DATABASE CONSTRAINT, so it must be driven both ways. */
  const DEVICE_FIRST = {} as Household;
  /** Activity, app door first. */
  const ACTIVITY = {} as Household;

  const sys = (what: string, fn: () => Promise<any>): Promise<any> =>
    runAsSystemAsync('TEST_FIXTURE', `health goal badge doors: ${what}`, async () => await fn());

  // -- the readers: every assertion goes through one of these -----------------

  const badgeAwards = (h: Household): Promise<any[]> =>
    sys('badge awards', () =>
      prisma.childBadgeAward.findMany({ where: { childId: h.childId }, include: { badge: true } }),
    );

  const badgeKeys = async (h: Household): Promise<string[]> =>
    (await badgeAwards(h)).map((a: any) => a.badge.key).sort();

  const ledger = (h: Household): Promise<any[]> =>
    sys('ledger', () =>
      prisma.rewardsLedgerEntry.findMany({
        where: { childId: h.childId },
        orderBy: { createdAt: 'asc' },
      }),
    );

  const badgeLedger = async (h: Household): Promise<any[]> =>
    (await ledger(h)).filter((e: any) => e.rewardType === 'BADGE');

  /** `rewards_ledger_entries.business_date` is a `@db.Date`, so Prisma hands it
   *  back as a `Date` at UTC midnight. The DAY is the fact under test. */
  const dayOf = (value: unknown): string =>
    value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);

  const timeline = (h: Household): Promise<any[]> =>
    sys('timeline', () =>
      prisma.lifeTimelineEvent.findMany({ where: { childId: h.childId }, orderBy: { occurredAt: 'asc' } }),
    );

  const notifications = (h: Household, type?: string): Promise<any[]> =>
    sys('notifications', () =>
      prisma.notification.findMany({ where: { familyId: h.familyId, ...(type ? { type } : {}) } }),
    );

  const childMessages = (h: Household, category?: string): Promise<any[]> =>
    sys('child messages', () =>
      prisma.childMessage.findMany({ where: { childId: h.childId, ...(category ? { category } : {}) } }),
    );

  const domainEvents = (h: Household): Promise<any[]> =>
    sys('domain events', () => prisma.domainEvent.findMany({ where: { familyId: h.familyId } }));

  /** The four numbers every claim in this file is made of. */
  async function counts(h: Household): Promise<Record<string, number>> {
    const [b, l, t] = await Promise.all([badgeAwards(h), ledger(h), timeline(h)]);
    return {
      badges: b.length,
      badgeLedger: l.filter((e: any) => e.rewardType === 'BADGE').length,
      xpLedger: l.filter((e: any) => e.rewardType === 'XP').length,
      badgeTimeline: t.filter((e: any) => e.eventType === 'badge_awarded').length,
    };
  }

  // -- the two doors ---------------------------------------------------------

  const appAuth = (h: Household) => ({ Authorization: `Bearer ${h.deviceToken}` });

  /** DOOR A — the button the Child App actually calls. */
  const pressHydrationButton = (h: Household, amountMl = CROSSING_ML) =>
    request(http).post('/life-intelligence/self/health/hydration-logs').set(appAuth(h)).send({ amountMl });

  const pressActivityButton = (h: Household, durationMinutes = CROSSING_MINUTES) =>
    request(http)
      .post('/life-intelligence/self/health/activity-logs')
      .set(appAuth(h))
      .send({ date: businessDay, activityType: 'WALKING', durationMinutes });

  /** DOOR B — the same crossing, aggregated on the device and posted as an
   *  event. `occurredAt` is the frozen NOW so ingestion's skew bound accepts it
   *  and its own `getBusinessDate` lands on the same family day. */
  async function postDeviceEvent(h: Household, type: string, clientEventId: string): Promise<any> {
    const res = await request(http)
      .post('/events/batch')
      .set(appAuth(h))
      .send({
        deviceTime: new Date().toISOString(),
        events: [
          {
            clientEventId,
            type,
            occurredAt: new Date().toISOString(),
            localDate: businessDay,
            payload: {},
          },
        ],
      });
    await drainOutbox();
    return res;
  }

  async function drainOutbox(maxPasses = 8): Promise<void> {
    for (let i = 0; i < maxPasses; i++) {
      const pass = await relay.tick();
      if (pass.claimed === 0) break;
    }
  }

  /** The family's own day at the frozen instant — never `toISOString().slice(0, 10)`. */
  let businessDay: string;

  // -- fixtures --------------------------------------------------------------

  async function pairDevice(familyId: string, childId: string): Promise<{ deviceId: string; token: string }> {
    const device = await sys('seed device', () =>
      prisma.device.create({
        data: { familyId, ownerType: 'CHILD', childId, platform: 'ANDROID', status: 'ACTIVE', pairedAt: new Date() },
        select: { id: true },
      }),
    );
    const pair = await runWithTenant({ familyId, actorType: 'DEVICE', actorId: device.id }, () =>
      tokens.issueTokenPair({ subjectId: device.id, actorType: 'DEVICE', familyId }),
    );
    return { deviceId: device.id, token: pair.accessToken };
  }

  /** EVERY STEP IS CHECKED — a half-failed fixture hands the assertions an
   *  `undefined` id, and `where: { childId: undefined }` is NO FILTER. */
  async function registerHousehold(label: string, target: Household): Promise<void> {
    const email = `health.doors.${label}.${stamp}@example.com`;
    const password = 'Health-Doors-Passw0rd!23';
    const reg = await request(http).post('/auth/register').send({
      email,
      password,
      fullName: `Health Doors Parent ${label}`,
      familyName: `Health Doors Family ${label}`,
      timezone: CAIRO,
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
      .send({ firstName: `Doors Kid ${label}`, dateOfBirth: '2015-04-01' });
    if (!child.body?.id) throw new Error(`child(${label}) -> ${child.status} ${JSON.stringify(child.body)}`);
    target.childId = child.body.id;

    const paired = await pairDevice(target.familyId, target.childId);
    target.deviceId = paired.deviceId;
    target.deviceToken = paired.token;
  }

  beforeAll(async () => {
    freezeGoldenClock(GOLDEN_NOON);
    businessDay = getBusinessDate(new Date(), CAIRO);

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
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();

    http = app.getHttpServer();
    prisma = app.get(PrismaService);
    tokens = app.get(TokenService);
    relay = app.get(OutboxRelay);
    bus = app.get(EVENT_PUBLISHER);
    rewardsRepo = app.get(PrismaRewardsRepository);

    await registerHousehold('appfirst', APP_FIRST);
    await registerHousehold('devicefirst', DEVICE_FIRST);
    await registerHousehold('activity', ACTIVITY);
  }, 300_000);

  afterAll(async () => {
    if (prisma) {
      await sys('teardown', async () => {
        const ids = [APP_FIRST, DEVICE_FIRST, ACTIVITY];
        await prisma.device.deleteMany({ where: { id: { in: ids.map((h) => h.deviceId) } } });
        await prisma.family.deleteMany({ where: { id: { in: ids.map((h) => h.familyId) } } });
        await prisma.user.deleteMany({ where: { id: { in: ids.map((h) => h.userId) } } });
      });
    }
    jest.setSystemTime(GOLDEN_NOON);
    jest.useRealTimers();
    await app?.close();
  });

  // =========================================================================
  // 0. THE FIXTURE, STATED — every count below depends on these.
  // =========================================================================

  describe('0. the ground the counts stand on', () => {
    it('three households, one child each, each with a paired device', () => {
      for (const h of [APP_FIRST, DEVICE_FIRST, ACTIVITY]) {
        expect(h.familyId).toEqual(expect.any(String));
        expect(h.childId).toEqual(expect.any(String));
        expect(h.deviceId).toEqual(expect.any(String));
      }
      expect(new Set([APP_FIRST.childId, DEVICE_FIRST.childId, ACTIVITY.childId]).size).toBe(3);
    });

    it('nothing has been earned yet — the "after" numbers are differences, not totals', async () => {
      for (const h of [APP_FIRST, DEVICE_FIRST, ACTIVITY]) {
        expect(await counts(h)).toEqual({ badges: 0, badgeLedger: 0, xpLedger: 0, badgeTimeline: 0 });
      }
    });

    it('the badge rules this file depends on are seeded and active', async () => {
      const rules = await sys('platform health rules', () =>
        prisma.rewardRule.findMany({ where: { familyId: null, triggerEngine: 'health', rewardType: 'BADGE' } }),
      );
      expect(rules.map((r: any) => `${r.eventType}:${r.rewardAmountOrBadgeId}`).sort()).toEqual([
        'ACTIVITY_GOAL_COMPLETED:first_activity_goal',
        'HYDRATION_GOAL_COMPLETED:first_hydration_goal',
      ]);
      expect(rules.every((r: any) => r.isActive)).toBe(true);
    });
  });

  // =========================================================================
  // 1. THE APP DOOR — the assertion that was FALSE before the fix.
  // =========================================================================

  describe('1. the Child App hydration button earns the badge', () => {
    it('a log BELOW the target pays nothing and awards nothing', async () => {
      const res = await pressHydrationButton(APP_FIRST, 100);
      expect([200, 201]).toContain(res.status);
      expect(await counts(APP_FIRST)).toEqual({ badges: 0, badgeLedger: 0, xpLedger: 0, badgeTimeline: 0 });
    });

    it('CROSSING THE TARGET through the app button awards first_hydration_goal', async () => {
      const res = await pressHydrationButton(APP_FIRST);
      expect([200, 201]).toContain(res.status);

      // THE ROW, not the response body. Before the fix this was `[]`.
      expect(await badgeKeys(APP_FIRST)).toEqual(['first_hydration_goal']);
      expect(await badgeLedger(APP_FIRST)).toHaveLength(1);
    });

    it('and the badge announcement reached both audiences exactly once', async () => {
      expect(await notifications(APP_FIRST, 'BADGE_EARNED_PARENT')).toHaveLength(1);
      expect(await childMessages(APP_FIRST, 'BADGE_EARNED')).toHaveLength(1);
      const t = await timeline(APP_FIRST);
      expect(t.filter((e: any) => e.eventType === 'badge_awarded')).toHaveLength(1);
    });

    /**
     * THE KEY IS THE MECHANISM, SO IT IS ASSERTED RATHER THAN DESCRIBED.
     *
     * `RewardsEngineService` builds every ledger key as
     * `${trigger.idempotencyKey}:${rewardType}:${source}`, and the trigger key
     * for this door is now `composeIdempotencyKey('HYDRATION_GOAL_COMPLETED',
     * …)` — the SAME call `EventIngestionService` makes for the device door.
     * That shared prefix is the whole reason §2 can hold, and it carries the
     * FAMILY's business date rather than UTC's.
     */
    /**
     * =====================================================================
     * A CONSEQUENCE OF THIS FIX, MEASURED AND PINNED RATHER THAN LEFT SILENT.
     * =====================================================================
     *
     * The platform seeds TWO XP rules for the SAME hydration crossing, one per
     * event name — `default:health:daily-goal-hydration`
     * (`DAILY_GOAL_COMPLETED {metric: hydration}`, 15 XP) and
     * `default:hydration:goal` (`HYDRATION_GOAL_COMPLETED`, 15 XP). Their
     * `labelAr` is BYTE-IDENTICAL («هدف شرب الماء اليومي»), as are their
     * amount, caps and category: they are one reward written twice, once for
     * each door, because until now each door produced only one of the names.
     *
     * Firing the contract name from THIS door — which is what makes the badge
     * reachable at all — therefore matches BOTH rules, and the app door now
     * pays 15 + 15 where it used to pay 15. The two rules have different ids,
     * so `source` differs, so the ledger keys differ, so the DATABASE cannot
     * and should not collapse them: they are, as far as the rules table is
     * concerned, two distinct rewards.
     *
     * THIS IS NOT SOMETHING THIS TEST APPROVES OF. `reward-rule-catalogue.ts`
     * states the invariant it breaks in its own header — «the same real-world
     * completion can no longer be paid twice». Collapsing the duplicate pair is
     * a change to `src/shared/rewards/reward-rule-catalogue.ts` and to the
     * migration that seeded it, NEITHER OF WHICH THIS AGENT OWNS, so the number
     * is pinned here instead of being quietly doubled: whoever owns the
     * catalogue will see this assertion fail the moment they fix it, and the
     * failure will tell them exactly what the new number should be.
     */
    it('MEASURED CONSEQUENCE: two seeded XP rules now match one crossing, so the app door pays twice', async () => {
      const xp = (await ledger(APP_FIRST)).filter((e: any) => e.rewardType === 'XP');
      expect(xp).toHaveLength(2);
      // Two DIFFERENT platform rules, not one rule paid twice — the ledger's
      // unique constraint would have refused that.
      expect(new Set(xp.map((e: any) => e.source)).size).toBe(2);
      expect(xp.every((e: any) => String(e.source).startsWith('reward_rule:'))).toBe(true);
      // 15 (DAILY_GOAL_COMPLETED{hydration}) + 15 (HYDRATION_GOAL_COMPLETED).
      expect(xp.reduce((sum: number, e: any) => sum + Number(e.amount), 0)).toBe(30);
    });

    it('the BADGE ledger row is keyed on the SHARED, server-composed contract key', async () => {
      const shared = composeIdempotencyKey('HYDRATION_GOAL_COMPLETED', {
        childId: APP_FIRST.childId,
        localDate: businessDay,
      });
      const badgeRow = (await badgeLedger(APP_FIRST))[0];
      expect(badgeRow.idempotencyKey.startsWith(`${shared}:BADGE:`)).toBe(true);
      // The family's own day, spelled out — not `new Date().toISOString()`.
      expect(shared).toContain(`:hydration:${businessDay}`);
      expect(dayOf(badgeRow.businessDate)).toBe(businessDay);
    });
  });

  // =========================================================================
  // 2. BOTH DOORS, SAME CHILD, SAME BUSINESS DAY.
  // =========================================================================

  describe('2. app door then device event — one badge, one ledger row', () => {
    let before: Record<string, number>;

    it('the device event for the SAME crossing is accepted', async () => {
      before = await counts(APP_FIRST);
      const res = await postDeviceEvent(APP_FIRST, 'HYDRATION_GOAL_COMPLETED', 'doors-app-then-device');
      expect(res.status).toBe(200);
      // ACCEPTED, not rejected: the event is a real, ingestible completion. The
      // refusal this file is about happens further down, at the ledger.
      expect(res.body.data.results[0].status).toBe('ACCEPTED');
      expect((await domainEvents(APP_FIRST)).filter((e: any) => e.eventType === 'HYDRATION_GOAL_COMPLETED')).toHaveLength(1);
    });

    it('AND THE CHILD STILL HOLDS EXACTLY ONE BADGE AND ONE BADGE LEDGER ROW', async () => {
      expect(await badgeKeys(APP_FIRST)).toEqual(['first_hydration_goal']);
      expect(await counts(APP_FIRST)).toEqual(before);
    });

    it('the second door announced nothing — no child or parent was told twice', async () => {
      expect(await notifications(APP_FIRST, 'BADGE_EARNED_PARENT')).toHaveLength(1);
      expect(await childMessages(APP_FIRST, 'BADGE_EARNED')).toHaveLength(1);
    });
  });

  describe('3. device event then app door — the same answer in the other order', () => {
    it('the device event alone awards the badge', async () => {
      const res = await postDeviceEvent(DEVICE_FIRST, 'HYDRATION_GOAL_COMPLETED', 'doors-device-then-app');
      expect(res.status).toBe(200);
      expect(await badgeKeys(DEVICE_FIRST)).toEqual(['first_hydration_goal']);
      expect(await badgeLedger(DEVICE_FIRST)).toHaveLength(1);
    });

    it('and the app button afterwards adds NO second badge and NO second BADGE row', async () => {
      const before = await counts(DEVICE_FIRST);
      const res = await pressHydrationButton(DEVICE_FIRST);
      expect([200, 201]).toContain(res.status);

      const after = await counts(DEVICE_FIRST);
      expect(await badgeKeys(DEVICE_FIRST)).toEqual(['first_hydration_goal']);
      expect(after.badges).toBe(1);
      expect(after.badgeLedger).toBe(1);
      expect(after.badgeTimeline).toBe(before.badgeTimeline);
    });

    it('both doors composed the SAME key — which is why the database could refuse', async () => {
      const shared = composeIdempotencyKey('HYDRATION_GOAL_COMPLETED', {
        childId: DEVICE_FIRST.childId,
        localDate: businessDay,
      });
      const keyed = (await ledger(DEVICE_FIRST)).filter((e: any) =>
        e.idempotencyKey.startsWith(`${shared}:`),
      );
      // One XP row and one BADGE row under the SHARED key — the second door
      // produced neither a third row nor a differently-keyed duplicate.
      expect(keyed.filter((e: any) => e.rewardType === 'BADGE')).toHaveLength(1);
      expect(keyed.filter((e: any) => e.rewardType === 'XP')).toHaveLength(1);
    });
  });

  // =========================================================================
  // 4. ACTIVITY — the same defect, the same fix, the same proof.
  // =========================================================================

  describe('4. first_activity_goal is earnable through the app button too', () => {
    it('crossing 60 minutes through POST /self/health/activity-logs awards the badge', async () => {
      const res = await pressActivityButton(ACTIVITY);
      expect([200, 201]).toContain(res.status);
      expect(await badgeKeys(ACTIVITY)).toEqual(['first_activity_goal']);
      expect(await badgeLedger(ACTIVITY)).toHaveLength(1);
    });

    it('the device event for the same crossing adds nothing', async () => {
      const before = await counts(ACTIVITY);
      const res = await postDeviceEvent(ACTIVITY, 'ACTIVITY_GOAL_COMPLETED', 'doors-activity-device');
      expect(res.status).toBe(200);
      expect(await counts(ACTIVITY)).toEqual(before);
      expect(await badgeKeys(ACTIVITY)).toEqual(['first_activity_goal']);
    });

    it('and it is keyed on the shared contract key, on the family day', async () => {
      const shared = composeIdempotencyKey('ACTIVITY_GOAL_COMPLETED', {
        childId: ACTIVITY.childId,
        localDate: businessDay,
      });
      const badgeRow = (await badgeLedger(ACTIVITY))[0];
      expect(badgeRow.idempotencyKey.startsWith(`${shared}:BADGE:`)).toBe(true);
      expect(dayOf(badgeRow.businessDate)).toBe(businessDay);
    });
  });

  // =========================================================================
  // 5. REPLAY — and then the HARD replay, with the code-level markers gone.
  // =========================================================================

  describe('5. replayed, and then replayed with nothing but the database left to refuse', () => {
    let baseline: Record<string, number>;

    beforeAll(async () => {
      baseline = await counts(APP_FIRST);
    });

    it('THE PLAIN REPLAY: pressing the button again changes nothing', async () => {
      const res = await pressHydrationButton(APP_FIRST);
      expect([200, 201]).toContain(res.status);
      expect(await counts(APP_FIRST)).toEqual(baseline);
    });

    /**
     * THE HARD REPLAY. The plain replay above is refused EARLY and cheaply: the
     * crossing test (`totalToday - amountMl < target`) is false once the day's
     * total is already past the target, so the reward seam is never reached and
     * the assertion proves the guard, not the constraint.
     *
     * Deleting the day's `hydration_logs` deletes exactly that guard. The next
     * POST re-crosses from zero and the WHOLE chain runs again from the top:
     * timeline write, three triggers, rule evaluation, badge lookup, award
     * attempt, ledger insert. Nothing is left to refuse a second badge except
     * `child_badge_awards (child_id, badge_id)` and `rewards_ledger_entries
     * (child_id, idempotency_key)`.
     *
     * AND THE REFUSAL IS WATCHED WHERE IT HAPPENS. `awardBadgeIfNotAlready` is
     * an INSERT inside a `catch` — it returns `false` ONLY because PostgreSQL
     * refused the row. Spying on it (calling THROUGH; mocking nothing) turns
     * "the count did not change" into "the database is the thing that said no".
     */
    it('THE HARD REPLAY: markers deleted, the chain genuinely re-runs, the CONSTRAINT refuses', async () => {
      await sys('delete the crossing guard', () =>
        prisma.hydrationLog.deleteMany({ where: { childId: APP_FIRST.childId } }),
      );
      expect(
        await sys('hydration logs', () => prisma.hydrationLog.findMany({ where: { childId: APP_FIRST.childId } })),
      ).toHaveLength(0);

      // Past every CODE-LEVEL dedupe window (the fatigue guard's minutes, the
      // notification bucket) while staying on the SAME business day, so the
      // composed key is byte-identical and a constraint is the only candidate.
      jest.setSystemTime(new Date(GOLDEN_NOON.getTime() + 45 * 60 * 1000));
      expect(getBusinessDate(new Date(), CAIRO)).toBe(businessDay);

      const freshToken = await runWithTenant(
        { familyId: APP_FIRST.familyId, actorType: 'DEVICE', actorId: APP_FIRST.deviceId },
        () =>
          tokens.issueTokenPair({
            subjectId: APP_FIRST.deviceId,
            actorType: 'DEVICE',
            familyId: APP_FIRST.familyId,
          }),
      );

      const spy = jest.spyOn(rewardsRepo, 'awardBadgeIfNotAlready');
      try {
        const res = await request(http)
          .post('/life-intelligence/self/health/hydration-logs')
          .set({ Authorization: `Bearer ${freshToken.accessToken}` })
          .send({ amountMl: CROSSING_ML });
        expect([200, 201]).toContain(res.status);

        // The chain REALLY re-ran: the award was attempted again...
        expect(spy).toHaveBeenCalled();
        // ...and every attempt came back false, from the `catch` around a
        // refused INSERT.
        expect(await Promise.all(spy.mock.results.map((r: any) => r.value))).toEqual(
          spy.mock.results.map(() => false),
        );
      } finally {
        spy.mockRestore();
        jest.setSystemTime(GOLDEN_NOON);
      }

      expect(await counts(APP_FIRST)).toEqual(baseline);
      expect(await badgeKeys(APP_FIRST)).toEqual(['first_hydration_goal']);
    });

    /**
     * THE OTHER DOOR'S MARKER. `RewardsCompletionConsumer` wraps its work in
     * `ConsumerIdempotency.once`, which is a `consumed_messages` row — a
     * CODE-LEVEL check-then-run. Deleting it and re-publishing the SAME stored
     * envelope (rebuilt exactly as `OutboxRelay.dispatch` rebuilds it) makes the
     * consumer run the whole grant path again for an event it has already
     * handled. Again, only constraints are left.
     */
    it('THE CONSUMER REPLAY: consumed_messages deleted, the event re-published, still one badge', async () => {
      const event = (await domainEvents(DEVICE_FIRST)).find(
        (e: any) => e.eventType === 'HYDRATION_GOAL_COMPLETED',
      );
      expect(event).toBeDefined();

      const deleted = await sys('delete consumer marker', () =>
        prisma.consumedMessage.deleteMany({ where: { domainEventId: event.id } }),
      );
      expect(deleted.count).toBeGreaterThan(0);

      const before = await counts(DEVICE_FIRST);

      await runWithTenant(
        { familyId: DEVICE_FIRST.familyId, actorType: 'SYSTEM', actorId: 'test:hard-replay' },
        () =>
          bus.publish({
            envelopeVersion: ENVELOPE_VERSION,
            id: event.id,
            type: event.eventType,
            schemaVersion: event.schemaVersion,
            familyId: event.familyId,
            childId: event.childId,
            deviceId: event.deviceId,
            aggregateType: event.aggregateType,
            aggregateId: event.aggregateId,
            occurredAt: new Date(event.occurredAt).toISOString(),
            receivedAt: new Date(event.receivedAt).toISOString(),
            idempotencyKey: event.idempotencyKey,
            clientEventId: event.clientEventId,
            traceId: event.correlationId,
            payload: event.payload,
          }),
      );

      expect(await counts(DEVICE_FIRST)).toEqual(before);
      expect(await badgeKeys(DEVICE_FIRST)).toEqual(['first_hydration_goal']);
    });
  });

  // =========================================================================
  // 6. THE FAMILY'S CALENDAR, NOT UTC'S.
  // =========================================================================

  /**
   * The key embeds a day, and this repo has been bitten repeatedly by that day
   * being UTC's. THE INSTANT IS CHOSEN SO THE TWO GENUINELY DISAGREE: after
   * midnight on the family's clock while UTC still reads the previous date. A
   * key built from `toISOString().slice(0, 10)` would carry YESTERDAY there,
   * would not collide with the other door's key, and would pay the same goal
   * twice across the boundary.
   *
   * THE OFFSET IS READ FROM tzdata, NEVER WRITTEN DOWN. `getBusinessDate` is the
   * product's own function; this test asserts the DISAGREEMENT rather than a
   * hard-coded `+02:00` or `+03:00`, so Egypt's on-again-off-again DST cannot
   * make it assert something false in a different month.
   */
  describe('6. the idempotency key carries the family business date, not UTC', () => {
    it('past midnight in Cairo while UTC still reads the previous day, the key carries the CAIRO day', () => {
      // Walk forward in half-hour steps from midday UTC until the Cairo day has
      // rolled over and the UTC day has not. In any positive offset such an
      // instant exists; deriving it keeps the test honest under DST changes.
      const base = new Date(`${businessDay}T12:00:00.000Z`).getTime();
      let divergent: Date | null = null;
      for (let i = 1; i <= 24 && divergent === null; i++) {
        const candidate = new Date(base + i * 30 * 60 * 1000);
        if (getBusinessDate(candidate, CAIRO) !== candidate.toISOString().slice(0, 10)) {
          divergent = candidate;
        }
      }
      expect(divergent).not.toBeNull();

      const cairoDay = getBusinessDate(divergent as Date, CAIRO);
      const utcDay = (divergent as Date).toISOString().slice(0, 10);
      // The family has turned the page; UTC has not.
      expect(cairoDay).not.toBe(utcDay);
      expect(utcDay).toBe(businessDay);

      const key = composeIdempotencyKey('HYDRATION_GOAL_COMPLETED', {
        childId: APP_FIRST.childId,
        localDate: cairoDay,
      });
      expect(key).toContain(`:hydration:${cairoDay}`);
      expect(key).not.toContain(`:hydration:${utcDay}`);
    });
  });
});
