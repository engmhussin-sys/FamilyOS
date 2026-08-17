/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-var-requires */
/**
 * PHASE D (GROWTH) — THE API, AGAINST A REAL POSTGRESQL AND A REAL SEEDED
 * DATASET.
 *
 * Everything asserted here is EXECUTED. The KPIs are computed from rows this
 * file inserts, and every expected value is HAND-COMPUTED in the test title
 * from those rows — not derived by calling the same function the code calls,
 * which would prove only self-consistency.
 *
 * THE FOUR PROPERTIES THIS SUITE EXISTS FOR, in the order they matter:
 *
 *   1. TENANT SAFETY. No analytics endpoint may leak one household's data to
 *      another, and no parent may reach a cross-tenant surface at all. Proven
 *      by driving real HTTP with real tokens, not by inspecting decorators.
 *   2. COUNTRY AND CURRENCY SEPARATION. An Egyptian query must never see Saudi
 *      revenue, and a platform-scope query must refuse to produce a money
 *      number at all rather than adding EGP to SAR.
 *   3. FUNNEL STEP COUNTS against a dataset whose shape is stated in the test.
 *   4. FORECAST / TARGET / ACTUAL SEPARATION — three fields, never merged.
 *
 * The offline-Prisma pattern and the `describeIfDb` skip are the ones
 * `scheduler.e2e.spec.ts` established for Phase C.
 */
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request = require('supertest');

import { AppModule } from '../../src/app.module';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { createTenantExtension } from '../../src/common/tenancy/tenant.extension';
import { runAsSystemAsync } from '../../src/common/tenancy/system-context';
import { integrationDatabaseUrl } from '../tenancy/prisma-test-client';
import { KpiService } from '../../src/modules/analytics/application/kpi.service';
import { FunnelService } from '../../src/modules/analytics/application/funnel.service';
import { ReferralService } from '../../src/modules/analytics/application/referral.service';
import { ReferralRewardService } from '../../src/modules/analytics/application/referral-reward.service';
import { GrowthSettingsService } from '../../src/modules/analytics/application/growth-settings.service';
import { GrowthEventEmitter } from '../../src/modules/analytics/application/growth-event-emitter.service';

const describeIfDb = integrationDatabaseUrl() ? describe : describe.skip;
const ADMIN_KEY = process.env.INTERNAL_ADMIN_API_KEY as string;

/** A fixed instant so every window in this suite is deterministic. */
const NOW = new Date('2026-08-16T12:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

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

describeIfDb('PHASE D (GROWTH) — the growth API (real PostgreSQL)', () => {
  let app: INestApplication;
  let http: any;
  let prisma: any;
  let kpis: KpiService;
  let funnel: FunnelService;
  let referrals: ReferralService;
  let referralRewards: ReferralRewardService;
  let settings: GrowthSettingsService;

  const stamp = Date.now();
  const createdFamilies: string[] = [];
  const createdUsers: string[] = [];

  /** Egyptian households, and one Saudi household to prove separation. */
  let egFamilyA = '';
  let egFamilyB = '';
  let saFamily = '';
  let parentAToken = '';
  let parentBToken = '';
  /**
   * The households the two PARENTS own. Deliberately distinct from
   * `egFamilyA`/`egFamilyB`: registration CREATES its own family (that is the
   * FAMILY_CREATED funnel step), so a parent seeded through `/auth/register`
   * cannot be attached to a pre-existing seeded household. The seeded ones
   * carry attribution and money; these carry sessions.
   */
  let parentAFamily = '';
  let parentBFamily = '';

  /**
   * The fixture escape hatch. Returns `any` deliberately: the offline Prisma
   * client is constructed through `require` (the WASM engine path), so its
   * model delegates are untyped here — the same trade `scheduler.e2e.spec.ts`
   * makes, and the reason this file carries the `no-explicit-any` disable at
   * the top rather than pretending to a type it does not have.
   */
  const sys = (what: string, fn: () => Promise<any>): Promise<any> =>
    runAsSystemAsync('TEST_FIXTURE', `Growth API suite: ${what}`, async () => await fn());

  async function seedFamily(
    label: string,
    countryCode: string,
    channel: string,
    createdAt: Date,
  ): Promise<string> {
    const family = await sys('create family', () =>
      prisma.family.create({
        data: { name: `growth ${label} ${stamp}`, timezone: countryCode === 'EG' ? 'Africa/Cairo' : 'Asia/Riyadh', createdAt },
        select: { id: true },
      }),
    );
    createdFamilies.push(family.id);

    await sys('create attribution', () =>
      prisma.acquisitionAttribution.create({
        data: { familyId: family.id, channel, countryCode, campaign: `q3-${countryCode.toLowerCase()}`, createdAt },
      }),
    );
    return family.id;
  }

  async function seedUser(label: string): Promise<{ userId: string; familyId: string; token: string }> {
    const registerRes = await request(http)
      .post('/auth/register')
      .send({
        email: `growth.${label}.${stamp}@example.test`,
        password: 'Sup3rSecretPass1',
        fullName: `Growth ${label}`,
        acceptedTerms: true,
      })
      .expect(201);

    createdUsers.push(registerRes.body.id);
    createdFamilies.push(registerRes.body.familyId);

    const loginRes = await request(http)
      .post('/auth/login')
      .send({ email: `growth.${label}.${stamp}@example.test`, password: 'Sup3rSecretPass1' })
      .expect(200);

    return {
      userId: registerRes.body.id,
      familyId: registerRes.body.familyId,
      token: loginRes.body.tokens.accessToken,
    };
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue(offlinePrismaService())
      .compile();

    app = moduleRef.createNestApplication();
    const { ValidationPipe } = require('@nestjs/common');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    http = app.getHttpServer();

    prisma = app.get(PrismaService);
    kpis = app.get(KpiService);
    funnel = app.get(FunnelService);
    referrals = app.get(ReferralService);
    referralRewards = app.get(ReferralRewardService);
    settings = app.get(GrowthSettingsService);

    /**
     * THE RATE LIMITER IS REAL AND ITS STATE IS IN REDIS, WHICH IS WHY THIS
     * LINE EXISTS.
     *
     * `/auth/register` is throttled at 5/min per IP and that limit is a
     * genuine control — `controller-guard-coverage.spec.ts` records it as the
     * reason the route is safe to leave public. This suite needs SEVEN
     * registrations from 127.0.0.1 to build a two-market, two-channel,
     * referrer-and-referred dataset, and `RedisThrottlerStorage` remembers the
     * previous run's counters across processes.
     *
     * The counters are CLEARED rather than the limit being lowered. Lowering a
     * production control to make a test pass trades a real defence for a green
     * tick; clearing the counter leaves the limit exactly where it is and
     * states in one place that this suite is not the thing testing it.
     */
    const { RedisService } = require('../../src/common/redis/redis.service');
    const redis = app.get(RedisService).getRawClient();
    const throttleKeys = await redis.keys('throttle:*');
    if (throttleKeys.length > 0) await redis.del(...throttleKeys);

    // -- reference data the money KPIs need ---------------------------------
    await sys('seed currencies', () =>
      prisma.currency.upsert({
        where: { code: 'EGP' },
        create: { code: 'EGP', symbolEn: 'E£', symbolAr: 'ج.م', minorUnits: 2 },
        update: {},
      }),
    );
    await sys('seed currencies', () =>
      prisma.currency.upsert({
        where: { code: 'SAR' },
        create: { code: 'SAR', symbolEn: 'SR', symbolAr: 'ر.س', minorUnits: 2 },
        update: {},
      }),
    );
    await sys('seed countries', () =>
      prisma.country.upsert({
        where: { code: 'EG' },
        create: { code: 'EG', nameEn: 'Egypt', nameAr: 'مصر', currencyCode: 'EGP', vatBasisPoints: 1400 },
        update: { isActive: true },
      }),
    );
    await sys('seed countries', () =>
      prisma.country.upsert({
        where: { code: 'SA' },
        create: { code: 'SA', nameEn: 'Saudi Arabia', nameAr: 'السعودية', currencyCode: 'SAR', vatBasisPoints: 1500 },
        update: { isActive: true },
      }),
    );

    // -- THE SEEDED DATASET -------------------------------------------------
    // Two Egyptian households registered 45 days ago (so they are inside the
    // activation cohort window, which ends 30 days ago), one Saudi household.
    const fortyFiveDaysAgo = new Date(NOW.getTime() - 45 * DAY);
    egFamilyA = await seedFamily('eg-a', 'EG', 'TIKTOK', fortyFiveDaysAgo);
    egFamilyB = await seedFamily('eg-b', 'EG', 'ORGANIC', fortyFiveDaysAgo);
    saFamily = await seedFamily('sa', 'SA', 'GOOGLE', fortyFiveDaysAgo);

    // ONE of the two Egyptian households activated, 150 minutes after registering.
    await sys('seed activation', () =>
      prisma.familyActivation.create({
        data: {
          familyId: egFamilyA,
          ruleVersion: 'MEANINGFUL_GOAL_V1',
          completionKind: 'HABIT',
          occurredAt: new Date(fortyFiveDaysAgo.getTime() + 150 * 60_000),
          timeToValueMinutes: 150,
          countryCode: 'EG',
        },
      }),
    );

    // ONE Egyptian household paid: 17,900 EGP minor gross, 2,198 VAT, 15,702 net.
    await sys('seed egp payment', () =>
      prisma.paymentTransaction.create({
        data: {
          familyId: egFamilyA,
          provider: 'PAYMOB',
          providerTransactionId: `eg-txn-${stamp}`,
          currency: 'EGP',
          countryCode: 'EG',
          grossAmountMinor: 17_900,
          vatAmountMinor: 2_198,
          netAmountMinor: 15_702,
          status: 'SUCCEEDED',
          idempotencyKey: `eg-key-${stamp}`,
          occurredAt: new Date(NOW.getTime() - 10 * DAY),
        },
      }),
    );

    // The Saudi household paid 3,400 SAR minor gross / 2,957 net. If a query
    // ever adds these two together the currency test below goes red.
    await sys('seed sar payment', () =>
      prisma.paymentTransaction.create({
        data: {
          familyId: saFamily,
          provider: 'MOYASAR',
          providerTransactionId: `sa-txn-${stamp}`,
          currency: 'SAR',
          countryCode: 'SA',
          grossAmountMinor: 3_400,
          vatAmountMinor: 443,
          netAmountMinor: 2_957,
          status: 'SUCCEEDED',
          idempotencyKey: `sa-key-${stamp}`,
          occurredAt: new Date(NOW.getTime() - 10 * DAY),
        },
      }),
    );

    // Two parents with real sessions, for the tenant-safety proofs.
    const a = await seedUser('parent-a');
    const b = await seedUser('parent-b');
    parentAToken = a.token;
    parentBToken = b.token;
    parentAFamily = a.familyId;
    parentBFamily = b.familyId;
  }, 60_000);

  afterAll(async () => {
    if (!app) return;
    await sys('cleanup', async () => {
      await prisma.$executeRawUnsafe(
        'ALTER TABLE "payment_transactions" DISABLE TRIGGER "payment_transactions_no_delete"',
      );
      await prisma.$executeRawUnsafe('DELETE FROM "families" WHERE "id" = ANY($1::uuid[])', createdFamilies);
      await prisma.$executeRawUnsafe(
        'ALTER TABLE "payment_transactions" ENABLE TRIGGER "payment_transactions_no_delete"',
      );
      await prisma.$executeRawUnsafe('DELETE FROM "users" WHERE "id" = ANY($1::uuid[])', createdUsers);
    });
    await app.close();
  }, 30_000);

  // -------------------------------------------------------------------------
  describe('1. TENANT SAFETY — no analytics endpoint leaks another family', () => {
    it('a parent token is REFUSED by every admin growth endpoint', async () => {
      for (const path of [
        '/admin/growth/kpis?countryCode=EG',
        '/admin/growth/funnel?countryCode=EG',
        '/admin/growth/channels?countryCode=EG',
        '/admin/growth/campaigns',
        '/admin/growth/quarterly?countryCode=EG',
        '/admin/growth/alerts',
        '/admin/growth/settings',
        '/admin/growth/daily?countryCode=EG',
      ]) {
        const res = await request(http).get(path).set('Authorization', `Bearer ${parentAToken}`);
        expect([401, 403]).toContain(res.status);
      }
    });

    it('an UNAUTHENTICATED caller is refused by every admin growth endpoint', async () => {
      for (const path of ['/admin/growth/kpis?countryCode=EG', '/admin/growth/catalogue', '/admin/growth/alerts']) {
        const res = await request(http).get(path);
        expect([401, 403]).toContain(res.status);
      }
    });

    it('the internal admin key IS admitted — the guard is real, not a blanket denial', async () => {
      const res = await request(http)
        .get('/admin/growth/catalogue')
        .set('x-internal-admin-key', ADMIN_KEY)
        .expect(200);
      expect(res.body.kpis.length).toBeGreaterThan(15);
      expect(res.body.channels).toContain('TIKTOK');
      expect(res.body.activation.eventName).toBe('CHILD_COMPLETES_FIRST_MEANINGFUL_GOAL');
    });

    it('a parent reading their OWN referral summary sees only their own counts', async () => {
      const a = await request(http).get('/referral/me').set('Authorization', `Bearer ${parentAToken}`).expect(200);
      const b = await request(http).get('/referral/me').set('Authorization', `Bearer ${parentBToken}`).expect(200);

      expect(a.body.code).toHaveLength(8);
      expect(b.body.code).toHaveLength(8);
      // Two households, two codes. A shared code would mean one household could
      // claim another's conversions.
      expect(a.body.code).not.toBe(b.body.code);
      expect(a.body.sentCount).toBe(0);
      expect(a.body.registeredCount).toBe(0);
    });

    it('the referral surface NEVER returns another household id, even to the referrer', async () => {
      const res = await request(http).get('/referral/me').set('Authorization', `Bearer ${parentAToken}`).expect(200);
      const body = JSON.stringify(res.body);
      for (const otherId of [egFamilyB, saFamily, parentBFamily]) {
        expect(body).not.toContain(otherId);
      }
      // A referrer learns HOW MANY of their invitations converted, never WHO.
      expect(Object.keys(res.body).sort()).toEqual(
        ['code', 'isActive', 'qualifiedCount', 'registeredCount', 'sentCount'].sort(),
      );
    });
  });

  // -------------------------------------------------------------------------
  describe('2. COUNTRY AND CURRENCY SEPARATION', () => {
    it('an EGYPTIAN snapshot reports EGP and never touches the Saudi transaction', async () => {
      const snapshot = await kpis.snapshot({ countryCode: 'EG', asOf: NOW });
      expect(snapshot.currencyCode).toBe('EGP');
      expect(snapshot.reportingTimeZone).toBe('Africa/Cairo');

      const arppu = snapshot.values.find((v) => v.kpi === 'ARPPU');
      // ONE paying Egyptian household, 15,702 EGP minor net -> ARPPU = 15,702.
      // If the 2,957 SAR had leaked in, this would be 18,659.
      expect(arppu?.value).toBe(15_702);
      expect(arppu?.currencyCode).toBe('EGP');
    });

    it('a SAUDI snapshot reports SAR and the Saudi number only', async () => {
      const snapshot = await kpis.snapshot({ countryCode: 'SA', asOf: NOW });
      expect(snapshot.currencyCode).toBe('SAR');
      expect(snapshot.reportingTimeZone).toBe('Asia/Riyadh');

      const arppu = snapshot.values.find((v) => v.kpi === 'ARPPU');
      expect(arppu?.value).toBe(2_957);
      expect(arppu?.currencyCode).toBe('SAR');
    });

    it('THE PLATFORM SCOPE REFUSES TO PRODUCE A MONEY NUMBER rather than adding EGP to SAR', async () => {
      const snapshot = await kpis.snapshot({ countryCode: '**', asOf: NOW });
      expect(snapshot.currencyCode).toBeNull();
      for (const id of ['ARPU', 'ARPPU', 'MRR', 'ARR', 'CAC']) {
        const value = snapshot.values.find((v) => v.kpi === id);
        expect(value).toBeDefined();
        // `null` = "this cannot be answered without an FX rate", not "zero".
        expect(value?.value).toBeNull();
      }
    });

    it('the two markets use DIFFERENT reporting calendars, read from tzdata', async () => {
      expect(await settings.reportingTimeZone('EG')).toBe('Africa/Cairo');
      expect(await settings.reportingTimeZone('SA')).toBe('Asia/Riyadh');
      // A country with no configured zone falls back to the PLATFORM calendar,
      // never silently to UTC — which would mis-bucket the hours around local
      // midnight, the defect B1/B2 removed everywhere else.
      expect(await settings.reportingTimeZone('KW')).toBe('Africa/Cairo');
    });
  });

  // -------------------------------------------------------------------------
  describe('3. KPIs AGAINST THE SEEDED DATASET, hand-computed', () => {
    it('ACTIVATION_RATE: 1 activated of the 2 Egyptian households in the cohort = 0.5', async () => {
      const snapshot = await kpis.snapshot({ countryCode: 'EG', asOf: NOW });
      const activation = snapshot.values.find((v) => v.kpi === 'ACTIVATION_RATE');
      // Both EG households registered 45 days ago, i.e. inside the cohort
      // window [60 days ago, 30 days ago). Exactly one has an activation row.
      expect(activation?.value).toBe(0.5);
      expect(activation?.provenance).toBe('ACTUAL');
    });

    it('TIME_TO_VALUE_HOURS: the single activation is 150 minutes = 2.5 hours', async () => {
      const snapshot = await kpis.snapshot({ countryCode: 'EG', asOf: NOW });
      const ttv = snapshot.values.find((v) => v.kpi === 'TIME_TO_VALUE_HOURS');
      expect(ttv?.value).toBe(2.5);
    });

    it('CONVERSION_RATE: 1 of the 2 Egyptian cohort households ever paid = 0.5', async () => {
      const snapshot = await kpis.snapshot({ countryCode: 'EG', asOf: NOW });
      expect(snapshot.values.find((v) => v.kpi === 'CONVERSION_RATE')?.value).toBe(0.5);
    });

    it('LTV IS TAGGED FORECAST AND CAC IS TAGGED ACTUAL — an assumption is never a fact', async () => {
      const snapshot = await kpis.snapshot({ countryCode: 'EG', asOf: NOW });
      expect(snapshot.values.find((v) => v.kpi === 'LTV')?.provenance).toBe('FORECAST');
      expect(snapshot.values.find((v) => v.kpi === 'LTV_CAC_RATIO')?.provenance).toBe('FORECAST');
      expect(snapshot.values.find((v) => v.kpi === 'PAYBACK_MONTHS')?.provenance).toBe('FORECAST');
      expect(snapshot.values.find((v) => v.kpi === 'CAC')?.provenance).toBe('ACTUAL');
      expect(snapshot.values.find((v) => v.kpi === 'DAU')?.provenance).toBe('ACTUAL');
    });

    it('a KPI with no data returns null, never 0 — D90 for a 45-day-old cohort', async () => {
      const snapshot = await kpis.snapshot({ countryCode: 'EG', asOf: NOW });
      const d90 = snapshot.values.find((v) => v.kpi === 'RETENTION_D90');
      expect(d90).toBeDefined();
      expect(d90?.value).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  describe('4. THE FUNNEL', () => {
    it('counts households, not events, and reports the source of every step', async () => {
      const result = await funnel.build({
        countryCode: 'EG',
        from: new Date(NOW.getTime() - 60 * DAY),
        to: NOW,
      });

      expect(result.steps.map((s) => s.step)).toEqual([
        'IMPRESSION', 'VISIT', 'INSTALL', 'REGISTRATION', 'FAMILY_CREATED',
        'CHILD_ADDED', 'FIRST_GOAL', 'FIRST_REWARD', 'TRIAL', 'PAID', 'RENEWAL',
      ]);

      const byStep = new Map(result.steps.map((s) => [s.step, s]));
      // Two Egyptian households registered inside the window.
      expect(byStep.get('REGISTRATION')!.count).toBeGreaterThanOrEqual(2);
      // REGISTRATION and FAMILY_CREATED are equal by construction in this
      // product — registration creates the family in the same transaction.
      expect(byStep.get('FAMILY_CREATED')!.count).toBe(byStep.get('REGISTRATION')!.count);
      // Exactly one of them paid.
      expect(byStep.get('PAID')!.count).toBe(1);
      // Neither paid twice, so nobody renewed.
      expect(byStep.get('RENEWAL')!.count).toBe(0);

      // THE HONESTY REQUIREMENT: the two steps this backend cannot observe say so.
      expect(byStep.get('IMPRESSION')!.source).toBe('EXTERNAL_REPORTED');
      expect(byStep.get('VISIT')!.source).toBe('EXTERNAL_REPORTED');
      expect(byStep.get('PAID')!.source).toBe('DOMAIN_TABLE');
      expect(byStep.get('INSTALL')!.source).toBe('ANALYTICS_EVENT');
    });

    it('slicing by CHANNEL narrows the funnel rather than reporting the whole thing under one name', async () => {
      const tiktok = await funnel.build({
        countryCode: 'EG',
        channel: 'TIKTOK',
        from: new Date(NOW.getTime() - 60 * DAY),
        to: NOW,
      });
      const organic = await funnel.build({
        countryCode: 'EG',
        channel: 'ORGANIC',
        from: new Date(NOW.getTime() - 60 * DAY),
        to: NOW,
      });

      const paidVia = (r: typeof tiktok) => r.steps.find((s) => s.step === 'PAID')!.count;
      // The paying household came in via TikTok; the organic one did not pay.
      expect(paidVia(tiktok)).toBe(1);
      expect(paidVia(organic)).toBe(0);
    });

    it('the channel report separates the two Egyptian channels', async () => {
      const rows = await funnel.byChannel({
        countryCode: 'EG',
        from: new Date(NOW.getTime() - 60 * DAY),
        to: NOW,
      });
      const tiktok = rows.find((r) => r.channel === 'TIKTOK');
      const organic = rows.find((r) => r.channel === 'ORGANIC');
      expect(tiktok?.paid).toBe(1);
      expect(tiktok?.conversion).toBe(1);
      expect(organic?.paid).toBe(0);
      expect(organic?.conversion).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  describe('5. FORECAST vs TARGET vs ACTUAL — three fields, never merged', () => {
    it('a quarter with no committed target reports target: null, not a number borrowed from the forecast', async () => {
      const res = await request(http)
        .get('/admin/growth/quarterly?countryCode=EG&year=2026')
        .set('x-internal-admin-key', ADMIN_KEY)
        .expect(200);

      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body.length).toBe(4 * 7); // four quarters x seven metrics

      for (const row of res.body) {
        expect(row).toHaveProperty('target');
        expect(row).toHaveProperty('actual');
        expect(row).toHaveProperty('forecast');
        // A row must never present a single merged `value`.
        expect(row).not.toHaveProperty('value');
      }

      const q1Users = res.body.find((r: any) => r.quarter === 1 && r.metric === 'USERS');
      expect(q1Users.target).toBeNull();
    });

    it('a committed target appears as TARGET and the measurement stays ACTUAL', async () => {
      await request(http)
        .post('/admin/growth/quarterly/target')
        .set('x-internal-admin-key', ADMIN_KEY)
        .send({ countryCode: 'EG', year: 2026, quarter: 3, metric: 'USERS', targetValue: 5000 })
        .expect(201);

      const res = await request(http)
        .get('/admin/growth/quarterly?countryCode=EG&year=2026')
        .set('x-internal-admin-key', ADMIN_KEY)
        .expect(200);

      const q3Users = res.body.find((r: any) => r.quarter === 3 && r.metric === 'USERS');
      expect(q3Users.target).toBe(5000);
      // The quarter has started, so an actual exists and is measured, not
      // inferred from the target.
      expect(typeof q3Users.actual).toBe('number');
      expect(q3Users.actual).not.toBe(5000);
      expect(q3Users.attainment).toBeCloseTo(q3Users.actual / 5000, 6);

      await sys('cleanup target', () =>
        prisma.growthQuarterlyTarget.deleteMany({ where: { countryCode: 'EG', year: 2026, quarter: 3 } }),
      );
    });

    it('a scenario returns its ASSUMPTIONS alongside the projection, so a reader can disagree with the inputs', async () => {
      await request(http)
        .post('/admin/growth/forecast/scenario')
        .set('x-internal-admin-key', ADMIN_KEY)
        .send({
          scenario: 'BASE',
          countryCode: 'EG',
          currencyCode: 'EGP',
          monthlyAcquisition: 10000,
          conversionRate: 0.25,
          paidConversionRate: 0.4,
          churnRate: 0.06,
          arpuMinor: 17900,
          cacMinor: 35000,
          retentionD30: 0.35,
        })
        .expect(201);

      const res = await request(http)
        .get('/admin/growth/forecast?countryCode=EG&months=3')
        .set('x-internal-admin-key', ADMIN_KEY)
        .expect(200);

      const base = res.body.find((r: any) => r.scenario === 'BASE');
      expect(base.assumptions.monthlyAcquisition).toBe(10000);
      expect(base.assumptions.churnRate).toBe(0.06);
      // 10,000 x 0.25 = 2,500 trials; x 0.4 = 1,000 new paid in month 1.
      expect(base.months[0].newTrials).toBe(2500);
      expect(base.months[0].newPaid).toBe(1000);
      expect(base.months).toHaveLength(3);

      await sys('cleanup scenario', () =>
        prisma.growthForecastScenario.deleteMany({ where: { countryCode: 'EG' } }),
      );
    });

    it('an assumption outside [0,1] is REFUSED before it can produce an impossible projection', async () => {
      await request(http)
        .post('/admin/growth/forecast/scenario')
        .set('x-internal-admin-key', ADMIN_KEY)
        .send({
          scenario: 'AGGRESSIVE',
          countryCode: 'EG',
          currencyCode: 'EGP',
          monthlyAcquisition: 10000,
          conversionRate: 1.5,
          paidConversionRate: 0.4,
          churnRate: 0.06,
          arpuMinor: 17900,
          cacMinor: 35000,
          retentionD30: 0.35,
        })
        .expect(400);
    });
  });

  // -------------------------------------------------------------------------
  describe('6. REFERRAL — the happy path, end to end, through real HTTP', () => {
    it('a parent gets a code, a per-channel link, and can record an invitation', async () => {
      const me = await request(http).get('/referral/me').set('Authorization', `Bearer ${parentAToken}`).expect(200);
      const code = me.body.code;

      const link = await request(http)
        .post('/referral/link')
        .set('Authorization', `Bearer ${parentAToken}`)
        .send({ channel: 'INSTAGRAM' })
        .expect(201);
      expect(link.body.url).toContain(code);
      expect(link.body.url).toContain('instagram');

      // Idempotent: asking again returns the SAME url, not a second row.
      const again = await request(http)
        .post('/referral/link')
        .set('Authorization', `Bearer ${parentAToken}`)
        .send({ channel: 'INSTAGRAM' })
        .expect(201);
      expect(again.body.url).toBe(link.body.url);

      await request(http)
        .post('/referral/sent')
        .set('Authorization', `Bearer ${parentAToken}`)
        .send({ channel: 'INSTAGRAM' })
        .expect(201);

      const after = await request(http).get('/referral/me').set('Authorization', `Bearer ${parentAToken}`).expect(200);
      expect(after.body.sentCount).toBe(1);
    });

    it('ATTRIBUTION IS CAPTURED THROUGH REGISTRATION, and the referral is bound to the referrer', async () => {
      const me = await request(http).get('/referral/me').set('Authorization', `Bearer ${parentAToken}`).expect(200);
      const code = me.body.code;

      const registered = await request(http)
        .post('/auth/register')
        .send({
          email: `growth.referred.${stamp}@example.test`,
          password: 'Sup3rSecretPass1',
          fullName: 'Referred Parent',
          acceptedTerms: true,
          attribution: {
            source: 'tiktok',
            campaign: 'ramadan-2026',
            medium: 'cpc',
            content: 'video-a',
            countryCode: 'EG',
            platform: 'ANDROID',
            referralCode: code,
            referrer: 'https://ads.tiktok.com/x',
            landingPage: 'https://abny.app/ar/parents',
            sessionId: `sess-${stamp}`,
          },
        })
        .expect(201);

      const referredFamilyId = registered.body.familyId;
      createdFamilies.push(referredFamilyId);
      createdUsers.push(registered.body.id);

      const attribution = await sys('read attribution', () =>
        prisma.acquisitionAttribution.findFirst({ where: { familyId: referredFamilyId } }),
      );
      expect(attribution).not.toBeNull();
      // THE REFERRAL CODE WINS THE CHANNEL, even though a TikTok UTM was also
      // present — the channel that gets charged is the channel that gets credited.
      expect(attribution.channel).toBe('REFERRAL');
      expect(attribution.source).toBe('tiktok');
      expect(attribution.campaign).toBe('ramadan-2026');
      expect(attribution.medium).toBe('cpc');
      expect(attribution.content).toBe('video-a');
      expect(attribution.countryCode).toBe('EG');
      expect(attribution.platform).toBe('ANDROID');
      expect(attribution.referrer).toBe('https://ads.tiktok.com/x');
      expect(attribution.landingPage).toBe('https://abny.app/ar/parents');
      expect(attribution.sessionId).toBe(`sess-${stamp}`);

      const bound = await sys('read referral event', () =>
        prisma.referralEvent.findFirst({
          where: { referredFamilyId, kind: 'REGISTERED' },
          select: { familyId: true },
        }),
      );
      expect(bound?.familyId).toBe(parentAFamily);

      const summary = await request(http)
        .get('/referral/me')
        .set('Authorization', `Bearer ${parentAToken}`)
        .expect(200);
      expect(summary.body.registeredCount).toBe(1);
    });

    it('A SECOND registration with the SAME code binds normally — one referrer, many referrals', async () => {
      const me = await request(http).get('/referral/me').set('Authorization', `Bearer ${parentAToken}`).expect(200);
      const registered = await request(http)
        .post('/auth/register')
        .send({
          email: `growth.referred2.${stamp}@example.test`,
          password: 'Sup3rSecretPass1',
          fullName: 'Referred Parent Two',
          acceptedTerms: true,
          attribution: { referralCode: me.body.code, countryCode: 'EG' },
        })
        .expect(201);
      createdFamilies.push(registered.body.familyId);
      createdUsers.push(registered.body.id);

      const summary = await request(http)
        .get('/referral/me')
        .set('Authorization', `Bearer ${parentAToken}`)
        .expect(200);
      expect(summary.body.registeredCount).toBe(2);
    });

    it('AN UNKNOWN REFERRAL CODE DOES NOT FAIL THE REGISTRATION — the household exists, uncredited', async () => {
      const registered = await request(http)
        .post('/auth/register')
        .send({
          email: `growth.badcode.${stamp}@example.test`,
          password: 'Sup3rSecretPass1',
          fullName: 'Bad Code Parent',
          acceptedTerms: true,
          attribution: { referralCode: 'ZZZZ9999' },
        })
        .expect(201);
      createdFamilies.push(registered.body.familyId);
      createdUsers.push(registered.body.id);

      const events = await sys('read referral events', () =>
        prisma.referralEvent.findMany({ where: { referredFamilyId: registered.body.familyId } }),
      );
      expect(events).toHaveLength(0);
    });

    it('QUALIFICATION requires a SUCCEEDED payment past the refund window — not yet, then yes', async () => {
      // The referred household has not paid at all yet.
      const referredEvent = await sys('read registered event', () =>
        prisma.referralEvent.findFirst({
          where: { familyId: parentAFamily, kind: 'REGISTERED' },
          select: { referredFamilyId: true, referralCodeId: true },
        }),
      );
      const referredFamilyId = referredEvent!.referredFamilyId as string;

      const notPaid = await referralRewards.qualify(
        parentAFamily,
        referredFamilyId,
        referredEvent!.referralCodeId,
        NOW,
      );
      expect(notPaid.qualified).toBe(false);
      expect(notPaid.reason).toBe('NO_QUALIFYING_PAYMENT');

      // A payment made TODAY is inside the 14-day refund window.
      await sys('seed referred payment', () =>
        prisma.paymentTransaction.create({
          data: {
            familyId: referredFamilyId,
            provider: 'PAYMOB',
            providerTransactionId: `ref-txn-${stamp}`,
            currency: 'EGP',
            countryCode: 'EG',
            grossAmountMinor: 17_900,
            vatAmountMinor: 2_198,
            netAmountMinor: 15_702,
            status: 'SUCCEEDED',
            idempotencyKey: `ref-key-${stamp}`,
            occurredAt: NOW,
          },
        }),
      );

      const tooSoon = await referralRewards.qualify(
        parentAFamily,
        referredFamilyId,
        referredEvent!.referralCodeId,
        NOW,
      );
      expect(tooSoon.qualified).toBe(false);
      expect(tooSoon.reason).toBe('NOT_YET_PAST_REFUND_WINDOW');

      // Fifteen days later the window has closed.
      const later = new Date(NOW.getTime() + 15 * DAY);
      const qualified = await referralRewards.qualify(
        parentAFamily,
        referredFamilyId,
        referredEvent!.referralCodeId,
        later,
      );
      expect(qualified.qualified).toBe(true);
      expect(qualified.rewardId).not.toBeNull();

      // AND IT IS IDEMPOTENT: a second sweep pays nothing more.
      const second = await referralRewards.qualify(
        parentAFamily,
        referredFamilyId,
        referredEvent!.referralCodeId,
        later,
      );
      expect(second.qualified).toBe(false);

      const rewards = await sys('count rewards', () =>
        prisma.referralReward.findMany({ where: { familyId: parentAFamily } }),
      );
      expect(rewards).toHaveLength(1);
      // The referrer holds no time-bounded entitlement, so the payout could not
      // be applied — and the row stays PENDING with a stated reason rather than
      // being marked GRANTED for a reward nobody received. See the HUMAN
      // DECISION in the Phase D Growth report.
      expect(rewards[0].status).toBe('PENDING');
      expect(rewards[0].failureReason).toContain('entitlement');
    }, 30_000);

    it('SELF-REFERRAL through the real service is refused and RECORDED', async () => {
      const me = await request(http).get('/referral/me').set('Authorization', `Bearer ${parentAToken}`).expect(200);
      const outcome = await referrals.registerReferral(parentAFamily, me.body.code);
      expect(outcome.bound).toBe(false);
      expect(outcome.reason).toBe('SELF_REFERRAL');

      const rejections = await sys('read rejections', () =>
        prisma.referralEvent.findMany({
          where: { familyId: parentAFamily, kind: 'REJECTED', rejectionReason: 'SELF_REFERRAL' },
        }),
      );
      expect(rejections.length).toBeGreaterThanOrEqual(1);
    });

    it('DUPLICATE REFERRAL through the real service is refused', async () => {
      const referredEvent = await sys('read registered event', () =>
        prisma.referralEvent.findFirst({
          where: { familyId: parentAFamily, kind: 'REGISTERED' },
          select: { referredFamilyId: true },
        }),
      );
      const meB = await request(http).get('/referral/me').set('Authorization', `Bearer ${parentBToken}`).expect(200);

      const outcome = await referrals.registerReferral(referredEvent!.referredFamilyId as string, meB.body.code);
      expect(outcome.bound).toBe(false);
      expect(outcome.reason).toBe('ALREADY_REFERRED');
    });
  });

  // -------------------------------------------------------------------------
  describe('7. GROWTH SETTINGS — every business number is admin-configurable', () => {
    it('exposes each setting with its schema, its default flag and whether it is an open business decision', async () => {
      const res = await request(http)
        .get('/admin/growth/settings')
        .set('x-internal-admin-key', ADMIN_KEY)
        .expect(200);

      const refundWindow = res.body.find((s: any) => s.key === 'referral.qualification.refundWindowDays');
      expect(refundWindow.value).toBe(14);
      expect(refundWindow.isDefault).toBe(true);
      expect(refundWindow.humanDecision).toBe(true);
      expect(refundWindow.descriptionAr.length).toBeGreaterThan(20);
    });

    it('a write takes effect immediately and an out-of-bounds write is REFUSED', async () => {
      await request(http)
        .post('/admin/growth/settings')
        .set('x-internal-admin-key', ADMIN_KEY)
        .send({ key: 'referral.qualification.refundWindowDays', value: '7' })
        .expect(201);

      expect(await settings.int('referral.qualification.refundWindowDays')).toBe(7);

      await request(http)
        .post('/admin/growth/settings')
        .set('x-internal-admin-key', ADMIN_KEY)
        .send({ key: 'referral.qualification.refundWindowDays', value: '9999' })
        .expect(500);

      // Still 7 — the refused write changed nothing.
      expect(await settings.int('referral.qualification.refundWindowDays')).toBe(7);

      await sys('reset setting', () =>
        prisma.growthSetting.deleteMany({ where: { key: 'referral.qualification.refundWindowDays' } }),
      );
      settings.invalidate();
      expect(await settings.int('referral.qualification.refundWindowDays')).toBe(14);
    });

    it('an unknown setting key is refused — the vocabulary is closed', async () => {
      await request(http)
        .post('/admin/growth/settings')
        .set('x-internal-admin-key', ADMIN_KEY)
        .send({ key: 'referral.reward.infinite', value: '1' })
        .expect(500);
    });
  });

  /**
   * PHASE F (`F6-004`, closing `PF-E-004`) — THE GUARD, ONE LAYER BELOW THE
   * SCENARIO THAT MEASURED IT.
   *
   * `e2e-01 › THE REPLAY` proves the counter no longer triples under a real
   * outbox redelivery. That is the PRODUCT proof and it is the one that
   * matters, but it costs a full booted app and a drained outbox, so it is not
   * where a future author changing `SelfHostedAnalyticsAdapter` will look.
   *
   * These four assertions pin the CONTRACT directly, against the real
   * PostgreSQL and the real emitter: same cause counts once, different causes
   * count separately, DIFFERENT EVENT NAMES sharing one cause both count
   * (a domain event legitimately projects into more than one growth event),
   * and NO cause is still at-least-once — which is the property the open
   * `POST /analytics/track` surface depends on and the one an over-eager
   * «just make it unique» fix would silently destroy.
   */
  describe('8. PF-E-004 — the analytics counter is idempotent on a CAUSE, and only on a cause', () => {
    const emitter = () => app.get(GrowthEventEmitter);
    const countOf = (eventName: string, familyId: string): Promise<number> =>
      runAsSystemAsync('TEST_FIXTURE', `Growth API suite: count ${eventName}`, async () =>
        prisma.analyticsEvent.count({ where: { familyId, eventName } }),
      );

    it('the SAME cause emitted twice is ONE row — a redelivery cannot inflate a funnel step', async () => {
      const cause = `guard:${stamp}:same`;
      const before = await countOf('REWARD_GRANTED', egFamilyA);

      for (let i = 0; i < 3; i++) {
        await emitter().emit({
          name: 'REWARD_GRANTED',
          familyId: egFamilyA,
          sessionId: `bus:${egFamilyA}`,
          sourceEventId: cause,
          payload: { grantCount: 1 },
        });
      }

      expect(await countOf('REWARD_GRANTED', egFamilyA)).toBe(before + 1);
    });

    it('a DIFFERENT cause is a different row — the constraint deduplicates the cause, not the type', async () => {
      const before = await countOf('REWARD_GRANTED', egFamilyA);
      await emitter().emit({
        name: 'REWARD_GRANTED',
        familyId: egFamilyA,
        sessionId: `bus:${egFamilyA}`,
        sourceEventId: `guard:${stamp}:other`,
      });
      expect(await countOf('REWARD_GRANTED', egFamilyA)).toBe(before + 1);
    });

    it('ONE cause projecting into TWO growth events writes BOTH — the event name is in the key', async () => {
      // `REWARD_GRANTED` on the bus produces a `REWARD_GRANTED` growth event and
      // feeds the activation; a completion produces `GOAL_COMPLETED`. A key on
      // the cause alone would have silently dropped the second projection of any
      // event that has one.
      const cause = `guard:${stamp}:shared`;
      const beforeReward = await countOf('REWARD_GRANTED', egFamilyA);
      const beforeGoal = await countOf('GOAL_COMPLETED', egFamilyA);

      await emitter().emit({ name: 'REWARD_GRANTED', familyId: egFamilyA, sessionId: 's', sourceEventId: cause });
      await emitter().emit({ name: 'GOAL_COMPLETED', familyId: egFamilyA, sessionId: 's', sourceEventId: cause });

      expect(await countOf('REWARD_GRANTED', egFamilyA)).toBe(beforeReward + 1);
      expect(await countOf('GOAL_COMPLETED', egFamilyA)).toBe(beforeGoal + 1);
    });

    it('an event with NO cause is STILL at-least-once — two page views are two page views', async () => {
      // The open `POST /analytics/track` surface. `source_event_id` is NULL, the
      // index is PARTIAL, and nothing about ad-hoc telemetry changed. This is
      // asserted rather than assumed because the obvious wrong fix — a TOTAL
      // unique index, or `createMany({ skipDuplicates: true })` — would collapse
      // every one of these into a single row and nobody would notice for months.
      const before = await countOf('GOAL_STARTED', egFamilyA);
      await emitter().emit({ name: 'GOAL_STARTED', familyId: egFamilyA, sessionId: 's' });
      await emitter().emit({ name: 'GOAL_STARTED', familyId: egFamilyA, sessionId: 's' });
      expect(await countOf('GOAL_STARTED', egFamilyA)).toBe(before + 2);
    });
  });
});
