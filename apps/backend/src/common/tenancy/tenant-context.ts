import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * CONTEXT.md principle 3: "`familyId` is NEVER read from the client. It is
 * derived from the JWT/session context."
 *
 * This module is the only place a tenant identity may enter the request. It is
 * populated exclusively by `TenantContextInterceptor` from `request.user` —
 * the object Passport builds from a VERIFIED token signature. There is no code
 * path from `req.body`, `req.query`, `req.params` or any header into a
 * `TenantContext`, and `test/tenancy/tenant-context.spec.ts` asserts that.
 */

/**
 * F3 adds `'SYSTEM'`: a consumer woken by the Outbox relay acts for a real,
 * single family but is neither a logged-in parent nor a paired device.
 * Labelling it `'DEVICE'` would put a false actor in the audit trail. Purely
 * additive — `TenantContextInterceptor` still only ever produces USER or DEVICE
 * from a token, because a token is the only thing it reads.
 */
export type TenantActorType = 'USER' | 'DEVICE' | 'SYSTEM';

export interface TenantContext {
  readonly kind: 'TENANT';
  /** Always from the authenticated principal. Never client-supplied. */
  readonly familyId: string;
  readonly actorType: TenantActorType;
  /** userId for USER actors, deviceId for DEVICE actors. */
  readonly actorId: string;
  readonly requestId?: string;
}

/**
 * The audited escape hatch. `reason` is a closed enum, not free text, so the
 * set of legitimate cross-tenant operations in this codebase is enumerable by
 * reading this file — which is the point.
 */
export type SystemReason =
  /** Scheduled retention/anonymisation sweeps, by definition cross-tenant. */
  | 'DATA_RETENTION_JOB'
  /** Provider webhooks: the payload is trusted only after signature checks,
   *  and the family is resolved FROM the payload, not from a caller token. */
  | 'BILLING_WEBHOOK'
  /** Internal admin surfaces behind InternalAdminGuard. */
  | 'ADMIN_CONSOLE'
  /** /health and /ready — must not require a tenant to answer. */
  | 'HEALTH_CHECK'
  /** Login/registration/refresh: runs before any family exists. */
  | 'AUTH_BOOTSTRAP'
  /** Account deletion / GDPR export executed for one family, but needing
   *  reads the extension would otherwise scope to the CALLER's family. */
  | 'ACCOUNT_LIFECYCLE'
  /** Test harnesses and seed scripts only. Never reachable from HTTP. */
  | 'TEST_FIXTURE'
  /**
   * F3 (R3). The Outbox relay polls `outbox_messages` across every tenant —
   * that is what a relay IS, and no per-request tenant exists on a timer tick.
   *
   * The bypass is deliberately NARROW and the narrowness is the control: only
   * the CLAIM and the STATUS UPDATE run under this reason. The moment a message
   * is claimed, the relay re-enters `runWithTenant({ familyId: message.familyId })`
   * before touching the bus, so every consumer — Rewards, Notifications,
   * Streaks — executes under the ordinary tenant extension with deny-by-default
   * intact, exactly as if a request from that family had arrived. A consumer
   * therefore cannot read another family's rows even though the relay that
   * woke it could see them all.
   */
  | 'OUTBOX_RELAY';

export interface SystemContext {
  readonly kind: 'SYSTEM';
  readonly reason: SystemReason;
  /** Free-text justification recorded in the log line for this bypass. */
  readonly justification: string;
}

export type AmbientContext = TenantContext | SystemContext;

const storage = new AsyncLocalStorage<AmbientContext>();

/** The raw store. Prefer the helpers below. */
export function currentContext(): AmbientContext | undefined {
  return storage.getStore();
}

export function currentTenant(): TenantContext | undefined {
  const ctx = storage.getStore();
  return ctx?.kind === 'TENANT' ? ctx : undefined;
}

export function currentSystemContext(): SystemContext | undefined {
  const ctx = storage.getStore();
  return ctx?.kind === 'SYSTEM' ? ctx : undefined;
}

/** Runs `fn` with a tenant bound to the async execution context. */
export function runWithTenant<T>(ctx: Omit<TenantContext, 'kind'>, fn: () => T): T {
  return storage.run({ kind: 'TENANT', ...ctx }, fn);
}

/** Internal: used by `system-context.ts`, which adds the mandatory logging. */
export function runWithContext<T>(ctx: AmbientContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

/**
 * Throws rather than returning undefined. There is no default `familyId`, and
 * a "sensible fallback" here would be the exact bug this sprint exists to make
 * impossible.
 */
export function requireTenant(): TenantContext {
  const ctx = currentTenant();
  if (!ctx) {
    throw new Error('TENANT_CONTEXT_MISSING: no authenticated tenant on this async context.');
  }
  return ctx;
}

/**
 * The value to put in a `create` payload's tenant column.
 *
 * The extension stamps `familyId` at runtime regardless, but Prisma's generated
 * input types now REQUIRE the column — and that is a feature, not an obstacle:
 * the compiler points at every write that has to name a tenant. This helper is
 * how a write names it without ever taking it from the client.
 *
 * - Under a TenantContext: the authenticated tenant. If the caller also passes
 *   an explicit id and it disagrees, that is a cross-tenant write attempt and
 *   it throws here rather than being silently corrected.
 * - Under an audited SystemContext (pairing bootstrap, webhooks, jobs): the
 *   explicit, server-derived id is required — there is no ambient tenant to
 *   fall back on, and guessing one is exactly the bug being designed out.
 * - With no context at all: throws. Deny by default, same as the extension.
 */
export function tenantIdForWrite(explicitFamilyId?: string): string {
  const ctx = currentContext();
  if (ctx?.kind === 'TENANT') {
    if (explicitFamilyId && explicitFamilyId !== ctx.familyId) {
      throw new Error(
        `CROSS_TENANT_WRITE: write targeted familyId=${explicitFamilyId} while the ` +
          `authenticated tenant is ${ctx.familyId}.`,
      );
    }
    return ctx.familyId;
  }
  if (ctx?.kind === 'SYSTEM') {
    if (!explicitFamilyId) {
      throw new Error(
        `TENANT_REQUIRED_UNDER_SYSTEM: a SystemContext (${ctx.reason}) write must pass an ` +
          'explicit, server-derived familyId — there is no ambient tenant to inherit.',
      );
    }
    return explicitFamilyId;
  }
  throw new Error('TENANT_CONTEXT_MISSING: a create/upsert ran with no tenant and no SystemContext.');
}
