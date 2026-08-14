import { Logger } from '@nestjs/common';

import { runWithContext, type SystemContext, type SystemReason } from './tenant-context';

const logger = new Logger('SystemContext');

/**
 * The ONLY sanctioned way to run a cross-tenant database operation.
 *
 * Three properties make it an escape hatch rather than a hole:
 *   1. `reason` is a closed union (see SystemReason) — the complete list of
 *      legitimate cross-tenant purposes is a compile-time artefact.
 *   2. `justification` is mandatory and non-empty, and it is emitted on every
 *      entry. Grepping the logs for `tenant.system_bypass` enumerates every
 *      cross-tenant operation that actually ran, with its stated reason.
 *   3. It is scoped to the async execution of `fn` and nothing else — there is
 *      no "disable tenancy" switch with a wider blast radius.
 *
 * A2 §6.3 row 15 (`data-retention-enforcement.service.ts` deleting across all
 * tenants on purpose) is exactly the case this exists for.
 */
export function runAsSystem<T>(
  reason: SystemReason,
  justification: string,
  fn: () => T,
): T {
  if (!justification || justification.trim().length < 10) {
    throw new Error(
      'runAsSystem requires a real justification (>= 10 chars). ' +
        'The justification is the audit trail — an empty one defeats the control.',
    );
  }
  const ctx: SystemContext = { kind: 'SYSTEM', reason, justification };
  logger.warn(
    `tenant.system_bypass reason=${reason} justification="${justification.replace(/"/g, "'")}"`,
  );
  return runWithContext(ctx, fn);
}

/** Async convenience wrapper; identical semantics. */
export async function runAsSystemAsync<T>(
  reason: SystemReason,
  justification: string,
  fn: () => Promise<T>,
): Promise<T> {
  return runAsSystem(reason, justification, fn);
}
