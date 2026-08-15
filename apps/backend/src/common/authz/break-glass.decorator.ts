import { SetMetadata } from '@nestjs/common';

export const BREAK_GLASS_METADATA = 'abny:break-glass';

export interface BreakGlassMetadata {
  /** What a support agent is being allowed to see, in one sentence. */
  readonly scope: string;
  /** Why that is ever acceptable. Non-empty, enforced at runtime. */
  readonly justification: string;
}

/**
 * Marks the ONLY kind of route a `SUPPORT` principal may ever reach.
 *
 * The client's requirement, restated as a machine-checkable rule: "a support
 * agent must never read a child's activity without an audited break-glass."
 * So:
 *
 *   1. `SUPPORT` is granted by no token-issuance path in this codebase
 *      (`test/authz/support-role-is-ungrantable.spec.ts`).
 *   2. Every route fails closed for it, because no route lists `Role.SUPPORT`.
 *   3. If a route ever DOES list it, `controller-guard-coverage.spec.ts`
 *      requires this decorator on the same handler, and `BreakGlassGuard`
 *      writes an `AuditLog` row — scoped to the family — BEFORE the handler
 *      runs. No silent read is reachable.
 *
 * Zero routes carry it today. That is stated plainly rather than hidden: the
 * mechanism is built and unit-tested, the support console is not built.
 */
export const BreakGlass = (scope: string, justification: string) =>
  SetMetadata<string, BreakGlassMetadata>(BREAK_GLASS_METADATA, { scope, justification });
