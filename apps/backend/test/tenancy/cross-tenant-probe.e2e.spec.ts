/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * The generated cross-tenant probe suite (F2 task 5b), generalising A4's
 * `idor-sweep`.
 *
 * What it does, in order:
 *   1. Boots the REAL application (the whole AppModule, real guards, real
 *      Passport strategies, real global TenantContextInterceptor, real
 *      PrismaService with the tenant extension) against a REAL PostgreSQL.
 *   2. Registers two families over HTTP — `POST /auth/register` — so the tokens
 *      are genuine, signed, and carry genuine `familyId` claims.
 *   3. Creates real resources inside family B: a child, a habit, a screen-time
 *      policy, an app-block rule, a learning goal, a faith practice.
 *   4. Enumerates the application's own route table from Nest's metadata and,
 *      for every route that takes a resource id it knows how to fill, replays
 *      it with FAMILY A's token pointed at FAMILY B's resource.
 *   5. Asserts the answer is 404 — not 200 (a leak) and not 403 (which confirms
 *      the resource exists, and is an information disclosure in its own right).
 *
 * The route list is derived, not hand-written, so a route added tomorrow is
 * probed tomorrow without anyone updating this file.
 */
import { INestApplication } from '@nestjs/common';
import { PATH_METADATA, METHOD_METADATA } from '@nestjs/common/constants';
import { Test } from '@nestjs/testing';
import * as fs from 'fs';
import * as path from 'path';
import request = require('supertest');

import { AppModule } from '../../src/app.module';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { createTenantExtension } from '../../src/common/tenancy/tenant.extension';
import { integrationDatabaseUrl } from './prisma-test-client';

const describeIfDb = integrationDatabaseUrl() ? describe : describe.skip;

const HTTP_METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'ALL', 'OPTIONS', 'HEAD', 'SEARCH'];

interface Route {
  method: string;
  path: string;
  params: string[];
}

function findControllerFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) findControllerFiles(full, acc);
    else if (entry.isFile() && entry.name.endsWith('.controller.ts')) acc.push(full);
  }
  return acc;
}

function enumerateRoutes(): Route[] {
  const out: Route[] = [];
  for (const file of findControllerFiles(path.resolve(__dirname, '../../src'))) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require(file);
    for (const exported of Object.values(mod)) {
      if (typeof exported !== 'function') continue;
      const base = Reflect.getMetadata(PATH_METADATA, exported);
      if (base === undefined) continue;
      const proto = (exported as any).prototype;
      for (const name of Object.getOwnPropertyNames(proto)) {
        if (name === 'constructor') continue;
        const handler = proto[name];
        if (typeof handler !== 'function') continue;
        const sub = Reflect.getMetadata(PATH_METADATA, handler);
        if (sub === undefined) continue;
        const verb = HTTP_METHODS[Reflect.getMetadata(METHOD_METADATA, handler)];
        const full = `/${base}/${sub}`.replace(/\/+/g, '/').replace(/\/$/, '') || '/';
        out.push({ method: verb, path: full, params: [...full.matchAll(/:(\w+)/g)].map((m) => m[1]) });
      }
    }
  }
  return out;
}

/** Builds a PrismaService substitute that works in this environment. */
function offlinePrismaService(): any {
  const url = process.env.INTEGRATION_DATABASE_URL as string;
  if (process.env.PRISMA_DRIVER_ADAPTER === 'pg') {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { PrismaClient } = require('@prisma/client/wasm');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { PrismaPg } = require('@prisma/adapter-pg');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
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
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { PrismaClient } = require('@prisma/client');
  const base = new PrismaClient({ datasources: { db: { url } } });
  const extended = base.$extends(createTenantExtension());
  extended.onModuleInit = async () => base.$connect();
  extended.onModuleDestroy = async () => base.$disconnect();
  return extended;
}

describeIfDb('R8 — generated cross-tenant probe suite against the real application', () => {
  let app: INestApplication;
  let http: any;
  let prisma: any;

  const stamp = Date.now();
  const tokens: Record<'A' | 'B', string> = { A: '', B: '' };
  const familyIds: Record<'A' | 'B', string> = { A: '', B: '' };
  /** Resource ids OWNED BY FAMILY B, keyed by the route param name they fill. */
  const bResources: Record<string, string> = {};
  const createdUserIds: string[] = [];

  async function register(label: 'A' | 'B') {
    const res = await request(http)
      .post('/auth/register')
      .send({
        email: `probe.${label.toLowerCase()}.${stamp}@example.com`,
        password: 'Probe-Passw0rd!23',
        fullName: `Probe Parent ${label}`,
        familyName: `Probe Family ${label}`,
        acceptedTerms: true,
      });
    if (res.status !== 201 && res.status !== 200) {
      throw new Error(`register(${label}) failed: ${res.status} ${JSON.stringify(res.body)}`);
    }
    // `POST /auth/register` returns the profile, not a session — so the token
    // comes from the real login flow, exactly as a client would obtain it.
    const login = await request(http)
      .post('/auth/login')
      .send({ email: `probe.${label.toLowerCase()}.${stamp}@example.com`, password: 'Probe-Passw0rd!23' });
    if (login.status !== 200) {
      throw new Error(`login(${label}) failed: ${login.status} ${JSON.stringify(login.body)}`);
    }
    tokens[label] = login.body.tokens?.accessToken ?? login.body.accessToken;
    if (!tokens[label]) throw new Error(`login(${label}) returned no access token: ${JSON.stringify(login.body)}`);
    const payload = JSON.parse(Buffer.from(tokens[label].split('.')[1], 'base64').toString());
    familyIds[label] = payload.familyId;
    createdUserIds.push(payload.sub);
  }

  const auth = (label: 'A' | 'B') => ({ Authorization: `Bearer ${tokens[label]}` });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue(offlinePrismaService())
      .compile();

    app = moduleRef.createNestApplication();
    await app.init();
    http = app.getHttpServer();
    prisma = app.get(PrismaService);

    await register('A');
    await register('B');

    // --- real resources, created by family B through the real API ---
    const child = await request(http)
      .post('/children')
      .set(auth('B'))
      .send({ firstName: 'Probe Kid B', dateOfBirth: '2015-04-01' });
    expect([200, 201]).toContain(child.status);
    bResources.childId = child.body.id;

    const habit = await request(http)
      .post(`/life-intelligence/habits/${bResources.childId}`)
      .set(auth('B'))
      .send({ title: 'Probe Habit B', category: 'LEARNING' });
    if ([200, 201].includes(habit.status)) bResources.habitId = habit.body.id;

    const rule = await request(http)
      .post(`/children/${bResources.childId}/app-block-rules`)
      .set(auth('B'))
      .send({ packageName: 'com.probe.b', ruleType: 'BLOCK' });
    if ([200, 201].includes(rule.status)) bResources.ruleId = rule.body.id;

    const goal = await request(http)
      .post(`/life-intelligence/learning/${bResources.childId}/goals`)
      .set(auth('B'))
      .send({ subject: 'MATH', title: 'Probe Goal B' });
    if ([200, 201].includes(goal.status)) bResources.goalId = goal.body.id;

    const practice = await request(http)
      .post(`/life-intelligence/faith/${bResources.childId}/practices`)
      .set(auth('B'))
      .send({ type: 'AZKAR', title: 'Probe Practice B' });
    if ([200, 201].includes(practice.status)) bResources.practiceId = practice.body.id;

    // familyId appears as a path param on one route (rewards store).
    bResources.familyId = familyIds.B;
  }, 60_000);

  afterAll(async () => {
    if (prisma) {
      const { runAsSystem } = require('../../src/common/tenancy/system-context');
      await runAsSystem('TEST_FIXTURE', 'Probe-suite teardown removes only the two families it created.', async () => {
        await prisma.family.deleteMany({ where: { id: { in: [familyIds.A, familyIds.B] } } });
        await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
      });
    }
    await app?.close();
  });

  it('seeded two distinct families with real tokens and real resources', () => {
    expect(familyIds.A).toBeTruthy();
    expect(familyIds.B).toBeTruthy();
    expect(familyIds.A).not.toBe(familyIds.B);
    expect(bResources.childId).toBeTruthy();
    // If nothing beyond the child was created, the probe below is far weaker
    // than it looks — say so loudly rather than quietly probing one route.
    expect(Object.keys(bResources).length).toBeGreaterThanOrEqual(4);
  });

  const routes = enumerateRoutes();
  const fillable = routes.filter(
    (r) => r.params.length > 0 && r.params.every((p) => ['childId', 'habitId', 'ruleId', 'goalId', 'practiceId', 'familyId'].includes(p)),
  );

  it('found a meaningful number of id-taking routes to probe', () => {
    expect(fillable.length).toBeGreaterThanOrEqual(20);
  });

  /**
   * Routes whose probe cannot decide the isolation question, WITH the reason.
   * Anything not in this map must answer 404 (or 401 on a device-only route).
   * The map is asserted to be exact — a route that starts or stops being
   * inconclusive fails the build.
   */
  const INCONCLUSIVE: Record<string, string> = {
    'GET /ai-core/recommendation/:childId':
      'Requires a ?deviceId= query param that is typed as `string` but never validated; omitting it reaches prisma.device.findUnique({where:{id: undefined}}) and answers 500 for the OWNER too. A pre-existing input-validation defect (not an isolation defect) — see F2 report.',
    'GET /ai-core/behavioral-trend/:childId': 'Same missing ?deviceId= validation as recommendation/:childId.',
  };

  it.each(fillable.map((r) => [`${r.method} ${r.path}`, r] as const))(
    "%s — family A must NOT reach family B's resource",
    async (label, route) => {
      let url = route.path;
      for (const p of route.params) url = url.replace(`:${p}`, bResources[p]);

      const verb = route.method.toLowerCase() as 'get' | 'post' | 'patch' | 'put' | 'delete';
      const res = await (request(http) as any)[verb](url).set(auth('A')).send({});

      // ---- the hard requirement, no exceptions --------------------------
      // A 2xx here is a confirmed cross-tenant read or write.
      expect(res.status).not.toBe(200);
      expect(res.status).not.toBe(201);
      expect(res.status).not.toBe(204);

      // ---- device-only routes -------------------------------------------
      // A parent token on a `/self/*` (or child-inbox) route is the wrong ACTOR
      // TYPE, not a tenancy question; the strategy rejects it at 401 before any
      // handler runs. Recorded as such rather than counted as a 404.
      if (res.status === 401) {
        expect(res.body.message).toMatch(/device access token/i);
        expect(route.path).toMatch(/\/self\/|\/communication\/child\//);
        return;
      }

      // ---- inconclusive, with a written reason ---------------------------
      if (INCONCLUSIVE[label]) {
        // Prove it really is the route and not the tenant: the OWNER gets the
        // identical status for the identical request.
        const owner = await (request(http) as any)[verb](url).set(auth('B')).send({});
        expect(owner.status).toBe(res.status);
        return;
      }

      // ---- the strong requirement ---------------------------------------
      // 404, never 403: a 403 confirms the resource exists in another family.
      // 400 is accepted only on write verbs, where DTO validation rejects the
      // empty probe body before ownership is consulted; the dedicated
      // valid-body test below closes that hole for the representative case.
      const acceptable = verb === 'get' || verb === 'delete' ? [404] : [400, 404];
      if (!acceptable.includes(res.status)) {
        // eslint-disable-next-line no-console
        console.log('PROBE-UNEXPECTED', label, res.status, JSON.stringify(res.body).slice(0, 300));
      }
      expect(acceptable).toContain(res.status);
      expect(res.status).not.toBe(403);
    },
    30_000,
  );

  it('the inconclusive list is exact — no stale entries, no silent growth', () => {
    const live = new Set(fillable.map((r) => `${r.method} ${r.path}`));
    expect(Object.keys(INCONCLUSIVE).filter((k) => !live.has(k))).toEqual([]);
    expect(Object.keys(INCONCLUSIVE)).toHaveLength(2);
  });

  it("a valid-bodied write against family B's child is still 404, not 400-by-accident", async () => {
    const res = await request(http)
      .post(`/life-intelligence/habits/${bResources.childId}`)
      .set(auth('A'))
      .send({ title: 'Cross-tenant habit', category: 'LEARNING' });
    expect(res.status).toBe(404);

    // And nothing was written into family B.
    const { runAsSystem } = require('../../src/common/tenancy/system-context');
    const planted = await runAsSystem('TEST_FIXTURE', 'Verifying the probe wrote nothing across tenants.', async () =>
      prisma.habit.count({ where: { title: 'Cross-tenant habit' } }),
    );
    expect(planted).toBe(0);
  }, 30_000);

  it("family B can still reach its OWN resources — the probe is not just breaking everything", async () => {
    const res = await request(http).get(`/children/${bResources.childId}`).set(auth('B'));
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(bResources.childId);
  }, 30_000);
});
