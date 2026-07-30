import { Inject, Injectable } from '@nestjs/common';

import { BILLING_REPOSITORY, type IBillingRepository } from '../ports/billing.repository.port';
import type { EntitlementKey } from '../../domain/billing.types';

const ENTITLED_STATUSES = new Set(['TRIALING', 'ACTIVE']);

/**
 * The actual feature-gating logic every other module should call
 * (once wired in \u2014 no existing feature currently calls this, since
 * this is Sprint 8's first pass at billing; wiring `AiDiagnosticsService`/
 * `RecommendationEngineService` to check entitlements is a real,
 * separate follow-up, not silently done here). A family with no
 * subscription row at all is treated as FREE tier \u2014 the same default
 * `Family.subscriptionPlan` already has at the schema level.
 */
@Injectable()
export class EntitlementsService {
  constructor(@Inject(BILLING_REPOSITORY) private readonly repository: IBillingRepository) {}

  async hasFeature(familyId: string, feature: EntitlementKey): Promise<boolean> {
    const subscription = await this.repository.findSubscriptionByFamily(familyId);

    const tier = subscription?.planTier ?? 'FREE';
    if (subscription && !ENTITLED_STATUSES.has(subscription.status)) {
      // PAST_DUE/CANCELED/EXPIRED — the family HAD a paid tier but isn't
      // currently entitled to it. Falls through to FREE's plan lookup below.
      const plan = await this.repository.findPlanByTier('FREE');
      return plan?.features.includes(feature) ?? false;
    }

    const plan = await this.repository.findPlanByTier(tier);
    return plan?.features.includes(feature) ?? false;
  }
}
