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
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { Role } from '../../src/common/authz/principal-role';
import { ROLES_METADATA } from '../../src/common/authz/roles.decorator';
import { PasswordService } from '../../src/modules/auth/application/services/password.service';
import { TokenService } from '../../src/modules/auth/application/services/token.service';
import { createTenantExtension } from '../../src/common/tenancy/tenant.extension';
import { runAsSystemAsync } from '../../src/common/tenancy/system-context';
import { runWithTenant } from '../../src/common/tenancy/tenant-context';
import { integrationDatabaseUrl } from './prisma-test-client';

const describeIfDb = integrationDatabaseUrl() ? describe : describe.skip;

const HTTP_METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'ALL', 'OPTIONS', 'HEAD', 'SEARCH'];

/**
 * PHASE C. The `/auth/register` throttle counter lives in the REAL Redis and is
 * IP-keyed, so every e2e suite in one `--runInBand` run draws on ONE budget from
 * 127.0.0.1. A suite that consumes without returning makes whichever suite runs
 * after it fail with a 429 that has nothing to do with what it asserts — and
 * this file registers two families. Cleared on the way in and on the way out.
 */
async function clearThrottleCounters(): Promise<void> {
  const Redis = require('ioredis');
  const client = new Redis(process.env.REDIS_URL as string);
  const keys = await client.keys('throttle:*');
  if (keys.length > 0) await client.del(...keys);
  await client.quit();
}

interface Route {
  method: string;
  path: string;
  params: string[];
  /** PHASE C: the roles the route declares, and the guards it carries. */
  roles: string[] | undefined;
  guardNames: string[];
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
        const classGuards: any[] = Reflect.getMetadata(GUARDS_METADATA, exported) ?? [];
        const methodGuards: any[] = Reflect.getMetadata(GUARDS_METADATA, handler) ?? [];
        out.push({
          method: verb,
          path: full,
          params: [...full.matchAll(/:(\w+)/g)].map((m) => m[1]),
          roles:
            (Reflect.getMetadata(ROLES_METADATA, handler) as string[] | undefined) ??
            (Reflect.getMetadata(ROLES_METADATA, exported) as string[] | undefined),
          guardNames: [...classGuards, ...methodGuards].map((g) => g?.name ?? String(g)),
        });
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
  /**
   * PHASE C. Two more principals INSIDE family B, so the same generated route
   * table can be replayed across ROLES and not only across TENANTS:
   *   - `bChildToken`: a genuine paired-device (CHILD) access token;
   *   - `bCoParentToken`: a genuine co-parent (PARENT) access token.
   * Both are minted by the application's own TokenService — the same call the
   * pairing and login paths make — rather than obtained over HTTP, because the
   * `/auth/*` throttle budget is shared across every e2e suite in one run and
   * this suite must not spend more of it than the isolation probe needs.
   */
  let bChildToken = '';
  let bCoParentToken = '';
  let bCoParentUserId = '';

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
    await clearThrottleCounters();

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

    // --- PHASE C: a CHILD device and a co-parent PARENT, both in family B ---
    const sys = (what: string, fn: () => Promise<any>): Promise<any> =>
      runAsSystemAsync('TEST_FIXTURE', `cross-role probe fixture: ${what}`, async () => await fn());
    const tokenService = app.get(TokenService);

    const device = await sys('seed device for B', () =>
      prisma.device.create({
        data: {
          familyId: familyIds.B,
          ownerType: 'CHILD',
          childId: bResources.childId,
          platform: 'ANDROID',
          status: 'ACTIVE',
          pairedAt: new Date(),
        },
        select: { id: true },
      }),
    );
    bChildToken = (
      await runWithTenant(
        { familyId: familyIds.B, actorType: 'DEVICE', actorId: device.id },
        () =>
          tokenService.issueTokenPair({
            subjectId: device.id,
            actorType: 'DEVICE',
            familyId: familyIds.B,
          }),
      )
    ).accessToken;

    const coParent = await sys('seed co-parent for B', async () =>
      prisma.user.create({
        data: {
          email: `probe.coparent.${stamp}@example.com`,
          passwordHash: await app.get(PasswordService).hash('Probe-CoParent-Passw0rd!23'),
          fullName: 'Probe Co-Parent B',
          termsAcceptedAt: new Date(),
          termsVersion: 'v1-placeholder',
        },
        select: { id: true },
      }),
    );
    bCoParentUserId = coParent.id;
    createdUserIds.push(coParent.id);
    await sys('seed co-parent membership', () =>
      prisma.familyMember.create({
        data: { familyId: familyIds.B, userId: coParent.id, role: 'PARENT' },
      }),
    );
    bCoParentToken = (
      await runWithTenant(
        { familyId: familyIds.B, actorType: 'USER', actorId: coParent.id },
        () =>
          tokenService.issueTokenPair({
            subjectId: coParent.id,
            actorType: 'USER',
            familyId: familyIds.B,
            familyRole: 'PARENT',
          }),
      )
    ).accessToken;
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
    await clearThrottleCounters();
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

  // =========================================================================
  // PHASE C / P3 — THE CROSS-ROLE SWEEP
  //
  // The tenant probe above replays the route table across FAMILIES. A4 §SA-005
  // showed the second axis was wide open: inside ONE family, every principal
  // had every permission. This replays the SAME derived route table across
  // ROLES, in the direction that is safe to execute — every call below is one
  // the system must REFUSE, so nothing is written and no fixture is mutated by
  // sweeping.
  //
  // Generated, not hand-written: a route added tomorrow is swept tomorrow.
  // =========================================================================

  const FILLER_UUID = '00000000-0000-4000-8000-000000000000';
  const fillParams = (route: Route): string => {
    let url = route.path;
    for (const p of route.params) url = url.replace(`:${p}`, bResources[p] ?? FILLER_UUID);
    return url;
  };
  const send = (route: Route, url: string, token: string) => {
    const verb = route.method.toLowerCase() as 'get' | 'post' | 'patch' | 'put' | 'delete';
    return (request(http) as any)[verb](url).set({ Authorization: `Bearer ${token}` }).send({});
  };

  /** Every route the CHILD surface does NOT include, and that is not public. */
  const notChildRoutes = routes.filter(
    (r) => (r.roles ?? []).length > 0 && !(r.roles ?? []).includes(Role.CHILD),
  );

  it('the cross-role sweep has a meaningful number of routes to probe', () => {
    expect(notChildRoutes.length).toBeGreaterThanOrEqual(140);
    expect(routes.filter((r) => (r.roles ?? []).includes(Role.CHILD)).length).toBeGreaterThanOrEqual(30);
  });

  it.each(notChildRoutes.map((r) => [`${r.method} ${r.path}`, r] as const))(
    "%s — a CHILD's device token must NOT reach it",
    async (_label, route) => {
      const res = await send(route, fillParams(route), bChildToken);
      // Not 2xx is the whole requirement. The status will be 401 on the parent
      // surface (the `jwt` strategy rejects a `device-jwt` actor before any
      // handler runs) and 404 on the platform surface; both are refusals, and
      // asserting the exact one would be asserting an implementation detail of
      // Passport rather than the security property.
      expect([200, 201, 202, 204]).not.toContain(res.status);
      expect(res.status).toBeGreaterThanOrEqual(400);
    },
    30_000,
  );

  /** Routes reserved for the family OWNER. Derived, so the list cannot drift. */
  const ownerOnlyRoutes = routes.filter(
    (r) => JSON.stringify(r.roles) === JSON.stringify([Role.OWNER]),
  );

  it('the OWNER-only surface is non-empty — otherwise the sweep below is vacuous', () => {
    expect(ownerOnlyRoutes.length).toBeGreaterThanOrEqual(5);
  });

  it.each(ownerOnlyRoutes.map((r) => [`${r.method} ${r.path}`, r] as const))(
    '%s — a CO-PARENT (PARENT) must be refused with 403 ROLE_NOT_PERMITTED',
    async (_label, route) => {
      const res = await send(route, fillParams(route), bCoParentToken);
      expect(res.status).toBe(403);
      // 403 and not 404 here is deliberate and argued in `authz.errors.ts`: the
      // caller is a PROVEN member of this tenant, so there is no existence to
      // conceal — only a permission to report, with a code the app can branch
      // on. The guard also runs BEFORE the ValidationPipe, which is why an
      // empty body does not turn this into a 400.
      expect(res.body.code).toBe('ROLE_NOT_PERMITTED');
      expect(res.body.requiredRoles).toEqual([Role.OWNER]);
      expect(res.body.heldRole).toBe(Role.PARENT);
    },
    30_000,
  );

  it('the co-parent is NOT locked out of the ordinary parenting surface', () => {
    // Without this the sweep above would pass just as well if PARENT had been
    // denied everything, which would be a different bug wearing the same green.
    return request(http)
      .get('/children')
      .set({ Authorization: `Bearer ${bCoParentToken}` })
      .expect(200)
      .then((res: any) => {
        expect(Array.isArray(res.body)).toBe(true);
        expect(res.body.map((c: any) => c.id)).toContain(bResources.childId);
      });
  }, 30_000);

  it("a co-parent still cannot reach family A — role and tenant are independent locks", async () => {
    expect(bCoParentUserId).toBeTruthy();
    const res = await request(http)
      .get('/children')
      .set({ Authorization: `Bearer ${bCoParentToken}` });
    expect(res.status).toBe(200);
    // Family A's child must not appear in family B's co-parent's list.
    const aChild = await request(http)
      .post('/children')
      .set(auth('A'))
      .send({ firstName: 'Probe Kid A', dateOfBirth: '2016-02-02' });
    expect([200, 201]).toContain(aChild.status);
    const again = await request(http)
      .get('/children')
      .set({ Authorization: `Bearer ${bCoParentToken}` });
    expect(again.body.map((c: any) => c.id)).not.toContain(aChild.body.id);
  }, 30_000);
});
