import { Inject, Injectable, Logger } from '@nestjs/common';

import {
  PAYMENT_REPOSITORY,
  type IEntitlementRecord,
  type IPaymentRepository,
} from '../ports/payment.repository.port';
import { BILLING_REPOSITORY, type IBillingRepository } from '../ports/billing.repository.port';
import type { EntitlementKey, PaymentProviderValue, SubscriptionPlanTier } from '../../domain/billing.types';
import { isEntitlementBearing, toCanonicalStatus } from '../../domain/subscription-status';

/**
 * PHASE D — THE ENTITLEMENT SERVICE. THE ONLY ANSWER TO «AM I ALLOWED?».
 *
 * ==================== THE RULE, AND WHY IT IS THE RULE ====================
 *
 * `00-Company-Response.md` Q17, first line: «الصلاحية تُحسم على الخادم فقط» —
 * entitlement is decided on the server, only. The app never decides whether a
 * user is subscribed; it asks. No local receipt, no device flag, no inference
 * from the last payment. Any entitlement logic on the client is defeated in
 * minutes.
 *
 * And the second half, which is what «provider-neutral» means concretely:
 *
 *   FEATURE ACCESS RESOLVES THROUGH AN `Entitlement` ROW — NEVER THROUGH
 *   «WHICH PROVIDER PAID».
 *
 * `Entitlement.source` records the channel (`APPLE_IAP` / `GOOGLE_PLAY` /
 * `PAYMOB` / `FAWRY` / `MOYASAR` / `MANUAL`) because accounting and the refund
 * rule need it — «a Play purchase is refunded only through Play» — but NO
 * BRANCH IN THIS FILE READS IT TO DECIDE ACCESS. A family that paid Fawry cash
 * at a kiosk and a family that tapped Buy in the App Store reach exactly the
 * same code here, and `test/billing/provider-neutrality.spec.ts` asserts that
 * by reading this file's own source for provider literals.
 *
 * ==================== HOW A GRANT BECOMES A ROW ====================
 *
 * `grantForPlan` is called by `PaymentVerificationService` AFTER a provider
 * verification succeeded, and only then. The features granted come from
 * `PlanDefinition.features` — the existing Sprint 8 catalogue, reused
 * unchanged — so «what does Premium include» stays one editable list and does
 * not fork per provider.
 *
 * ================ SPRINT F1 (P0) — THERE IS NOW ONE OF THESE ================
 *
 * `EntitlementsService` (Sprint 8, PLURAL) used to be a SECOND implementation
 * of `hasFeature` that computed access live from `subscription.status` +
 * `PlanDefinition.features` with its own inline `{TRIALING, ACTIVE}` set. The
 * two answers disagreed in both directions and both were live:
 *
 *   · A GRACE_PERIOD household — a household that HAS PAID, whose card failed
 *     on renewal — was refused a second child, a second device, priority
 *     support and insights, against schema.prisma's own promise of full access
 *     for seven days.
 *   · A household whose entitlements had been REVOKED (refund, chargeback,
 *     expiry) kept all four whenever `revokeAll` ran without the subscription
 *     row also moving — which `PaymentWebhookService` does on the
 *     EXPIRED/REVOKED and refund paths, where `applySubscriptionStateIfNewer`
 *     may legitimately drop a stale, out-of-order event and `revokeAll` runs
 *     anyway.
 *
 * That service is now a ZERO-LOGIC DELEGATE to this one; this file is the only
 * place in `src/` where the question is answered, and
 * `test/authz/entitlement-single-authority.guard.spec.ts` fails the build if a
 * second implementation reappears. The compatibility computation below is that
 * old service's logic, absorbed — not deleted, because every family that
 * subscribed before Phase D still has no entitlement rows, and a migration that
 * back-filled them from inferred state would be inventing financial history.
 * It differs from what the plural did in exactly one respect: the status set is
 * no longer written here at all. It is read from `ENTITLEMENT_STATUS_LEDGER`,
 * which carries a decision and a REASON for all eight statuses and cannot
 * silently omit a ninth.
 */
@Injectable()
export class EntitlementService {
  private readonly logger = new Logger(EntitlementService.name);

  constructor(
    @Inject(PAYMENT_REPOSITORY) private readonly payments: IPaymentRepository,
    @Inject(BILLING_REPOSITORY) private readonly billing: IBillingRepository,
  ) {}

  /**
   * THE QUESTION EVERY FEATURE ASKS.
   *
   * Three ways to be entitled, checked in this order:
   *   1. a live `Entitlement` row whose window contains `now` — the Phase D path;
   *   2. failing that, the Sprint 8 computation from the subscription's tier
   *      and status — the compatibility path for pre-Phase-D families;
   *   3. otherwise the FREE tier's feature list.
   *
   * A revoked or expired row is NOT a fall-through to (2): revocation is a
   * decision, and letting an inferred computation override it would undo every
   * refund.
   */
  async hasFeature(familyId: string, feature: EntitlementKey, now: Date = new Date()): Promise<boolean> {
    const entitlement = await this.payments.findEntitlement(familyId, feature);
    if (entitlement) return isLive(entitlement, now);

    // COMPATIBILITY PATH. No row exists for this feature at all — either the
    // family predates Phase D, or it never bought anything, or it subscribed
    // through the Sprint 8 path (`SubscriptionService.subscribe` /
    // `startTrial`), which writes a `subscriptions` row and no entitlement row.
    //
    // THE STATUS SET IS NOT WRITTEN HERE. `ENTITLEMENT_STATUS_LEDGER` in
    // `domain/subscription-status.ts` decides, per status, with the reason
    // beside it. Duplicating three strings into this file is precisely the
    // defect this merge closed.
    const subscription = await this.billing.findSubscriptionByFamily(familyId);
    const tier: SubscriptionPlanTier = subscription?.planTier ?? 'FREE';
    const effectiveTier =
      subscription && !isEntitlementBearing(toCanonicalStatus(subscription.status)) ? 'FREE' : tier;
    const plan = await this.billing.findPlanByTier(effectiveTier);
    return plan?.features.includes(feature) ?? false;
  }

  /** The whole picture, for `GET /billing/entitlements`. */
  async describe(
    familyId: string,
    now: Date = new Date(),
  ): Promise<{
    features: EntitlementKey[];
    records: IEntitlementRecord[];
    validUntil: Date | null;
    source: PaymentProviderValue | null;
    planTier: SubscriptionPlanTier | null;
  }> {
    const records = await this.payments.listEntitlements(familyId);
    const live = records.filter((record) => isLive(record, now));
    return {
      features: live.map((record) => record.featureKey as EntitlementKey),
      records,
      // The EARLIEST expiry across live grants — the honest answer to "until
      // when am I covered", because that is when something first lapses.
      validUntil: live.reduce<Date | null>((soonest, record) => {
        if (!record.validUntil) return soonest;
        if (!soonest) return record.validUntil;
        return record.validUntil < soonest ? record.validUntil : soonest;
      }, null),
      source: live[0]?.source ?? null,
      planTier: live[0]?.planTier ?? null,
    };
  }

  /**
   * Grants every feature of a plan tier, for a window.
   *
   * IDEMPOTENT BY CONSTRUCTION. The repository upserts on
   * `(family_id, feature_key)` with a monotonic `valid_until`, so calling this
   * twice for the same renewal is a no-op and calling it with a STALE window
   * cannot shorten access. That property is what lets the webhook handler be
   * simple: it does not have to know whether it has seen this renewal before.
   */
  async grantForPlan(input: {
    familyId: string;
    planTier: SubscriptionPlanTier;
    source: PaymentProviderValue;
    subscriptionId: string | null;
    validFrom: Date;
    validUntil: Date | null;
  }): Promise<IEntitlementRecord[]> {
    const plan = await this.billing.findPlanByTier(input.planTier);
    if (!plan) {
      this.logger.warn(`No PlanDefinition for tier ${input.planTier}; nothing granted.`);
      return [];
    }

    const granted: IEntitlementRecord[] = [];
    for (const feature of plan.features) {
      granted.push(
        await this.payments.grantEntitlement({
          familyId: input.familyId,
          featureKey: feature as EntitlementKey,
          planTier: input.planTier,
          source: input.source,
          subscriptionId: input.subscriptionId,
          validFrom: input.validFrom,
          validUntil: input.validUntil,
        }),
      );
    }
    return granted;
  }

  /**
   * Revokes everything for a family. Used for a refund, a chargeback, a
   * revocation, and the end of a grace period.
   *
   * NEVER DELETES. Q17 also constrains what revocation may NOT touch, and it
   * is worth restating because it is a product rule with teeth: «no data is
   * deleted, and the child's points are not withdrawn» — punishing a child for
   * a parent's unpaid card violates CONTEXT.md §3.7 (NO PUNITIVE UX). This
   * method touches `entitlements` and nothing else. It cannot reach the reward
   * ledger, and that is by construction, not by care.
   */
  async revokeAll(familyId: string, reason: string, at: Date = new Date()): Promise<number> {
    const count = await this.payments.revokeEntitlements(familyId, reason, at);
    this.logger.log(`Revoked ${count} entitlement(s) for family ${familyId}: ${reason}`);
    return count;
  }

  /**
   * An operator grant — a support gesture, a partner campaign, a pilot family.
   *
   * `source = MANUAL` and `validUntil` may be null (open-ended). This is the
   * ONLY way to create an entitlement without a verified payment, it is
   * deliberately a named method rather than a flag on the normal path, and its
   * callers are behind `InternalAdminGuard`.
   */
  async grantManual(input: {
    familyId: string;
    planTier: SubscriptionPlanTier;
    validUntil: Date | null;
    grantedByUserId: string;
  }): Promise<IEntitlementRecord[]> {
    this.logger.log(
      `MANUAL entitlement grant: family ${input.familyId} -> ${input.planTier} by user ${input.grantedByUserId}.`,
    );
    return this.grantForPlan({
      familyId: input.familyId,
      planTier: input.planTier,
      source: 'MANUAL',
      subscriptionId: null,
      validFrom: new Date(),
      validUntil: input.validUntil,
    });
  }
}

/**
 * THE OTHER HALF OF THE ANSWER, AS DATA — the three states an `entitlements`
 * ROW can be in, each with the reason it does or does not grant access.
 *
 * `ENTITLEMENT_STATUS_LEDGER` (domain/subscription-status.ts) decides what a
 * SUBSCRIPTION status means; this decides what a GRANT means, and a family that
 * has rows is answered here FIRST. Keyed by the record's own status union, so a
 * fourth row state cannot be added to `IEntitlementRecord` without an entry —
 * the same compile-time promise, for the same reason.
 */
export const ENTITLEMENT_ROW_LEDGER: Readonly<
  Record<IEntitlementRecord['status'], { readonly live: boolean; readonly because: string }>
> = {
  ACTIVE: {
    live: true,
    because: 'A verified payment granted it and nothing has withdrawn it. Still subject to the window below.',
  },
  REVOKED: {
    live: false,
    because:
      '`revokeAll` ran — a refund, a chargeback, a provider REVOKED/EXPIRED event, or the end of a grace period. Revocation is a DECISION; falling back to a computation from `subscriptions` here would undo every refund the moment a stale status row disagreed.',
  },
  EXPIRED: {
    live: false,
    because: 'The paid window closed and no renewal extended it. Same rule as REVOKED: a decision, not a fall-through.',
  },
};

/** A grant is live when its row state says so and `now` is inside its window. */
function isLive(record: IEntitlementRecord, now: Date): boolean {
  if (!ENTITLEMENT_ROW_LEDGER[record.status].live) return false;
  if (record.validFrom > now) return false;
  if (record.validUntil && record.validUntil <= now) return false;
  return true;
}
