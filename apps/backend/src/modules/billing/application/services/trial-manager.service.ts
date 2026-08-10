import { Inject, Injectable, NotFoundException } from '@nestjs/common';

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

  /** CLOSES A REAL GAP found while building Sprint B4 (Partner
   * Campaigns' TRIAL_EXTENSION type): TrialManager was read-only.
   * Extends from the LATER of (now, current trialEndsAt) — a family
   * whose trial already ended gets exactly `extraDays` from today,
   * not from a stale past date; a family still mid-trial gets the
   * days added on top of their real remaining time, never shortened. */
  async extendTrial(familyId: string, extraDays: number): Promise<Date> {
    const subscription = await this.repository.findSubscriptionByFamily(familyId);
    if (!subscription) {
      throw new NotFoundException(`No subscription found for family "${familyId}" to extend.`);
    }
    const base = subscription.trialEndsAt && subscription.trialEndsAt.getTime() > Date.now()
      ? subscription.trialEndsAt
      : new Date();
    const newTrialEndsAt = this.computeTrialEndDate(base, extraDays);

    await this.repository.updateSubscriptionStatus(subscription.id, 'TRIALING', { trialEndsAt: newTrialEndsAt });
    return newTrialEndsAt;
  }
}
