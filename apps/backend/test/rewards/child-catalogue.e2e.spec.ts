/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-var-requires */
/**
 * THE CHILD LEARNING CATALOGUE, PROVEN OVER REAL HTTP.
 *
 * `child-learning-catalogue.spec.ts` proves the projection and the route
 * metadata without a database. This suite proves the things only a running
 * server can prove, and it boots through `applyGlobalHttpPipeline` — THE SAME
 * FUNCTION `main.ts` CALLS — so every request below crosses the real `api/v1`
 * prefix, the real `forbidNonWhitelisted: true` pipe, the real guard chain and
 * the real `GlobalExceptionFilter`.
 *
 * WHAT IT ASSERTS:
 *   1. a DEVICE token reaches `/self/catalogue`; a PARENT token does not — and
 *      the mirror, that a device token cannot reach the parent's
 *      `/reward-programs/catalogue`.
 *   2. family B's device gets B's OWN child's view. The two families' children
 *      have deliberately different ages, so "the right child" is visible in the
 *      response's own numbers rather than inferred.
 *   3. NO `childId` in ANY request is honoured — not in a query string, not in
 *      a body, not in a header. The response is byte-identical to the clean
 *      call.
 *   4. the surface has NO mutating route: POST/PATCH/PUT/DELETE all fail.
 *   5. every label a child reads is Arabic, and no raw enum code stands where
 *      a label belongs.
 */
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request = require('supertest');

import { AppModule } from '../../src/app.module';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { applyGlobalHttpPipeline, API_GLOBAL_PREFIX } from '../../src/common/http/global-pipeline';
import { createTenantExtension } from '../../src/common/tenancy/tenant.extension';
import { runAsSystemAsync } from '../../src/common/tenancy/system-context';
import { runWithTenant } from '../../src/common/tenancy/tenant-context';
import { TokenService } from '../../src/modules/auth/application/services/token.service';
import { integrationDatabaseUrl } from '../tenancy/prisma-test-client';
import {
  suggestedDurationMinutesForAge,
  suggestedPointsForAge,
} from '../../src/modules/rewards-engine/domain/learning-catalogue';
import { PROGRAM_CATEGORIES } from '../../src/shared/rewards/program-taxonomy';

const describeIfDb = integrationDatabaseUrl() ? describe : describe.skip;
const V = `/${API_GLOBAL_PREFIX}`;
const ARABIC = /[؀-ۿ]/;

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

interface Tenant {
  familyId: string;
  userId: string;
  parentToken: string;
  childId: string;
  deviceToken: string;
  /** The age the fixture's date of birth produces today. */
  ageYears: number;
}

/** `yearsAgo(7)` -> an ISO date exactly seven years back, so the child's age is
 * that number on whatever day this suite runs. A hard-coded date of birth would
 * make these assertions expire. */
function yearsAgo(years: number): { iso: string; age: number } {
  const now = new Date();
  const dob = new Date(Date.UTC(now.getUTCFullYear() - years, now.getUTCMonth(), now.getUTCDate()));
  // Step one day back so a timezone shift cannot land the birthday tomorrow.
  dob.setUTCDate(dob.getUTCDate() - 1);
  return { iso: dob.toISOString().slice(0, 10), age: years };
}

describeIfDb('the child learning catalogue over the real deployed HTTP pipeline', () => {
  let app: INestApplication;
  let http: any;
  let prisma: any;
  let tokens: TokenService;

  const stamp = Date.now();
  // Two ages in DIFFERENT bands of the server's own suggestion table, so
  // "family B saw its own child" is provable from the numbers in the body.
  const A = { ageYears: 7 } as Tenant;
  const B = { ageYears: 14 } as Tenant;

  const sys = (what: string, fn: () => Promise<any>): Promise<any> =>
    runAsSystemAsync('TEST_FIXTURE', `child-catalogue suite: ${what}`, async () => await fn());

  async function registerTenant(label: string, t: Tenant): Promise<void> {
    const email = `catalogue.${label}.${stamp}@example.com`;
    const password = 'Catalogue-Contract-Passw0rd!23';

    const reg = await request(http).post(`${V}/auth/register`).send({
      email,
      password,
      fullName: `Catalogue Parent ${label}`,
      familyName: `Catalogue Family ${label}`,
      acceptedTerms: true,
    });
    if (![200, 201].includes(reg.status)) {
      throw new Error(`register -> ${reg.status} ${JSON.stringify(reg.body)}`);
    }

    const login = await request(http).post(`${V}/auth/login`).send({ email, password });
    t.parentToken = login.body.tokens?.accessToken ?? login.body.accessToken;
    const claims = JSON.parse(Buffer.from(t.parentToken.split('.')[1], 'base64').toString());
    t.familyId = claims.familyId;
    t.userId = claims.sub;

    const dob = yearsAgo(t.ageYears);
    const child = await request(http)
      .post(`${V}/children`)
      .set({ Authorization: `Bearer ${t.parentToken}` })
      .send({ firstName: `Catalogue Kid ${label}`, dateOfBirth: dob.iso });
    if (![200, 201].includes(child.status)) {
      throw new Error(`create child -> ${child.status} ${JSON.stringify(child.body)}`);
    }
    t.childId = child.body.id;

    const device = await sys('seed device', () =>
      prisma.device.create({
        data: {
          familyId: t.familyId,
          ownerType: 'CHILD',
          childId: t.childId,
          platform: 'ANDROID',
          status: 'ACTIVE',
          pairedAt: new Date(),
        },
        select: { id: true },
      }),
    );
    const pair = await runWithTenant(
      { familyId: t.familyId, actorType: 'DEVICE', actorId: device.id },
      () => tokens.issueTokenPair({ subjectId: device.id, actorType: 'DEVICE', familyId: t.familyId }),
    );
    t.deviceToken = pair.accessToken;
  }

  const asParent = (t: Tenant) => ({ Authorization: `Bearer ${t.parentToken}` });
  const asChild = (t: Tenant) => ({ Authorization: `Bearer ${t.deviceToken}` });

  beforeAll(async () => {
    // The throttler counters live in the REAL Redis and are IP-keyed for
    // `/auth/register` (5 per minute). Every e2e suite in this repository
    // registers tenants from 127.0.0.1, so under `--runInBand` a later suite
    // would 429 on a FIXTURE and fail for a reason unrelated to what it tests.
    // `b5-mobile-contract.e2e.spec.ts` uses the same block, for the same
    // reason.
    {
      const Redis = require('ioredis');
      const client = new Redis(process.env.REDIS_URL as string);
      const keys = await client.keys('throttle:*');
      if (keys.length > 0) await client.del(...keys);
      await client.quit();
    }

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useFactory({ factory: offlinePrismaService })
      .compile();

    app = moduleRef.createNestApplication();
    applyGlobalHttpPipeline(app);
    await app.init();

    http = app.getHttpServer();
    prisma = app.get(PrismaService);
    tokens = app.get(TokenService);

    await registerTenant('a', A);
    await registerTenant('b', B);
  }, 180000);

  afterAll(async () => {
    if (app) await app.close();
  });

  // =========================================================================
  // 1. WHO CAN REACH IT
  // =========================================================================

  describe('the guard is the boundary, not a role check someone can forget', () => {
    it('a DEVICE token reaches the catalogue', async () => {
      const res = await request(http).get(`${V}/self/catalogue`).set(asChild(A));
      expect(res.status).toBe(200);
      expect(res.body.domains.length).toBe(PROGRAM_CATEGORIES.length);
      expect(res.body.totals.activities).toBeGreaterThan(0);
    });

    it('a DEVICE token reaches the domains-only route', async () => {
      const res = await request(http).get(`${V}/self/catalogue/domains`).set(asChild(A));
      expect(res.status).toBe(200);
      expect(res.body.domains.length).toBe(PROGRAM_CATEGORIES.length);
      for (const domain of res.body.domains) expect(domain.items).toBeUndefined();
    });

    it('a PARENT token does NOT reach the catalogue — two Passport strategies, not a role flag', async () => {
      for (const path of ['/self/catalogue', '/self/catalogue/domains']) {
        const res = await request(http).get(`${V}${path}`).set(asParent(A));
        expect([401, 403]).toContain(res.status);
      }
    });

    it('an unauthenticated call does not reach it either', async () => {
      const res = await request(http).get(`${V}/self/catalogue`);
      expect([401, 403]).toContain(res.status);
    });

    it('THE MIRROR: a DEVICE token does NOT reach the PARENT catalogue', async () => {
      const res = await request(http).get(`${V}/reward-programs/catalogue`).set(asChild(A));
      expect([401, 403]).toContain(res.status);

      // …and the parent's own catalogue still works, so the assertion above is
      // about the token and not about a broken route.
      const parent = await request(http).get(`${V}/reward-programs/catalogue`).set(asParent(A));
      expect(parent.status).toBe(200);
      expect(parent.body.categories.length).toBe(PROGRAM_CATEGORIES.length);
    });
  });

  // =========================================================================
  // 2. EACH DEVICE SEES ITS OWN CHILD
  // =========================================================================

  describe('the childId comes from the device, never from the request', () => {
    it("family B's device gets B's OWN child's view — the ages differ, and so do the numbers", async () => {
      const a = await request(http).get(`${V}/self/catalogue`).set(asChild(A));
      const b = await request(http).get(`${V}/self/catalogue`).set(asChild(B));

      expect(a.status).toBe(200);
      expect(b.status).toBe(200);
      expect(a.body.child.ageYears).toBe(A.ageYears);
      expect(b.body.child.ageYears).toBe(B.ageYears);
      expect(a.body.child.ageBand).not.toBe(b.body.child.ageBand);

      const firstItem = (body: any) => body.domains[0].items[0];
      expect(firstItem(a.body).reward.suggestedAmount).toBe(suggestedPointsForAge(A.ageYears));
      expect(firstItem(b.body).reward.suggestedAmount).toBe(suggestedPointsForAge(B.ageYears));
      expect(firstItem(a.body).estimatedDurationMinutes).toBe(
        suggestedDurationMinutesForAge(A.ageYears),
      );
      expect(firstItem(b.body).estimatedDurationMinutes).toBe(
        suggestedDurationMinutesForAge(B.ageYears),
      );
      // The two views are genuinely different, so "B got its own" is not
      // trivially true because both are the same document.
      expect(JSON.stringify(a.body)).not.toEqual(JSON.stringify(b.body));

      // Neither response carries the other family's identifiers, or any
      // identifier at all — the catalogue is reference data, not rows.
      for (const res of [a, b]) {
        const raw = JSON.stringify(res.body);
        expect(raw).not.toContain(A.childId);
        expect(raw).not.toContain(B.childId);
        expect(raw).not.toContain(A.familyId);
        expect(raw).not.toContain(B.familyId);
      }
    });

    it('NO childId in ANY request is honoured — query, body or header', async () => {
      const clean = await request(http).get(`${V}/self/catalogue`).set(asChild(A));
      expect(clean.status).toBe(200);

      // THUNKS, awaited one at a time. Supertest lazily binds the server on
      // the first request; five built up front and fired together race on that
      // bind and fail with ECONNREFUSED for a reason that has nothing to do
      // with what is being asserted.
      const attempts: Array<() => request.Test> = [
        () => request(http).get(`${V}/self/catalogue?childId=${B.childId}`).set(asChild(A)),
        () => request(http).get(`${V}/self/catalogue`).set(asChild(A)).query({ childId: B.childId }),
        () => request(http).get(`${V}/self/catalogue`).set(asChild(A)).send({ childId: B.childId }),
        () =>
          request(http)
            .get(`${V}/self/catalogue`)
            .set({ ...asChild(A), 'x-child-id': B.childId }),
        () =>
          request(http)
            .get(`${V}/self/catalogue?childId=${B.childId}&familyId=${B.familyId}&ageYears=17`)
            .set(asChild(A)),
      ];

      for (const attempt of attempts) {
        const res = await attempt();
        expect(res.status).toBe(200);
        // BYTE-IDENTICAL to the clean call. Not "does not leak B" — the value
        // was never read at all, so there is nothing for it to have changed.
        expect(JSON.stringify(res.body)).toEqual(JSON.stringify(clean.body));
        expect(res.body.child.ageYears).toBe(A.ageYears);
      }
    });

    it('a request cannot raise its own points, weaken verification or lift a quota', async () => {
      const clean = await request(http).get(`${V}/self/catalogue`).set(asChild(A));

      const res = await request(http)
        .get(
          `${V}/self/catalogue?points=9999&maxPerDay=50&requiresParentApproval=false` +
            `&verificationLevel=SELF_CHECK&streakMultiplierBps=999999&difficulty=EASY`,
        )
        .set(asChild(A))
        .send({
          points: 9999,
          reward: { type: 'POINTS', amount: 9999 },
          verificationLevel: 'SELF_CHECK',
          requiresParentApproval: false,
          maxPerDay: 50,
        });

      expect(res.status).toBe(200);
      expect(JSON.stringify(res.body)).toEqual(JSON.stringify(clean.body));

      const items = res.body.domains.flatMap((d: any) => d.items);
      for (const item of items) {
        expect(item.reward.suggestedAmount).toBe(suggestedPointsForAge(A.ageYears));
        expect(item.limits.maxPerDay).toBe(1);
        expect(item.limits.streakMultiplierMaxBps).toBe(30000);
        expect(item.verification.method).not.toBe('SELF_CHECK');
      }
      // Every Quran item still says a parent decides.
      const quran = items.filter((i: any) => i.domainCode === 'QURAN');
      expect(quran.length).toBeGreaterThan(0);
      for (const item of quran) expect(item.requiresParentApproval).toBe(true);
    });
  });

  // =========================================================================
  // 3. NO MUTATING ROUTE
  // =========================================================================

  describe('the surface is read-only over HTTP as well as in metadata', () => {
    it('POST, PATCH, PUT and DELETE do not exist on any catalogue path', async () => {
      const paths = ['/self/catalogue', '/self/catalogue/domains', '/self/catalogue/QURAN'];
      const observed: Array<{ call: string; status: number }> = [];

      for (const path of paths) {
        for (const verb of ['post', 'patch', 'put', 'delete'] as const) {
          const res = await (request(http) as any)
            [verb](`${V}${path}`)
            .set(asChild(A))
            .send({ points: 9999, verificationLevel: 'SELF_CHECK', maxPerDay: 50 });
          observed.push({ call: `${verb.toUpperCase()} ${path}`, status: res.status });
        }
      }

      // 404 (no such route) or 405 (method not allowed). NEVER a 2xx, and
      // never a 400 either — a 400 would mean a handler with a body ran and
      // VALIDATED it, i.e. a write surface exists here. Collecting first and
      // asserting once means a failure names every offending call rather than
      // stopping at the first.
      expect(observed.length).toBe(paths.length * 4);
      expect(observed.filter((o) => ![404, 405].includes(o.status))).toEqual([]);
    });
  });

  // =========================================================================
  // 4. ARABIC, AND NOTHING HIDDEN
  // =========================================================================

  describe('what the child actually reads', () => {
    it('every label is Arabic and no raw enum code stands where a label belongs', async () => {
      const res = await request(http).get(`${V}/self/catalogue`).set(asChild(A));
      expect(res.status).toBe(200);

      const walk = (node: any, path: string, out: Array<[string, unknown]>): void => {
        if (Array.isArray(node)) return node.forEach((v, i) => walk(v, `${path}[${i}]`, out));
        if (node && typeof node === 'object') {
          for (const [key, value] of Object.entries(node)) {
            if (key.endsWith('Ar')) out.push([`${path}.${key}`, value]);
            walk(value, `${path}.${key}`, out);
          }
        }
      };
      const labels: Array<[string, unknown]> = [];
      walk(res.body, '$', labels);
      expect(labels.length).toBeGreaterThan(100);
      for (const [path, value] of labels) {
        expect({ path, ok: typeof value === 'string' && ARABIC.test(value) }).toEqual({
          path,
          ok: true,
        });
      }
    });

    it('a seven-year-old is shown PROGRAMMING — dimmed, never hidden, never locked', async () => {
      const res = await request(http).get(`${V}/self/catalogue`).set(asChild(A));
      const programming = res.body.domains.find((d: any) => d.code === 'PROGRAMMING');
      expect(programming).toBeDefined();
      expect(programming.items.length).toBeGreaterThan(0);
      expect(programming.suitability.hidden).toBe(false);
      expect(programming.suitability.suggestedAtThisAge).toBe(false);
      expect(programming.suitability.noteAr).toMatch(ARABIC);

      // …and the fourteen-year-old sees it as suggested. Same surface, same
      // item set, different annotation.
      const older = await request(http).get(`${V}/self/catalogue`).set(asChild(B));
      const olderProgramming = older.body.domains.find((d: any) => d.code === 'PROGRAMMING');
      expect(olderProgramming.suitability.suggestedAtThisAge).toBe(true);
      expect(olderProgramming.items.length).toBe(programming.items.length);
      expect(older.body.totals.activities).toBe(res.body.totals.activities);
    });

    it('the fields with no source in the repository arrive explicitly absent, not invented', async () => {
      const res = await request(http).get(`${V}/self/catalogue`).set(asChild(A));
      for (const item of res.body.domains.flatMap((d: any) => d.items)) {
        expect(item.ageRange.recommendedMinAge).toBeNull();
        expect(item.ageRange.recommendedMaxAge).toBeNull();
        expect(item.reward.range).toBeNull();
        expect(item.ageRange.noteAr).toMatch(ARABIC);
        expect(item.reward.rangeNoteAr).toMatch(ARABIC);
      }
    });
  });
});
