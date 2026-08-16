import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';

import { BILLING_REPOSITORY, type IBillingRepository } from '../ports/billing.repository.port';
import { TrialManager } from './trial-manager.service';
import { PaymentService } from './payment.service';
import { InvoiceService } from './invoice.service';
import { AuditService } from '../../../audit/application/audit.service';
import { GrowthEventEmitter } from '../../../analytics/application/growth-event-emitter.service';
import type { PaymentProviderValue, SubscriptionPlanTier } from '../../domain/billing.types';

@Injectable()
export class SubscriptionService {
  constructor(
    @Inject(BILLING_REPOSITORY) private readonly repository: IBillingRepository,
    private readonly trialManager: TrialManager,
    private readonly paymentService: PaymentService,
    private readonly invoiceService: InvoiceService,
    private readonly auditService: AuditService,
    /**
     * PHASE D (GROWTH). The five commercial growth events are emitted from the
     * paths that already own the fact — never re-derived from a table by a
     * reporting job, which would make a marker appear hours after the money
     * moved and would be silently wrong for any row written before Phase D.
     *
     * NOTE WHAT THESE EVENTS ARE AND ARE NOT: they are MARKERS for funnel
     * counting and channel slicing. REVENUE IS NEVER SUMMED FROM THEM — it is
     * summed from `payment_transactions`, which the database itself keeps
     * append-only. An analytics event is a copy; the transaction is the fact.
     */
    private readonly growthEvents: GrowthEventEmitter,
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

    const created = await this.repository.createSubscription({
      familyId,
      planTier: 'PREMIUM',
      provider: 'MANUAL',
      status: 'TRIALING',
      trialEndsAt: this.trialManager.computeTrialEndDate(),
    });

    await this.growthEvents.emit({
      name: 'TRIAL_STARTED',
      familyId,
      sessionId: `billing:${familyId}`,
      payload: { planTier: 'PREMIUM', provider: 'MANUAL' },
    });

    return created;
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

    await this.growthEvents.emit({
      name: chargeResult.success ? 'PAYMENT_SUCCESS' : 'PAYMENT_FAILED',
      familyId,
      userId: actorUserId,
      sessionId: `billing:${familyId}`,
      payload: {
        planTier,
        provider,
        // The AMOUNT is a slicing dimension only. `payment_transactions` is the
        // authority on money and is what every revenue KPI sums.
        amountMinor: invoice?.amountCents,
        failureReason: chargeResult.success ? undefined : 'CHARGE_DECLINED',
      },
    });

    if (chargeResult.success) {
      await this.growthEvents.emit({
        name: 'SUBSCRIPTION_STARTED',
        familyId,
        userId: actorUserId,
        sessionId: `billing:${familyId}`,
        payload: { planTier, provider },
      });
    }

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

    await this.growthEvents.emit({
      name: 'SUBSCRIPTION_CANCELLED',
      familyId,
      userId: actorUserId,
      sessionId: `billing:${familyId}`,
      payload: { planTier: subscription.planTier, provider: subscription.provider },
    });
  }

  async getBillingHistory(familyId: string) {
    const subscription = await this.repository.findSubscriptionByFamily(familyId);
    if (!subscription) return [];
    return this.invoiceService.listForSubscription(subscription.id);
  }
}
