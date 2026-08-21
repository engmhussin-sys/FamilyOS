/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * ============================================================================
 * THE PLAN CATALOGUE — proven by the paywall it OPENS FOR EVERY HOUSEHOLD.
 * ============================================================================
 *
 * `plan_definitions` is the table the whole commercial side reads, and until
 * now nothing wrote it. `schema.prisma` calls it «seeded once, admin-editable
 * later»; neither half was true. On a database built from the migration
 * history it is empty, and the effect is not cosmetic: `hasFeature` falls back
 * to the family's tier, looks it up here, finds nothing, and answers false.
 * Every paid feature is locked for every household, and a real verified
 * purchase grants nothing because `grantForPlan` iterates a plan that is not
 * there.
 *
 * So the claim this suite has to prove is not «a row was written». It is:
 * DEFINE A TIER, AND A HOUSEHOLD ON THAT TIER GAINS WHAT THE TIER SAYS.
 *
 * RULE C1  Both routes refuse an anonymous caller and a wrong operator key.
 * RULE C2  A fresh catalogue reports itself as EMPTY, and says which feature
 *          keys exist to choose from — read from code, not typed into a form's
 *          help text, so the two cannot drift.
 * RULE C3  An upsert on a tier that already exists REPLACES it rather than
 *          creating a second row: `tier` is unique, and a catalogue with two
 *          PREMIUMs is a catalogue that answers differently depending on which
 *          row a query happens to read first.
 * RULE C4  THE POINT. A household whose subscription tier is defined here gains
 *          exactly the features the tier lists — measured through
 *          `EntitlementService.hasFeature`, the single authority — and loses
 *          them when the tier is edited to drop one.
 * RULE C5  Validation refuses what would corrupt the catalogue: an unknown
 *          feature key, an unknown tier, a non-ISO currency.
 * RULE C6  Every write is audited, and the audit row carries what it REPLACED —
 *          a catalogue change is reversible by reading the trail, not by
 *          remembering.
 */
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request = require('supertest');

import { AppModule } from '../../src/app.module';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { applyGlobalHttpPipeline } from '../../src/common/http/global-pipeline';
import { EntitlementService } from '../../src/modules/billing/application/services/entitlement.service';
import { runWithTenant } from '../../src/common/tenancy/tenant-context';
import { createTestPrisma, createTestPrismaService, integrationDatabaseUrl } from '../tenancy/prisma-test-client';

const P = '/api/v1';
const describeIfDb =
  integrationDatabaseUrl() && process.env.INTERNAL_ADMIN_API_KEY ? describe : describe.skip;

describeIfDb('the plan catalogue', () => {
  let app: INestApplication;
  let http: any;
  let raw: ReturnType<typeof createTestPrisma>;
  let entitlements: EntitlementService;
  const key = process.env.INTERNAL_ADMIN_API_KEY as string;

  const stamp = Date.now();
  const email = `catalogue.probe.${stamp}@example.com`;
  const password = 'CatalogueProbe-Passw0rd!23';
  let familyId = '';

  /** A tier this suite owns outright, so it cannot disturb a real catalogue. */
  const TIER = 'ENTERPRISE';

  const putPlan = (body: Record<string, unknown>) =>
    request(http).put(`${P}/system/billing/plans`).set('x-internal-admin-key', key).send(body);

  /**
   * `hasFeature` reads `entitlements`, a TENANT-SCOPED table, so calling it
   * from a test with no ambient context is denied by the tenant extension —
   * exactly as it would be from any code path that forgot to establish one.
   * The suite therefore asks the question the way a request does: inside the
   * household's own context. Measured the first time this file ran, as
   * TENANT_CONTEXT_MISSING.
   */
  const hasFeature = (feature: 'multiple_children' | 'priority_support' | 'ai_diagnostics') =>
    runWithTenant({ familyId, actorType: 'USER', actorId: 'catalogue-probe' }, () =>
      entitlements.hasFeature(familyId, feature),
    );

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue(createTestPrismaService())
      .compile();

    app = moduleRef.createNestApplication();
    applyGlobalHttpPipeline(app);
    await app.init();
    http = app.getHttpServer();
    raw = createTestPrisma();
    entitlements = app.get(EntitlementService);

    const reg = await request(http).post(`${P}/auth/register`).send({
      email,
      password,
      fullName: 'Catalogue Probe',
      familyName: 'Catalogue Probe Family',
      acceptedTerms: true,
    });
    if (reg.status !== 201 && reg.status !== 200) {
      throw new Error(`register failed: ${reg.status} ${JSON.stringify(reg.body)}`);
    }

    const member = await raw.raw.familyMember.findFirst({
      where: { user: { email } },
      include: { family: true },
    });
    familyId = member.familyId;

    /**
     * The household is put on the tier under test with an ACTIVE subscription
     * and NO entitlement rows, which is the state a Sprint-8-path subscriber is
     * in: `hasFeature` then has to answer from the catalogue, which is exactly
     * the path being measured.
     */
    await raw.raw.subscription.upsert({
      where: { familyId },
      create: { familyId, planTier: TIER, status: 'ACTIVE' },
      update: { planTier: TIER, status: 'ACTIVE' },
    });
  }, 150_000);

  afterAll(async () => {
    // The tier this suite defined is removed so it cannot change the answer for
    // any other suite that reads the catalogue.
    if (raw) {
      await raw.raw.planDefinition.deleteMany({ where: { tier: TIER } }).catch(() => undefined);
      await raw.disconnect();
    }
    if (app) await app.close();
  });

  it('C1 — both routes refuse an anonymous caller and a wrong key', async () => {
    for (const call of [
      () => request(http).get(`${P}/system/billing/plans`),
      () => request(http).put(`${P}/system/billing/plans`).send({}),
    ]) {
      expect((await call()).status).toBe(401);
    }
    const wrong = await request(http)
      .get(`${P}/system/billing/plans`)
      .set('x-internal-admin-key', 'not-the-operator-key');
    expect(wrong.status).toBe(401);
  }, 60_000);

  it('C2 — the catalogue reports whether it is empty, and which keys exist', async () => {
    const res = await request(http).get(`${P}/system/billing/plans`).set('x-internal-admin-key', key);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.plans)).toBe(true);
    expect(typeof res.body.isEmpty).toBe('boolean');
    expect(res.body.isEmpty).toBe(res.body.plans.length === 0);
    // Read from ENTITLEMENT_KEYS in code, so a seventh feature added tomorrow
    // appears here without anyone editing a form.
    expect(res.body.availableFeatures).toEqual(
      expect.arrayContaining(['multiple_children', 'priority_support']),
    );
  }, 60_000);

  it('C4 — defining a tier gives every household on it exactly those features', async () => {
    // Nothing defined yet for this tier: the authority must say no.
    expect(await hasFeature('multiple_children')).toBe(false);

    const created = await putPlan({
      tier: TIER,
      name: 'Catalogue Probe Tier',
      priceCents: 4999,
      currency: 'EGP',
      billingIntervalMonths: 1,
      features: ['multiple_children', 'priority_support'],
      isActive: true,
    });
    expect(created.status).toBe(200);
    expect(created.body.tier).toBe(TIER);

    expect(await hasFeature('multiple_children')).toBe(true);
    expect(await hasFeature('priority_support')).toBe(true);
    // A feature the tier does NOT list stays closed — otherwise "defining a
    // tier" would mean "unlocking everything".
    expect(await hasFeature('ai_diagnostics')).toBe(false);
  }, 90_000);

  it('C3 — editing a tier replaces it, and the household loses what was removed', async () => {
    const edited = await putPlan({
      tier: TIER,
      name: 'Catalogue Probe Tier (edited)',
      priceCents: 5999,
      currency: 'EGP',
      billingIntervalMonths: 1,
      features: ['priority_support'],
      isActive: true,
    });
    expect(edited.status).toBe(200);

    const rows = await raw.raw.planDefinition.findMany({ where: { tier: TIER } });
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe('Catalogue Probe Tier (edited)');

    expect(await hasFeature('priority_support')).toBe(true);
    expect(await hasFeature('multiple_children')).toBe(false);
  }, 90_000);

  it('C5 — refuses an unknown feature key, an unknown tier and a bad currency', async () => {
    const cases = [
      { label: 'feature', body: { features: ['unlimited_everything'] } },
      { label: 'tier', body: { tier: 'PLATINUM' } },
      { label: 'currency', body: { currency: 'egyptian pounds' } },
    ];
    for (const testCase of cases) {
      const res = await putPlan({
        tier: TIER,
        name: 'Should not be written',
        priceCents: 100,
        currency: 'EGP',
        billingIntervalMonths: 1,
        features: ['priority_support'],
        isActive: true,
        ...testCase.body,
      });
      expect({ case: testCase.label, status: res.status }).toEqual({ case: testCase.label, status: 400 });
    }
  }, 90_000);

  it('C6 — every write is audited, and carries what it replaced', async () => {
    const rows = await raw.raw.auditLog.findMany({
      where: { action: { in: ['billing.plan_created', 'billing.plan_updated'] } },
      orderBy: { createdAt: 'desc' },
      take: 5,
    });
    expect(rows.length).toBeGreaterThanOrEqual(2);

    const update = rows.find((row: any) => row.action === 'billing.plan_updated');
    expect(update).toBeTruthy();
    const metadata = JSON.stringify(update.metadata);
    expect(metadata).toContain('Catalogue Probe Tier (edited)');
    // The previous shape is what makes a catalogue change reversible by
    // reading rather than by remembering.
    expect(metadata).toContain('previous');
    expect(metadata).toContain('multiple_children');

    // A plan is global: attributing the change to a household would be a lie
    // about who it affected.
    expect(update.familyId).toBeNull();
  }, 60_000);
});
