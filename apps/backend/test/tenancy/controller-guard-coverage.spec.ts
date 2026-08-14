/**
 * R14, generalised.
 *
 * F1 shipped a structural test that counted the guards on every handler of
 * `LifeIntelligenceController`. A0 §R14 recorded the obvious hole: that covers
 * ONE controller out of 27, and the real risk is "a new controller written in
 * the same fail-open style".
 *
 * This suite closes it. It discovers every `@Controller` class in `src/` from
 * the filesystem, imports it, reads Nest's own metadata for every route
 * handler, and requires each route to be either:
 *
 *   (a) guarded — at the method or the class level, or
 *   (b) present in PUBLIC_ROUTES below, WITH a written reason.
 *
 * The allow-list is the audit trail. Adding a route to it is a visible,
 * reviewable diff; forgetting `@UseGuards` on a new route is a red build.
 *
 * It deliberately reads the compiled decorators, not the source text: a route
 * that "looks guarded" because the string `@UseGuards` appears in a comment
 * does not pass.
 */
import * as fs from 'fs';
import * as path from 'path';

import { PATH_METADATA, METHOD_METADATA, GUARDS_METADATA } from '@nestjs/common/constants';

/**
 * Routes that are public ON PURPOSE. Format: `METHOD /full/path` -> reason.
 *
 * Rules for adding an entry (enforced by review, not by the machine):
 *   - it must be unauthenticatable by nature (an orchestrator probe, a
 *     provider webhook, or the login/registration surface itself), and
 *   - it must have its own non-token control (signature verification, a
 *     one-time code, a rate limit), named in the reason.
 */
const PUBLIC_ROUTES: Record<string, string> = {
  'POST /auth/register': 'Creates the account and the Family; there is nothing to authenticate yet. Throttled 5/min.',
  'POST /auth/login': 'The authentication surface itself. Throttled 10/min.',
  'POST /auth/refresh': 'Presents a refresh token, not an access token; the token IS the credential. Throttled 20/min.',
  'POST /pairing/accept': 'A child device redeems a one-time, 10-minute pairing code; the code is the credential. Throttled 10/min.',
  'POST /webhooks/stripe': 'Server-to-server call from Stripe. Control is HMAC signature verification (StripeWebhookService.verifySignature), which runs before anything else in the handler.',
  'GET /health/live': 'Liveness probe. Orchestrators cannot authenticate. Returns {status:"ok"} and nothing else.',
  'GET /health/ready': 'Readiness probe. Returns three booleans, no tenant data.',
  'GET /system/readiness': 'Infrastructure readiness probe, same reasoning as /health/ready.',
  'GET /system/diagnostics': 'Build/config diagnostics — booleans, counts and version strings only, reviewed line by line for the absence of secrets and tenant data.',
  'POST /support': 'A support request may legitimately come from someone who cannot log in (that is often WHY they are writing). Throttled 5/min; SupportRequest.familyId is nullable for exactly this case. It carries OptionalJwtAuthGuard, which never rejects — it exists only so a caller who DOES have a session is identified from the verified token instead of from the request body (see NON_REJECTING_GUARDS below).',
};

interface DiscoveredRoute {
  controller: string;
  handler: string;
  method: string;
  fullPath: string;
  guardCount: number;
  /** Guards that can actually deny the request (i.e. excluding OptionalJwtAuthGuard). */
  rejectingGuardCount: number;
}

const HTTP_METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'ALL', 'OPTIONS', 'HEAD', 'SEARCH'];

function findControllerFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) findControllerFiles(full, acc);
    else if (entry.isFile() && entry.name.endsWith('.controller.ts')) acc.push(full);
  }
  return acc;
}

function normalise(base: string, sub: string): string {
  const joined = `/${base}/${sub}`.replace(/\/+/g, '/');
  return joined.length > 1 && joined.endsWith('/') ? joined.slice(0, -1) : joined;
}

function discoverRoutes(): DiscoveredRoute[] {
  const srcRoot = path.resolve(__dirname, '../../src');
  const routes: DiscoveredRoute[] = [];

  for (const file of findControllerFiles(srcRoot)) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require(file);
    for (const exported of Object.values(mod)) {
      if (typeof exported !== 'function') continue;
      const controllerPath = Reflect.getMetadata(PATH_METADATA, exported);
      if (controllerPath === undefined) continue;

      const classGuards: unknown[] = Reflect.getMetadata(GUARDS_METADATA, exported) ?? [];
      const proto = (exported as { prototype: object }).prototype;

      for (const name of Object.getOwnPropertyNames(proto)) {
        if (name === 'constructor') continue;
        const handler = (proto as Record<string, unknown>)[name];
        if (typeof handler !== 'function') continue;
        const methodPath = Reflect.getMetadata(PATH_METADATA, handler);
        if (methodPath === undefined) continue;
        const verbIndex = Reflect.getMetadata(METHOD_METADATA, handler);
        const methodGuards: unknown[] = Reflect.getMetadata(GUARDS_METADATA, handler) ?? [];

        const allGuards = [...classGuards, ...methodGuards];
        routes.push({
          controller: (exported as { name: string }).name,
          handler: name,
          method: HTTP_METHODS[verbIndex] ?? String(verbIndex),
          fullPath: normalise(String(controllerPath), String(methodPath)),
          guardCount: allGuards.length,
          rejectingGuardCount: allGuards.filter(
            (g) => (g as { name?: string })?.name !== 'OptionalJwtAuthGuard',
          ).length,
        });
      }
    }
  }
  return routes;
}

describe('R14 — every route in the application is guarded or explicitly public', () => {
  const routes = discoverRoutes();

  it('discovers a realistic number of controllers and routes', () => {
    const controllers = new Set(routes.map((r) => r.controller));
    // A4 counted 27 controllers / 147 routes. If this collapses to a handful,
    // the discovery walk is broken and every assertion below is vacuous.
    expect(controllers.size).toBeGreaterThanOrEqual(25);
    expect(routes.length).toBeGreaterThanOrEqual(140);
  });

  it.each(
    // Keyed by a stable string so a failure names the offending route.
    discoverRoutes().map((r) => [`${r.method} ${r.fullPath}`, r] as const),
  )('%s is guarded, or allow-listed with a reason', (key, route) => {
    if (route.rejectingGuardCount > 0) return;

    const reason = PUBLIC_ROUTES[key];
    expect(
      reason,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ).toBeDefined();
    expect((reason ?? '').length).toBeGreaterThan(30);
  });

  it('the allow-list contains no stale entries', () => {
    const live = new Set(routes.map((r) => `${r.method} ${r.fullPath}`));
    const stale = Object.keys(PUBLIC_ROUTES).filter((k) => !live.has(k));
    expect(stale).toEqual([]);
  });

  /**
   * Guards that ALLOW every request through and exist only to identify the
   * caller when a token happens to be present. A route carrying one of these
   * is still public and must still be justified in PUBLIC_ROUTES.
   */
  const NON_REJECTING_GUARDS = new Set(['OptionalJwtAuthGuard']);

  it('no allow-listed route has silently GAINED a REJECTING guard without leaving the list', () => {
    // Not a failure of security, but a failure of the audit trail: the list
    // must describe reality.
    const guarded = routes
      .filter((r) => r.rejectingGuardCount > 0)
      .map((r) => `${r.method} ${r.fullPath}`);
    const contradictions = Object.keys(PUBLIC_ROUTES).filter((k) => guarded.includes(k));
    expect(contradictions).toEqual([]);
  });

  it('the non-rejecting guard allow-list is not being used to smuggle routes past the check', () => {
    const usages = routes.filter((r) => r.guardCount > 0 && r.rejectingGuardCount === 0);
    // Exactly one route may be public-with-identification today: POST /support.
    expect(usages.map((r) => `${r.method} ${r.fullPath}`)).toEqual(['POST /support']);
    expect([...NON_REJECTING_GUARDS]).toEqual(['OptionalJwtAuthGuard']);
  });

  it('every public route also declares WHY it needs no tenant (@SystemRoute) or is tenant-free by nature', () => {
    // /health/live touches no database at all and needs no declaration.
    const TENANT_FREE_BY_NATURE = new Set(['GET /health/live']);
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { SYSTEM_ROUTE_METADATA } = require('../../src/common/tenancy/system-route.decorator');

    const missing: string[] = [];
    for (const route of routes) {
      const key = `${route.method} ${route.fullPath}`;
      if (!(key in PUBLIC_ROUTES) || TENANT_FREE_BY_NATURE.has(key)) continue;
      const srcRoot = path.resolve(__dirname, '../../src');
      const file = findControllerFiles(srcRoot).find((f) => {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const mod = require(f);
        return Object.values(mod).some(
          (e) => typeof e === 'function' && (e as { name: string }).name === route.controller,
        );
      });
      if (!file) continue;
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const mod = require(file);
      const cls = Object.values(mod).find(
        (e) => typeof e === 'function' && (e as { name: string }).name === route.controller,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ) as any;
      const meta = Reflect.getMetadata(SYSTEM_ROUTE_METADATA, cls.prototype[route.handler]);
      if (!meta) missing.push(key);
    }
    expect(missing).toEqual([]);
  });
});
