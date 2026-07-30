import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';

import { BILLING_REPOSITORY, type IBillingRepository } from '../ports/billing.repository.port';
import { TrialManager } from './trial-manager.service';
import { PaymentService } from './payment.service';
import { InvoiceService } from './invoice.service';
import type { PaymentProviderValue, SubscriptionPlanTier } from '../../domain/billing.types';

@Injectable()
export class SubscriptionService {
  constructor(
    @Inject(BILLING_REPOSITORY) private readonly repository: IBillingRepository,
    private readonly trialManager: TrialManager,
    private readonly paymentService: PaymentService,
    private readonly invoiceService: InvoiceService,
  ) {}

  getForFamily(familyId: string) {
    return this.repository.findSubscriptionByFamily(familyId);
  }

  /** Every family gets exactly one FREE-tier trial in its lifetime \u2014
   * calling this twice for the same family is rejected, not silently
   * re-granted (a real product-abuse guard, not just a data-shape one). */
  async startTrial(familyId: string) {
    const existing = await this.repository.findSubscriptionByFamily(familyId);
    if (existing) {
      throw new ConflictException('This family already has a subscription record.');
    }

    return this.repository.createSubscription({
      familyId,
      planTier: 'PREMIUM',
      provider: 'MANUAL',
      status: 'TRIALING',
      trialEndsAt: this.trialManager.computeTrialEndDate(),
    });
  }

  /** Subscribes (or converts a trial) to a paid tier via the given
   * provider. Charges immediately via PaymentService \u2014 an unconfigured
   * provider throws PaymentProviderNotConfiguredException, which
   * propagates untouched (a 503, correctly signaling "try again once
   * this is set up," not a generic subscription failure). */
  async subscribe(familyId: string, planTier: SubscriptionPlanTier, provider: PaymentProviderValue) {
    const plan = await this.repository.findPlanByTier(planTier);
    if (!plan) {
      throw new NotFoundException(`Plan tier "${planTier}" does not exist.`);
    }

    let subscription = await this.repository.findSubscriptionByFamily(familyId);
    if (!subscription) {
      subscription = await this.repository.createSubscription({
        familyId,
        planTier,
        provider,
        status: 'ACTIVE',
      });
    }

    const invoice = await this.invoiceService.createDraftInvoice(subscription.id, plan.priceCents, plan.currency);
    const chargeResult = await this.paymentService.charge(provider, subscription.id, plan.priceCents, plan.currency);

    if (chargeResult.success) {
      await this.invoiceService.markPaid(invoice.id);
      const periodStart = new Date();
      const periodEnd = new Date(periodStart);
      periodEnd.setMonth(periodEnd.getMonth() + plan.billingIntervalMonths);
      await this.repository.updateSubscriptionStatus(subscription.id, 'ACTIVE', {
        currentPeriodStart: periodStart,
        currentPeriodEnd: periodEnd,
      });
    } else {
      await this.repository.updateSubscriptionStatus(subscription.id, 'PAST_DUE');
    }

    return { subscription, invoice, chargeResult };
  }

  async cancel(familyId: string) {
    const subscription = await this.repository.findSubscriptionByFamily(familyId);
    if (!subscription) {
      throw new NotFoundException('No subscription found for this family.');
    }
    await this.repository.updateSubscriptionStatus(subscription.id, 'CANCELED', { canceledAt: new Date() });
  }

  async getBillingHistory(familyId: string) {
    const subscription = await this.repository.findSubscriptionByFamily(familyId);
    if (!subscription) return [];
    return this.invoiceService.listForSubscription(subscription.id);
  }
}
