import { Inject, Injectable } from '@nestjs/common';

import { BILLING_REPOSITORY, type IBillingRepository } from '../ports/billing.repository.port';
import type { SubscriptionPlanTier } from '../../domain/billing.types';

@Injectable()
export class PlanService {
  constructor(@Inject(BILLING_REPOSITORY) private readonly repository: IBillingRepository) {}

  listActivePlans() {
    return this.repository.findAllActivePlans();
  }

  getPlan(tier: SubscriptionPlanTier) {
    return this.repository.findPlanByTier(tier);
  }
}
