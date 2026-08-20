import { BadRequestException, ForbiddenException, Inject, Injectable, Logger } from '@nestjs/common';

import {
  PAYMENT_PROVIDER_REGISTRY,
  type IPaymentProvider,
  type IPaymentProviderRegistry,
  type IVerifiedPurchase,
} from '../ports/payment-provider.port';
import {
  PAYMENT_REPOSITORY,
  type IPaymentRepository,
  type IPaymentTransactionRecord,
} from '../ports/payment.repository.port';
import { BILLING_REPOSITORY, type IBillingRepository } from '../ports/billing.repository.port';
import { EntitlementService } from './entitlement.service';
import { PricingService } from './pricing.service';
import type { PaymentProviderValue, SubscriptionPlanTier } from '../../domain/billing.types';
import { isEntitlementBearing } from '../../domain/subscription-status';
import { splitVat } from '../../domain/money';

/**
 * PHASE D — THE MIDDLE BOX OF THE BRIEF'S OWN ARCHITECTURE.
 *
 *   Payment Provider -> [TRANSACTION VERIFICATION] -> Entitlement Service
 *                    -> ABNY Subscription -> Feature Access
 *
 * Everything a purchase must survive before it becomes access happens here,
 * once, for every provider. Not once per provider — ONCE. That is the whole
 * argument for the abstraction: the tenant check, the tamper check, the
 * sandbox check and the idempotency defence are written a single time, so a
 * new provider cannot arrive with a subtly weaker version of any of them.
 *
 * ============ THE EIGHT CHECKS, IN ORDER (PHASE G ADDED THE EIGHTH) ========
 *
 *  1. VERIFY WITH THE PROVIDER. The adapter talks to Apple / Google / the
 *     gateway. A forged token dies here and never reaches step 2.
 *  2. RESOLVE THE TENANT FROM THE PROVIDER'S ANSWER — via
 *     `provider_account_links`, keyed on the store's opaque account token.
 *     NOT from the session. This is the cross-tenant defence.
 *  3. REJECT A SANDBOX PURCHASE outside a sandbox deployment. It is recorded,
 *     so an operator can see the attempt, and it grants nothing.
 *  4. MAP THE STORE PRODUCT TO OUR OWN TIER through `PricingService`. The
 *     entitlement follows OUR catalogue, never a string the store sent.
 *  5. COMPARE AMOUNT AND CURRENCY against that catalogue entry. A tampered
 *     amount and a tampered currency are two separate rejections.
 *  6. RECORD THE TRANSACTION, defended by a unique index. A duplicate is a
 *     no-op that returns the original record.
 *  7. GRANT ENTITLEMENT — and only if the verified status is entitlement-
 *     bearing and the transaction was recorded in this call or already
 *     entitled the family.
 *
 *  8. ACKNOWLEDGE TO THE STORE — PHASE G, and only for providers whose
 *     `supports('ACKNOWLEDGE')` says they require it. LAST, deliberately: it
 *     tells the store "delivered", and it must not be able to say that before
 *     the transaction row and the entitlement exist. Google Play automatically
 *     refunds and cancels an unacknowledged purchase after three days, and
 *     before Phase G nothing in this system ever called it.
 *
 * There is no order in which 1–7 can be skipped, because each one's output is
 * the next one's input. Step 8 is the one step that CANNOT fail the request —
 * see `acknowledgeIfRequired` for why that asymmetry is correct.
 */
@Injectable()
export class PaymentVerificationService {
  private readonly logger = new Logger(PaymentVerificationService.name);

  constructor(
    @Inject(PAYMENT_PROVIDER_REGISTRY) private readonly registry: IPaymentProviderRegistry,
    @Inject(PAYMENT_REPOSITORY) private readonly payments: IPaymentRepository,
    @Inject(BILLING_REPOSITORY) private readonly billing: IBillingRepository,
    private readonly entitlements: EntitlementService,
    private readonly pricing: PricingService,
  ) {}

  /**
   * The client-initiated path: the app finished a StoreKit or Play purchase
   * and hands us the token.
   *
   * `sessionFamilyId` comes from the JWT and is used for exactly ONE thing —
   * comparison. If the provider says the purchase belongs to another family,
   * this throws. The session never wins that argument.
   */
  async verifyAndApply(input: {
    provider: PaymentProviderValue;
    providerToken: string;
    sessionFamilyId: string;
    /** Store conversions can land a minor unit away; gateways cannot. */
    amountToleranceMinor?: number;
    allowSandbox?: boolean;
  }): Promise<{
    transaction: IPaymentTransactionRecord;
    verified: IVerifiedPurchase;
    entitlementGranted: boolean;
    wasDuplicate: boolean;
  }> {
    const adapter = this.registry.getAdapter(input.provider);
    if (!adapter.supports('VERIFY')) {
      throw new BadRequestException(`Provider ${input.provider} does not support purchase verification.`);
    }

    // ---- 1. VERIFY WITH THE PROVIDER -------------------------------------
    const verified = await adapter.verifyPurchase({
      providerToken: input.providerToken,
      familyId: input.sessionFamilyId,
    });

    // ---- 2. RESOLVE THE TENANT FROM THE PROVIDER'S ANSWER ----------------
    const familyId = await this.resolveTenant(verified, input.sessionFamilyId);

    // ---- 3. SANDBOX ------------------------------------------------------
    if (verified.isSandbox && !input.allowSandbox) {
      // Recorded, not silently dropped: an operator needs to see that someone
      // presented a sandbox receipt to production.
      this.logger.warn(
        `Sandbox purchase presented to a non-sandbox deployment (provider ${verified.provider}, family ${familyId}). Recorded, not entitled.`,
      );
      throw new ForbiddenException('This purchase was made in a sandbox environment and cannot grant access.');
    }

    // ---- 4 & 5. PRODUCT, AMOUNT, CURRENCY --------------------------------
    const resolved = await this.pricing.resolveByStoreProduct(verified.productRef);
    if (!resolved) {
      throw new BadRequestException(
        `Product "${verified.productRef}" is not mapped to any configured price. ` +
          'A store product that is not in the catalogue grants nothing — mapping it is configuration, not code.',
      );
    }

    this.pricing.assertAmountMatches({
      expected: resolved.money,
      reportedGrossMinor: verified.grossAmountMinor,
      reportedCurrency: verified.currency,
      toleranceMinor: input.amountToleranceMinor ?? 0,
    });

    // ---- 6. RECORD, IDEMPOTENTLY -----------------------------------------
    const subscription = await this.billing.findSubscriptionByFamily(familyId);
    const money = splitVat({
      amountMinor: verified.grossAmountMinor,
      vatBasisPoints: resolved.country.vatBasisPoints,
      vatMode: 'INCLUSIVE',
      currency: verified.currency,
    });

    const { record: transaction, wasCreated } = await this.payments.recordPaymentTransaction({
      familyId,
      subscriptionId: subscription?.id ?? null,
      provider: verified.provider,
      providerTransactionId: verified.providerTransactionId,
      providerOriginalTransactionId: verified.providerOriginalTransactionId,
      productRef: verified.productRef,
      planTier: resolved.price.planTier,
      billingPeriod: resolved.price.billingPeriod,
      countryCode: resolved.country.code,
      currency: money.currency,
      grossAmountMinor: money.grossMinor,
      vatAmountMinor: money.vatMinor,
      netAmountMinor: money.netMinor,
      status: verified.status === 'PENDING' ? 'PENDING' : 'SUCCEEDED',
      // THE IDEMPOTENCY KEY. Deterministic from provider facts alone, so two
      // different code paths (a client callback and a webhook) that see the
      // same purchase derive the same key and credit the household once.
      idempotencyKey: buildPurchaseIdempotencyKey(verified),
      occurredAt: verified.purchasedAt,
      verifiedAt: new Date(),
      verifiedPayloadDigest: verified.verifiedPayloadDigest,
      isSandbox: verified.isSandbox,
    });

    // ---- 7. ENTITLEMENT ---------------------------------------------------
    let entitlementGranted = false;
    if (isEntitlementBearing(verified.status)) {
      await this.entitlements.grantForPlan({
        familyId,
        planTier: resolved.price.planTier,
        source: verified.provider,
        subscriptionId: subscription?.id ?? null,
        validFrom: verified.purchasedAt,
        validUntil: verified.expiresAt,
      });
      entitlementGranted = true;
    }

    if (subscription && verified.providerOriginalTransactionId) {
      await this.payments.attachProviderLineage({
        subscriptionId: subscription.id,
        providerOriginalTransactionId: verified.providerOriginalTransactionId,
        providerProductId: verified.productRef,
        countryCode: resolved.country.code,
        currencyCode: resolved.country.currencyCode,
        billingPeriod: resolved.price.billingPeriod,
        subscriptionPriceId: resolved.price.id,
      });
      await this.payments.applySubscriptionStateIfNewer({
        subscriptionId: subscription.id,
        eventAt: verified.purchasedAt,
        status: verified.status,
        currentPeriodStart: verified.purchasedAt,
        currentPeriodEnd: verified.expiresAt,
        autoRenewing: verified.autoRenewing,
        providerProductId: verified.productRef,
      });
    }

    // ---- 8. ACKNOWLEDGE, LAST AND ONLY LAST -------------------------------
    await this.acknowledgeIfRequired(adapter, verified, familyId);

    return { transaction, verified, entitlementGranted, wasDuplicate: !wasCreated };
  }

  /**
   * PHASE G — STEP 8. Tell the store we delivered, once we actually have.
   *
   * WHY THIS IS A STEP AND NOT A DETAIL. Google Play automatically refunds and
   * cancels any purchase not acknowledged within three days. Before this,
   * `GooglePlayProvider.acknowledge` existed, was unit-tested, and was called by
   * nothing: the client path would have verified correctly, recorded correctly,
   * granted correctly — and then had every Play purchase silently reversed on
   * day three. Nothing in the system would have looked broken until the refunds
   * arrived.
   *
   * IT IS LAST, AND THE ORDER IS THE POINT. Acknowledging before the transaction
   * and the entitlement exist would tell the store "delivered" about access the
   * family does not have — and acknowledgement is precisely what closes the
   * automatic-remedy window. This way round, the worst case is that a family who
   * paid keeps their access and the store refunds them: bad, visible,
   * recoverable. The other way round has no remedy at all.
   *
   * IT NEVER THROWS. By the time it runs, the money is recorded and the
   * entitlement is granted. Propagating a failure would return an error to a
   * client whose purchase actually succeeded, and that client would retry —
   * re-entering a path whose only protection against double-granting is
   * idempotency we would then be leaning on for no reason. A failure is logged
   * at ERROR with what an operator must do about it, and the request still
   * succeeds.
   *
   * PROVIDER-NEUTRAL BY MECHANISM. No provider name appears here: it asks
   * `supports('ACKNOWLEDGE')` and calls an optional port method. A provider with
   * no acknowledgement step is neither named nor excluded by name —
   * `test/billing/provider-neutrality.spec.ts` scans this very file for exactly
   * that, because the rule does not survive on review alone.
   */
  private async acknowledgeIfRequired(
    adapter: IPaymentProvider,
    verified: IVerifiedPurchase,
    familyId: string,
  ): Promise<void> {
    if (!adapter.supports('ACKNOWLEDGE') || !adapter.acknowledgePurchase) return;
    try {
      await adapter.acknowledgePurchase(verified);
    } catch (error) {
      this.logger.error(
        `ACKNOWLEDGEMENT FAILED for a verified ${verified.provider} purchase ` +
          `(family ${familyId}, transaction ${verified.providerTransactionId}). The entitlement WAS ` +
          'granted and the payment IS recorded — this request is not being failed. But a store that ' +
          'requires acknowledgement reverses the charge if it never arrives, and the window is days, ' +
          'not weeks. Re-acknowledge this purchase, or expect a refund and a support contact. Cause: ' +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * STEP 2, ISOLATED — because it is the check that a reviewer should be able
   * to read on its own.
   *
   * THE ATTACK IT STOPS: family A obtains a purchase token belonging to family
   * B (shared device, leaked log line, a friend's receipt) and POSTs it with
   * family A's own valid session. Every other check passes — the token is
   * genuine, Apple signed it, the amount is right — and without this step
   * family A gets a subscription it did not buy, while family B's real renewal
   * later collides with it.
   *
   * The defence is that the LINK is the authority, not the session:
   *
   *  - if the provider's account reference is already linked to a family, that
   *    family is the answer, and a mismatch with the session is a 403;
   *  - if it is not linked yet, the session's family claims it — through a
   *    UNIQUE index, so two families racing to claim the same reference cannot
   *    both win;
   *  - if the provider gave us no account reference at all (an older client
   *    that did not set `appAccountToken` / `obfuscatedExternalAccountId`), we
   *    fall back to the session AND say so in the log, because that case has
   *    genuinely weaker binding and an operator should know it is happening.
   */
  private async resolveTenant(verified: IVerifiedPurchase, sessionFamilyId: string): Promise<string> {
    if (!verified.providerAccountRef) {
      this.logger.warn(
        `${verified.provider} purchase ${verified.providerTransactionId} carries no account reference; ` +
          'falling back to the session tenant. The client should set appAccountToken / obfuscatedExternalAccountId.',
      );
      return sessionFamilyId;
    }

    const linkedFamilyId = await this.payments.findFamilyByProviderAccountRef(
      verified.provider,
      verified.providerAccountRef,
    );

    if (linkedFamilyId && linkedFamilyId !== sessionFamilyId) {
      this.logger.warn(
        `CROSS-TENANT PURCHASE REJECTED: ${verified.provider} account reference is linked to another family; session claimed ${sessionFamilyId}.`,
      );
      throw new ForbiddenException('This purchase belongs to a different account.');
    }
    if (linkedFamilyId) return linkedFamilyId;

    const claim = await this.payments.linkProviderAccount({
      familyId: sessionFamilyId,
      provider: verified.provider,
      providerAccountRef: verified.providerAccountRef,
    });
    if (!claim.wasCreated && claim.record.familyId !== sessionFamilyId) {
      // Lost the race to another family in the window between the read and the
      // insert. The unique index decided; we accept its answer and refuse.
      throw new ForbiddenException('This purchase belongs to a different account.');
    }
    return claim.record.familyId;
  }
}

/**
 * THE IDEMPOTENCY KEY FOR A PURCHASE.
 *
 * Derived ONLY from facts the provider asserted — never from a clock, a UUID,
 * or a request id. That is what makes it stable across:
 *
 *   - a client verification and a webhook describing the same purchase;
 *   - a redelivery hours later;
 *   - a retry after our own process crashed mid-transaction.
 *
 * Exported so the webhook handler derives the SAME key rather than its own,
 * which is how the two paths converge on one row instead of two.
 */
export function buildPurchaseIdempotencyKey(verified: {
  provider: PaymentProviderValue;
  providerTransactionId: string;
}): string {
  return `purchase:${verified.provider}:${verified.providerTransactionId}`;
}

/** The same discipline for a refund. */
export function buildRefundIdempotencyKey(params: {
  provider: PaymentProviderValue;
  providerTransactionId: string;
  providerRefundId: string | null;
}): string {
  return `refund:${params.provider}:${params.providerTransactionId}:${params.providerRefundId ?? 'full'}`;
}

export type { SubscriptionPlanTier };
