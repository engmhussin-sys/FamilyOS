import { SetMetadata } from '@nestjs/common';

import type { SystemReason } from './tenant-context';

export const SYSTEM_ROUTE_METADATA = 'abny:system-route';

export interface SystemRouteMetadata {
  reason: SystemReason;
  justification: string;
}

/**
 * Marks a route that legitimately runs WITHOUT a tenant — and says why, in
 * code, at the route itself.
 *
 * This is the only way an HTTP request reaches a tenant-scoped table without a
 * `familyId` from a verified token. Every use is:
 *   - typed (the reason is a closed union),
 *   - justified (a non-empty sentence, enforced at runtime by `runAsSystem`),
 *   - logged on every single execution (`tenant.system_bypass`),
 *   - and enumerable: `grep -rn "@SystemRoute" src/` IS the audit trail.
 *
 * Anything not marked and not authenticated fails closed at the Prisma layer.
 */
export const SystemRoute = (reason: SystemReason, justification: string) =>
  SetMetadata<string, SystemRouteMetadata>(SYSTEM_ROUTE_METADATA, { reason, justification });
