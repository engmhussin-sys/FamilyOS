/**
 * PHASE D — APPLE STOREKIT 2 / APP STORE SERVER API PAYLOAD SHAPES.
 *
 * Transcribed from Apple's own documentation, fetched 2026-08-16:
 *
 *  - App Store Server API (base URLs, endpoints, JWT auth)
 *    https://developer.apple.com/documentation/appstoreserverapi
 *  - Generating JSON Web Tokens for API requests
 *    https://developer.apple.com/documentation/appstoreserverapi/generating-json-web-tokens-for-api-requests
 *  - JWSDecodedHeader (the x5c chain and how to verify it)
 *    https://developer.apple.com/documentation/appstoreserverapi/jwsdecodedheader
 *  - responseBodyV2DecodedPayload (App Store Server Notifications V2)
 *    https://developer.apple.com/documentation/appstoreservernotifications/responsebodyv2decodedpayload
 *  - notificationType (the full life-cycle table)
 *    https://developer.apple.com/documentation/appstoreservernotifications/notificationtype
 *
 * WHY THESE ARE HAND-WRITTEN TYPES AND NOT `any`. The whole point of this
 * module is that the shape of what Apple sends is checked, not assumed. A
 * field that Apple renamed shows up here as a compile error rather than as a
 * silently-undefined `price` that becomes a zero-amount transaction.
 *
 * NOTE ON `price`. Apple added `price` and `currency` to
 * `JWSTransactionDecodedPayload` in the 2023 revision; `price` is in
 * MILLI-UNITS of `currency` (a 99.00 charge is 99000), which is a different
 * scale from the minor units the rest of this system uses. The conversion
 * happens in exactly one place — `AppleStoreKitProvider.toVerifiedPurchase` —
 * and is commented there.
 */

/** `environment` distinguishes a real purchase from a sandbox one. */
export type AppleEnvironment = 'Sandbox' | 'Production';

/**
 * https://developer.apple.com/documentation/appstoreserverapi/jwstransactiondecodedpayload
 */
export interface IAppleJwsTransactionPayload {
  transactionId: string;
  originalTransactionId: string;
  webOrderLineItemId?: string;
  bundleId: string;
  productId: string;
  subscriptionGroupIdentifier?: string;
  /** Milliseconds since epoch. */
  purchaseDate: number;
  originalPurchaseDate: number;
  expiresDate?: number;
  quantity?: number;
  type: 'Auto-Renewable Subscription' | 'Non-Consumable' | 'Consumable' | 'Non-Renewing Subscription';
  /**
   * THE TENANT LINK. A UUID the iOS app sets on the purchase
   * (`Product.PurchaseOption.appAccountToken`). Opaque to Apple. Resolved
   * against `provider_account_links` — which is why a purchase belonging to
   * another household cannot be applied to the caller's.
   */
  appAccountToken?: string;
  inAppOwnershipType: 'PURCHASED' | 'FAMILY_SHARED';
  signedDate: number;
  /** Present only on a refunded/revoked transaction. */
  revocationDate?: number;
  revocationReason?: number;
  offerType?: number;
  offerIdentifier?: string;
  environment: AppleEnvironment;
  /** ISO-3166-1 alpha-3 (`EGY`, `SAU`) — NOT alpha-2. Converted on the way in. */
  storefront?: string;
  storefrontId?: string;
  transactionReason?: 'PURCHASE' | 'RENEWAL';
  /** ISO-4217. */
  currency?: string;
  /** MILLI-units of `currency`. 99.00 EGP is 99000. See the file docstring. */
  price?: number;
}

/**
 * https://developer.apple.com/documentation/appstoreserverapi/jwsrenewalinfodecodedpayload
 */
export interface IAppleJwsRenewalInfoPayload {
  originalTransactionId: string;
  autoRenewProductId?: string;
  productId: string;
  /** 0 = off, 1 = on. */
  autoRenewStatus: 0 | 1;
  /** 1 customer cancelled · 2 billing error · 3 declined price increase · 4 product unavailable · 5 unknown. */
  expirationIntent?: 1 | 2 | 3 | 4 | 5;
  /** 0 = not in retry, 1 = App Store is still trying to charge. */
  isInBillingRetryPeriod?: boolean;
  /** Milliseconds. Present while the subscription is in a BILLING GRACE PERIOD. */
  gracePeriodExpiresDate?: number;
  /** 0 = not eligible, 1 = eligible for an introductory offer. */
  priceIncreaseStatus?: 0 | 1;
  offerType?: number;
  offerIdentifier?: string;
  signedDate: number;
  environment: AppleEnvironment;
  recentSubscriptionStartDate?: number;
  renewalDate?: number;
  currency?: string;
  renewalPrice?: number;
}

/**
 * The full notificationType vocabulary, from Apple's own life-cycle table.
 * Kept complete rather than trimmed to "the ones we handle": an unknown string
 * would be indistinguishable from a typo, and the handler's `UNHANDLED` branch
 * is a deliberate decision per type, not a fallback for everything.
 */
export type AppleNotificationType =
  | 'SUBSCRIBED'
  | 'DID_RENEW'
  | 'DID_CHANGE_RENEWAL_PREF'
  | 'DID_CHANGE_RENEWAL_STATUS'
  | 'DID_FAIL_TO_RENEW'
  | 'EXPIRED'
  | 'GRACE_PERIOD_EXPIRED'
  | 'OFFER_REDEEMED'
  | 'PRICE_INCREASE'
  | 'REFUND'
  | 'REFUND_DECLINED'
  | 'REFUND_REVERSED'
  | 'REVOKE'
  | 'CONSUMPTION_REQUEST'
  | 'RENEWAL_EXTENDED'
  | 'RENEWAL_EXTENSION'
  | 'ONE_TIME_CHARGE'
  | 'EXTERNAL_PURCHASE_TOKEN'
  | 'TEST';

export type AppleNotificationSubtype =
  | 'INITIAL_BUY'
  | 'RESUBSCRIBE'
  | 'DOWNGRADE'
  | 'UPGRADE'
  | 'AUTO_RENEW_ENABLED'
  | 'AUTO_RENEW_DISABLED'
  | 'VOLUNTARY'
  | 'BILLING_RETRY'
  | 'PRICE_INCREASE'
  | 'PRODUCT_NOT_FOR_SALE'
  | 'GRACE_PERIOD'
  | 'BILLING_RECOVERY'
  | 'PENDING'
  | 'ACCEPTED'
  | 'SUMMARY'
  | 'FAILURE';

/**
 * https://developer.apple.com/documentation/appstoreservernotifications/responsebodyv2decodedpayload
 */
export interface IAppleNotificationPayload {
  notificationType: AppleNotificationType;
  subtype?: AppleNotificationSubtype;
  /** THE DEDUPE KEY. Stable across Apple's redeliveries. */
  notificationUUID: string;
  version: string;
  signedDate: number;
  data?: {
    appAppleId?: number;
    bundleId: string;
    bundleVersion?: string;
    environment: AppleEnvironment;
    /** A nested JWS. Verified separately — the outer signature does not vouch for it. */
    signedTransactionInfo?: string;
    signedRenewalInfo?: string;
    status?: number;
  };
  summary?: {
    requestIdentifier: string;
    environment: AppleEnvironment;
    appAppleId?: number;
    bundleId: string;
    productId: string;
    storefrontCountryCodes?: string[];
    failedCount: number;
    succeededCount: number;
  };
  externalPurchaseToken?: {
    externalPurchaseId: string;
    tokenCreationDate: number;
    appAppleId?: number;
    bundleId: string;
  };
}

/**
 * `GET /inApps/v1/subscriptions/{originalTransactionId}` response.
 * https://developer.apple.com/documentation/appstoreserverapi/statusresponse
 */
export interface IAppleStatusResponse {
  environment: AppleEnvironment;
  bundleId: string;
  appAppleId?: number;
  data: Array<{
    subscriptionGroupIdentifier: string;
    lastTransactions: Array<{
      originalTransactionId: string;
      /** 1 active · 2 expired · 3 billing retry · 4 billing grace period · 5 revoked. */
      status: 1 | 2 | 3 | 4 | 5;
      signedTransactionInfo: string;
      signedRenewalInfo: string;
    }>;
  }>;
}

/** Apple's numeric subscription status, from `statusResponse`. */
export const APPLE_STATUS_ACTIVE = 1;
export const APPLE_STATUS_EXPIRED = 2;
export const APPLE_STATUS_BILLING_RETRY = 3;
export const APPLE_STATUS_BILLING_GRACE_PERIOD = 4;
export const APPLE_STATUS_REVOKED = 5;

/**
 * `GET /inApps/v1/transactions/{transactionId}` response — a single signed
 * transaction, which is how a client-supplied `transactionId` is checked
 * against Apple rather than against itself.
 * https://developer.apple.com/documentation/appstoreserverapi/transactioninforesponse
 */
export interface IAppleTransactionInfoResponse {
  signedTransactionInfo: string;
}

/** Apple's documented base URLs. */
export const APPLE_API_BASE_PRODUCTION = 'https://api.storekit.itunes.apple.com';
export const APPLE_API_BASE_SANDBOX = 'https://api.storekit-sandbox.itunes.apple.com';

/** Apple's documented JWT audience for the App Store Server API. */
export const APPLE_JWT_AUDIENCE = 'appstoreconnect-v1';

/** «Tokens that expire more than 60 minutes after `iat` are not valid.» */
export const APPLE_JWT_MAX_LIFETIME_SECONDS = 3600;
