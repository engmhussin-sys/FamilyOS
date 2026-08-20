/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-var-requires */
/**
 * ============================================================================
 * ONE SEVEN-DAY STREAK, ONE PAYMENT — DRIVEN THROUGH BOTH DOORS.
 * ============================================================================
 *
 * THE DEFECT, MEASURED against real PostgreSQL before the fix. A habit streak
 * has TWO producers and, until this file, they composed the idempotency key two
 * different ways:
 *
 *   habit-engine.service.ts   `streak:<full-uuid>:habits:7`
 *   streak-detection.consumer `child:<short-uuid>:streak:habits:7`
 *
 * Both resolve to `engine: 'habit-builder'` + `type: 'STREAK_ACHIEVED'`, and
 * both therefore match the single seeded rule `default:habit:streak`
 * (COINS · 15). `rewards_ledger_entries (child_id, idempotency_key)` is a real
 * UNIQUE CONSTRAINT and it could not help: two key shapes are two different
 * keys and two legitimate rows. The measurement below, run against this file
 * with the pre-fix code, was TWO `EARN` COINS rows of 15 for ONE seven-day
 * streak — the same defect shape migration 0030 was written to end, on a
 * different crossing.
 *
 * The fix is not an `if`. Both producers now call
 * `composeIdempotencyKey('STREAK_ACHIEVED', …)`, so the two doors compose a
 * BYTE-IDENTICAL key and the ledger's own unique constraint refuses the second
 * grant. This file asserts the PERSISTED ROWS, not a return value.
 *
 * ON THE CLOCK: frozen (`freezeGoldenClock`), because the streak is measured on
 * the family's business day and a suite that straddles midnight in Cairo would
 * compute a different streak length in its second half.
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
import { FamilyDateService } from '../../src/common/time/family-date.service';
import { getBusinessDate } from '../../src/common/time/family-date';
import { composeIdempotencyKey } from '../../src/shared/events/idempotency';
import { integrationDatabaseUrl } from '../tenancy/prisma-test-client';
import { freezeGoldenClock, GOLDEN_NOON } from '../golden/golden-world';

const describeIfDb = integrationDatabaseUrl() ? describe : describe.skip;

/** Cairo, so the family calendar is a real offset from UTC rather than UTC. */
const CAIRO = 'Africa/Cairo';

/** The milestone under test. Seven consecutive qualifying days: six seeded,
 *  one earned live through the doors below. */
const MILESTONE = 7;

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
  habitId: string;
  deviceId: string;
  deviceToken: string;
}

describeIfDb('HABIT STREAK — the app button and the device event pay one milestone once', () => {
  let app: INestApplication;
  let http: any;
  let prisma: any;
  let tokens: TokenService;
  let relay: OutboxRelay;

  const stamp = Date.now();

  /** APP DOOR FIRST, then the device event. */
  const APP_FIRST = {} as Household;
  /** DEVICE DOOR FIRST, then the app button. Order independence is a property
   *  of a DATABASE CONSTRAINT, so it must be driven both ways. */
  const DEVICE_FIRST = {} as Household;

  let businessDay: string;

  const sys = (what: string, fn: () => Promise<any>): Promise<any> =>
    runAsSystemAsync('TEST_FIXTURE', `habit streak one payment: ${what}`, async () => await fn());

  // -- the readers: every assertion goes through one of these -----------------

  const ledger = (h: Household): Promise<any[]> =>
    sys('ledger', () =>
      prisma.rewardsLedgerEntry.findMany({
        where: { childId: h.childId },
        orderBy: { createdAt: 'asc' },
      }),
    );

  /** Every ledger row this crossing can produce, WHICHEVER key shape wrote it —
   *  the pre-fix `streak:<uuid>:habits:7` and the composed
   *  `child:<short>:streak:habits:7` both match, which is the only way this
   *  file could have counted 2 before the fix and can count 1 after it. */
  const streakLedger = async (h: Household): Promise<any[]> =>
    (await ledger(h)).filter((e: any) => /(^|:)streak:/.test(String(e.idempotencyKey)));

  /** THE PAYMENT. One currency, one crossing — the number this file is about. */
  const streakCoins = async (h: Household): Promise<any[]> =>
    (await streakLedger(h)).filter((e: any) => e.rewardType === 'COINS');

  /** The once-ever badge on the same crossing, protected by a DIFFERENT
   *  constraint (`child_badge_awards (child_id, badge_id)`) and therefore not
   *  evidence either way about the key. Counted so it cannot silently vanish. */
  const streakBadges = async (h: Household): Promise<any[]> =>
    (await streakLedger(h)).filter((e: any) => e.rewardType === 'BADGE');

  /** THE COMPLETION ITSELF, which the same two doors also pay
   *  (`default:habit:completed`, XP 10) — a second instance of the very same
   *  «two producers, two key shapes» defect, found by running this file. */
  const completionXp = async (h: Household): Promise<any[]> =>
    (await ledger(h)).filter(
      (e: any) => e.rewardType === 'XP' && /(^|:)habit(-completion)?:/.test(String(e.idempotencyKey)),
    );

  const account = (h: Household): Promise<any> =>
    sys('account', () => prisma.rewardsAccount.findFirst({ where: { childId: h.childId } }));

  const appAuth = (h: Household) => ({ Authorization: `Bearer ${h.deviceToken}` });

  // -- the two doors ---------------------------------------------------------

  /** DOOR A — the button the Child App actually calls. */
  const pressCompleteButton = (h: Household) =>
    request(http).post(`/life-intelligence/self/habits/${h.habitId}/complete`).set(appAuth(h)).send({});

  /** DOOR B — the same completion, aggregated on the device and posted as an
   *  event, which reaches `StreakDetectionConsumer` through the outbox. */
  async function postDeviceCompletion(h: Household, clientEventId: string): Promise<any> {
    const res = await request(http)
      .post('/events/batch')
      .set(appAuth(h))
      .send({
        deviceTime: new Date().toISOString(),
        events: [
          {
            clientEventId,
            type: 'HABIT_COMPLETED',
            occurredAt: new Date().toISOString(),
            localDate: businessDay,
            payload: { habitId: h.habitId },
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
    const email = `habit.streak.${label}.${stamp}@example.com`;
    const password = 'Habit-Streak-Passw0rd!23';
    const reg = await request(http).post('/auth/register').send({
      email,
      password,
      fullName: `Habit Streak Parent ${label}`,
      familyName: `Habit Streak Family ${label}`,
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
      .send({ firstName: `Streak Kid ${label}`, dateOfBirth: '2015-04-01' });
    if (!child.body?.id) throw new Error(`child(${label}) -> ${child.status} ${JSON.stringify(child.body)}`);
    target.childId = child.body.id;

    const habit = await request(http)
      .post(`/life-intelligence/habits/${target.childId}`)
      .set({ Authorization: `Bearer ${target.parentToken}` })
      .send({ title: 'ترتيب الغرفة', category: 'PERSONAL_CARE', recurrence: 'DAILY' });
    if (!habit.body?.id) throw new Error(`habit(${label}) -> ${habit.status} ${JSON.stringify(habit.body)}`);
    target.habitId = habit.body.id;

    const paired = await pairDevice(target.familyId, target.childId);
    target.deviceId = paired.deviceId;
    target.deviceToken = paired.token;

    // SIX PRIOR DAYS, seeded as rows rather than driven through the doors: the
    // fact under test is what happens on the SEVENTH day, and six more HTTP
    // round trips would only add clock surface. `date` is a `@db.Date`, so it
    // is written at the UTC midnight the column stores a business day at.
    await sys(`seed ${label} history`, () =>
      prisma.habitCompletion.createMany({
        data: Array.from({ length: MILESTONE - 1 }, (_, i) => ({
          familyId: target.familyId,
          habitId: target.habitId,
          childId: target.childId,
          date: FamilyDateService.toDateColumn(FamilyDateService.addDays(businessDay, -(i + 1))),
          status: 'COMPLETED' as const,
        })),
        skipDuplicates: true,
      }),
    );
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

    await registerHousehold('appfirst', APP_FIRST);
    await registerHousehold('devicefirst', DEVICE_FIRST);
  }, 300_000);

  afterAll(async () => {
    if (prisma) {
      await sys('teardown', async () => {
        const ids = [APP_FIRST, DEVICE_FIRST];
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
  // 0. THE GROUND THE COUNTS STAND ON
  // =========================================================================

  describe('0. the fixture', () => {
    it('two households, one child and one habit each, six qualifying days already banked', async () => {
      for (const h of [APP_FIRST, DEVICE_FIRST]) {
        expect(h.familyId).toEqual(expect.any(String));
        expect(h.childId).toEqual(expect.any(String));
        expect(h.habitId).toEqual(expect.any(String));
        const rows = await sys('history', () =>
          prisma.habitCompletion.findMany({ where: { childId: h.childId } }),
        );
        expect(rows).toHaveLength(MILESTONE - 1);
        expect(await streakLedger(h)).toHaveLength(0);
      }
      expect(APP_FIRST.childId).not.toBe(DEVICE_FIRST.childId);
    });

    /**
     * TWO SEEDED RULES ON THIS CROSSING, AND THAT IS NOT THE DEFECT: one XP-like
     * COINS payment and one once-ever BADGE. Two CURRENCIES for one act is a
     * product decision (`crossingCollisions` says so explicitly); two payments
     * in ONE currency is what this file exists to refuse.
     */
    it('the crossing is seeded with exactly one COINS rule and one BADGE rule', async () => {
      const rules = await sys('platform streak rules', () =>
        prisma.rewardRule.findMany({
          where: { familyId: null, triggerEngine: 'habit-builder', eventType: 'STREAK_ACHIEVED' },
        }),
      );
      expect(rules.filter((r: any) => r.rewardType === 'COINS')).toHaveLength(1);
      expect(rules.filter((r: any) => r.rewardType === 'BADGE')).toHaveLength(1);
      expect(rules.every((r: any) => r.isActive)).toBe(true);
      expect(rules.find((r: any) => r.rewardType === 'COINS').rewardAmountOrBadgeId).toBe('15');
    });
  });

  // =========================================================================
  // 1. APP DOOR FIRST — the assertion that was FALSE before the fix.
  // =========================================================================

  describe('1. the app button, then the same completion as a device event', () => {
    it('the seventh day, pressed in the app, pays the streak exactly once', async () => {
      const res = await pressCompleteButton(APP_FIRST);
      expect([200, 201]).toContain(res.status);

      expect(await streakCoins(APP_FIRST)).toHaveLength(1);
      expect(await streakBadges(APP_FIRST)).toHaveLength(1);
    });

    it('THE KEY IS THE COMPOSED ONE — not a hand-written second shape', async () => {
      const expected = composeIdempotencyKey('STREAK_ACHIEVED', {
        childId: APP_FIRST.childId,
        kind: 'habits',
        milestone: MILESTONE,
      });
      const [row] = await streakCoins(APP_FIRST);
      // `RewardsEngineService` appends `:${rewardType}:${source}` to the
      // trigger key, so the trigger key is a PREFIX of the ledger key.
      expect(String(row.idempotencyKey).startsWith(`${expected}:`)).toBe(true);
      // AND THE RETIRED SHAPE IS GONE. This is the byte-for-byte string the
      // pre-fix `habit-engine.service.ts` wrote, and it must never reappear.
      expect(String(row.idempotencyKey).startsWith(`streak:${APP_FIRST.childId}:`)).toBe(false);
    });

    it('the SAME milestone arriving through the device door adds NO second payment', async () => {
      const [before] = await streakCoins(APP_FIRST);
      const res = await postDeviceCompletion(APP_FIRST, `app-first-${stamp}`);
      expect([200, 201]).toContain(res.status);

      // THE ROWS, not the response body. Before the fix this was 2.
      const after = await streakCoins(APP_FIRST);
      expect(after).toHaveLength(1);
      expect(after[0].id).toBe(before.id);
    });

    it('and the wallet was credited once — 15 coins, not 30', async () => {
      const rows = await streakCoins(APP_FIRST);
      expect(rows.reduce((sum: number, r: any) => sum + Number(r.delta ?? 0), 0)).toBe(15);
      expect(Number((await account(APP_FIRST))?.coins ?? 0)).toBe(15);
    });

    /**
     * AND THE COMPLETION UNDER THE STREAK IS PAID ONCE TOO. `completeHabit`
     * hand-wrote `habit-completion:{habitId}:{day}` while the ingestion door
     * composed `child:{c}:habit:{habitId}:{day}` for the same tick of the same
     * habit on the same day — the identical defect one crossing lower down, and
     * it paid 10 + 10 XP. Found by running this file, so it is asserted here
     * rather than described somewhere.
     */
    it('the habit tick itself is paid once through both doors — 10 XP, not 20', async () => {
      const rows = await completionXp(APP_FIRST);
      expect(rows).toHaveLength(1);
      expect(rows.reduce((sum: number, r: any) => sum + Number(r.delta ?? 0), 0)).toBe(10);
      const expected = composeIdempotencyKey('HABIT_COMPLETED', {
        childId: APP_FIRST.childId,
        sourceId: APP_FIRST.habitId,
        localDate: businessDay,
      });
      expect(String(rows[0].idempotencyKey).startsWith(`${expected}:`)).toBe(true);
    });
  });

  // =========================================================================
  // 2. DEVICE DOOR FIRST — order independence, because a unique constraint has
  //    no opinion about which of two writers arrives first.
  // =========================================================================

  describe('2. the device event, then the app button', () => {
    it('the seventh day, arriving as a device event, pays the streak exactly once', async () => {
      const res = await postDeviceCompletion(DEVICE_FIRST, `device-first-${stamp}`);
      expect([200, 201]).toContain(res.status);

      expect(await streakCoins(DEVICE_FIRST)).toHaveLength(1);
    });

    it('and the app button on the same day adds NO second payment', async () => {
      const res = await pressCompleteButton(DEVICE_FIRST);
      expect([200, 201]).toContain(res.status);

      const rows = await streakCoins(DEVICE_FIRST);
      expect(rows).toHaveLength(1);
      expect(rows.reduce((sum: number, r: any) => sum + Number(r.delta ?? 0), 0)).toBe(15);
      expect(Number((await account(DEVICE_FIRST))?.coins ?? 0)).toBe(15);
    });

    it('both households composed the SAME key, up to the child id', async () => {
      const [a] = await streakCoins(APP_FIRST);
      const [b] = await streakCoins(DEVICE_FIRST);
      const withoutChild = (key: string, childId: string): string =>
        key.replace(childId.replace(/-/g, '').slice(0, 12), '<child>');
      expect(withoutChild(String(b.idempotencyKey), DEVICE_FIRST.childId)).toBe(
        withoutChild(String(a.idempotencyKey), APP_FIRST.childId),
      );
    });
  });
});
