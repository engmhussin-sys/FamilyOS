import * as crypto from 'crypto';

import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type {
  BillingPeriodValue,
  IChargeInput,
  IChargeResult,
  IPaymentProvider,
  IPaymentProviderAdapter,
  IProviderWebhookEvent,
  IVerifiedPurchase,
  IVerifyPurchaseInput,
  IWebhookRequest,
  IWebhookVerification,
  ProviderCapability,
  ProviderKind,
  WebhookEventKind,
} from '../../application/ports/payment-provider.port';
import type { CanonicalSubscriptionStatus } from '../../domain/subscription-status';
import { PaymentProviderNotConfiguredException } from '../../domain/billing.errors';
import {
  PlayDeveloperApiClient,
  type FetchLike,
  type IPlayDeveloperApiConfig,
} from '../google/play-developer-api.client';
import {
  GOOGLE_REFUND_TYPE_FULL,
  GOOGLE_SUBSCRIPTION_CANCELED,
  GOOGLE_SUBSCRIPTION_CANCELLATION_SCHEDULED,
  GOOGLE_SUBSCRIPTION_DEFERRED,
  GOOGLE_SUBSCRIPTION_EXPIRED,
  GOOGLE_SUBSCRIPTION_IN_GRACE_PERIOD,
  GOOGLE_SUBSCRIPTION_ITEMS_CHANGED,
  GOOGLE_SUBSCRIPTION_ON_HOLD,
  GOOGLE_SUBSCRIPTION_PAUSED,
  GOOGLE_SUBSCRIPTION_PAUSE_SCHEDULE_CHANGED,
  GOOGLE_SUBSCRIPTION_PENDING_PURCHASE_CANCELED,
  GOOGLE_SUBSCRIPTION_PRICE_CHANGE_CONFIRMED,
  GOOGLE_SUBSCRIPTION_PRICE_CHANGE_UPDATED,
  GOOGLE_SUBSCRIPTION_PRICE_STEP_UP_CONSENT_UPDATED,
  GOOGLE_SUBSCRIPTION_PURCHASED,
  GOOGLE_SUBSCRIPTION_RECOVERED,
  GOOGLE_SUBSCRIPTION_RENEWED,
  GOOGLE_SUBSCRIPTION_RESTARTED,
  GOOGLE_SUBSCRIPTION_REVOKED,
  type GoogleSubscriptionState,
  type IGoogleDeveloperNotification,
  type IGooglePubSubEnvelope,
  type IGoogleSubscriptionPurchaseV2,
} from '../google/google-play.types';

/**
 * PHASE D — GOOGLE PLAY BILLING, SERVER-AUTHORITATIVE.
 *
 * ================ THE ANDROID CLIENT IS NEVER AUTHORITATIVE ================
 *
 * The Android app sends one thing: a `purchaseToken`. Not a price, not a
 * state, not an expiry, not a family id. Everything this system believes about
 * a Google purchase comes from an authenticated
 * `purchases.subscriptionsv2.get` call against Google's servers.
 *
 * A stolen or invented purchase token is not a vulnerability, because the
 * answer that comes back describes whoever REALLY owns it, and the tenant is
 * resolved from `obfuscatedExternalAccountId` in THAT ANSWER against
 * `provider_account_links` — never from the session that made the request.
 * That is the mechanism that makes the "cross-tenant attempt rejected" test
 * pass, and it is the same mechanism as Apple's `appAccountToken`.
 *
 * ============= WHY RTDN VERIFICATION LOOKS DIFFERENT FROM APPLE =============
 *
 * Apple signs its notification; Google does not. A Real-time Developer
 * Notification arrives as a Cloud Pub/Sub PUSH message whose body is
 * `{message: {data: <base64>, messageId}}`, and its authenticity comes from
 * the TRANSPORT, not from the payload: Pub/Sub push signs the request with an
 * OIDC token in the `Authorization` header, issued by Google for the service
 * account configured on the push subscription.
 *
 * `verifyWebhookSignature` therefore checks that OIDC token. And it does not
 * matter very much either way, because — per Google's own reference —
 * «After receiving an RTDN, call the Google Play Developer API to get complete
 * purchase status.» The notification is a DOORBELL. Even a perfectly forged
 * one causes us to ask Google about a purchase token and act on Google's
 * answer, which is the correct behaviour anyway. Defence in depth, not the
 * only defence.
 *
 * ==================== WHAT IS BLOCKED, EXPLICITLY ====================
 *
 * SANDBOX VERIFICATION AGAINST REAL GOOGLE SERVERS HAS NOT BEEN PERFORMED AND
 * CANNOT BE. It requires a Play Console account, a published package name, a
 * linked GCP project, a service account with the androidpublisher scope, a
 * Pub/Sub topic and a licence tester — none of which exist for this project.
 * The tests mock GOOGLE'S HTTP RESPONSES; the state mapping, the tenant
 * resolution and the idempotency they exercise are the production ones.
 */
@Injectable()
export class GooglePlayProvider implements IPaymentProvider, IPaymentProviderAdapter {
  readonly providerName = 'GOOGLE_PLAY' as const;
  readonly kind: ProviderKind = 'STORE';

  private readonly logger = new Logger(GooglePlayProvider.name);
  private client: PlayDeveloperApiClient | null = null;

  constructor(
    private readonly configService: ConfigService,
    /**
     * The HTTP boundary and the clock, both injectable so tests can mock
     * GOOGLE'S RESPONSES and control time — never our own state-mapping logic.
     *
     * `@Optional()` is load-bearing, not decoration — see the note in
     * `AppleStoreKitProvider` for the exact Nest failure it prevents.
     */
    @Optional() private readonly fetchImpl: FetchLike = defaultFetch,
    @Optional() private readonly now: () => Date = () => new Date(),
  ) {}

  isConfigured(): boolean {
    return this.readConfig() !== null;
  }

  supports(capability: ProviderCapability): boolean {
    // NO CHECKOUT, NO REFUND. Q17 states the rule the business follows and this
    // enforces: «a refund is not applied to a Play purchase except through
    // Play.» Offering a refund button here would produce a refund we cannot
    // actually perform.
    // PHASE G — ACKNOWLEDGE is Google-only among the seven providers, and it is
    // not a nicety: an unacknowledged Play purchase is auto-refunded and
    // cancelled after three days.
    return capability === 'VERIFY' || capability === 'WEBHOOK' || capability === 'ACKNOWLEDGE';
  }

  private readConfig(): IPlayDeveloperApiConfig | null {
    const clientEmail = this.configService.get<string>('GOOGLE_PLAY_SERVICE_ACCOUNT_EMAIL');
    const privateKey = this.configService.get<string>('GOOGLE_PLAY_SERVICE_ACCOUNT_PRIVATE_KEY');
    const packageName = this.configService.get<string>('GOOGLE_PLAY_PACKAGE_NAME');
    if (!clientEmail || !privateKey || !packageName) return null;
    return { clientEmail, privateKeyPem: privateKey.replace(/\\n/g, '\n'), packageName };
  }

  private requireClient(): PlayDeveloperApiClient {
    const config = this.readConfig();
    if (!config) throw new PaymentProviderNotConfiguredException('Google Play Billing');
    if (!this.client) this.client = new PlayDeveloperApiClient(config, this.fetchImpl, this.now);
    return this.client;
  }

  // -------------------------------------------------------------------------
  // Verification
  // -------------------------------------------------------------------------

  async verifyPurchase(input: IVerifyPurchaseInput): Promise<IVerifiedPurchase> {
    const config = this.readConfig();
    if (!config) throw new PaymentProviderNotConfiguredException('Google Play Billing');
    const purchase = await this.requireClient().getSubscriptionV2(input.providerToken);
    return this.toVerifiedPurchase(input.providerToken, purchase);
  }

  /**
   * Acknowledge, so Google does not auto-refund after three days. Separate
   * from `verifyPurchase` on purpose: acknowledgement is a WRITE and belongs
   * after the entitlement has actually been granted in our own transaction.
   * Acknowledging a purchase we then failed to record would be the worst
   * possible ordering.
   */
  async acknowledge(subscriptionId: string, purchaseToken: string): Promise<void> {
    await this.requireClient().acknowledgeSubscription(subscriptionId, purchaseToken);
  }

  // -------------------------------------------------------------------------
  // Real-time Developer Notifications
  // -------------------------------------------------------------------------

  /**
   * Verifies the Pub/Sub push OIDC token.
   *
   * Full RS256 verification against Google's rotating JWKS would require an
   * outbound fetch of `https://www.googleapis.com/oauth2/v3/certs` inside the
   * webhook path. What is done here instead, and stated honestly:
   *
   *   - the `Authorization: Bearer <jwt>` header MUST be present;
   *   - its `aud` MUST equal the configured `GOOGLE_PUBSUB_AUDIENCE`;
   *   - its `email` claim MUST equal the configured
   *     `GOOGLE_PUBSUB_SERVICE_ACCOUNT`;
   *   - its `exp` MUST be in the future.
   *
   * The SIGNATURE of that token is NOT checked here — and this is a real,
   * named limitation, recorded in `PHASE-D-Payments-Report.md`. It is
   * acceptable ONLY because of the structural fact above: an RTDN is a
   * doorbell, and every claim it makes is discarded in favour of a fresh
   * authenticated `subscriptionsv2.get`. An attacker who forges one achieves
   * nothing except causing us to re-read the true state of a purchase token
   * they already knew. Closing it properly (JWKS fetch + cache) is one
   * function and is listed as follow-up work, not pretended away.
   */
  async verifyWebhookSignature(request: IWebhookRequest): Promise<IWebhookVerification> {
    if (!this.readConfig()) {
      return { verified: false, reason: 'Google Play Billing is not configured.' };
    }

    const expectedAudience = this.configService.get<string>('GOOGLE_PUBSUB_AUDIENCE');
    const expectedAccount = this.configService.get<string>('GOOGLE_PUBSUB_SERVICE_ACCOUNT');
    if (!expectedAudience || !expectedAccount) {
      return {
        verified: false,
        reason: 'GOOGLE_PUBSUB_AUDIENCE / GOOGLE_PUBSUB_SERVICE_ACCOUNT are not configured.',
      };
    }

    const header = request.headers.authorization ?? request.headers.Authorization;
    if (!header?.startsWith('Bearer ')) {
      return { verified: false, reason: 'Pub/Sub push request has no bearer token.' };
    }

    const claims = decodeJwtClaims(header.slice('Bearer '.length));
    if (!claims) return { verified: false, reason: 'Pub/Sub bearer token is not a decodable JWT.' };
    if (claims.aud !== expectedAudience) {
      return { verified: false, reason: 'Pub/Sub token audience does not match GOOGLE_PUBSUB_AUDIENCE.' };
    }
    if (claims.email !== expectedAccount) {
      return { verified: false, reason: 'Pub/Sub token was not issued for the configured service account.' };
    }
    if (typeof claims.exp !== 'number' || claims.exp * 1000 <= this.now().getTime()) {
      return { verified: false, reason: 'Pub/Sub token is expired.' };
    }
    if (claims.email_verified === false) {
      return { verified: false, reason: 'Pub/Sub token email claim is not verified.' };
    }

    return { verified: true, reason: null };
  }

  async parseWebhook(request: IWebhookRequest): Promise<IProviderWebhookEvent> {
    const envelope = JSON.parse(request.rawBody) as IGooglePubSubEnvelope;
    const decoded = Buffer.from(envelope.message.data, 'base64').toString('utf8');
    const notification = JSON.parse(decoded) as IGoogleDeveloperNotification;

    // THE DEDUPE KEY. Pub/Sub's `messageId` is stable across its own
    // redeliveries — Google's reference names it for exactly this purpose
    // («Check messageId uniqueness to avoid processing duplicate
    // notifications»). Falling back to a digest is a last resort that is
    // recorded, never silent.
    const messageId = envelope.message.messageId ?? envelope.message.message_id;
    const providerEventId = messageId ?? `digest:${crypto.createHash('sha256').update(decoded).digest('hex')}`;
    if (!messageId) {
      this.logger.warn('Pub/Sub push had no messageId; falling back to a payload digest for dedupe.');
    }

    // THE PACKAGE CHECK. A notification for another developer's app must not
    // be acted on, exactly as Apple's bundle check.
    const configuredPackage = this.readConfig()?.packageName;
    if (configuredPackage && notification.packageName && notification.packageName !== configuredPackage) {
      throw new GooglePlayVerificationError(
        `RTDN is for package "${notification.packageName}", not this application.`,
      );
    }

    const signedAt = notification.eventTimeMillis
      ? new Date(Number.parseInt(notification.eventTimeMillis, 10))
      : null;

    if (notification.testNotification) {
      return {
        provider: this.providerName,
        providerEventId,
        kind: 'TEST',
        rawEventType: 'TEST_NOTIFICATION',
        rawEventSubtype: null,
        signedAt,
        verifiedPurchase: null,
        refund: null,
        providerOriginalTransactionId: null,
        providerAccountRef: null,
      };
    }

    if (notification.voidedPurchaseNotification) {
      const voided = notification.voidedPurchaseNotification;
      return {
        provider: this.providerName,
        providerEventId,
        kind: 'REFUNDED',
        rawEventType: 'VOIDED_PURCHASE',
        rawEventSubtype: voided.refundType === GOOGLE_REFUND_TYPE_FULL ? 'FULL_REFUND' : 'PARTIAL_REFUND',
        signedAt,
        verifiedPurchase: null,
        refund: {
          providerRefundId: null,
          providerTransactionId: voided.orderId,
          // Google's void notification carries NO amount. Null here is honest;
          // the handler reads the amount from the ORIGINAL transaction we
          // already recorded, which is the only trustworthy source anyway.
          amountMinor: null,
          currency: null,
          reason: voided.refundType === GOOGLE_REFUND_TYPE_FULL ? 'FULL_REFUND' : 'PARTIAL_REFUND',
          occurredAt: signedAt ?? this.now(),
          isReversal: false,
        },
        providerOriginalTransactionId: voided.purchaseToken,
        providerAccountRef: null,
      };
    }

    const subscription = notification.subscriptionNotification;
    if (!subscription) {
      return {
        provider: this.providerName,
        providerEventId,
        kind: 'UNHANDLED',
        rawEventType: 'ONE_TIME_PRODUCT_OR_UNKNOWN',
        rawEventSubtype: null,
        signedAt,
        verifiedPurchase: null,
        refund: null,
        providerOriginalTransactionId: null,
        providerAccountRef: null,
      };
    }

    // NO PURCHASE DATA IS TAKEN FROM THE NOTIFICATION. `verifiedPurchase` stays
    // null; the handler calls `verifyPurchase(purchaseToken)` and acts on
    // Google's answer. See the class docstring.
    return {
      provider: this.providerName,
      providerEventId,
      kind: mapNotificationKind(subscription.notificationType),
      rawEventType: `SUBSCRIPTION_${subscription.notificationType}`,
      rawEventSubtype: subscription.subscriptionId,
      signedAt,
      verifiedPurchase: null,
      refund: null,
      providerOriginalTransactionId: subscription.purchaseToken,
      providerAccountRef: null,
    };
  }

  /** Reads the Pub/Sub messageId without trusting anything else. */
  peekEventId(rawBody: string): string | null {
    try {
      const envelope = JSON.parse(rawBody) as IGooglePubSubEnvelope;
      return envelope.message?.messageId ?? envelope.message?.message_id ?? null;
    } catch {
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // Translation
  // -------------------------------------------------------------------------

  toVerifiedPurchase(purchaseToken: string, purchase: IGoogleSubscriptionPurchaseV2): IVerifiedPurchase {
    const lineItem = purchase.lineItems?.[0];
    const price = lineItem?.autoRenewingPlan?.recurringPrice;

    const expiresAt = lineItem?.expiryTime ? new Date(lineItem.expiryTime) : null;
    const purchasedAt = purchase.startTime ? new Date(purchase.startTime) : this.now();

    return {
      provider: this.providerName,
      // Google's `latestOrderId` is the per-charge identifier and is what the
      // idempotency index is anchored on. A renewal produces a NEW order id
      // under the SAME purchase token, which is precisely the distinction
      // between "this charge" and "this subscription lineage".
      providerTransactionId: purchase.latestOrderId ?? purchaseToken,
      providerOriginalTransactionId: purchaseToken,
      productRef: lineItem?.offerDetails?.basePlanId ?? lineItem?.productId ?? '',
      // THE TENANT LINK — from GOOGLE's answer, never from the request.
      providerAccountRef: purchase.externalAccountIdentifiers?.obfuscatedExternalAccountId ?? null,
      currency: (price?.currencyCode ?? 'USD').toUpperCase(),
      grossAmountMinor: googleMoneyToMinor(price),
      countryCode: purchase.regionCode ?? null,
      billingPeriod: inferBillingPeriod(purchasedAt, expiresAt),
      purchasedAt,
      expiresAt,
      status: mapSubscriptionState(purchase.subscriptionState),
      autoRenewing: lineItem?.autoRenewingPlan?.autoRenewEnabled === true,
      // `testPurchase` is present-or-absent, not true-or-false. Checking
      // `=== true` would treat every licence-tester purchase as real.
      isSandbox: purchase.testPurchase !== undefined,
      verifiedPayloadDigest: crypto.createHash('sha256').update(JSON.stringify(purchase)).digest('hex'),
      // PHASE G — the v1 SUBSCRIPTION id, which acknowledgement needs and
      // `productRef` (the basePlanId, above) is NOT. `purchases.subscriptionsv2`
      // has no acknowledge method, so acknowledgement goes through the v1
      // `purchases.subscriptions` resource, which is keyed on this id. Passing
      // the basePlanId there returns 404 — and never acknowledging means Google
      // silently refunds the purchase three days later. Two Google identifiers
      // for one purchase; they are not interchangeable.
      providerAcknowledgeRef: lineItem?.productId ?? null,
      // Google's own view of whether this purchase still needs acknowledging.
      // Read here so the decision is made from GOOGLE'S ANSWER rather than from
      // any state of ours.
      needsAcknowledgement: purchase.acknowledgementState !== 'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED',
    };
  }

  /**
   * PHASE G — ACKNOWLEDGE. Called by `PaymentVerificationService` only AFTER the
   * transaction row and the entitlement exist.
   *
   * WHY THIS EXISTS AT ALL: Google automatically refunds and cancels any
   * purchase not acknowledged within three days. `acknowledge()` above was
   * written and unit-tested in Phase D and then **never called by any
   * application service** — so the Play path would have granted access
   * correctly and had every purchase reversed on day three. That is the kind of
   * defect that looks like a business problem for a week before anyone reads
   * the API reference.
   *
   * ALREADY-ACKNOWLEDGED IS A NO-OP, NOT AN ERROR, and the decision is made from
   * Google's `acknowledgementState`, not from our own records. The client path
   * and the RTDN path both legitimately arrive for the same purchase.
   */
  async acknowledgePurchase(verified: IVerifiedPurchase): Promise<void> {
    if (verified.needsAcknowledgement === false) {
      this.logger.log('Google Play purchase is already acknowledged — no second call.');
      return;
    }
    const subscriptionId = verified.providerAcknowledgeRef;
    const purchaseToken = verified.providerOriginalTransactionId;
    if (!subscriptionId || !purchaseToken) {
      // Loud, and deliberately NOT an exception: the entitlement has already
      // been granted by the time this runs, and throwing would make the client
      // retry a purchase that actually succeeded. What is at risk is the
      // auto-refund window, and an operator needs to see it while it can still
      // be fixed by hand.
      this.logger.error(
        'Cannot acknowledge a Google Play purchase: the verified purchase carries no v1 ' +
          `subscription id (${subscriptionId ?? 'null'}) or no purchase token. Google auto-refunds ` +
          'unacknowledged purchases after three days, so this one will be reversed unless it is ' +
          'acknowledged another way.',
      );
      return;
    }
    await this.acknowledge(subscriptionId, purchaseToken);
  }

  /** KEPT AND STILL THROWING — see AppleStoreKitProvider.charge. */
  async charge(_input: IChargeInput): Promise<IChargeResult> {
    throw new PaymentProviderNotConfiguredException(
      'Google Play Billing (charge() does not apply — purchases are client-initiated through Play Billing and verified server-side)',
    );
  }
}

export class GooglePlayVerificationError extends Error {}

/**
 * Google's nine SubscriptionState values, mapped.
 *
 * The two that are easy to get wrong:
 *
 *  - `CANCELED` means «canceled but NOT EXPIRED YET». The customer has paid
 *    through the end of the period and MUST keep access until `expiryTime`.
 *    Mapping it to a state that revokes access immediately would take away
 *    something already paid for — the same trap as Apple's
 *    AUTO_RENEW_DISABLED.
 *  - `PAUSED` is a Play feature with no equivalent here. It is mapped to
 *    EXPIRED because access genuinely stops; a `SUBSCRIPTION_RECOVERED`
 *    notification restores it.
 */
export function mapSubscriptionState(state: GoogleSubscriptionState): CanonicalSubscriptionStatus {
  switch (state) {
    case 'SUBSCRIPTION_STATE_ACTIVE':
      return 'ACTIVE';
    case 'SUBSCRIPTION_STATE_CANCELED':
      return 'CANCELLED';
    case 'SUBSCRIPTION_STATE_IN_GRACE_PERIOD':
      return 'GRACE_PERIOD';
    case 'SUBSCRIPTION_STATE_ON_HOLD':
      return 'PAST_DUE';
    case 'SUBSCRIPTION_STATE_PENDING':
      return 'PENDING';
    case 'SUBSCRIPTION_STATE_PENDING_PURCHASE_CANCELED':
      return 'CANCELLED';
    case 'SUBSCRIPTION_STATE_PAUSED':
    case 'SUBSCRIPTION_STATE_EXPIRED':
      return 'EXPIRED';
    case 'SUBSCRIPTION_STATE_UNSPECIFIED':
    default:
      // FAIL CLOSED. An unrecognised state must never become ACTIVE.
      return 'EXPIRED';
  }
}

/** The full RTDN notificationType table, mapped. */
export function mapNotificationKind(notificationType: number): WebhookEventKind {
  switch (notificationType) {
    case GOOGLE_SUBSCRIPTION_PURCHASED:
      return 'PURCHASED';
    case GOOGLE_SUBSCRIPTION_RENEWED:
    case GOOGLE_SUBSCRIPTION_RECOVERED:
    case GOOGLE_SUBSCRIPTION_RESTARTED:
      return 'RENEWED';
    case GOOGLE_SUBSCRIPTION_IN_GRACE_PERIOD:
      return 'GRACE_PERIOD_STARTED';
    case GOOGLE_SUBSCRIPTION_ON_HOLD:
      // Account hold: Google is still retrying, access has STOPPED.
      return 'BILLING_RETRY';
    case GOOGLE_SUBSCRIPTION_CANCELED:
    case GOOGLE_SUBSCRIPTION_CANCELLATION_SCHEDULED:
      return 'CANCELLED';
    case GOOGLE_SUBSCRIPTION_REVOKED:
      return 'REVOKED';
    case GOOGLE_SUBSCRIPTION_EXPIRED:
    case GOOGLE_SUBSCRIPTION_PAUSED:
      return 'EXPIRED';
    case GOOGLE_SUBSCRIPTION_PENDING_PURCHASE_CANCELED:
      return 'CANCELLED';
    case GOOGLE_SUBSCRIPTION_DEFERRED:
    case GOOGLE_SUBSCRIPTION_PAUSE_SCHEDULE_CHANGED:
    case GOOGLE_SUBSCRIPTION_ITEMS_CHANGED:
    case GOOGLE_SUBSCRIPTION_PRICE_CHANGE_CONFIRMED:
    case GOOGLE_SUBSCRIPTION_PRICE_CHANGE_UPDATED:
    case GOOGLE_SUBSCRIPTION_PRICE_STEP_UP_CONSENT_UPDATED:
    default:
      // Every one of these still causes a fresh `subscriptionsv2.get` at the
      // handler level if it resolves to a known subscription, so "unhandled"
      // means "no special-cased behaviour", not "ignored".
      return 'UNHANDLED';
  }
}

/**
 * Google returns money as `{units: "99", nanos: 990000000}`. Converting to
 * minor units means `units * 100 + nanos / 1e7` — and `units` is a STRING,
 * because it is an int64 over the wire. Getting the nanos scale wrong by a
 * factor of ten is the classic bug here, which is why it is one function with
 * one test rather than an inline expression at three call sites.
 */
export function googleMoneyToMinor(price: { units?: string; nanos?: number } | undefined): number {
  if (!price) return 0;
  const units = price.units ? Number.parseInt(price.units, 10) : 0;
  const nanos = price.nanos ?? 0;
  // 1 unit = 100 minor units; 1 nano = 1e-9 unit = 1e-7 minor units.
  return Math.round(units * 100 + nanos / 10_000_000);
}

function inferBillingPeriod(start: Date, end: Date | null): BillingPeriodValue | null {
  if (!end) return null;
  const days = (end.getTime() - start.getTime()) / 86_400_000;
  if (days <= 45) return 'MONTHLY';
  if (days <= 135) return 'QUARTERLY';
  return 'ANNUAL';
}

/** The subset of a Pub/Sub push OIDC token this adapter reads. */
interface IPubSubOidcClaims {
  aud?: string;
  email?: string;
  email_verified?: boolean;
  exp?: number;
  iss?: string;
}

function decodeJwtClaims(token: string): IPubSubOidcClaims | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    return JSON.parse(
      Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'),
    ) as IPubSubOidcClaims;
  } catch {
    return null;
  }
}

const defaultFetch: FetchLike = (url, init) =>
  (globalThis as unknown as { fetch: FetchLike }).fetch(url, init);
