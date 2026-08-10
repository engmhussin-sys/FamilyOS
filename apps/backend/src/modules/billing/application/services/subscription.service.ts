import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';

import { BILLING_REPOSITORY, type IBillingRepository } from '../ports/billing.repository.port';
import { TrialManager } from './trial-manager.service';
import { PaymentService } from './payment.service';
import { InvoiceService } from './invoice.service';
import { AuditService } from '../../../audit/application/audit.service';
import type { PaymentProviderValue, SubscriptionPlanTier } from '../../domain/billing.types';

@Injectable()
export class SubscriptionService {
  constructor(
    @Inject(BILLING_REPOSITORY) private readonly repository: IBillingRepository,
    private readonly trialManager: TrialManager,
    private readonly paymentService: PaymentService,
    private readonly invoiceService: InvoiceService,
    private readonly auditService: AuditService,
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
  async subscribe(
    familyId: string,
    planTier: SubscriptionPlanTier,
    provider: PaymentProviderValue,
    actorUserId?: string,
  ) {
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

    // CLOSES A REAL GAP (previously explicitly flagged: "DISCOUNT
    // codes are not yet supported"). Computed ONCE and used for BOTH
    // the invoice and the actual charge below — they must never
    // diverge (a real bug risk avoided by not computing this twice
    // separately).
    const discountPercent = subscription.pendingDiscountPercent;
    const finalAmountCents = discountPercent
      ? Math.round(plan.priceCents * (1 - discountPercent / 100))
      : plan.priceCents;

    const invoice = await this.invoiceService.createDraftInvoice(subscription.id, finalAmountCents, plan.currency);
    const chargeResult = await this.paymentService.charge(provider, subscription.id, finalAmountCents, plan.currency);

    // One-time use: clear immediately after being applied, regardless
    // of charge success/failure — a failed charge should require
    // redeeming a fresh code, not silently retry the same discount
    // indefinitely on every subsequent attempt.
    if (discountPercent) {
      await this.repository.clearPendingDiscount(subscription.id);
    }

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

    await this.auditService.record({
      actorType: actorUserId ? 'USER' : 'SYSTEM',
      actorUserId,
      action: chargeResult.success ? 'billing.subscribed' : 'billing.charge_failed',
      entityType: 'Subscription',
      entityId: subscription.id,
      metadata: { planTier, provider, success: chargeResult.success },
    });

    return { subscription, invoice, chargeResult };
  }

  async cancel(familyId: string, actorUserId?: string) {
    const subscription = await this.repository.findSubscriptionByFamily(familyId);
    if (!subscription) {
      throw new NotFoundException('No subscription found for this family.');
    }
    await this.repository.updateSubscriptionStatus(subscription.id, 'CANCELED', { canceledAt: new Date() });

    await this.auditService.record({
      actorType: actorUserId ? 'USER' : 'SYSTEM',
      actorUserId,
      action: 'billing.canceled',
      entityType: 'Subscription',
      entityId: subscription.id,
    });
  }

  async getBillingHistory(familyId: string) {
    const subscription = await this.repository.findSubscriptionByFamily(familyId);
    if (!subscription) return [];
    return this.invoiceService.listForSubscription(subscription.id);
  }
}
