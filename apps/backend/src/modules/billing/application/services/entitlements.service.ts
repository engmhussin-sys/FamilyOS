import { Injectable } from '@nestjs/common';

import { EntitlementService } from './entitlement.service';
import type { EntitlementKey } from '../../domain/billing.types';

/**
 * ============================================================================
 * SPRINT F1 (P0) — A DELEGATE. IT DECIDES NOTHING.
 * ============================================================================
 *
 * THE DEFECT THAT EMPTIED THIS FILE. Until this change, this class carried its
 * OWN `hasFeature` with its own inline `ENTITLED_STATUSES = {TRIALING, ACTIVE}`,
 * and `EntitlementService` (singular) carried a different one that read the
 * `entitlements` table and treated `{TRIALING, ACTIVE, GRACE_PERIOD}` as
 * entitled. Two services answered «is this family entitled to feature X?» and
 * they disagreed, in both directions, on live routes:
 *
 *   · A HOUSEHOLD THAT HAD PAID WAS REFUSED. schema.prisma states GRACE_PERIOD
 *     keeps FULL access for seven days after a failed renewal. This class said
 *     no — so `POST /children` (second child), `POST /pairing/device/register`
 *     (second device for one child), `POST /support` (priority) and
 *     `GET /life-intelligence/insights/:childId/weekly` all refused a paying
 *     family inside its grace window.
 *   · A HOUSEHOLD THAT HAD BEEN REFUNDED KEPT ACCESS. This class never read the
 *     `entitlements` table, so `EntitlementService.revokeAll` — refund,
 *     chargeback, provider revocation — changed nothing about what those four
 *     surfaces allowed.
 *
 * WHY THE SYMBOL SURVIVES. It is the DI token four modules inject
 * (`ChildrenService`, `PairingOrchestratorService`, `SupportService`,
 * `FamilyInsightService`) and that their unit suites — owned elsewhere, and
 * out of bounds for this change — provide by name. So the SYMBOL stays and THE
 * LOGIC DOES NOT: every caller of this class now reaches
 * `EntitlementService.hasFeature`, the single implementation in `src/`.
 *
 * NOTHING MAY BE ADDED HERE. Not a branch, not a status, not a cache. The
 * moment this file decides anything, there are two answers again —
 * `test/authz/entitlement-single-authority.guard.spec.ts` reads this method's
 * body and fails the build if it does. New code injects `EntitlementService`.
 *
 * @deprecated Inject `EntitlementService` instead.
 */
@Injectable()
export class EntitlementsService {
  constructor(private readonly entitlements: EntitlementService) {}

  async hasFeature(familyId: string, feature: EntitlementKey): Promise<boolean> {
    return this.entitlements.hasFeature(familyId, feature);
  }
}
