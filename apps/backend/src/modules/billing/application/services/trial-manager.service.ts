import { Inject, Injectable } from '@nestjs/common';

import { BILLING_REPOSITORY, type IBillingRepository } from '../ports/billing.repository.port';

const DEFAULT_TRIAL_DAYS = 14;

@Injectable()
export class TrialManager {
  constructor(@Inject(BILLING_REPOSITORY) private readonly repository: IBillingRepository) {}

  computeTrialEndDate(startDate: Date = new Date(), trialDays: number = DEFAULT_TRIAL_DAYS): Date {
    const end = new Date(startDate);
    end.setDate(end.getDate() + trialDays);
    return end;
  }

  async isInTrial(familyId: string): Promise<boolean> {
    const subscription = await this.repository.findSubscriptionByFamily(familyId);
    if (!subscription || subscription.status !== 'TRIALING' || !subscription.trialEndsAt) {
      return false;
    }
    return subscription.trialEndsAt.getTime() > Date.now();
  }

  async trialDaysRemaining(familyId: string): Promise<number> {
    const subscription = await this.repository.findSubscriptionByFamily(familyId);
    if (!subscription?.trialEndsAt) return 0;
    const msRemaining = subscription.trialEndsAt.getTime() - Date.now();
    return Math.max(0, Math.ceil(msRemaining / (24 * 60 * 60 * 1000)));
  }
}
