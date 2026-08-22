/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-var-requires */
/**
 * ============================================================================
 * SPRINT F1 (P0) — ONE ENTITLEMENT ANSWER, PROVEN ON THE FOUR REAL ROUTES.
 * ============================================================================
 *
 * WHAT WAS MEASURED. Two services answered «is this family entitled to feature
 * X?» and they disagreed:
 *
 *   `EntitlementsService.hasFeature`  — {TRIALING, ACTIVE}, computed from
 *                                       `subscriptions`, and the ONLY one the
 *                                       four gated features called.
 *   `EntitlementService.hasFeature`   — reads the `entitlements` table, and
 *                                       {TRIALING, ACTIVE, GRACE_PERIOD} when
 *                                       there is no row.
 *
 * Both consequences were live, in opposite directions:
 *
 *   1  A HOUSEHOLD THAT HAD PAID WAS REFUSED. `schema.prisma` states
 *      GRACE_PERIOD keeps FULL access for seven days (Q17). The service the
 *      features called said no.
 *   2  A HOUSEHOLD THAT HAD BEEN REFUNDED KEPT ACCESS. `revokeAll` writes the
 *      `entitlements` rows and touches nothing else; the service the features
 *      called never read that table.
 *
 * WHAT THIS SUITE PROVES, through the REAL routes of the REAL AppModule against
 * a REAL PostgreSQL — the gate is never called directly, because a suite that
 * calls the service proves the service, not the product:
 *
 *   POST   /api/v1/children                                   (second child)
 *   POST   /api/v1/pairing/device/register                    (second device)
 *   POST   /api/v1/support                                    (priority flag)
 *   GET    /api/v1/life-intelligence/insights/:childId/weekly (insights)
 *
 * FOUR HOUSEHOLDS, each identical apart from its billing state:
 *
 *   GRACE    subscription GRACE_PERIOD, FAMILY tier   -> all four ALLOWED
 *   REVOKED  subscription ACTIVE + revoked rows       -> all four REFUSED
 *   TRIAL    subscription TRIALING, FAMILY tier       -> all four ALLOWED  (pin)
 *   ACTIVE   subscription ACTIVE, FAMILY tier         -> all four ALLOWED  (pin)
 *
 * TRIAL and ACTIVE are REGRESSION PINS: they behaved this way before the merge
 * and must behave identically after it. A merge that quietly changed the common
 * case would be a policy change wearing a bug fix's clothes.
 *
 * WHY `REVOKED` IS A REACHABLE STATE AND NOT A CONTRIVANCE. `revokeAll` never
 * touches `subscriptions`, and `PaymentWebhookService` calls it on the
 * EXPIRED/REVOKED path and the refund path REGARDLESS of whether
 * `applySubscriptionStateIfNewer` applied — that guard legitimately drops a
 * stale, out-of-order provider callback, which Q17 says to expect. So «rows
 * revoked, subscription still ACTIVE» is exactly what a genuine late-arriving
 * refund leaves behind. The rows here are written with the REAL
 * `EntitlementService.grantForPlan` and the REAL `revokeAll`.
 */
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request = require('supertest');

import { AppModule } from '../../src/app.module';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { applyGlobalHttpPipeline } from '../../src/common/http/global-pipeline';
import { createTenantExtension } from '../../src/common/tenancy/tenant.extension';
import { runAsSystemAsync } from '../../src/common/tenancy/system-context';
import { runWithTenant } from '../../src/common/tenancy/tenant-context';
import { EntitlementService } from '../../src/modules/billing/application/services/entitlement.service';
import { integrationDatabaseUrl } from '../tenancy/prisma-test-client';

const describeIfDb = integrationDatabaseUrl() ? describe : describe.skip;

const P = '/api/v1';

/** The four features the four gated routes ask about. */
const GATED_FEATURES = [
  'multiple_children',
  'unlimited_devices_per_child',
  'priority_support',
  'family_insights',
] as const;

/**
 * A tier of this suite's own, so that nothing here depends on — or disturbs —
 * the PREMIUM row `subscription-cancel.e2e.spec.ts` creates in the same shared
 * database. `plan_definitions` is GLOBAL: it has no `family_id`.
 */
const TIER = 'FAMILY' as const;

async function clearThrottleCounters(): Promise<void> {
  const Redis = require('ioredis');
  const client = new Redis(process.env.REDIS_URL as string);
  const keys = await client.keys('throttle:*');
  if (keys.length > 0) await client.del(...keys);
  await client.quit();
}

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
  label: string;
  familyId: string;
  ownerId: string;
  token: string;
  childId: string;
}

describeIfDb('SPRINT F1 (P0) — one entitlement answer, on the real routes', () => {
  let app: INestApplication;
  let http: any;
  let prisma: any;
  let entitlements: EntitlementService;

  const stamp = Date.now();
  const createdFamilies: string[] = [];
  const createdUsers: string[] = [];
  let createdPlan = false;

  const GRACE = { label: 'grace' } as Household;
  const REVOKED = { label: 'revoked' } as Household;
  const TRIAL = { label: 'trial' } as Household;
  const ACTIVE = { label: 'active' } as Household;

  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

  const sys = (what: string, fn: () => Promise<any>): Promise<any> =>
    runAsSystemAsync('TEST_FIXTURE', `F1 entitlement-parity suite: ${what}`, async () => await fn());

  async function registerHousehold(target: Household): Promise<void> {
    // The register/login throttle counters are IP-keyed and shared by every
    // suite drawing on 127.0.0.1; returned in `afterAll`.
    await clearThrottleCounters();
    const email = `f1.entitlement.${target.label}.${stamp}@example.com`;
    const password = 'F1-Entitlement-Passw0rd!23';

    const reg = await request(http).post(`${P}/auth/register`).send({
      email,
      password,
      fullName: `F1 Owner ${target.label}`,
      familyName: `F1 Family ${target.label}`,
      acceptedTerms: true,
    });
    if (![200, 201].includes(reg.status)) {
      throw new Error(`register(${target.label}) -> ${reg.status} ${JSON.stringify(reg.body)}`);
    }

    const login = await request(http).post(`${P}/auth/login`).send({ email, password });
    if (login.status !== 200) {
      throw new Error(`login(${target.label}) -> ${login.status} ${JSON.stringify(login.body)}`);
    }
    target.token = login.body.tokens?.accessToken ?? login.body.accessToken;
    const claims = JSON.parse(Buffer.from(target.token.split('.')[1], 'base64').toString());
    target.familyId = claims.familyId;
    target.ownerId = claims.sub;
    createdFamilies.push(target.familyId);
    createdUsers.push(target.ownerId);

    // THE FIRST CHILD IS FREE ON EVERY TIER — no entitlement is consulted for
    // it, which is what makes the SECOND one a clean probe.
    const child = await request(http)
      .post(`${P}/children`)
      .set(bearer(target.token))
      .send({ firstName: `F1 Kid ${target.label}`, dateOfBirth: '2015-04-01' });
    if (![200, 201].includes(child.status)) {
      throw new Error(`child(${target.label}) -> ${child.status} ${JSON.stringify(child.body)}`);
    }
    target.childId = child.body.id;
  }

  async function seedSubscription(target: Household, status: string): Promise<void> {
    await sys(`subscription ${status} for ${target.label}`, () =>
      prisma.subscription.create({
        data: {
          familyId: target.familyId,
          planTier: TIER,
          status: status as any,
          provider: 'MANUAL',
          currentPeriodStart: new Date(Date.now() - 30 * 86_400_000),
          currentPeriodEnd: new Date(Date.now() - 60_000),
          gracePeriodEndsAt: status === 'GRACE_PERIOD' ? new Date(Date.now() + 7 * 86_400_000) : null,
        },
      }),
    );
  }

  /**
   * THE FIRST DEVICE, SEEDED — and it is seeded rather than paired for a
   * reason worth stating. The first device for a child never consults the
   * entitlement (`existingDevicesForThisChild.length >= 1` is the gate), so it
   * is fixture, not subject. Running the full handshake for it would leave the
   * child's pairing state machine at `DEVICE_REGISTERED`, from which
   * `PAIRING_INVITED` is legitimately refused with 409 — and the probe that
   * MATTERS, the second device, would then never reach the entitlement check
   * this suite is about. The row below is byte-identical to the one the
   * handshake writes; `POST /pairing/device/register` is still the real route
   * under test, for the device that is actually gated.
   */
  async function seedFirstDevice(target: Household): Promise<void> {
    await sys(`first device for ${target.label}`, () =>
      prisma.device.create({
        data: {
          familyId: target.familyId,
          ownerType: 'CHILD',
          childId: target.childId,
          platform: 'ANDROID',
          status: 'ACTIVE',
          pairedAt: new Date(),
        },
        select: { id: true },
      }),
    );
  }

  /** The whole real handshake: invite -> accept -> register. */
  async function pairDevice(target: Household, keyLabel: string): Promise<request.Response> {
    const invited = await request(http)
      .post(`${P}/pairing/invite`)
      .set(bearer(target.token))
      .send({ childId: target.childId });
    if (invited.status !== 200) {
      throw new Error(`invite(${target.label}) -> ${invited.status} ${JSON.stringify(invited.body)}`);
    }
    const accepted = await request(http).post(`${P}/pairing/accept`).send({ code: invited.body.code });
    if (accepted.status !== 200) {
      throw new Error(`accept(${target.label}) -> ${accepted.status} ${JSON.stringify(accepted.body)}`);
    }
    return request(http)
      .post(`${P}/pairing/device/register`)
      .set(bearer(accepted.body.token))
      .send({
        publicKey: `F1-${target.label}-${keyLabel}-PUBLIC-KEY`,
        platform: 'ANDROID',
        deviceModel: 'Pixel 7a',
        osVersion: '14',
        appVersion: '1.0.0',
        pairingProtocolVersion: '1',
      });
  }

  // ---- the four probes, each one a real HTTP request ----

  const addSecondChild = (h: Household) =>
    request(http)
      .post(`${P}/children`)
      .set(bearer(h.token))
      .send({ firstName: `F1 Sibling ${h.label}`, dateOfBirth: '2018-09-09' });

  const submitSupport = async (h: Household) => {
    await clearThrottleCounters(); // POST /support is 5/min per IP.
    return request(http).post(`${P}/support`).set(bearer(h.token)).send({
      email: `f1.${h.label}.${stamp}@example.com`,
      subject: 'F1 entitlement parity',
      message: 'Checking whether this household reaches priority support.',
    });
  };

  const readInsights = (h: Household) =>
    request(http).get(`${P}/life-intelligence/insights/${h.childId}/weekly`).set(bearer(h.token));

  beforeAll(async () => {
    await clearThrottleCounters();

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue(offlinePrismaService())
      .compile();

    app = moduleRef.createNestApplication();
    applyGlobalHttpPipeline(app);
    await app.init();
    http = app.getHttpServer();
    prisma = app.get(PrismaService);
    entitlements = app.get(EntitlementService);

    // The plan catalogue is what «what does FAMILY include» means; with no row
    // every assertion below would be vacuously false. Created only if absent
    // and removed again in `afterAll`, because `plan_definitions` is global.
    const existingPlan = await sys('look for the FAMILY plan', () =>
      prisma.planDefinition.findUnique({ where: { tier: TIER }, select: { id: true } }),
    );
    if (!existingPlan) {
      await sys('create the FAMILY plan', () =>
        prisma.planDefinition.create({
          data: {
            tier: TIER,
            name: 'Family',
            priceCents: 24900,
            currency: 'EGP',
            billingIntervalMonths: 1,
            features: [...GATED_FEATURES],
            isActive: true,
          },
        }),
      );
      createdPlan = true;
    }

    for (const household of [GRACE, REVOKED, TRIAL, ACTIVE]) {
      await registerHousehold(household);
      await seedFirstDevice(household);
    }

    await seedSubscription(GRACE, 'GRACE_PERIOD');
    await seedSubscription(TRIAL, 'TRIALING');
    await seedSubscription(ACTIVE, 'ACTIVE');

    // The refunded household: a REAL grant through the REAL service, then a
    // REAL revocation — and `subscriptions` deliberately left at ACTIVE, the
    // state a stale-but-genuine refund callback leaves behind.
    await seedSubscription(REVOKED, 'ACTIVE');
    await runWithTenant({ familyId: REVOKED.familyId, actorType: 'SYSTEM', actorId: 'f1-fixture' }, () =>
      entitlements.grantForPlan({
        familyId: REVOKED.familyId,
        planTier: TIER,
        source: 'MANUAL',
        subscriptionId: null,
        validFrom: new Date(Date.now() - 86_400_000),
        validUntil: new Date(Date.now() + 30 * 86_400_000),
      }),
    );
    await runWithTenant({ familyId: REVOKED.familyId, actorType: 'SYSTEM', actorId: 'f1-fixture' }, () =>
      entitlements.revokeAll(REVOKED.familyId, 'refund'),
    );
  }, 180_000);

  afterAll(async () => {
    if (prisma) {
      await sys('teardown', async () => {
        await prisma.auditLog.deleteMany({ where: { familyId: { in: createdFamilies } } });
        await prisma.family.deleteMany({ where: { id: { in: createdFamilies } } });
        await prisma.user.deleteMany({ where: { id: { in: createdUsers } } });
        if (createdPlan) await prisma.planDefinition.deleteMany({ where: { tier: TIER } });
      });
    }
    await app?.close();
    await clearThrottleCounters();
  });

  it('the fixture is real: four households, four billing states, one child and one device each', async () => {
    for (const h of [GRACE, REVOKED, TRIAL, ACTIVE]) {
      expect(h.familyId).toBeTruthy();
      expect(h.childId).toBeTruthy();
    }
    const revokedRows = await sys('read the revoked rows', () =>
      prisma.$queryRawUnsafe(
        `SELECT "status"::text AS status FROM "entitlements" WHERE "family_id" = $1::uuid`,
        REVOKED.familyId,
      ),
    );
    expect(revokedRows).toHaveLength(GATED_FEATURES.length);
    expect(new Set(revokedRows.map((r: any) => r.status))).toEqual(new Set(['REVOKED']));

    const subStatus = await sys('read the revoked household subscription', () =>
      prisma.$queryRawUnsafe(
        `SELECT "status"::text AS status FROM "subscriptions" WHERE "family_id" = $1::uuid`,
        REVOKED.familyId,
      ),
    );
    // The whole point of this household: the subscription row still says ACTIVE.
    expect(subStatus[0].status).toBe('ACTIVE');
  });

  // =========================================================================
  // 1. THE DEFECT, DIRECTION 1 — A PAYING HOUSEHOLD IN ITS GRACE WINDOW
  // =========================================================================
  describe('a GRACE_PERIOD household has everything it paid for', () => {
    it('can add a second child — POST /children', async () => {
      const response = await addSecondChild(GRACE);
      expect(response.status).toBe(201);
      expect(response.body.id).toBeTruthy();
    });

    it('can pair a second device for the same child — POST /pairing/device/register', async () => {
      const response = await pairDevice(GRACE, 'SECOND-DEVICE');
      expect(response.status).toBe(201);
      expect(response.body.deviceId).toBeTruthy();
    });

    it('reaches priority support — POST /support', async () => {
      const response = await submitSupport(GRACE);
      expect(response.status).toBe(201);
      expect(response.body.isPriority).toBe(true);
    });

    it('sees insights — GET /life-intelligence/insights/:childId/weekly', async () => {
      const response = await readInsights(GRACE);
      expect(response.status).toBe(200);
      expect(response.body.childId).toBe(GRACE.childId);
    });
  });

  // =========================================================================
  // 2. THE DEFECT, DIRECTION 2 — A REFUNDED HOUSEHOLD
  // =========================================================================
  describe('a household whose entitlements were revoked is refused all four', () => {
    it('cannot add a second child — POST /children', async () => {
      const response = await addSecondChild(REVOKED);
      expect(response.status).toBe(403);
      expect(response.body.code).toBe('PLAN_UPGRADE_REQUIRED');
      // B3: the refusal a parent reads is Arabic, and names no feature flag.
      expect(response.body.messageAr).toBeTruthy();
    });

    it('cannot pair a second device — POST /pairing/device/register', async () => {
      const response = await pairDevice(REVOKED, 'SECOND-DEVICE');
      expect(response.status).toBe(403);
      expect(response.body.code).toBe('PLAN_UPGRADE_REQUIRED');
      expect(response.body.messageAr).toBeTruthy();
    });

    it('does not reach priority support — POST /support', async () => {
      const response = await submitSupport(REVOKED);
      expect(response.status).toBe(201);
      expect(response.body.isPriority).toBe(false);
    });

    it('does not see insights — GET /life-intelligence/insights/:childId/weekly', async () => {
      const response = await readInsights(REVOKED);
      expect(response.status).toBe(403);
    });

    it('and `GET /billing/entitlements` agrees — the two answers are now ONE', async () => {
      const response = await request(http).get(`${P}/billing/entitlements`).set(bearer(REVOKED.token));
      expect(response.status).toBe(200);
      expect(response.body.features).toEqual([]);
    });
  });

  // =========================================================================
  // 3. THE REGRESSION PINS — the common case must not have moved
  // =========================================================================
  describe.each([
    ['TRIALING', () => TRIAL],
    ['ACTIVE', () => ACTIVE],
  ])('a %s household behaves exactly as it did before the merge', (_status, get) => {
    it('adds a second child', async () => {
      expect((await addSecondChild(get())).status).toBe(201);
    });

    it('pairs a second device for the same child', async () => {
      expect((await pairDevice(get(), 'SECOND-DEVICE')).status).toBe(201);
    });

    it('reaches priority support', async () => {
      expect((await submitSupport(get())).body.isPriority).toBe(true);
    });

    it('sees insights', async () => {
      expect((await readInsights(get())).status).toBe(200);
    });
  });
});
