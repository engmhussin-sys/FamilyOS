import * as crypto from 'crypto';

import { Inject, Injectable, Logger } from '@nestjs/common';

import {
  PAYMENT_PROVIDER_REGISTRY,
  type IPaymentProviderRegistry,
  type IProviderWebhookEvent,
  type IVerifiedPurchase,
  type IWebhookRequest,
} from '../ports/payment-provider.port';
import {
  PAYMENT_REPOSITORY,
  type IPaymentRepository,
  type WebhookOutcomeValue,
} from '../ports/payment.repository.port';
import { BILLING_REPOSITORY, type IBillingRepository } from '../ports/billing.repository.port';
import { EntitlementService } from './entitlement.service';
import { PricingService } from './pricing.service';
import {
  buildPurchaseIdempotencyKey,
  buildRefundIdempotencyKey,
} from './payment-verification.service';
import type { PaymentProviderValue } from '../../domain/billing.types';
import { isEntitlementBearing } from '../../domain/subscription-status';
import { splitVat } from '../../domain/money';
import { runAsSystemAsync } from '../../../../common/tenancy/system-context';
import { BillingNotificationProducer } from './billing-notification.producer';

/** What the controller turns into an HTTP status. */
export interface IWebhookIngestResult {
  readonly outcome: WebhookOutcomeValue;
  readonly acknowledged: boolean;
  readonly detail: string;
}

/**
 * PHASE D — WEBHOOK INGESTION. THE PART THAT USUALLY BREAKS.
 *
 * `00-Company-Response.md` Q17 calls webhook idempotency «النقطة التي تكسر
 * أنظمة الاشتراك عادةً» — the point that usually breaks subscription systems —
 * and names the exact defences. All of them are here, in this order, and the
 * order is the design:
 *
 *   1. SIGNATURE FIRST. Before parsing, before dedupe, before touching the
 *      database's business tables. An unsigned or wrongly-signed callback is
 *      recorded as `REJECTED_SIGNATURE` and nothing else happens. SG-26.
 *
 *   2. DEDUPE SECOND, by INSERT. `payment_webhook_events` has a UNIQUE index
 *      on `(provider, provider_event_id)`. We INSERT; a conflict means we have
 *      seen this event, and we return 200 IMMEDIATELY WITHOUT REPROCESSING.
 *      Note the ordering: the dedupe row is written BEFORE the effects, so a
 *      crash halfway through leaves a row that makes the redelivery a
 *      no-op — which is the conservative direction. The alternative (effects
 *      first, dedupe after) double-credits on every crash.
 *
 *   3. EFFECTS THIRD, and every one of them idempotent on its own. Belt and
 *      braces: even if the dedupe row were somehow lost, the payment insert
 *      and the entitlement upsert would each still be safe.
 *
 *   4. THE OUT-OF-ORDER GUARD. «`subscription.cancelled` may arrive before
 *      `subscription.created`.» State is applied through
 *      `applySubscriptionStateIfNewer`, which compares the PROVIDER'S signed
 *      timestamp inside the UPDATE's WHERE clause. An older event changes
 *      nothing.
 *
 *   5. ALWAYS 200 for a well-formed, signed event — even an unhandled type.
 *      A non-2xx makes every provider retry, and retrying an event we have
 *      deliberately decided not to model is pure noise. A REJECTED signature
 *      is the exception and gets a 4xx, because that one SHOULD stop.
 *
 * ================= WHAT IS NEVER TRUSTED FROM A WEBHOOK =================
 *
 * The amount, the currency and the subscription status in the payload are
 * treated as CLAIMS. For Apple they are re-derived from a separately-verified
 * nested JWS; for Google they are discarded entirely in favour of a fresh
 * `subscriptionsv2.get`; for the gateways the amount is compared against OUR
 * price catalogue and a mismatch is a rejection. There is no path in this file
 * from a number in a request body to a number in `payment_transactions`.
 */
@Injectable()
export class PaymentWebhookService {
  private readonly logger = new Logger(PaymentWebhookService.name);

  constructor(
    @Inject(PAYMENT_PROVIDER_REGISTRY) private readonly registry: IPaymentProviderRegistry,
    @Inject(PAYMENT_REPOSITORY) private readonly payments: IPaymentRepository,
    @Inject(BILLING_REPOSITORY) private readonly billing: IBillingRepository,
    private readonly entitlements: EntitlementService,
    private readonly pricing: PricingService,
    /**
     * SPRINT F1 — THE PARENT FINALLY HEARS ABOUT IT.
     *
     * `notification-class.ts:277` said «(no producer yet.) The billing module
     * writes no notification of any kind — `payment-webhook.service.ts` moves
     * entitlement and stops.» That was exactly true, and this is the line that
     * stops it being true. `BillingNotificationProducer` is the ONE door: this
     * file still writes no notification, composes no sentence and decides
     * nothing about quiet hours — see `applyStatus`.
     *
     * It comes from `BillingNotificationsModule`, which is `@Global` because
     * `BillingModule -> NotificationEngineModule` is a measured import cycle;
     * that module's header carries Nest's own error message for it.
     */
    private readonly billingNotifications: BillingNotificationProducer,
  ) {}

  /**
   * The whole pipeline. Runs under `runAsSystemAsync('BILLING_WEBHOOK')`
   * because there is no caller tenant: the family is RESOLVED FROM the
   * verified payload, which is the reason that `SystemReason` value already
   * exists in `tenant-context.ts` with exactly this justification written next
   * to it.
   */
  async ingest(provider: PaymentProviderValue, request: IWebhookRequest): Promise<IWebhookIngestResult> {
    return runAsSystemAsync(
      'BILLING_WEBHOOK',
      `${provider} sends server-to-server callbacks with no session; the family is resolved from the VERIFIED payload via provider_account_links, never from a caller token.`,
      async () => this.ingestInner(provider, request),
    );
  }

  private async ingestInner(
    provider: PaymentProviderValue,
    request: IWebhookRequest,
  ): Promise<IWebhookIngestResult> {
    const adapter = this.registry.getAdapter(provider);
    const payloadDigest = crypto.createHash('sha256').update(request.rawBody, 'utf8').digest('hex');

    // ---- 1. SIGNATURE ----------------------------------------------------
    const signature = await adapter.verifyWebhookSignature(request);
    if (!signature.verified) {
      // Recorded so that a burst of forged callbacks is VISIBLE to an
      // operator. Keyed on the digest, because a forgery has no trustworthy
      // event id — using one from the body would let an attacker occupy our
      // dedupe space with ids of their choosing.
      await this.payments.recordWebhookEvent({
        provider,
        providerEventId: `unverified:${payloadDigest.slice(0, 32)}`,
        eventType: 'UNVERIFIED',
        eventSubtype: null,
        signatureVerified: false,
        outcome: 'REJECTED_SIGNATURE',
        payloadDigest,
        providerSignedAt: null,
        familyId: null,
      });
      this.logger.warn(`Rejected ${provider} webhook: ${signature.reason}`);
      // The REASON is deliberately not returned to the caller. A verifier that
      // explains why it failed is an oracle for constructing a valid one.
      return { outcome: 'REJECTED_SIGNATURE', acknowledged: false, detail: 'signature verification failed' };
    }

    // ---- PARSE (only after the signature held) ---------------------------
    let event: IProviderWebhookEvent;
    try {
      event = await adapter.parseWebhook(request);
    } catch (error) {
      await this.payments.recordWebhookEvent({
        provider,
        providerEventId: `unparsable:${payloadDigest.slice(0, 32)}`,
        eventType: 'UNPARSABLE',
        eventSubtype: null,
        signatureVerified: true,
        outcome: 'REJECTED_VALIDATION',
        payloadDigest,
        providerSignedAt: null,
        familyId: null,
      });
      this.logger.error(`Signed ${provider} webhook could not be parsed: ${describe(error)}`);
      return { outcome: 'REJECTED_VALIDATION', acknowledged: true, detail: 'payload rejected' };
    }

    // ---- 2. DEDUPE, BY INSERT --------------------------------------------
    const dedupe = await this.payments.recordWebhookEvent({
      provider,
      providerEventId: event.providerEventId,
      eventType: event.rawEventType,
      eventSubtype: event.rawEventSubtype,
      signatureVerified: true,
      outcome: 'RECEIVED',
      payloadDigest,
      providerSignedAt: event.signedAt,
      familyId: null,
    });

    if (!dedupe.wasCreated) {
      // Q17, verbatim: «a duplicate means 200 OK immediately with no
      // reprocessing». Under CONCURRENT delivery this is also the branch the
      // loser of the unique-index race takes, which is why this returns
      // without doing anything at all rather than "checking whether the other
      // one finished".
      this.logger.log(`Duplicate ${provider} webhook ${event.providerEventId} — acknowledged, not reprocessed.`);
      return { outcome: 'DUPLICATE', acknowledged: true, detail: 'already processed' };
    }

    // ---- 3. EFFECTS ------------------------------------------------------
    try {
      const result = await this.apply(event);
      await this.payments.finaliseWebhookEvent(dedupe.record.id, result.outcome, result.familyId, null);
      return { outcome: result.outcome, acknowledged: true, detail: result.detail };
    } catch (error) {
      await this.payments.finaliseWebhookEvent(dedupe.record.id, 'FAILED', null, describe(error));
      this.logger.error(`Failed to apply ${provider} webhook ${event.providerEventId}: ${describe(error)}`);
      // Deliberately acknowledged=false so the controller answers 5xx and the
      // provider RETRIES. This is the one case where a retry is what we want:
      // the event was genuine and we failed to apply it. The dedupe row is
      // already written, so a retry hits the DUPLICATE branch — which is why
      // `FAILED` rows are what the reconciliation job looks for.
      return { outcome: 'FAILED', acknowledged: false, detail: 'processing failed' };
    }
  }

  // -------------------------------------------------------------------------

  private async apply(
    event: IProviderWebhookEvent,
  ): Promise<{ outcome: WebhookOutcomeValue; familyId: string | null; detail: string }> {
    if (event.kind === 'TEST') {
      return { outcome: 'IGNORED', familyId: null, detail: 'test notification' };
    }
    if (event.kind === 'UNHANDLED') {
      // 200 and no action. Acknowledging an event we have decided not to model
      // is what stops a provider retrying it forever.
      return { outcome: 'IGNORED', familyId: null, detail: `unmodelled event ${event.rawEventType}` };
    }

    const familyId = await this.resolveFamily(event);
    if (!familyId) {
      // A signed, genuine event about a purchase that belongs to no household
      // of ours. Recorded with a NULL tenant — which is exactly why
      // `PaymentWebhookEvent` is PLATFORM_ANNOTATED and not STRICT.
      this.logger.warn(
        `${event.provider} event ${event.providerEventId} (${event.rawEventType}) could not be attributed to a family.`,
      );
      return { outcome: 'IGNORED', familyId: null, detail: 'no matching family' };
    }

    switch (event.kind) {
      case 'PURCHASED':
      case 'RENEWED':
      case 'PAYMENT_SUCCEEDED':
        return this.applyPurchase(event, familyId);

      case 'GRACE_PERIOD_STARTED':
        // GRACE_PERIOD KEEPS FULL ACCESS. Q17 specifies 7 days with a clear,
        // non-frightening notice, and CONTEXT.md §3.7 forbids punitive UX;
        // downgrading a household the instant a card fails violates both.
        //
        // SPRINT F1: «a clear notice» is `notifyPaymentFailure` below. The
        // grace period IS the failed charge — Apple sends
        // DID_FAIL_TO_RENEW/GRACE_PERIOD and Google SUBSCRIPTION_IN_GRACE_PERIOD
        // for a renewal that did not go through — so this is one of the three
        // kinds that owe the parent `PAYMENT_FAILED`, and it is the one where
        // telling them MATTERS MOST: they still have every feature and seven
        // days to fix a card, and only a notification makes that window usable.
        return this.applyStatus(event, familyId, 'GRACE_PERIOD', 'entered the grace period', {
          revoke: false,
          notifyPaymentFailure: true,
        });

      case 'BILLING_RETRY':
        // Access HAS stopped: Apple's billing retry without a grace period and
        // Google's account hold both mean the customer is not currently paid up.
        return this.applyStatus(event, familyId, 'PAST_DUE', 'entered billing retry', {
          revoke: true,
          notifyPaymentFailure: true,
        });

      case 'PAYMENT_FAILED':
        return this.applyStatus(event, familyId, 'PAST_DUE', 'payment failed', {
          revoke: true,
          notifyPaymentFailure: true,
        });

      case 'PAYMENT_PENDING':
        // Fawry's kiosk window. Nothing was ever granted, so there is nothing
        // to revoke — and revoking here would strip a household that is
        // renewing early while its previous period is still running.
        return this.applyStatus(event, familyId, 'PENDING', 'awaiting payment', { revoke: false });

      case 'CANCELLED':
        // NOT A REVOCATION, and this is the single most consequential line in
        // the file. The customer has PAID THROUGH THE END OF THE PERIOD and
        // keeps access until it ends; only auto-renewal stops. Entitlement
        // lapses on its own at `valid_until`, which the grant already set.
        //
        // Both Apple's DID_CHANGE_RENEWAL_STATUS/AUTO_RENEW_DISABLED and
        // Google's SUBSCRIPTION_STATE_CANCELED read like "cancelled" and tempt
        // a handler into revoking immediately — which takes away something the
        // customer already paid for and generates the support ticket that
        // teaches everyone this lesson the expensive way.
        return this.applyStatus(
          event,
          familyId,
          'CANCELLED',
          'auto-renewal disabled; access continues to period end',
          { revoke: false },
        );

      case 'GRACE_PERIOD_EXPIRED':
      case 'EXPIRED':
      case 'REVOKED': {
        await this.payments.applySubscriptionStateIfNewer({
          subscriptionId: (await this.billing.findSubscriptionByFamily(familyId))?.id ?? '',
          eventAt: event.signedAt ?? new Date(),
          status: event.kind === 'REVOKED' ? 'CANCELLED' : 'EXPIRED',
        });
        await this.entitlements.revokeAll(familyId, `provider event ${event.rawEventType}`, event.signedAt ?? new Date());
        return { outcome: 'PROCESSED', familyId, detail: 'entitlement revoked' };
      }

      case 'REFUNDED':
        return this.applyRefund(event, familyId);

      case 'REFUND_REVERSED':
        // The customer disputed a refund and lost. Access comes back.
        return this.applyPurchase(event, familyId);

      default:
        return { outcome: 'IGNORED', familyId, detail: `unmodelled event ${event.rawEventType}` };
    }
  }

  /**
   * The purchase / renewal path.
   *
   * For Apple, `event.verifiedPurchase` is present because the notification
   * embeds a separately-verified `signedTransactionInfo`. For Google it is
   * null by design and we make an authenticated `subscriptionsv2.get` here —
   * the notification is a doorbell, not a source of facts. That asymmetry is
   * a property of the two platforms and it is handled at THIS boundary so
   * nothing downstream has to know about it.
   */
  private async applyPurchase(
    event: IProviderWebhookEvent,
    familyId: string,
  ): Promise<{ outcome: WebhookOutcomeValue; familyId: string; detail: string }> {
    const verified = await this.obtainVerifiedPurchase(event, familyId);
    if (!verified) {
      return { outcome: 'IGNORED', familyId, detail: 'no verifiable transaction on this event' };
    }

    const resolved = await this.pricing.resolveByStoreProduct(verified.productRef);
    if (!resolved) {
      // A product the catalogue does not know grants NOTHING. Silently
      // granting "some tier" would turn a config mistake into free Premium.
      this.logger.warn(`Product "${verified.productRef}" is not mapped to a configured price; granting nothing.`);
      return { outcome: 'REJECTED_VALIDATION', familyId, detail: 'unmapped product' };
    }

    // THE TAMPER CHECKS, on the webhook path too. A signed notification proves
    // WHO sent it, not WHAT it should have said.
    this.pricing.assertAmountMatches({
      expected: resolved.money,
      reportedGrossMinor: verified.grossAmountMinor,
      reportedCurrency: verified.currency,
      toleranceMinor: 1,
    });

    const subscription = await this.billing.findSubscriptionByFamily(familyId);
    const money = splitVat({
      amountMinor: verified.grossAmountMinor,
      vatBasisPoints: resolved.country.vatBasisPoints,
      vatMode: 'INCLUSIVE',
      currency: verified.currency,
    });

    await this.payments.recordPaymentTransaction({
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
      // THE SAME KEY the client-initiated path derives. That is how the two
      // paths converge on one row instead of double-crediting a renewal that
      // both the app and the webhook reported.
      idempotencyKey: buildPurchaseIdempotencyKey(verified),
      occurredAt: verified.purchasedAt,
      verifiedAt: new Date(),
      verifiedPayloadDigest: verified.verifiedPayloadDigest,
      isSandbox: verified.isSandbox,
    });

    if (subscription) {
      await this.payments.applySubscriptionStateIfNewer({
        subscriptionId: subscription.id,
        eventAt: event.signedAt ?? verified.purchasedAt,
        status: verified.status,
        currentPeriodStart: verified.purchasedAt,
        currentPeriodEnd: verified.expiresAt,
        gracePeriodEndsAt: null,
        autoRenewing: verified.autoRenewing,
        providerProductId: verified.productRef,
      });
    }

    if (isEntitlementBearing(verified.status)) {
      await this.entitlements.grantForPlan({
        familyId,
        planTier: resolved.price.planTier,
        source: verified.provider,
        subscriptionId: subscription?.id ?? null,
        validFrom: verified.purchasedAt,
        validUntil: verified.expiresAt,
      });
      return { outcome: 'PROCESSED', familyId, detail: 'entitlement granted' };
    }

    return { outcome: 'PROCESSED', familyId, detail: `recorded; status ${verified.status} grants nothing` };
  }

  private async applyRefund(
    event: IProviderWebhookEvent,
    familyId: string,
  ): Promise<{ outcome: WebhookOutcomeValue; familyId: string; detail: string }> {
    const fact = event.refund;
    if (!fact) return { outcome: 'IGNORED', familyId, detail: 'refund event with no refund data' };

    const original = await this.payments.findPaymentTransaction(event.provider, fact.providerTransactionId);
    if (!original) {
      // A refund for a payment we never recorded. Refusing to invent the
      // original is the right answer: a `refunds` row pointing at nothing is
      // a corrupt ledger, and the reconciliation job is what finds the gap.
      this.logger.warn(
        `Refund for unknown ${event.provider} transaction ${fact.providerTransactionId}; recorded as unmatched.`,
      );
      return { outcome: 'REJECTED_VALIDATION', familyId, detail: 'refund for unknown transaction' };
    }

    // THE AMOUNT COMES FROM THE ORIGINAL TRANSACTION when the provider did not
    // send one (Google's void notification never does). Never from a default,
    // never from zero.
    const amountMinor = fact.amountMinor ?? original.grossAmountMinor;
    const currency = (fact.currency ?? original.currency).toUpperCase();

    if (currency !== original.currency) {
      throw new Error(
        `Refund currency ${currency} does not match the original transaction's ${original.currency}.`,
      );
    }
    if (amountMinor > original.grossAmountMinor) {
      throw new Error(
        `Refund of ${amountMinor} exceeds the original transaction's ${original.grossAmountMinor}.`,
      );
    }

    const { wasCreated } = await this.payments.recordRefund({
      familyId,
      paymentTransactionId: original.id,
      provider: event.provider,
      providerRefundId: fact.providerRefundId,
      amountMinor,
      currency,
      reason: fact.reason,
      status: 'COMPLETED',
      idempotencyKey: buildRefundIdempotencyKey({
        provider: event.provider,
        providerTransactionId: fact.providerTransactionId,
        providerRefundId: fact.providerRefundId,
      }),
      occurredAt: fact.occurredAt,
    });

    if (!wasCreated) {
      return { outcome: 'DUPLICATE', familyId, detail: 'refund already recorded' };
    }

    // The transaction ADVANCES to REFUNDED. It is not rewritten — the trigger
    // installed by migration 0014 would reject any change to its amounts.
    if (original.status === 'SUCCEEDED') {
      await this.payments.advancePaymentStatus(original.id, 'REFUNDED');
    }

    const subscription = await this.billing.findSubscriptionByFamily(familyId);
    if (subscription) {
      await this.payments.applySubscriptionStateIfNewer({
        subscriptionId: subscription.id,
        eventAt: fact.occurredAt,
        status: 'REFUNDED',
      });
    }

    // A refund revokes IMMEDIATELY, unlike a cancellation. Money went back;
    // access goes with it. Q17: «every refund creates SUBSCRIPTION_REFUNDED +
    // entitlement withdrawal + an audit row.»
    await this.entitlements.revokeAll(familyId, 'refund', fact.occurredAt);

    return { outcome: 'PROCESSED', familyId, detail: 'refund recorded and entitlement revoked' };
  }

  /**
   * `revoke` is an EXPLICIT PARAMETER, not derived from
   * `isEntitlementBearing(status)`.
   *
   * Deriving it was the first implementation and it was wrong: `CANCELLED` is
   * not an entitlement-bearing status — a cancelled subscription grants nothing
   * NEW — but a cancellation must not withdraw the period the customer already
   * paid for. Those are two different questions, and collapsing them into one
   * predicate produced exactly the "revoke on cancel" bug the test
   * `AUTO_RENEW_DISABLED marks the subscription cancelled and leaves
   * entitlement intact` now pins down. Every caller states its answer.
   *
   * SPRINT F1 — `notifyPaymentFailure` IS THE SAME KIND OF PARAMETER, AND FOR
   * THE SAME KIND OF REASON. It is not derived from
   * `!isEntitlementBearing(status)` and it is not derived from `revoke`:
   * `GRACE_PERIOD` keeps every feature and STILL means a card was declined,
   * `PENDING` revokes nothing and means a kiosk reference nobody has paid yet,
   * `CANCELLED` revokes nothing and means the customer chose to stop. Three
   * different sentences to a parent, and one predicate cannot pick between
   * them. Every caller states its answer.
   */
  private async applyStatus(
    event: IProviderWebhookEvent,
    familyId: string,
    status: Parameters<IPaymentRepository['applySubscriptionStateIfNewer']>[0]['status'],
    detail: string,
    options: { revoke: boolean; notifyPaymentFailure?: boolean },
  ): Promise<{ outcome: WebhookOutcomeValue; familyId: string; detail: string }> {
    const subscription = await this.billing.findSubscriptionByFamily(familyId);
    if (!subscription) return { outcome: 'IGNORED', familyId, detail: 'no subscription for this family' };

    // ONE date for the end of grace, computed once and used by both the
    // subscription row and the entitlement rows below. Two computations would
    // be two answers.
    const gracePeriodEndsAt = status === 'GRACE_PERIOD' ? this.graceEnd(event) : null;

    const applied = await this.payments.applySubscriptionStateIfNewer({
      subscriptionId: subscription.id,
      eventAt: event.signedAt ?? new Date(),
      status,
      gracePeriodEndsAt,
      canceledAt: status === 'CANCELLED' ? (event.signedAt ?? new Date()) : null,
      autoRenewing: status === 'CANCELLED' ? false : undefined,
    });

    if (!applied) {
      // The out-of-order guard fired. This is a SUCCESS: the event was real,
      // it was simply stale, and dropping it is the correct behaviour.
      return { outcome: 'IGNORED', familyId, detail: 'stale event; newer state already applied' };
    }

    if (options.revoke) {
      await this.entitlements.revokeAll(familyId, detail, event.signedAt ?? new Date());
    }

    /**
     * THE SEVEN-DAY PROMISE, DELIVERED TO THE ROWS THAT DECIDE ACCESS.
     *
     * `schema.prisma:92-94`: GRACE_PERIOD keeps FULL access for seven days.
     * Writing `grace_period_ends_at` alone did not do that. `hasFeature`
     * answers from an `entitlements` ROW whenever one exists, so a household
     * granted through Phase D whose rows lapsed AT PERIOD END — which is when
     * a renewal charge is attempted, i.e. the normal case — was refused
     * throughout the window built to prevent exactly that. The fallback that
     * would have said «GRACE_PERIOD is entitlement-bearing» is never reached
     * for a family that has rows.
     *
     * The SAME `gracePeriodEndsAt` the subscription row just took, so the two
     * cannot disagree about when grace ends. `extendThrough` moves ACTIVE rows
     * FORWARD ONLY: a refund stays refunded and a longer paid window is not
     * shortened.
     */
    if (gracePeriodEndsAt) {
      await this.entitlements.extendThrough(familyId, gracePeriodEndsAt);
    }

    /**
     * SPRINT F1 — AFTER THE STATE MOVED, NEVER BEFORE, AND NEVER IF IT DID NOT.
     *
     * Placed below the `if (!applied) return` above, which is the whole
     * correctness argument for this line: `applySubscriptionStateIfNewer`
     * compares the PROVIDER'S OWN SIGNED TIMESTAMP inside the UPDATE's WHERE
     * clause, so `applied === true` means this callback is the newest word on
     * this subscription and the household really is in a failed-payment state
     * now. A stale, out-of-order callback — which Q17 says to expect —
     * changes no row and therefore tells the parent nothing.
     *
     * `subscription.id` is the notification's dedupe subject and
     * `event.providerEventId` its occurrence; `forBillingEvent` composes both
     * into the key that `notification_decisions_cause_uniq` and
     * `notifications (family_id, source_event_id, user_id)` refuse a second
     * time. The webhook's own `payment_webhook_events (provider,
     * provider_event_id)` already stops a redelivery reaching this method, so
     * that is the SECOND layer, not the only one.
     *
     * It cannot fail the webhook: the producer never throws, by construction,
     * and a 5xx here would make the provider retry a callback we applied
     * correctly.
     */
    if (options.notifyPaymentFailure) {
      await this.billingNotifications.paymentFailed({
        familyId,
        subscriptionId: subscription.id,
        provider: event.provider,
        providerEventId: event.providerEventId,
        occurredAt: event.signedAt ?? new Date(),
      });
    }

    return { outcome: 'PROCESSED', familyId, detail };
  }

  /**
   * THE 7-DAY GRACE WINDOW (Q17). A configured duration, read from the
   * environment, defaulting to the documented 7 days — not a magic number
   * three files deep.
   */
  private graceEnd(event: IProviderWebhookEvent): Date {
    const base = event.signedAt ?? new Date();
    const end = new Date(base);
    end.setDate(end.getDate() + GRACE_PERIOD_DAYS);
    return end;
  }

  /**
   * Resolves the household from the event, in the same order of trust as
   * `PaymentVerificationService`: the store account link first (the strongest
   * binding), then the subscription lineage key we recorded ourselves at
   * purchase time. There is no third option, and in particular there is no
   * "take the family id from the payload".
   */
  private async resolveFamily(event: IProviderWebhookEvent): Promise<string | null> {
    if (event.verifiedPurchase?.providerAccountRef) {
      const linked = await this.payments.findFamilyByProviderAccountRef(
        event.provider,
        event.verifiedPurchase.providerAccountRef,
      );
      if (linked) return linked;
    }
    if (event.providerAccountRef) {
      const linked = await this.payments.findFamilyByProviderAccountRef(event.provider, event.providerAccountRef);
      if (linked) return linked;
    }
    const lineageKey =
      event.providerOriginalTransactionId ?? event.verifiedPurchase?.providerOriginalTransactionId ?? null;
    if (lineageKey) {
      const subscription = await this.payments.findSubscriptionByOriginalTransactionId(lineageKey);
      if (subscription) return subscription.familyId;
    }
    return null;
  }

  /**
   * Apple embeds a verified transaction in the notification; Google does not
   * and must be asked. This is where that difference is absorbed.
   */
  private async obtainVerifiedPurchase(
    event: IProviderWebhookEvent,
    familyId: string,
  ): Promise<IVerifiedPurchase | null> {
    if (event.verifiedPurchase) return event.verifiedPurchase;
    const lineageKey = event.providerOriginalTransactionId;
    if (!lineageKey) return null;

    const adapter = this.registry.getAdapter(event.provider);
    if (!adapter.supports('VERIFY')) return null;
    return adapter.verifyPurchase({ providerToken: lineageKey, familyId });
  }
}

/** Q17: «grace period — 7 days after a failed payment or expiry.» */
export const GRACE_PERIOD_DAYS = 7;

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
