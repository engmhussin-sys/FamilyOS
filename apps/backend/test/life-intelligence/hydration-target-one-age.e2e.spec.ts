/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-var-requires */
/**
 * ============================================================================
 * ONE ANSWER TO «HOW OLD IS THIS CHILD?» — MEASURED ON A NINTH BIRTHDAY.
 * ============================================================================
 *
 * THE DEFECT. Age had three implementations:
 *
 *   businessAgeInYears        common/time/family-date.ts   calendar, family tz
 *   HealthEngineService.ageYears  health-engine.service.ts  ÷ 365.25
 *   calculateAge              common/utils/age.ts          the HOST's clock
 *
 * and the first two BOTH fed `computeHydrationTargetMl`.
 *
 * `÷ 365.25` is not a calendar. Nine calendar years spanning only two leap days
 * is 3287 days; 3287 / 365.25 = 8.9993, which floors to EIGHT. Whether it
 * floors to eight or nine depends on the TIME OF DAY the question is asked:
 * adding twelve hours pushes the same child over 9.0. Scanned over a year of
 * «today» values and ages 3–18, the two forms disagree on 3,600 (today, DOB)
 * pairs at 00:00 UTC, 730 of which land in DIFFERENT hydration bands. At 12:00
 * UTC the band-crossing disagreements are zero — which is why this file freezes
 * the clock EARLY IN THE DAY and not at the golden noon every other suite uses.
 * A defect that only appears before dawn is still a defect.
 *
 * WHAT IT COST, in this file's own terms: on the child's ninth birthday the
 * ÷365.25 form said 8 → 1700 ml while the calendar form said 9 → 2100 ml. So
 * `getDailyProgress` reported the goal reached at 1800 ml, `logHydration`
 * fired `HYDRATION_GOAL_COMPLETED` and PAID for it there, the persisted
 * `health_scores` row recorded a 1700 ml target — and `ChildSignalService`,
 * which asks `businessAgeInYears`, went on nudging the same child to drink.
 *
 * `businessAgeInYears` is kept. Everything below reads PERSISTED ROWS.
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
import { businessAgeInYears, getBusinessDate } from '../../src/common/time/family-date';
import { computeHydrationTargetMl } from '../../src/modules/life-intelligence/application/services/health-rules';
import { integrationDatabaseUrl } from '../tenancy/prisma-test-client';
import { freezeGoldenClock, goldenAt, GOLDEN_NOON } from '../golden/golden-world';

const describeIfDb = integrationDatabaseUrl() ? describe : describe.skip;

const CAIRO = 'Africa/Cairo';

/**
 * 01:00 UTC is 04:00 in Cairo — the same calendar day, and early enough that the
 * ÷365.25 form has not yet accumulated the twelve hours it needs to agree with
 * the calendar on a birthday. At the golden noon the two forms AGREE for this
 * DOB, so a suite frozen there could not see the defect at all.
 */
const EARLY_MORNING = goldenAt('01:00');

/** Under the ninth-birthday target (2100) and over the eighth-year one (1700).
 *  The whole defect lives in this gap. */
const BETWEEN_THE_TARGETS_ML = 1800;

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

describeIfDb('HYDRATION TARGET — one age, on the family calendar, on a birthday', () => {
  let app: INestApplication;
  let http: any;
  let prisma: any;
  let tokens: TokenService;
  let relay: OutboxRelay;

  const stamp = Date.now();
  const H = {} as Household;

  let businessDay: string;
  /** Exactly nine calendar years before today, on the family's calendar. */
  let dateOfBirth: string;

  const sys = (what: string, fn: () => Promise<any>): Promise<any> =>
    runAsSystemAsync('TEST_FIXTURE', `hydration target one age: ${what}`, async () => await fn());

  const parentAuth = () => ({ Authorization: `Bearer ${H.parentToken}` });
  const appAuth = () => ({ Authorization: `Bearer ${H.deviceToken}` });

  // -- the readers -----------------------------------------------------------

  const hydrationLedger = async (): Promise<any[]> =>
    sys('ledger', () =>
      prisma.rewardsLedgerEntry.findMany({ where: { childId: H.childId }, orderBy: { createdAt: 'asc' } }),
    ).then((rows: any[]) => rows.filter((r) => /:hydration:/.test(String(r.idempotencyKey))));

  const healthScoreRow = (): Promise<any> =>
    sys('health score', () =>
      prisma.healthScoreDaily.findFirst({
        where: { childId: H.childId, date: FamilyDateService.toDateColumn(businessDay) },
      }),
    );

  const drink = (amountMl: number) =>
    request(http).post('/life-intelligence/self/health/hydration-logs').set(appAuth()).send({ amountMl });

  async function drainOutbox(maxPasses = 8): Promise<void> {
    for (let i = 0; i < maxPasses; i++) {
      const pass = await relay.tick();
      if (pass.claimed === 0) break;
    }
  }

  beforeAll(async () => {
    freezeGoldenClock(EARLY_MORNING);
    businessDay = getBusinessDate(new Date(), CAIRO);
    // Nine calendar years back, same month and day — so today IS the birthday.
    dateOfBirth = `${Number(businessDay.slice(0, 4)) - 9}${businessDay.slice(4)}`;

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
    relay = app.get(OutboxRelay);

    const email = `hydration.age.${stamp}@example.com`;
    const password = 'Hydration-Age-Passw0rd!23';
    const reg = await request(http).post('/auth/register').send({
      email,
      password,
      fullName: 'Hydration Age Parent',
      familyName: 'Hydration Age Family',
      timezone: CAIRO,
      acceptedTerms: true,
    });
    if (![200, 201].includes(reg.status)) {
      throw new Error(`register -> ${reg.status} ${JSON.stringify(reg.body)}`);
    }
    const login = await request(http).post('/auth/login').send({ email, password });
    H.parentToken = login.body.tokens?.accessToken ?? login.body.accessToken;
    if (!H.parentToken) throw new Error(`login -> ${JSON.stringify(login.body)}`);
    const claims = JSON.parse(Buffer.from(H.parentToken.split('.')[1], 'base64').toString());
    H.familyId = claims.familyId;
    H.userId = claims.sub;

    const child = await request(http)
      .post('/children')
      .set(parentAuth())
      .send({ firstName: 'Birthday Kid', dateOfBirth });
    if (!child.body?.id) throw new Error(`child -> ${child.status} ${JSON.stringify(child.body)}`);
    H.childId = child.body.id;

    const device = await sys('seed device', () =>
      prisma.device.create({
        data: {
          familyId: H.familyId,
          ownerType: 'CHILD',
          childId: H.childId,
          platform: 'ANDROID',
          status: 'ACTIVE',
          pairedAt: new Date(),
        },
        select: { id: true },
      }),
    );
    H.deviceId = device.id;
    H.deviceToken = (
      await runWithTenant({ familyId: H.familyId, actorType: 'DEVICE', actorId: device.id }, () =>
        tokens.issueTokenPair({ subjectId: device.id, actorType: 'DEVICE', familyId: H.familyId }),
      )
    ).accessToken;
  }, 300_000);

  afterAll(async () => {
    if (prisma) {
      await sys('teardown', async () => {
        await prisma.device.deleteMany({ where: { id: H.deviceId } });
        await prisma.family.deleteMany({ where: { id: H.familyId } });
        await prisma.user.deleteMany({ where: { id: H.userId } });
      });
    }
    jest.setSystemTime(GOLDEN_NOON);
    jest.useRealTimers();
    await app?.close();
  });

  // =========================================================================
  // 0. THE FIXTURE IS THE DEFECT'S OWN CONDITIONS, STATED
  // =========================================================================

  describe('0. today is this child’s ninth birthday, and the two forms disagreed', () => {
    it('the calendar says nine, and nine means 2100 ml', () => {
      expect(dateOfBirth.slice(5)).toBe(businessDay.slice(5));
      expect(businessAgeInYears(dateOfBirth, new Date(), CAIRO)).toBe(9);
      expect(computeHydrationTargetMl(9)).toBe(2100);
      expect(computeHydrationTargetMl(8)).toBe(1700);
    });

    /**
     * THE RETIRED ARITHMETIC, RECONSTRUCTED HERE AND NOWHERE ELSE. This is
     * byte-for-byte what `HealthEngineService.ageYears` computed, kept only so
     * this file can PROVE the two forms disagree at this instant rather than
     * assert it. It is deleted from `src/`.
     */
    it('the retired ÷365.25 form says eight at this hour — the disagreement is real', () => {
      const retired = Math.floor(
        (Date.now() - new Date(dateOfBirth).getTime()) / (365.25 * 24 * 3600 * 1000),
      );
      expect(retired).toBe(8);
      expect(retired).not.toBe(businessAgeInYears(dateOfBirth, new Date(), CAIRO));
    });
  });

  // =========================================================================
  // 1. THE MONEY — the grant fires on the calendar age's line, not the other's.
  // =========================================================================

  describe('1. drinking 1800 ml on a ninth birthday', () => {
    it('is accepted', async () => {
      const res = await drink(BETWEEN_THE_TARGETS_ML);
      expect([200, 201]).toContain(res.status);
      await drainOutbox();
    });

    /**
     * THE ROWS. Before the fix, 1800 ml crossed the ÷365.25 form's 1700 and
     * `logHydration` paid for the day's goal right here. 1800 is below a
     * nine-year-old's real 2100 target, so the honest answer is no grant yet.
     */
    it('pays NOTHING — 1800 is under a nine-year-old’s 2100 ml target', async () => {
      expect(await hydrationLedger()).toEqual([]);
    });

    it('and the progress screen agrees: 2100 ml, not reached', async () => {
      const res = await request(http)
        .get(`/life-intelligence/health/${H.childId}/progress`)
        .set(parentAuth());
      expect([200, 201]).toContain(res.status);
      expect(res.body.hydration.targetMl).toBe(2100);
      expect(res.body.hydration.isAchieved).toBe(false);
    });

    /**
     * AND THE PERSISTED SCORE ROW CARRIES THE SAME TARGET. `health_scores
     * .breakdown` is stored, read back by the Digital Twin and shown to a
     * parent; before the fix it recorded 1700 for a nine-year-old.
     */
    it('and the stored health_scores breakdown records 2100 ml', async () => {
      const res = await request(http)
        .get(`/life-intelligence/health/${H.childId}/score`)
        .set(parentAuth());
      expect([200, 201]).toContain(res.status);

      const row = await healthScoreRow();
      expect(row).not.toBeNull();
      expect(row.breakdown.hydration.targetMl).toBe(2100);
    });
  });

  // =========================================================================
  // 2. AND THE LINE THAT DOES PAY IS THE REAL ONE
  // =========================================================================

  describe('2. crossing the real target', () => {
    it('another 400 ml (2200 total) crosses 2100 and pays exactly once', async () => {
      const res = await drink(400);
      expect([200, 201]).toContain(res.status);
      await drainOutbox();

      const rows = await hydrationLedger();
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.filter((r: any) => r.rewardType === 'XP')).toHaveLength(1);
    });

    it('and drinking more does not pay again', async () => {
      const before = await hydrationLedger();
      const res = await drink(500);
      expect([200, 201]).toContain(res.status);
      await drainOutbox();
      expect((await hydrationLedger()).length).toBe(before.length);
    });
  });
});
