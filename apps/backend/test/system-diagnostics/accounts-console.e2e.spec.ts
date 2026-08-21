/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * ============================================================================
 * THE ACCOUNTS CONSOLE — rows, across every tenant, for the platform owner.
 * ============================================================================
 *
 * This is the surface that answers «who is on my platform and what state are
 * they in», which until now nothing could: every platform-wide endpoint in this
 * product returns an aggregate. An owner reading "1,204 families" cannot find
 * the one that emailed support.
 *
 * IT IS ALSO THE MOST DANGEROUS SHAPE OF ENDPOINT IN THE CODEBASE — one query
 * that deliberately crosses every tenant boundary. So the rules below are
 * mostly about what it must refuse and what it must not carry.
 *
 * RULE A1  Anonymous and wrong-key callers are refused. A cross-tenant register
 *          reachable without the operator key is the whole customer list.
 * RULE A2  It returns ROWS, and the two households this suite creates are both
 *          in them — proving it crosses the tenant boundary on purpose, which
 *          is the one thing a tenant-scoped query could never do.
 * RULE A3  The counts are REAL: a household with two children reports two, and
 *          the number moves when a child is added. A console showing a
 *          plausible constant is worse than no console.
 * RULE A4  It carries NO personal detail beyond the owner's email — no child
 *          name, no date of birth. Asserted on the serialised body, so a field
 *          added carelessly later trips this.
 * RULE A5  Pagination is keyset and honest: `limit` is respected, `nextCursor`
 *          leads to DIFFERENT rows, and the two pages never repeat a family.
 * RULE A6  `limit` is bounded by the server, not by the caller's manners.
 * RULE A7  Search matches the owner's email, so an operator can find the
 *          household somebody just wrote to them about.
 */
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request = require('supertest');

import { AppModule } from '../../src/app.module';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { applyGlobalHttpPipeline } from '../../src/common/http/global-pipeline';
import { createTestPrismaService, integrationDatabaseUrl } from '../tenancy/prisma-test-client';

const P = '/api/v1';
const describeIfDb =
  integrationDatabaseUrl() && process.env.INTERNAL_ADMIN_API_KEY ? describe : describe.skip;

describeIfDb('the accounts console', () => {
  let app: INestApplication;
  let http: any;
  const key = process.env.INTERNAL_ADMIN_API_KEY as string;
  const stamp = Date.now();

  const households: { email: string; token: string }[] = [];

  async function makeHousehold(index: number, children: string[]) {
    const email = `accounts.probe.${stamp}.${index}@example.com`;
    const password = 'AccountsProbe-Passw0rd!23';
    const reg = await request(http).post(`${P}/auth/register`).send({
      email,
      password,
      fullName: `Accounts Probe ${index}`,
      familyName: `Accounts Probe Household ${index}`,
      acceptedTerms: true,
    });
    if (reg.status !== 201 && reg.status !== 200) {
      throw new Error(`register(${index}) failed: ${reg.status} ${JSON.stringify(reg.body)}`);
    }
    const login = await request(http).post(`${P}/auth/login`).send({ email, password });
    const token = login.body.tokens?.accessToken ?? login.body.accessToken;
    if (!token) throw new Error(`login(${index}) produced no token`);

    for (const firstName of children) {
      // The second child needs an entitlement this household does not have, so
      // only the first is created here — which is itself the state the console
      // has to report accurately.
      await request(http)
        .post(`${P}/children`)
        .set('authorization', `Bearer ${token}`)
        .send({ firstName, lastName: 'Probe', dateOfBirth: '2016-05-05', gender: 'unspecified' });
    }
    households.push({ email, token });
  }

  const listAs = (query: Record<string, string | number> = {}) =>
    request(http).get(`${P}/system/accounts`).query(query).set('x-internal-admin-key', key);

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue(createTestPrismaService())
      .compile();

    app = moduleRef.createNestApplication();
    applyGlobalHttpPipeline(app);
    await app.init();
    http = app.getHttpServer();

    await makeHousehold(1, ['Alpha']);
    await makeHousehold(2, ['Beta']);
  }, 180_000);

  afterAll(async () => {
    if (app) await app.close();
  });

  it('A1 — refuses an anonymous caller and a wrong key', async () => {
    const anon = await request(http).get(`${P}/system/accounts`);
    expect(anon.status).toBe(401);

    const wrong = await request(http)
      .get(`${P}/system/accounts`)
      .set('x-internal-admin-key', 'not-the-operator-key');
    expect(wrong.status).toBe(401);
  }, 60_000);

  it('A2 — returns rows spanning tenants: both households created here appear', async () => {
    const res = await listAs({ limit: 100 });
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.rows)).toBe(true);

    const emails = res.body.rows.map((row: any) => row.ownerEmail);
    for (const household of households) {
      expect(emails).toContain(household.email);
    }
  }, 60_000);

  it('A3 — the counts are measured, and they move', async () => {
    const before = await listAs({ search: households[0].email });
    expect(before.body.rows).toHaveLength(1);
    const row = before.body.rows[0];

    expect(row.memberCount).toBeGreaterThanOrEqual(1);
    expect(row.childCount).toBe(1);
    expect(row.ownerStatus).toEqual(expect.any(String));
    expect(row.familyId).toEqual(expect.any(String));

    // Grant the feature the paywall gates, add a second child, and the console
    // must report two. A count that never moves is a constant with a label.
    const granted = await request(http)
      .post(`${P}/system/billing/grants/features`)
      .set('x-internal-admin-key', key)
      .send({
        email: households[0].email,
        features: ['multiple_children'],
        planTier: 'PREMIUM',
        days: 3,
        reason: 'accounts console count probe',
      });
    expect(granted.status).toBe(200);

    const added = await request(http)
      .post(`${P}/children`)
      .set('authorization', `Bearer ${households[0].token}`)
      .send({ firstName: 'Gamma', lastName: 'Probe', dateOfBirth: '2019-01-01', gender: 'unspecified' });
    expect([200, 201]).toContain(added.status);

    const after = await listAs({ search: households[0].email });
    expect(after.body.rows[0].childCount).toBe(2);
    // ...and the live grant is visible, which is what makes the console usable
    // for deciding whether a comp is still running.
    expect(after.body.rows[0].hasLiveEntitlement).toBe(true);
  }, 120_000);

  it('A4 — carries no personal detail beyond the owner’s email', async () => {
    const res = await listAs({ search: households[0].email });
    const body = JSON.stringify(res.body);

    // The children created above are named; none of those names may be here.
    for (const forbidden of ['Alpha', 'Beta', 'Gamma', 'dateOfBirth', '2016-05-05', '2019-01-01']) {
      expect({ forbidden, present: body.includes(forbidden) }).toEqual({ forbidden, present: false });
    }
    // The exact key set, so a field added later has to be considered here.
    expect(Object.keys(res.body.rows[0]).sort()).toEqual(
      [
        'childCount',
        'countryCode',
        'createdAt',
        'deviceCount',
        'familyId',
        'familyName',
        'hasLiveEntitlement',
        'lastSeenAt',
        'memberCount',
        'ownerEmail',
        'ownerStatus',
        'planTier',
        'subscriptionStatus',
      ].sort(),
    );
  }, 60_000);

  it('A5 — keyset pagination returns different rows and never repeats a family', async () => {
    const first = await listAs({ limit: 1 });
    expect(first.body.rows).toHaveLength(1);
    expect(first.body.nextCursor).toEqual(expect.any(String));

    const second = await listAs({ limit: 1, cursor: first.body.nextCursor });
    expect(second.status).toBe(200);
    expect(second.body.rows).toHaveLength(1);
    expect(second.body.rows[0].familyId).not.toBe(first.body.rows[0].familyId);
  }, 60_000);

  it('A6 — the server bounds the page size, and a malformed cursor starts over', async () => {
    const tooBig = await listAs({ limit: 5000 });
    expect(tooBig.status).toBe(400);

    // A stale or mangled bookmark must not 500 — a console that breaks on a
    // bad cursor is a console people stop trusting.
    const garbage = await listAs({ limit: 2, cursor: 'not-a-cursor' });
    expect(garbage.status).toBe(200);
    expect(garbage.body.rows.length).toBeGreaterThan(0);
  }, 60_000);

  it('A7 — search finds a household by its owner’s email', async () => {
    const res = await listAs({ search: households[1].email });
    expect(res.status).toBe(200);
    expect(res.body.rows).toHaveLength(1);
    expect(res.body.rows[0].ownerEmail).toBe(households[1].email);
  }, 60_000);
});
