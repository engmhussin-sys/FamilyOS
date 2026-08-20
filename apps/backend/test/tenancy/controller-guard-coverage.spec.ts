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

import { BREAK_GLASS_METADATA } from '../../src/common/authz/break-glass.decorator';
import { PRINCIPAL_ROLES, Role } from '../../src/common/authz/principal-role';
import { ROLES_METADATA } from '../../src/common/authz/roles.decorator';

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
  'POST /webhooks/payments/:provider':
    'PHASE D. Server-to-server callbacks from Apple, Google, Paymob, Fawry and the Saudi gateway — none of which has, or can have, a user session. The control is PROVIDER SIGNATURE VERIFICATION inside PaymentWebhookService.ingest, which runs BEFORE the payload is parsed and before anything reaches a business table: Apple JWS against a pinned Apple Root CA G3 chain, Paymob HMAC-SHA512, Fawry SHA-256, Moyasar shared secret, Google Pub/Sub OIDC. Every adapter FAILS CLOSED when unconfigured (returns verified:false, never true). Throttled 300/min as defence in depth.',
  'POST /analytics/growth/install':
    "PHASE D (GROWTH). An app install precedes every credential this system could check — there is no account, no family and no token on first launch, which is the entire reason INSTALL is a funnel step above REGISTRATION. Three controls stand in for a token: a 10/min throttle, a payload that cannot name a family, a user or a child (it carries a client-generated session id and market dimensions only), and the fact that the event GRANTS NOTHING — the worst an abuser achieves is inflating a chart they have no way to read. The row lands in `analytics_events` with `family_id IS NULL`, which is PLATFORM_ANNOTATED and therefore invisible to every tenant.",
  'GET /health/live': 'Liveness probe. Orchestrators cannot authenticate. Returns {status:"ok"} and nothing else.',
  'GET /health/ready': 'Readiness probe. Returns three booleans, no tenant data.',
  // `GET /system/readiness` and `GET /system/diagnostics` stood here. Both were
  // anonymous, and both named the build to anyone who asked: version, commit,
  // NODE_ENV, feature flags, and — on readiness — raw dependency error strings
  // and which payment providers are configured. They now sit behind
  // InternalAdminGuard with the rest of `system/*`. The liveness and readiness
  // probes the deploy actually polls are `/health/live` and `/health/ready`,
  // which are above and disclose nothing about the build.
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
  /** PHASE C: guard class names, so the role assertions can reason about actor type. */
  guardNames: string[];
  /** PHASE C: the roles this route declares, method-level overriding class-level. */
  roles: string[] | undefined;
  /** PHASE C: present iff the route declares `@BreakGlass(...)`. */
  hasBreakGlass: boolean;
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
        // PHASE C. Method metadata overrides class metadata, exactly as Nest's
        // own `Reflector.getAllAndOverride` resolves it at runtime — so what
        // this suite reads is what the guard reads, not an approximation.
        const roles =
          (Reflect.getMetadata(ROLES_METADATA, handler) as string[] | undefined) ??
          (Reflect.getMetadata(ROLES_METADATA, exported) as string[] | undefined);
        routes.push({
          controller: (exported as { name: string }).name,
          handler: name,
          method: HTTP_METHODS[verbIndex] ?? String(verbIndex),
          fullPath: normalise(String(controllerPath), String(methodPath)),
          guardCount: allGuards.length,
          rejectingGuardCount: allGuards.filter(
            (g) => (g as { name?: string })?.name !== 'OptionalJwtAuthGuard',
          ).length,
          guardNames: allGuards.map((g) => (g as { name?: string })?.name ?? String(g)),
          roles,
          hasBreakGlass:
            Reflect.getMetadata(BREAK_GLASS_METADATA, handler) !== undefined ||
            Reflect.getMetadata(BREAK_GLASS_METADATA, exported) !== undefined,
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

  // =========================================================================
  // PHASE C / P3 — THE GENERATED CROSS-ROLE SWEEP
  //
  // R14 above answers "is this route guarded at all". A4 §SA-005 showed that
  // is not the question that was failing: 143 routes were guarded, and every
  // PARENT could still delete the family, because "guarded" only ever meant
  // "authenticated". These assertions answer the second question — "and WHO
  // may call it" — for every route in the table, derived, never hand-listed.
  //
  // The property that matters for CI: a route added tomorrow with
  // `@UseGuards(JwtAuthGuard)` and no `@Roles(...)` FAILS THIS BUILD. It also
  // fails at runtime (`assertRoleAllowed` denies an undeclared route), so
  // deleting this suite would not open the hole — it would only stop naming
  // it early.
  // =========================================================================

  /**
   * Guarded, but by something that is not a role-bearing principal. Same
   * contract as PUBLIC_ROUTES: an entry is a visible, reviewable diff and must
   * carry its reason.
   */
  const NON_ROLE_GUARDED_ROUTES: Record<string, string> = {
    'POST /pairing/device/register':
      'RegistrationTokenGuard consumes a one-time, server-issued registration token and supplies childId/familyId from it. The caller is a device that does not yet hold a session, so it holds no role either; the token IS the authorization, and it is single-use.',
  };

  /**
   * THE OWNER-ONLY SURFACE, enumerated with reasons.
   *
   * This list is asserted to be EXACT in both directions. A route that gains
   * OWNER-only status without a line here fails; a route that silently LOSES
   * it — the regression that would quietly re-open A4's custody-dispute
   * scenario — fails too. That second direction is the one worth having.
   */
  const OWNER_ONLY_ROUTES: Record<string, string> = {
    'DELETE /account':
      'Deletes the FAMILY, not merely a login: cancels the subscription and soft-deletes every child. This is A4\'s custody-dispute scenario reached by the wrong parent.',
    'POST /billing/subscribe':
      'schema.prisma documents OWNER as the BILLING owner. Money leaves one person\'s card; a co-parent may read the plan but may not commit the family to a charge.',
    'POST /billing/cancel':
      'Symmetric with subscribe: cancelling strips every paid entitlement from the whole household.',
    'POST /families/ownership/transfer':
      'After it, someone else can delete the family. The single most dangerous non-deleting action in the product.',
    'DELETE /families/members/:userId':
      'One parent removing the other. Named explicitly in A4 as the adversarial-parent case.',
    'GET /billing/store-account-ref':
      'PHASE G. Returns the opaque household reference the client hands to the store as obfuscatedExternalAccountId / appAccountToken, which is what makes the server resolve the tenant from the STORE\'s echo rather than from the session. Symmetric with the two routes below by intent: only the party permitted to start a purchase needs the value that binds a purchase to this household, and handing it to a co-parent would let them attach this family to a store account they control.',
    'POST /billing/purchases/verify':
      'PHASE D. Symmetric with /billing/subscribe: it converts a store purchase into an entitlement for the WHOLE household and binds the household to a store account through provider_account_links. A co-parent may read the catalogue and the entitlements; committing the family to a purchase is the billing owner\'s. (Note that even the OWNER does not get to decide WHOSE purchase it is — the tenant is resolved from the provider\'s own account reference, and a mismatch is a 403.)',
  };

  const allRoutes = discoverRoutes();

  it.each(allRoutes.map((r) => [`${r.method} ${r.fullPath}`, r] as const))(
    '%s declares WHICH ROLES may call it',
    (key, route) => {
      if (PUBLIC_ROUTES[key]) return; // unauthenticated by nature, justified above
      if (NON_ROLE_GUARDED_ROUTES[key]) {
        expect(NON_ROLE_GUARDED_ROUTES[key].length).toBeGreaterThan(30);
        return;
      }
      expect(route.roles).toBeDefined();
      expect((route.roles ?? []).length).toBeGreaterThan(0);
      for (const role of route.roles ?? []) {
        // A typo'd role string would otherwise silently deny everyone (or, if
        // it collided with nothing, deny everyone forever) with no signal.
        expect(PRINCIPAL_ROLES).toContain(role);
      }
    },
  );

  it('the non-role-guarded allow-list has no stale entries', () => {
    const live = new Set(allRoutes.map((r) => `${r.method} ${r.fullPath}`));
    expect(Object.keys(NON_ROLE_GUARDED_ROUTES).filter((k) => !live.has(k))).toEqual([]);
  });

  it('a device-guarded route admits CHILD and nothing else', () => {
    const offenders = allRoutes
      .filter((r) => r.guardNames.includes('DeviceJwtAuthGuard'))
      .filter((r) => JSON.stringify(r.roles) !== JSON.stringify([Role.CHILD]))
      .map((r) => `${r.method} ${r.fullPath} -> ${JSON.stringify(r.roles)}`);
    expect(offenders).toEqual([]);
  });

  it('a parent-guarded route NEVER admits CHILD — the strategy split is not the only lock', () => {
    // `JwtAuthGuard` is the `jwt` strategy and a device token is minted for
    // `device-jwt`, so a child could not reach these anyway. Declaring CHILD on
    // one would be a lie in the permission matrix, and the matrix is what the
    // next engineer reads.
    const offenders = allRoutes
      .filter((r) => r.guardNames.includes('JwtAuthGuard'))
      .filter((r) => (r.roles ?? []).includes(Role.CHILD))
      .map((r) => `${r.method} ${r.fullPath}`);
    expect(offenders).toEqual([]);
  });

  it('an internal-admin route admits SUPER_ADMIN and nothing else', () => {
    const adminRoutes = allRoutes.filter((r) => r.guardNames.includes('InternalAdminGuard'));
    expect(adminRoutes.length).toBeGreaterThan(0);
    const offenders = adminRoutes
      .filter((r) => JSON.stringify(r.roles) !== JSON.stringify([Role.SUPER_ADMIN]))
      .map((r) => `${r.method} ${r.fullPath} -> ${JSON.stringify(r.roles)}`);
    expect(offenders).toEqual([]);
  });

  it('SUPER_ADMIN is never mixed into a family-scoped route', () => {
    const offenders = allRoutes
      .filter((r) => (r.roles ?? []).includes(Role.SUPER_ADMIN) && (r.roles ?? []).length > 1)
      .map((r) => `${r.method} ${r.fullPath} -> ${JSON.stringify(r.roles)}`);
    expect(offenders).toEqual([]);
  });

  it('NO route admits SUPPORT without an audited @BreakGlass declaration', () => {
    const offenders = allRoutes
      .filter((r) => (r.roles ?? []).includes(Role.SUPPORT) && !r.hasBreakGlass)
      .map((r) => `${r.method} ${r.fullPath}`);
    expect(offenders).toEqual([]);
  });

  it('and today NO route admits SUPPORT at all — stated, not implied', () => {
    // The support console does not exist in this repository. Recording the
    // number here means the first route that ever admits a support agent shows
    // up as a deliberate diff on this line.
    const supportRoutes = allRoutes.filter((r) => (r.roles ?? []).includes(Role.SUPPORT));
    expect(supportRoutes.map((r) => `${r.method} ${r.fullPath}`)).toEqual([]);
  });

  it('the OWNER-only surface is EXACTLY the enumerated list, in both directions', () => {
    const live = allRoutes
      .filter((r) => JSON.stringify(r.roles) === JSON.stringify([Role.OWNER]))
      .map((r) => `${r.method} ${r.fullPath}`)
      .sort();
    expect(live).toEqual(Object.keys(OWNER_ONLY_ROUTES).sort());
    for (const reason of Object.values(OWNER_ONLY_ROUTES)) {
      expect(reason.length).toBeGreaterThan(40);
    }
  });

  it('the ordinary parenting surface is co-equal: OWNER and PARENT together, never PARENT alone', () => {
    // A route that admitted PARENT but not OWNER would mean the owner of the
    // family cannot do something a co-parent can, which is incoherent. This
    // catches `@Roles(Role.PARENT)` written where `@ParentSurface()` was meant.
    const offenders = allRoutes
      .filter((r) => (r.roles ?? []).includes(Role.PARENT) && !(r.roles ?? []).includes(Role.OWNER))
      .map((r) => `${r.method} ${r.fullPath}`);
    expect(offenders).toEqual([]);
  });

  it('the role coverage is not vacuous — the numbers are recorded so a collapse is visible', () => {
    const declared = allRoutes.filter((r) => (r.roles ?? []).length > 0);
    const undeclared = allRoutes.filter((r) => (r.roles ?? []).length === 0);
    // Every undeclared route must be one of the two justified allow-lists.
    for (const r of undeclared) {
      const key = `${r.method} ${r.fullPath}`;
      expect(Boolean(PUBLIC_ROUTES[key] || NON_ROLE_GUARDED_ROUTES[key])).toBe(true);
    }
    expect(declared.length).toBeGreaterThanOrEqual(180);
    // PHASE D (GROWTH): 12 -> 13. The thirteenth is `POST /analytics/growth/install`,
    // and it is in PUBLIC_ROUTES with its full reasoning. Bumping this ceiling
    // is the intended workflow — the loop above still fails for a route that
    // is undeclared WITHOUT an allow-list entry, so the ceiling alone cannot
    // be used to sneak a route past review.
    expect(undeclared.length).toBeLessThanOrEqual(13);
  });
});
