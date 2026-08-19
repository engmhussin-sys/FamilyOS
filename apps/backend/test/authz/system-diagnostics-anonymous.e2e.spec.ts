/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-var-requires */
/**
 * ============================================================================
 * THE SYSTEM DIAGNOSTICS SURFACE IS NOT A PUBLIC SURFACE.
 * ============================================================================
 *
 * WHAT WAS MEASURED, on the real booted application, before this suite existed:
 *
 *   $ curl -s http://host/api/v1/system/diagnostics        # no token, no key
 *   {"version":"0.1.0","commit":null,"environment":"test","uptimeSeconds":3,
 *    "memory":{...},"cpu":{...},"configValidation":{...},
 *    "featureFlags":[{"key":"...","isEnabledGlobally":false}, ...]}
 *
 * That is a reconnaissance endpoint: it names the exact build an attacker is
 * looking at, the environment it thinks it is, and which features are on. On a
 * public staging or production host it is free work for whoever asks first, and
 * asking costs nothing.
 *
 * `GET /system/readiness` was anonymous too, and worse in kind: its `detail`
 * strings carry the DATABASE'S OWN ERROR TEXT when a check fails, which
 * external providers are configured (`STRIPE_SECRET_KEY, PAYMOB_API_KEY, ...`),
 * and internal document paths. Fixing only the route that was reported would
 * have left the neighbour it shares a controller with — the same shape of
 * defect this repository already shipped once, when `GET /feature-flags`
 * returned every family's UUID.
 *
 * ============================ WHAT THIS SUITE FIXES IN PLACE ================
 *
 * RULE S1  EVERY route of `SystemDiagnosticsController` — derived from Nest's
 *          own metadata, never hand-listed — refuses an anonymous caller. A
 *          third diagnostics route added tomorrow is swept tomorrow.
 * RULE S2  ...and refuses a WRONG operator key, so the guard is doing the work
 *          and not merely the absence of a header.
 * RULE S3  ...and answers the RIGHT operator key, because a diagnostics
 *          endpoint an operator cannot read is not a fix, it is a deletion.
 * RULE S4  The platform's own probes — `/health/live` and `/health/ready`, the
 *          two the staging deploy config polls — still answer ANONYMOUSLY.
 *          They are the reason an unauthenticated endpoint exists at all.
 * RULE S5  ...and what they answer discloses NOTHING ABOUT THE BUILD. Asserted
 *          on the real response body, key by key, not on a type: their keys are
 *          exactly the ones named here, and the serialised bodies contain
 *          neither the build fields nor the values the diagnostics route
 *          publishes to an operator.
 */
import { INestApplication } from '@nestjs/common';
import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { Test } from '@nestjs/testing';
import request = require('supertest');

import { AppModule } from '../../src/app.module';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { API_PREFIX_EXCLUDED, applyGlobalHttpPipeline } from '../../src/common/http/global-pipeline';
import { ROLES_METADATA } from '../../src/common/authz/roles.decorator';
import { Role } from '../../src/common/authz/principal-role';
import { SystemDiagnosticsController } from '../../src/modules/system-diagnostics/presentation/controllers/system-diagnostics.controller';
import { createTestPrismaService, integrationDatabaseUrl } from '../tenancy/prisma-test-client';

const describeIfDb = integrationDatabaseUrl() ? describe : describe.skip;

const P = '/api/v1';
/**
 * The two probe paths are DERIVED from the application's own prefix
 * configuration, because they are deliberately EXCLUDED from `api/v1` — the
 * orchestrator that polls them does not know this API's version. A hard-coded
 * `/api/v1/health/live` here would 404 and prove nothing.
 */
const LIVE = API_PREFIX_EXCLUDED.includes('health/live') ? '/health/live' : `${P}/health/live`;
const READY = API_PREFIX_EXCLUDED.includes('health/ready') ? '/health/ready' : `${P}/health/ready`;
const HTTP_METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'ALL', 'OPTIONS', 'HEAD', 'SEARCH'];

/**
 * The diagnostics controller's routes, READ FROM NEST'S METADATA. The list this
 * suite sweeps is the list the application actually serves.
 */
function diagnosticsRoutes(): { method: string; path: string; guards: string[]; roles: string[] }[] {
  const base = Reflect.getMetadata(PATH_METADATA, SystemDiagnosticsController) as string;
  const classGuards: unknown[] = Reflect.getMetadata(GUARDS_METADATA, SystemDiagnosticsController) ?? [];
  const proto = SystemDiagnosticsController.prototype as unknown as Record<string, unknown>;
  const routes: { method: string; path: string; guards: string[]; roles: string[] }[] = [];

  for (const name of Object.getOwnPropertyNames(proto)) {
    if (name === 'constructor') continue;
    const handler = proto[name];
    if (typeof handler !== 'function') continue;
    const sub = Reflect.getMetadata(PATH_METADATA, handler);
    if (sub === undefined) continue;
    const methodGuards: unknown[] = Reflect.getMetadata(GUARDS_METADATA, handler) ?? [];
    routes.push({
      method: HTTP_METHODS[Reflect.getMetadata(METHOD_METADATA, handler)] ?? 'GET',
      path: `/${base}/${String(sub)}`.replace(/\/+/g, '/'),
      guards: [...classGuards, ...methodGuards].map((g) => (g as { name?: string })?.name ?? String(g)),
      roles:
        (Reflect.getMetadata(ROLES_METADATA, handler) as string[] | undefined) ??
        (Reflect.getMetadata(ROLES_METADATA, SystemDiagnosticsController) as string[] | undefined) ??
        [],
    });
  }
  return routes;
}

async function clearThrottleCounters(): Promise<void> {
  const Redis = require('ioredis');
  const client = new Redis(process.env.REDIS_URL as string);
  const keys = await client.keys('throttle:*');
  if (keys.length > 0) await client.del(...keys);
  await client.quit();
}

describeIfDb('the system diagnostics surface is an operator surface', () => {
  let app: INestApplication;
  let http: any;
  const operatorKey = process.env.INTERNAL_ADMIN_API_KEY as string;

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
  }, 60_000);

  afterAll(async () => {
    if (app) await app.close();
  });

  it('the route list is derived and non-empty — otherwise every sweep below is vacuous', () => {
    const routes = diagnosticsRoutes();
    expect(routes.length).toBeGreaterThanOrEqual(2);
    expect(routes.map((r) => `${r.method} ${r.path}`).sort()).toEqual([
      'GET /system/diagnostics',
      'GET /system/readiness',
    ]);
  });

  it.each(diagnosticsRoutes().map((r) => [`${r.method} ${r.path}`, r] as const))(
    'RULE S1 — %s refuses an anonymous caller and discloses nothing in the refusal',
    async (_key, route) => {
      const res = await request(http)[route.method.toLowerCase() as 'get'](`${P}${route.path}`);
      expect(res.status).toBe(401);
      const body = JSON.stringify(res.body);
      // A refusal that still names the build would have moved the leak, not
      // closed it.
      for (const marker of ['version', 'commit', 'featureFlags', 'uptimeSeconds', 'NODE_ENV', 'Postgres']) {
        expect(body).not.toContain(marker);
      }
    },
  );

  it.each(diagnosticsRoutes().map((r) => [`${r.method} ${r.path}`, r] as const))(
    'RULE S2 — %s refuses a WRONG operator key',
    async (_key, route) => {
      const res = await request(http)
        [route.method.toLowerCase() as 'get'](`${P}${route.path}`)
        .set('x-internal-admin-key', `${operatorKey}-wrong`);
      expect(res.status).toBe(401);
    },
  );

  it.each(diagnosticsRoutes().map((r) => [`${r.method} ${r.path}`, r] as const))(
    'RULE S3 — %s answers the RIGHT operator key',
    async (_key, route) => {
      const res = await request(http)
        [route.method.toLowerCase() as 'get'](`${P}${route.path}`)
        .set('x-internal-admin-key', operatorKey);
      expect([200, 503]).toContain(res.status);
      expect(res.body).toBeDefined();
    },
  );

  it('RULE S1/S3 (structural) — every diagnostics route carries InternalAdminGuard and declares SUPER_ADMIN', () => {
    const offenders = diagnosticsRoutes()
      .filter(
        (r) =>
          !r.guards.includes('InternalAdminGuard') || JSON.stringify(r.roles) !== JSON.stringify([Role.SUPER_ADMIN]),
      )
      .map((r) => `${r.method} ${r.path} -> guards ${JSON.stringify(r.guards)}, roles ${JSON.stringify(r.roles)}`);
    expect(offenders).toEqual([]);
  });

  it('RULE S3 — the operator still gets the build facts the route exists to report', async () => {
    const res = await request(http).get(`${P}/system/diagnostics`).set('x-internal-admin-key', operatorKey);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('version');
    expect(res.body).toHaveProperty('environment');
    expect(res.body).toHaveProperty('featureFlags');
  });

  it('RULE S4 — /health/live and /health/ready still answer ANONYMOUSLY', async () => {
    const live = await request(http).get(LIVE);
    expect(live.status).toBe(200);
    const ready = await request(http).get(READY);
    // 503 is a legitimate anonymous answer (a dependency is down); what must
    // never happen is a 401, which would break the deploy config's probe.
    expect([200, 503]).toContain(ready.status);
  });

  it('RULE S5 — what an anonymous caller CAN still reach discloses nothing about the build', async () => {
    const live = await request(http).get(LIVE);
    const ready = await request(http).get(READY);

    expect(Object.keys(live.body).sort()).toEqual(['status']);
    expect(Object.keys(ready.body).sort()).toEqual(['database', 'redis', 'status']);
    expect(typeof ready.body.database).toBe('boolean');
    expect(typeof ready.body.redis).toBe('boolean');

    // And the same assertion made on the SERIALISED bodies, against the exact
    // fields the operator route publishes — the build identity, the
    // environment, the flags, and the readiness detail strings.
    const anonymousSurface = `${JSON.stringify(live.body)}${JSON.stringify(ready.body)}`;
    for (const marker of [
      'version',
      'commit',
      'environment',
      'uptimeSeconds',
      'memory',
      'cpu',
      'configValidation',
      'featureFlags',
      'component',
      'detail',
      process.env.NODE_ENV ?? 'development',
      process.env.npm_package_version ?? '0.1.0',
    ]) {
      expect(anonymousSurface).not.toContain(marker);
    }
  });
});
