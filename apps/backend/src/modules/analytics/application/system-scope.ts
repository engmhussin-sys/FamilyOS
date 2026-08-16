import { runAsSystemAsync } from '../../../common/tenancy/system-context';
import type { SystemReason } from '../../../common/tenancy/tenant-context';

/**
 * PHASE D (GROWTH) — `runAsSystemAsync`, WITH THE LAZY-PROMISE TRAP CLOSED.
 *
 * THE BUG THIS EXISTS TO MAKE UNWRITABLE, which cost an afternoon before it
 * was understood:
 *
 *   runAsSystemAsync(reason, why, () => this.prisma.family.count(...))
 *
 * reads as "run this query as system" and does not do that. A `PrismaPromise`
 * is LAZY — it executes when `.then` is attached, not when it is constructed —
 * so the arrow above BUILDS the query inside the AsyncLocalStorage scope and
 * the caller `await`s it OUTSIDE. The tenant extension resolves the context at
 * execution time, sees none, and denies by default with
 * `TENANT_CONTEXT_MISSING`. `FamilyDateService` documents exactly this trap and
 * solves it with `async () => await read()`; the F3 fixtures hit it too.
 *
 * Relying on every future call site remembering `async () => await` is relying
 * on a detail that is invisible at the call site and whose failure mode is a
 * runtime error in a scheduled job at 02:00. So the `await` lives HERE, once,
 * and every growth service calls this instead. A call site that passes a bare
 * arrow returning a `PrismaPromise` is now correct anyway.
 */
export function runInSystemScope<T>(
  reason: SystemReason,
  justification: string,
  fn: () => Promise<T>,
): Promise<T> {
  // The `await` is the entire point of this wrapper. Do not "simplify" it to
  // `runAsSystemAsync(reason, justification, fn)`.
  return runAsSystemAsync(reason, justification, async () => await fn());
}
