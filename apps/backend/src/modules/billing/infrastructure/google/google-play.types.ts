/**
 * PHASE D — GOOGLE PLAY DEVELOPER API v3 PAYLOAD SHAPES.
 *
 * Transcribed from Google's own documentation, fetched 2026-08-16:
 *
 *  - purchases.subscriptionsv2.get (endpoint, scope, SubscriptionPurchaseV2)
 *    https://developers.google.com/android-publisher/api-ref/rest/v3/purchases.subscriptionsv2/get
 *  - SubscriptionState enum (all nine values)
 *    https://developers.google.com/android-publisher/api-ref/rest/v3/purchases.subscriptionsv2#SubscriptionState
 *  - Real-time developer notifications reference (payload, Pub/Sub encoding,
 *    the full notificationType table, VoidedPurchaseNotification)
 *    https://developer.android.com/google/play/billing/rtdn-reference
 *
 * THE STRUCTURAL FACT THAT SHAPES THIS WHOLE ADAPTER, and the reason Google is
 * NOT symmetrical with Apple:
 *
 *   AN RTDN CARRIES NO PURCHASE DATA. It carries a purchase TOKEN and a type
 *   integer. Google's own reference says it outright: «After receiving an
 *   RTDN, call the Google Play Developer API to get complete purchase status.»
 *
 * So Google's `parseWebhook` returns `verifiedPurchase: null` and the handler
 * MUST make an authenticated server-to-server call. There is no version of
 * this integration in which the notification alone is enough — which is
 * convenient, because it means there is nothing in the notification worth
 * forging.
 *
 * The `subscriptionsv2` resource is used rather than the deprecated
 * `purchases.subscriptions`: it is the only one that models base plans, offers
 * and the full nine-value state machine. Note that `subscriptionsv2` has NO
 * `acknowledge` method — acknowledgement is still done through
 * `purchases.subscriptions.acknowledge`, and an unacknowledged purchase is
 * AUTOMATICALLY REFUNDED BY GOOGLE after three days. That is a real production
 * hazard and it is called out in the adapter.
 */

/** All nine values, verbatim. */
export type GoogleSubscriptionState =
  | 'SUBSCRIPTION_STATE_UNSPECIFIED'
  | 'SUBSCRIPTION_STATE_PENDING'
  | 'SUBSCRIPTION_STATE_ACTIVE'
  | 'SUBSCRIPTION_STATE_PAUSED'
  | 'SUBSCRIPTION_STATE_IN_GRACE_PERIOD'
  | 'SUBSCRIPTION_STATE_ON_HOLD'
  | 'SUBSCRIPTION_STATE_CANCELED'
  | 'SUBSCRIPTION_STATE_EXPIRED'
  | 'SUBSCRIPTION_STATE_PENDING_PURCHASE_CANCELED';

export type GoogleAcknowledgementState =
  | 'ACKNOWLEDGEMENT_STATE_UNSPECIFIED'
  | 'ACKNOWLEDGEMENT_STATE_PENDING'
  | 'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED';

export interface IGoogleMoney {
  /** ISO-4217. */
  currencyCode: string;
  /** Whole units, as a STRING (Google returns int64 as a string). */
  units?: string;
  /** Nano units: 1e-9 of a unit. 990000000 nanos = 0.99. */
  nanos?: number;
}

export interface IGoogleSubscriptionLineItem {
  productId: string;
  /** RFC-3339. */
  expiryTime: string;
  autoRenewingPlan?: {
    autoRenewEnabled?: boolean;
    recurringPrice?: IGoogleMoney;
  };
  prepaidPlan?: { allowExtendAfterTime?: string };
  offerDetails?: {
    basePlanId: string;
    offerId?: string;
    offerTags?: string[];
  };
  /** Present when the line item has a price the caller may read. */
  signupPromotion?: unknown;
}

/**
 * https://developers.google.com/android-publisher/api-ref/rest/v3/purchases.subscriptionsv2#SubscriptionPurchaseV2
 */
export interface IGoogleSubscriptionPurchaseV2 {
  kind?: string;
  regionCode?: string;
  /** RFC-3339. */
  startTime?: string;
  subscriptionState: GoogleSubscriptionState;
  latestOrderId?: string;
  linkedPurchaseToken?: string;
  pausedStateContext?: { autoResumeTime?: string };
  canceledStateContext?: {
    userInitiatedCancellation?: { cancelSurveyResult?: unknown; cancelTime?: string };
    systemInitiatedCancellation?: Record<string, never>;
    developerInitiatedCancellation?: Record<string, never>;
    replacementCancellation?: Record<string, never>;
  };
  /**
   * THE TENANT LINK. `obfuscatedExternalAccountId` is a value OUR APP sets on
   * the BillingFlowParams. Opaque to Google. Resolved against
   * `provider_account_links` — which is why a purchase belonging to another
   * household cannot be applied to the caller's.
   */
  externalAccountIdentifiers?: {
    externalAccountId?: string;
    obfuscatedExternalAccountId?: string;
    obfuscatedExternalProfileId?: string;
  };
  subscribeWithGoogleInfo?: unknown;
  /** Present ONLY for a licence-tester purchase. Its mere presence is the flag. */
  testPurchase?: Record<string, never>;
  acknowledgementState: GoogleAcknowledgementState;
  lineItems: IGoogleSubscriptionLineItem[];
}

/**
 * The RTDN envelope, after base64-decoding the Pub/Sub `message.data`.
 * https://developer.android.com/google/play/billing/rtdn-reference
 */
export interface IGoogleDeveloperNotification {
  version: string;
  packageName: string;
  /** Milliseconds since epoch, as a STRING. */
  eventTimeMillis: string;
  subscriptionNotification?: {
    version: string;
    notificationType: number;
    purchaseToken: string;
    subscriptionId: string;
  };
  oneTimeProductNotification?: {
    version: string;
    notificationType: number;
    purchaseToken: string;
    sku: string;
  };
  voidedPurchaseNotification?: {
    purchaseToken: string;
    orderId: string;
    /** 1 = subscription, 2 = one-time. */
    productType: number;
    /** 1 = full refund, 2 = quantity-based partial refund. */
    refundType: number;
  };
  testNotification?: { version: string };
}

/** The Pub/Sub push envelope Google POSTs to our endpoint. */
export interface IGooglePubSubEnvelope {
  message: {
    /** Base64 of the `IGoogleDeveloperNotification` JSON. */
    data: string;
    /** THE DEDUPE KEY. Pub/Sub guarantees this is stable per message. */
    messageId?: string;
    message_id?: string;
    publishTime?: string;
    publish_time?: string;
    attributes?: Record<string, string>;
  };
  subscription: string;
}

/**
 * The full subscriptionNotification type table, from Google's reference.
 * Named constants rather than magic integers — `case 12:` in a payment handler
 * is how a revocation gets mistaken for a pause.
 */
export const GOOGLE_SUBSCRIPTION_RECOVERED = 1;
export const GOOGLE_SUBSCRIPTION_RENEWED = 2;
export const GOOGLE_SUBSCRIPTION_CANCELED = 3;
export const GOOGLE_SUBSCRIPTION_PURCHASED = 4;
export const GOOGLE_SUBSCRIPTION_ON_HOLD = 5;
export const GOOGLE_SUBSCRIPTION_IN_GRACE_PERIOD = 6;
export const GOOGLE_SUBSCRIPTION_RESTARTED = 7;
export const GOOGLE_SUBSCRIPTION_PRICE_CHANGE_CONFIRMED = 8;
export const GOOGLE_SUBSCRIPTION_DEFERRED = 9;
export const GOOGLE_SUBSCRIPTION_PAUSED = 10;
export const GOOGLE_SUBSCRIPTION_PAUSE_SCHEDULE_CHANGED = 11;
export const GOOGLE_SUBSCRIPTION_REVOKED = 12;
export const GOOGLE_SUBSCRIPTION_EXPIRED = 13;
export const GOOGLE_SUBSCRIPTION_ITEMS_CHANGED = 17;
export const GOOGLE_SUBSCRIPTION_CANCELLATION_SCHEDULED = 18;
export const GOOGLE_SUBSCRIPTION_PRICE_CHANGE_UPDATED = 19;
export const GOOGLE_SUBSCRIPTION_PENDING_PURCHASE_CANCELED = 20;
export const GOOGLE_SUBSCRIPTION_PRICE_STEP_UP_CONSENT_UPDATED = 22;

/** `refundType` on a VoidedPurchaseNotification. */
export const GOOGLE_REFUND_TYPE_FULL = 1;
export const GOOGLE_REFUND_TYPE_PARTIAL = 2;

export const GOOGLE_ANDROIDPUBLISHER_BASE = 'https://androidpublisher.googleapis.com';
export const GOOGLE_OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const GOOGLE_ANDROIDPUBLISHER_SCOPE = 'https://www.googleapis.com/auth/androidpublisher';
