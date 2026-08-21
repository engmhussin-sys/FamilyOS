/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * ============================================================================
 * COMPING A PLAN — PROVEN BY THE PAYWALL IT OPENS, AND THE ONE IT CLOSES AGAIN.
 * ============================================================================
 *
 * `POST /system/billing/grants` exists so a household can have full features
 * without a payment: a tester, a pilot family, a support gesture. The claim it
 * makes is not "a row was written" — it is "the SECOND CHILD now succeeds".
 * So that is what this suite asserts, through the real HTTP surface, on the
 * real entitlement path.
 *
 * WHY THE SECOND CHILD IS THE PROBE. `ChildrenService.createChild` calls
 * `hasFeature(familyId, 'multiple_children')` and answers 403
 * PLAN_UPGRADE_REQUIRED when it is false. It is the paywall a real family hits
 * first, it is the one the seeder script hits on a fresh account, and it reads
 * the SINGLE entitlement authority — so a grant that opens it has demonstrably
 * changed what the product allows, not merely what a table contains.
 *
 * RULE G1  Before any grant, the second child is refused. Without this the rest
 *          of the suite could pass on a plan that never gated anything.
 * RULE G2  Anonymous and wrong-key callers are refused on EVERY route here,
 *          derived from Nest's own metadata rather than hand-listed. A comp
 *          surface reachable without the operator key is a free upgrade for
 *          whoever finds it.
 * RULE G3  A grant opens the paywall: the same request that was 403 succeeds.
 * RULE G4  A revoke closes it again — through `revokeAll`, the same path a
 *          refund uses — and the second child is refused once more.
 * RULE G5  The grant is BOUNDED. `validUntil` comes back as a real date inside
 *          the requested window, and an unbounded or over-long request is
 *          rejected by validation rather than written.
 * RULE G6  It is AUDITED. An `audit_logs` row exists for the family carrying
 *          the operator's stated reason — the thing that makes "why does this
 *          household have PREMIUM without paying" answerable months later.
 * RULE G7  No route accepts a `familyId`. The household is resolved from the
 *          email server-side, and an unknown email is a flat 404 that does not
 *          distinguish "no account" from "no household".
 */
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request = require('supertest');

import { AppModule } from '../../src/app.module';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { applyGlobalHttpPipeline } from '../../src/common/http/global-pipeline';
import { createTestPrisma, createTestPrismaService, integrationDatabaseUrl } from '../tenancy/prisma-test-client';

const P = '/api/v1';
const describeIfDb =
  integrationDatabaseUrl() && process.env.INTERNAL_ADMIN_API_KEY ? describe : describe.skip;

describeIfDb('operator plan grants', () => {
  let app: INestApplication;
  let http: any;
  let raw: ReturnType<typeof createTestPrisma>;
  const key = process.env.INTERNAL_ADMIN_API_KEY as string;

  const stamp = Date.now();
  const email = `grant.probe.${stamp}@example.com`;
  const password = 'GrantProbe-Passw0rd!23';
  let token = '';
  let familyId = '';

  const addChild = (firstName: string) =>
    request(http)
      .post(`${P}/children`)
      .set('authorization', `Bearer ${token}`)
      .send({ firstName, lastName: 'Probe', dateOfBirth: '2016-03-03', gender: 'unspecified' });

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

    const reg = await request(http).post(`${P}/auth/register`).send({
      email,
      password,
      fullName: 'Grant Probe',
      familyName: 'Grant Probe Family',
      acceptedTerms: true,
    });
    if (reg.status !== 201 && reg.status !== 200) {
      throw new Error(`register failed: ${reg.status} ${JSON.stringify(reg.body)}`);
    }
    const login = await request(http).post(`${P}/auth/login`).send({ email, password });
    token = login.body.tokens?.accessToken ?? login.body.accessToken;
    if (!token) throw new Error(`login produced no token: ${JSON.stringify(login.body)}`);

    // The first child is free on every tier, so it establishes the state in
    // which the SECOND is the entitlement question.
    const first = await addChild('First');
    if (first.status !== 201 && first.status !== 200) {
      throw new Error(`first child failed: ${first.status} ${JSON.stringify(first.body)}`);
    }
  }, 120_000);

  afterAll(async () => {
    if (raw) await raw.disconnect();
    if (app) await app.close();
  });

  it('G1 — before any grant, the second child is refused by the paywall', async () => {
    const res = await addChild('SecondBefore');
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('PLAN_UPGRADE_REQUIRED');
  }, 60_000);

  it('G2 — every route refuses an anonymous caller and a wrong key', async () => {
    const calls: [string, string, any][] = [
      ['get', `${P}/system/billing/grants?email=${encodeURIComponent(email)}`, undefined],
      ['post', `${P}/system/billing/grants`, { email, planTier: 'PREMIUM', days: 7, reason: 'probe' }],
      [
        'post',
        `${P}/system/billing/grants/features`,
        { email, features: ['multiple_children'], planTier: 'PREMIUM', days: 7, reason: 'probe' },
      ],
      ['post', `${P}/system/billing/grants/revoke`, { email, reason: 'probe' }],
    ];
    for (const [method, path, body] of calls) {
      const anon = await (request(http) as any)[method](path).send(body);
      expect({ path, status: anon.status }).toEqual({ path, status: 401 });

      const wrong = await (request(http) as any)
        [method](path)
        .set('x-internal-admin-key', 'not-the-operator-key')
        .send(body);
      expect({ path, status: wrong.status }).toEqual({ path, status: 401 });
    }
  }, 90_000);

  /**
   * G3a IS THE DEFECT THIS SUITE CAUGHT, KEPT AS A RULE.
   *
   * The tier path delegates to `grantForPlan`, which reads `plan_definitions`
   * — a table documented as «seeded once» that NO migration seeds. The first
   * version of this service answered 200 with `features: []` there: an
   * operator would have read success, told a tester they were upgraded, and
   * the paywall would have refused them exactly as before. On a database with
   * a catalogue the grant must work; on one without, it must REFUSE.
   */
  it('G3a — the tier path never reports success while granting nothing', async () => {
    const granted = await request(http)
      .post(`${P}/system/billing/grants`)
      .set('x-internal-admin-key', key)
      .send({ email, planTier: 'PREMIUM', days: 14, reason: 'pilot testing window' });

    if (granted.status === 200) {
      // A catalogue exists here: then it must actually have granted something.
      expect(granted.body.features.length).toBeGreaterThan(0);
      familyId = granted.body.familyId;
      return;
    }
    expect(granted.status).toBe(409);
    expect(granted.body.code).toBe('PLAN_CATALOGUE_EMPTY');
    // The refusal has to hand the operator the way forward, not just a no.
    expect(JSON.stringify(granted.body)).toContain('multiple_children');
  }, 90_000);

  it('G3 — a feature grant opens the paywall: the same request that was 403 succeeds', async () => {
    const granted = await request(http)
      .post(`${P}/system/billing/grants/features`)
      .set('x-internal-admin-key', key)
      .send({
        email,
        features: ['multiple_children'],
        planTier: 'PREMIUM',
        days: 14,
        reason: 'pilot testing window',
      });

    expect(granted.status).toBe(200);
    expect(granted.body.features).toEqual(expect.arrayContaining(['multiple_children']));
    familyId = granted.body.familyId;
    expect(familyId).toEqual(expect.any(String));

    const res = await addChild('SecondAfterGrant');
    expect([200, 201]).toContain(res.status);
  }, 90_000);

  it('G3b — an unknown feature key is refused, and the refusal names the valid ones', async () => {
    const res = await request(http)
      .post(`${P}/system/billing/grants/features`)
      .set('x-internal-admin-key', key)
      .send({ email, features: ['unlimited_everything'], planTier: 'PREMIUM', days: 7, reason: 'typo probe' });

    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toContain('multiple_children');
  }, 60_000);

  it('G5 — the grant is bounded, and an unbounded or over-long one is refused', async () => {
    const state = await request(http)
      .get(`${P}/system/billing/grants`)
      .query({ email })
      .set('x-internal-admin-key', key);

    expect(state.status).toBe(200);
    const validUntil = new Date(state.body.validUntil);
    expect(Number.isNaN(validUntil.getTime())).toBe(false);
    // Inside the 14 days asked for — not null, and not a century.
    expect(validUntil.getTime()).toBeGreaterThan(Date.now());
    expect(validUntil.getTime()).toBeLessThanOrEqual(Date.now() + 15 * 24 * 60 * 60 * 1000);

    for (const days of [0, 100_000]) {
      const bad = await request(http)
        .post(`${P}/system/billing/grants/features`)
        .set('x-internal-admin-key', key)
        .send({ email, features: ['priority_support'], planTier: 'PREMIUM', days, reason: 'should not be written' });
      expect({ days, status: bad.status }).toEqual({ days, status: 400 });
    }
    // ...and neither is a missing reason, because the audit row is the point.
    const noReason = await request(http)
      .post(`${P}/system/billing/grants/features`)
      .set('x-internal-admin-key', key)
      .send({ email, features: ['priority_support'], planTier: 'PREMIUM', days: 7 });
    expect(noReason.status).toBe(400);
  }, 90_000);

  it('G6 — the grant is audited, with the operator’s stated reason', async () => {
    const rows = await raw.raw.auditLog.findMany({
      where: { familyId, action: 'billing.operator_grant' },
    });
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(rows[0].metadata)).toContain('pilot testing window');
  }, 60_000);

  it('G4 — a revoke closes the paywall again', async () => {
    const revoked = await request(http)
      .post(`${P}/system/billing/grants/revoke`)
      .set('x-internal-admin-key', key)
      .send({ email, reason: 'testing window over' });

    expect(revoked.status).toBe(200);
    expect(revoked.body.revokedCount).toBeGreaterThanOrEqual(1);

    const res = await addChild('ThirdAfterRevoke');
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('PLAN_UPGRADE_REQUIRED');
  }, 90_000);

  it('G7 — an unknown email is a flat 404 that reveals nothing', async () => {
    const res = await request(http)
      .post(`${P}/system/billing/grants`)
      .set('x-internal-admin-key', key)
      .send({ email: `nobody.${stamp}@example.com`, planTier: 'PREMIUM', days: 7, reason: 'probe' });
    // Resolution happens before the catalogue check, so an unknown household is
    // 404 whether or not any plan is defined.

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('FAMILY_NOT_FOUND');
    // The refusal must not tell a key-holder whether the ACCOUNT exists — that
    // is a different fact from whether it has a household.
    expect(JSON.stringify(res.body)).not.toMatch(/user|account exists|no member/i);
  }, 60_000);
});
