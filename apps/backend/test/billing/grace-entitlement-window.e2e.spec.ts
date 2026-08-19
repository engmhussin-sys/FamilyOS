/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-var-requires */
/**
 * ============================================================================
 * THE GRACE WINDOW, ON A REAL ROUTE AND A REAL POSTGRESQL.
 * ============================================================================
 *
 * `payment-webhook.pipeline.spec.ts` proves the DECISION — the webhook extends
 * the entitlement rows to the same instant it writes into
 * `subscriptions.grace_period_ends_at`, and the boundary holds on both sides —
 * against constraint-enforcing repository doubles.
 *
 * WHAT IT CANNOT PROVE is the half that is SQL: `extendEntitlements` is an
 * `updateMany` whose WHERE clause IS the rule («ACTIVE, bounded, and ending
 * EARLIER than the new end»). A double that reimplements that WHERE in
 * TypeScript agrees with itself by construction. So the same three properties
 * are asserted here against real rows in real PostgreSQL, and read back through
 * the REAL ROUTE a client actually asks — `GET /api/v1/billing/entitlements`,
 * the one Q17 calls the single source of truth for feature access.
 *
 * MEASURED BEFORE THE FIX, this fixture: a household whose rows lapsed at
 * period end answered `{planTier: null, features: [], validUntil: null}` for
 * the whole of its seven-day grace window.
 *
 * THE CLOCK IS FROZEN in the sense that matters for a boundary: every window is
 * derived from ONE captured instant, and the two probes either side of the end
 * are one second apart on that instant's timeline.
 */
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request = require('supertest');

import { AppModule } from '../../src/app.module';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { applyGlobalHttpPipeline } from '../../src/common/http/global-pipeline';
import { runAsSystemAsync } from '../../src/common/tenancy/system-context';
import { runWithTenant } from '../../src/common/tenancy/tenant-context';
import { EntitlementService } from '../../src/modules/billing/application/services/entitlement.service';
import { createTestPrismaService, integrationDatabaseUrl } from '../tenancy/prisma-test-client';

const describeIfDb = integrationDatabaseUrl() ? describe : describe.skip;

const P = '/api/v1';
const DAY = 86_400_000;
/** This suite's own tier, so it neither depends on nor disturbs the PREMIUM
 *  and FAMILY rows other billing suites create in the same shared database.
 *  `plan_definitions` is GLOBAL — it has no `family_id`. */
const TIER = 'ENTERPRISE' as const;
const FEATURES = ['ai_diagnostics', 'family_insights', 'priority_support'] as const;

describeIfDb('PHASE D — the grace window keeps a real household entitled, on the real route', () => {
  let app: INestApplication;
  let http: any;
  let prisma: any;
  let entitlements: EntitlementService;

  const stamp = Date.now();
  let familyId: string;
  let token: string;
  let createdPlan = false;

  /** The one captured instant every window below is derived from. */
  const t0 = new Date();
  const periodEnd = new Date(t0.getTime() - DAY); // the rows lapsed YESTERDAY
  const graceEnd = new Date(periodEnd.getTime() + 7 * DAY);

  const sys = <T>(what: string, fn: () => Promise<T>): Promise<T> =>
    runAsSystemAsync('TEST_FIXTURE', `grace window e2e: ${what}`, fn);

  async function clearThrottleCounters(): Promise<void> {
    const Redis = require('ioredis');
    const client = new Redis(process.env.REDIS_URL as string);
    const keys = await client.keys('throttle:*');
    if (keys.length > 0) await client.del(...keys);
    await client.quit();
  }

  async function readEntitlementsRoute(): Promise<any> {
    const res = await request(http).get(`${P}/billing/entitlements`).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    return res.body;
  }

  beforeAll(async () => {
    await clearThrottleCounters();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue(createTestPrismaService())
      .compile();

    app = moduleRef.createNestApplication();
    applyGlobalHttpPipeline(app);
    await app.init();
    http = app.getHttpServer();
    prisma = app.get(PrismaService);
    entitlements = app.get(EntitlementService);

    const existingPlan = await sys('look for the plan', () =>
      prisma.planDefinition.findUnique({ where: { tier: TIER }, select: { id: true } }),
    );
    if (!existingPlan) {
      await sys('create the plan', () =>
        prisma.planDefinition.create({
          data: {
            tier: TIER,
            name: 'Enterprise',
            priceCents: 29900,
            currency: 'EGP',
            billingIntervalMonths: 1,
            features: [...FEATURES],
            isActive: true,
          },
        }),
      );
      createdPlan = true;
    }

    const email = `grace.window.${stamp}@example.com`;
    const password = 'Grace-Window-Passw0rd!23';
    const reg = await request(http).post(`${P}/auth/register`).send({
      email,
      password,
      fullName: 'Grace Window Owner',
      familyName: `Grace Window ${stamp}`,
      acceptedTerms: true,
    });
    if (![200, 201].includes(reg.status)) {
      throw new Error(`register -> ${reg.status} ${JSON.stringify(reg.body)}`);
    }
    const login = await request(http).post(`${P}/auth/login`).send({ email, password });
    token = login.body.tokens?.accessToken ?? login.body.accessToken;
    const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString());
    familyId = claims.familyId;

    // A household granted through Phase D whose window CLOSED at period end —
    // written with the real service, so these are the rows a real purchase
    // leaves behind.
    await runWithTenant({ familyId, actorType: 'SYSTEM', actorId: 'grace-window-fixture' }, () =>
      entitlements.grantForPlan({
        familyId,
        planTier: TIER,
        source: 'MANUAL',
        subscriptionId: null,
        validFrom: new Date(periodEnd.getTime() - 30 * DAY),
        validUntil: periodEnd,
      }),
    );
  }, 180_000);

  afterAll(async () => {
    if (prisma) {
      await sys('teardown', async () => {
        await prisma.auditLog.deleteMany({ where: { familyId } });
        await prisma.family.deleteMany({ where: { id: familyId } });
        if (createdPlan) await prisma.planDefinition.deleteMany({ where: { tier: TIER } });
      });
    }
    if (app) await app.close();
  });

  it('BEFORE the grace window is applied, the lapsed household is refused on the real route', async () => {
    const body = await readEntitlementsRoute();
    expect(body.features).toEqual([]);
    expect(body.validUntil).toBeNull();
  });

  it('the grace window extends the REAL rows, and the real route says so', async () => {
    const moved = await runWithTenant({ familyId, actorType: 'SYSTEM', actorId: 'grace-window' }, () =>
      entitlements.extendThrough(familyId, graceEnd),
    );
    expect(moved).toBe(FEATURES.length);

    const body = await readEntitlementsRoute();
    expect([...body.features].sort()).toEqual([...FEATURES].sort());
    expect(new Date(body.validUntil).toISOString()).toBe(graceEnd.toISOString());
    expect(body.planTier).toBe(TIER);
  });

  it('the boundary holds in BOTH directions on the real rows', async () => {
    for (const feature of FEATURES) {
      expect(
        await runWithTenant({ familyId, actorType: 'SYSTEM', actorId: 'grace-window' }, () =>
          entitlements.hasFeature(familyId, feature as never, new Date(graceEnd.getTime() - 1000)),
        ),
      ).toBe(true);
      expect(
        await runWithTenant({ familyId, actorType: 'SYSTEM', actorId: 'grace-window' }, () =>
          entitlements.hasFeature(familyId, feature as never, graceEnd),
        ),
      ).toBe(false);
      expect(
        await runWithTenant({ familyId, actorType: 'SYSTEM', actorId: 'grace-window' }, () =>
          entitlements.hasFeature(familyId, feature as never, new Date(graceEnd.getTime() + DAY)),
        ),
      ).toBe(false);
    }
  });

  it('a second, EARLIER grace window cannot shorten the rows — the WHERE clause is the rule', async () => {
    const earlier = new Date(graceEnd.getTime() - 3 * DAY);
    const moved = await runWithTenant({ familyId, actorType: 'SYSTEM', actorId: 'grace-window' }, () =>
      entitlements.extendThrough(familyId, earlier),
    );
    expect(moved).toBe(0);

    const body = await readEntitlementsRoute();
    expect(new Date(body.validUntil).toISOString()).toBe(graceEnd.toISOString());
  });

  it('a REVOKED household is not resurrected by a grace window', async () => {
    await runWithTenant({ familyId, actorType: 'SYSTEM', actorId: 'grace-window' }, () =>
      entitlements.revokeAll(familyId, 'refund', new Date()),
    );
    const moved = await runWithTenant({ familyId, actorType: 'SYSTEM', actorId: 'grace-window' }, () =>
      entitlements.extendThrough(familyId, new Date(graceEnd.getTime() + 30 * DAY)),
    );
    expect(moved).toBe(0);

    const body = await readEntitlementsRoute();
    expect(body.features).toEqual([]);
    expect(body.validUntil).toBeNull();
  });
});
