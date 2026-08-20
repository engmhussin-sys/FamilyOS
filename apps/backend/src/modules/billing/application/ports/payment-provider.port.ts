import type { PaymentProviderValue, SubscriptionPlanTier } from '../../domain/billing.types';
import type { CanonicalSubscriptionStatus } from '../../domain/subscription-status';

export const PAYMENT_PROVIDER_REGISTRY = Symbol('PAYMENT_PROVIDER_REGISTRY');

/**
 * PHASE D — THE ONE SEAM EVERY PAYMENT PROVIDER CROSSES.
 *
 * A1-Backend-Audit §22 measured the previous version of this file and was
 * right about it: the port's entire contract was
 * `charge(subscriptionId, amountCents, currency)`, which cannot express a
 * Paymob flow (authenticate -> order register -> payment key -> redirect ->
 * HMAC callback), cannot express Fawry (a reference the customer settles days
 * later), and cannot express a store purchase at all — because Apple and
 * Google purchases are INITIATED BY THE CLIENT and the server's job is to
 * VERIFY them, not to move money. The audit's verdict was REBUILD. This is the
 * rebuild, and the Sprint 8 contract survives at the bottom of the file so
 * that every existing caller keeps working.
 *
 * THE ARCHITECTURE THE BRIEF SPECIFIES, in one line:
 *
 *   Payment Provider -> Transaction Verification -> Entitlement Service
 *                    -> ABNY Subscription -> Feature Access
 *
 * Every arrow in that chain is a boundary in this file's design:
 *
 *  - `verifyPurchase` is the SECOND box. It returns an `IVerifiedPurchase` —
 *    a provider-neutral fact — and it is the ONLY way a purchase becomes real.
 *    There is no path from "the client said it paid" to an entitlement.
 *  - `verifyWebhookSignature` and `parseWebhook` are how the same second box is
 *    entered asynchronously.
 *  - Nothing downstream of `IVerifiedPurchase` knows which provider produced
 *    it. `SubscriptionService` imports this file and never an adapter; the
 *    string `'APPLE_IAP'` appears in no business-logic branch.
 *
 * WHAT THE CLIENT IS ALLOWED TO SEND: an opaque token. A StoreKit
 * `JWSTransaction`, a Play `purchaseToken`, a gateway order reference. That is
 * all. Amount, currency, product, status and expiry come back from the provider
 * over a channel the client cannot forge, or are read from our own price
 * catalogue. A client-supplied amount is not merely distrusted here — it has
 * nowhere to enter.
 */

/** ISO-4217 alpha-3, uppercase. */
export type CurrencyCode = string;

export type BillingPeriodValue = 'MONTHLY' | 'QUARTERLY' | 'ANNUAL';

/** Whether the adapter is a store (client-initiated) or a gateway (server-initiated). */
export type ProviderKind =
  /** Apple / Google. The client buys; we verify. We never charge. */
  | 'STORE'
  /** Paymob / Fawry / Moyasar / Stripe. We create a charge; the customer completes it. */
  | 'GATEWAY'
  /** Manual reconciliation by an operator. No external system. */
  | 'MANUAL';

// ---------------------------------------------------------------------------
// VERIFICATION — the provider-neutral fact every adapter must produce.
// ---------------------------------------------------------------------------

/**
 * What a client is permitted to hand us. Deliberately one opaque string plus
 * routing context that comes from the SESSION, not the body.
 */
export interface IVerifyPurchaseInput {
  /**
   * The provider's opaque proof. Apple: the signed `JWSTransaction`. Google:
   * the `purchaseToken`. Gateway: the merchant order reference WE issued.
   *
   * This is the only client-supplied value in the whole verification path, and
   * it is not trusted either — it is verified against the provider's signing
   * key, or presented to the provider's API, and everything else is read from
   * the result.
   */
  readonly providerToken: string;
  /** Derived from the authenticated session. NEVER from the request body. */
  readonly familyId: string;
  /** Google needs the product/base-plan to disambiguate; Apple does not. */
  readonly productRef?: string;
}

/**
 * The provider-neutral outcome of a server-side verification.
 *
 * Everything in here came from the provider or from our own catalogue. Nothing
 * in here came from a request body. That sentence is the security model.
 */
export interface IVerifiedPurchase {
  readonly provider: PaymentProviderValue;
  /** The provider's id for this specific transaction. Idempotency anchor. */
  readonly providerTransactionId: string;
  /** Apple `originalTransactionId` / Google `purchaseToken`. Lineage anchor. */
  readonly providerOriginalTransactionId: string | null;
  /** Apple `productId` / Google `basePlanId` / our own price id. */
  readonly productRef: string;
  /**
   * The store's opaque account reference — Apple `appAccountToken`, Google
   * `obfuscatedExternalAccountId`. Resolved against `provider_account_links` to
   * find the tenant. NULL means the purchase cannot be attributed and MUST NOT
   * be applied to whichever family happened to make the request.
   */
  readonly providerAccountRef: string | null;
  readonly currency: CurrencyCode;
  /** Gross, minor units, as the PROVIDER reports it. */
  readonly grossAmountMinor: number;
  readonly countryCode: string | null;
  readonly billingPeriod: BillingPeriodValue | null;
  /** Provider's own timestamps. Ordering is decided by these, never by arrival. */
  readonly purchasedAt: Date;
  readonly expiresAt: Date | null;
  readonly status: CanonicalSubscriptionStatus;
  readonly autoRenewing: boolean;
  /**
   * TRUE for Apple `environment: "Sandbox"` and Google `testPurchase`. A
   * sandbox purchase is RECORDED and is never entitlement-bearing in a
   * production environment — the two facts together are what make a leaked
   * sandbox receipt worthless.
   */
  readonly isSandbox: boolean;
  /** SHA-256 of the exact bytes verified. Lets a dispute be re-checked. */
  readonly verifiedPayloadDigest: string;
  /**
   * PHASE G — the provider-specific resource id that `acknowledgePurchase`
   * needs, opaque to every caller. Optional and NULL for providers with no
   * acknowledgement step (all of them except Google Play).
   *
   * For Google this is the v1 SUBSCRIPTION id — `lineItems[].productId` — which
   * is deliberately NOT the same string as `productRef` (`basePlanId`), because
   * `purchases.subscriptionsv2` has no acknowledge method of its own and
   * acknowledgement still goes through the v1 `purchases.subscriptions`
   * resource. Two different Google identifiers for one purchase; conflating
   * them produces a 404 from Google and, three days later, a silent refund.
   */
  readonly providerAcknowledgeRef?: string | null;
  /**
   * PHASE G — does the PROVIDER still consider this purchase unacknowledged?
   *
   * Read from the provider's own answer (Google's `acknowledgementState`), never
   * from our records, so that a purchase acknowledged by the webhook path is not
   * acknowledged a second time by the client path — both legitimately arrive.
   * `undefined` for providers with no acknowledgement step.
   */
  readonly needsAcknowledgement?: boolean;
}

// ---------------------------------------------------------------------------
// WEBHOOKS
// ---------------------------------------------------------------------------

export interface IWebhookRequest {
  /**
   * The EXACT bytes received. Signature verification is over bytes, not over a
   * re-serialised object — `JSON.parse` then `JSON.stringify` changes key order
   * and whitespace and silently breaks every HMAC scheme in this file.
   */
  readonly rawBody: string;
  readonly headers: Readonly<Record<string, string | undefined>>;
}

export type WebhookEventKind =
  | 'PURCHASED'
  | 'RENEWED'
  | 'CANCELLED'
  | 'EXPIRED'
  | 'GRACE_PERIOD_STARTED'
  | 'GRACE_PERIOD_EXPIRED'
  | 'BILLING_RETRY'
  | 'REFUNDED'
  | 'REFUND_REVERSED'
  | 'REVOKED'
  | 'PAYMENT_SUCCEEDED'
  | 'PAYMENT_FAILED'
  | 'PAYMENT_PENDING'
  | 'TEST'
  /** Understood, deliberately not modelled. Acknowledged with 200, no action. */
  | 'UNHANDLED';

/**
 * A provider webhook, translated into this system's vocabulary.
 *
 * `providerEventId` is what the dedupe UNIQUE index is built on. Every adapter
 * must supply one the PROVIDER itself considers stable across redeliveries —
 * Apple `notificationUUID`, Google Pub/Sub `messageId`, a gateway's transaction
 * id. An adapter that synthesised one from a hash of the body would make a
 * redelivery with re-ordered JSON keys look like a new event, defeating the
 * entire mechanism.
 */
export interface IProviderWebhookEvent {
  readonly provider: PaymentProviderValue;
  readonly providerEventId: string;
  readonly kind: WebhookEventKind;
  /** The provider's own type string, kept verbatim for the audit trail. */
  readonly rawEventType: string;
  readonly rawEventSubtype: string | null;
  /** The PROVIDER's timestamp. The out-of-order guard compares against this. */
  readonly signedAt: Date | null;
  /**
   * The verified transaction this event is about, when the payload carries a
   * signed one. Apple always does — App Store Server Notifications V2 embed a
   * `signedTransactionInfo` JWS. Google never does: an RTDN carries only a
   * purchase token, which is exactly why `GooglePlayProvider.parseWebhook`
   * leaves this NULL and the handler must call `verifyPurchase` to obtain the
   * facts from the Developer API.
   */
  readonly verifiedPurchase: IVerifiedPurchase | null;
  /** Present for refund/void events. */
  readonly refund: IProviderRefundFact | null;
  /** Lineage key, when the event carries one without a full transaction. */
  readonly providerOriginalTransactionId: string | null;
  readonly providerAccountRef: string | null;
}

export interface IProviderRefundFact {
  readonly providerRefundId: string | null;
  readonly providerTransactionId: string;
  readonly amountMinor: number | null;
  readonly currency: CurrencyCode | null;
  readonly reason: string | null;
  readonly occurredAt: Date;
  /** Apple `REFUND_REVERSED`: a refund the customer disputed and lost. */
  readonly isReversal: boolean;
}

export interface IWebhookVerification {
  readonly verified: boolean;
  /**
   * Why not — for the `payment_webhook_events.failure_reason` column. NEVER
   * echoed to the caller: a signature oracle is a signature oracle.
   */
  readonly reason: string | null;
}

// ---------------------------------------------------------------------------
// CHARGES (gateways only) and REFUNDS
// ---------------------------------------------------------------------------

export interface ICheckoutInput {
  readonly subscriptionId: string;
  readonly familyId: string;
  readonly planTier: SubscriptionPlanTier;
  readonly billingPeriod: BillingPeriodValue;
  readonly countryCode: string;
  readonly currency: CurrencyCode;
  /** Computed by `PricingService` from the catalogue. NEVER from the client. */
  readonly grossAmountMinor: number;
  /** Where the customer returns after a 3-D Secure round trip. */
  readonly returnUrl?: string;
}

export interface ICheckoutResult {
  /** Our own reference, echoed back by the provider's callback. */
  readonly merchantReference: string;
  /** A redirect URL (cards / 3DS / wallets) or NULL for offline references. */
  readonly redirectUrl: string | null;
  /**
   * Fawry's whole model: a code the customer takes to a kiosk. The
   * subscription stays PENDING until the confirmation webhook arrives — the
   * customer returning to the app proves nothing (Q15: «the source of truth is
   * the webhook, not the user coming back to the app»).
   */
  readonly offlineReference: string | null;
  readonly expiresAt: Date | null;
}

export interface IRefundInput {
  readonly providerTransactionId: string;
  readonly amountMinor: number;
  readonly currency: CurrencyCode;
  readonly reason: string | null;
  /** Ours. Sent to the provider wherever the provider supports one. */
  readonly idempotencyKey: string;
}

export interface IRefundResult {
  readonly accepted: boolean;
  readonly providerRefundId: string | null;
  readonly failureReason: string | null;
}

// ---------------------------------------------------------------------------
// THE INTERFACE
// ---------------------------------------------------------------------------

export type ProviderCapability =
  | 'CHECKOUT'
  | 'REFUND'
  | 'WEBHOOK'
  | 'VERIFY'
  /**
   * PHASE G. The provider REQUIRES a purchase to be acknowledged after we have
   * granted access, or it reverses the charge by itself.
   *
   * A real asymmetry, not a tidiness exercise: Google Play AUTOMATICALLY
   * REFUNDS AND CANCELS any purchase not acknowledged within three days. Apple
   * has no equivalent — a receipt is a receipt. So this is a CAPABILITY, asked
   * for with `supports()`, rather than a method every adapter has to stub out.
   */
  | 'ACKNOWLEDGE';

/**
 * Every provider implements this. `SubscriptionService`, `EntitlementService`
 * and `InvoiceService` import THIS TYPE and never a concrete class.
 *
 * The optional members are optional because the CAPABILITIES genuinely differ,
 * and pretending otherwise is how a store adapter ends up with a `charge()`
 * that throws at runtime in production:
 *
 *  - A STORE provider has no `createCheckout` and no `refund`. Apple and Google
 *    own both flows; a refund on a Play purchase happens through Play, and a
 *    server offering a "refund" button for one is lying to the operator.
 *  - A GATEWAY provider has `createCheckout` and usually `refund`, and its
 *    `verifyPurchase` verifies OUR OWN order reference against the gateway's
 *    inquiry API rather than a signed client receipt.
 *
 * `supports()` is how a caller asks — without an `instanceof`, and without a
 * `switch` on the provider name anywhere in business logic.
 *
 * IT EXTENDS `IPaymentProviderAdapter` — the Sprint 8 contract — rather than
 * replacing it. That single word is what lets `PaymentService.charge()` and
 * the Sprint 8 `SubscriptionService.subscribe()` path keep working unchanged
 * against the SAME registry that now serves Phase D. A parallel registry for
 * the new interface would have been the easy move and would have produced two
 * places that know which adapter is which, which is the thing this whole file
 * exists to prevent.
 */
export interface IPaymentProvider extends IPaymentProviderAdapter {
  readonly providerName: PaymentProviderValue;
  readonly kind: ProviderKind;

  /**
   * FALSE when the adapter has no credentials. Every unconfigured adapter fails
   * LOUDLY at the point of use (`PaymentProviderNotConfiguredException`, a 503)
   * and never silently degrades to "success" — the posture the existing
   * Stripe/Paymob/Fawry adapters already had, kept deliberately and extended to
   * the new ones.
   */
  isConfigured(): boolean;

  supports(capability: ProviderCapability): boolean;

  /** THE server-side verification. See `IVerifiedPurchase`. */
  verifyPurchase(input: IVerifyPurchaseInput): Promise<IVerifiedPurchase>;

  /**
   * Signature check over the RAW BYTES. Called BEFORE the payload is parsed,
   * before dedupe, before anything. An adapter that returned
   * `{verified: true}` when its secret is missing would be a backdoor; every
   * adapter here returns `{verified: false, reason: '... not configured'}`.
   */
  verifyWebhookSignature(request: IWebhookRequest): Promise<IWebhookVerification>;

  /** Only ever called after `verifyWebhookSignature` returned verified. */
  parseWebhook(request: IWebhookRequest): Promise<IProviderWebhookEvent>;

  createCheckout?(input: ICheckoutInput): Promise<ICheckoutResult>;

  refund?(input: IRefundInput): Promise<IRefundResult>;

  /**
   * PHASE G — ONLY when `supports('ACKNOWLEDGE')`. Tell the store we have
   * delivered what was bought.
   *
   * ORDER IS THE WHOLE DESIGN, and it is the opposite of the intuitive one.
   * This is called AFTER the transaction row and the entitlement exist, never
   * before. Acknowledging a purchase we then failed to record would tell Google
   * "delivered" about access the family does not have — the one outcome with no
   * automatic remedy, since the auto-refund window is precisely what
   * acknowledgement closes. Getting it the other way round means a family who
   * paid keeps their access and Google refunds them: bad, visible, and
   * recoverable.
   *
   * It takes the whole `IVerifiedPurchase` rather than a token, because the
   * resource identifier acknowledgement needs is provider-specific and must
   * stay opaque to the application layer.
   */
  acknowledgePurchase?(verified: IVerifiedPurchase): Promise<void>;
}

/**
 * Resolves the configured adapter for a provider enum value.
 *
 * Deliberately a registry keyed on DATA, not a single adapter injected at
 * startup: `subscriptions.provider` is a column, so an Egyptian family on
 * Paymob and a Saudi family on Moyasar coexist in one deployment. A1's "what
 * was done right" section singled this design out; it is kept verbatim and
 * extended.
 */
export interface IPaymentProviderRegistry {
  getAdapter(provider: PaymentProviderValue): IPaymentProvider;
  /** Every registered adapter, for the reconciliation job and for diagnostics. */
  all(): readonly IPaymentProvider[];
}

// ---------------------------------------------------------------------------
// BACKWARD COMPATIBILITY — the Sprint 8 contract, kept.
// ---------------------------------------------------------------------------

/**
 * KEPT, NOT REMOVED. `PaymentService.charge()` and the Sprint 8
 * `SubscriptionService.subscribe()` path still speak this shape, and Phase D's
 * instruction is to EXTEND the billing module rather than build a rival one.
 * New code uses `createCheckout` / `verifyPurchase`; this remains the MANUAL
 * provider's contract, which is the one place a synchronous "charge succeeded"
 * is honestly true.
 */
export interface IChargeInput {
  subscriptionId: string;
  amountCents: number;
  currency: string;
}

export interface IChargeResult {
  success: boolean;
  providerChargeId: string | null;
  failureReason: string | null;
}

/** The Sprint 8 contract. Every adapter still implements it. */
export interface IPaymentProviderAdapter {
  readonly providerName: PaymentProviderValue;
  charge(input: IChargeInput): Promise<IChargeResult>;
}
