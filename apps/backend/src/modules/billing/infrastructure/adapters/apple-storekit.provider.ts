import { Injectable, Logger } from '@nestjs/common';
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
  AppleJwsVerifier,
  sha256Hex,
  unsafeDecodeJwsPayload,
} from '../apple/apple-jws.verifier';
import {
  AppStoreServerApiClient,
  type FetchLike,
  type IAppStoreServerApiConfig,
} from '../apple/app-store-server-api.client';
import {
  APPLE_STATUS_ACTIVE,
  APPLE_STATUS_BILLING_GRACE_PERIOD,
  APPLE_STATUS_BILLING_RETRY,
  APPLE_STATUS_EXPIRED,
  APPLE_STATUS_REVOKED,
  type AppleNotificationSubtype,
  type AppleNotificationType,
  type IAppleJwsRenewalInfoPayload,
  type IAppleJwsTransactionPayload,
  type IAppleNotificationPayload,
} from '../apple/apple-storekit.types';

/**
 * PHASE D — APPLE IN-APP PURCHASE (StoreKit 2), SERVER-AUTHORITATIVE.
 *
 * ================== IN-APP PURCHASE, NOT APPLE PAY ==================
 *
 * These are two unrelated systems and the brief is right to insist on the
 * distinction:
 *
 *   - IN-APP PURCHASE (this file) is how Apple requires DIGITAL content and
 *     subscriptions to be sold inside an iOS app. The purchase happens on the
 *     device through StoreKit; Apple bills the customer; Apple takes its
 *     commission; the server's entire role is to VERIFY and to grant
 *     entitlement. This backend never sees a card and never moves money.
 *
 *   - APPLE PAY is a card-presentment technology — a wallet that hands a
 *     payment token to a NORMAL payment gateway. It is for PHYSICAL goods and
 *     non-digital services, and Apple's own guidelines forbid using it for the
 *     digital subscriptions this product sells.
 *
 *   ARCHITECTURALLY THEY ARE NOT THE SAME MECHANISM AND MUST NOT SHARE AN
 *   ADAPTER. If ABNY ever sells something physical (a printed reward chart, a
 *   partner voucher fulfilled offline), Apple Pay belongs behind the SAUDI /
 *   EGYPTIAN GATEWAY adapters — `MoyasarProvider` already supports mada and
 *   Apple Pay as card-presentment methods, because to a gateway an Apple Pay
 *   token is just another way to present a card. It would enter this system as
 *   a `GATEWAY` provider, not as a second `STORE` one, and it would never
 *   touch this file. Stated here so nobody later "unifies" them.
 *
 * ============== THE CLIENT IS NEVER BELIEVED. HOW, EXACTLY. ==============
 *
 * The iOS app can send exactly one thing: a signed `JWSTransaction` string, or
 * a transaction id. Everything else — amount, currency, product, expiry,
 * renewal state, and WHICH HOUSEHOLD IT BELONGS TO — is derived as follows:
 *
 *   1. The JWS is verified against Apple's x5c chain, pinned to Apple Root
 *      CA G3 (`AppleJwsVerifier`). A forged blob dies here.
 *   2. `bundleId` inside the verified payload is compared to OUR configured
 *      bundle id. A genuinely Apple-signed receipt for a DIFFERENT APP is a
 *      real and easy attack, and this check is the only thing that stops it.
 *   3. The App Store Server API is called for the CURRENT status of the
 *      lineage. A validly-signed receipt for a subscription refunded last week
 *      is still validly signed; only Apple can say it is dead.
 *   4. `appAccountToken` is resolved against `provider_account_links` by the
 *      caller (`PaymentVerificationService`) to find the tenant. A purchase
 *      that resolves to another family is refused — the requesting session's
 *      `familyId` does not get a vote.
 *   5. `environment: "Sandbox"` is recorded and, outside a sandbox
 *      deployment, is refused entitlement.
 *
 * There is no code path in this file that produces an `IVerifiedPurchase` from
 * unverified input.
 *
 * ==================== WHAT IS BLOCKED, EXPLICITLY ====================
 *
 * SANDBOX VERIFICATION AGAINST REAL APPLE SERVERS HAS NOT BEEN PERFORMED AND
 * CANNOT BE. It needs an App Store Connect account, an Issuer ID, a Key ID, a
 * `.p8` private key and a real bundle id — none of which exist for this
 * project, and none of which may be fabricated. Every test in
 * `test/billing/apple-storekit.provider.spec.ts` mocks APPLE'S HTTP RESPONSES
 * and the SIGNING KEY (a locally generated ECDSA chain), never the verification
 * logic: the verifier under test is the production verifier, run against a
 * chain whose root is pinned to the test root. That proves the algorithm. It
 * does not prove interoperability with Apple, and this file does not pretend
 * otherwise.
 */
@Injectable()
export class AppleStoreKitProvider implements IPaymentProvider, IPaymentProviderAdapter {
  readonly providerName = 'APPLE_IAP' as const;
  readonly kind: ProviderKind = 'STORE';

  private readonly logger = new Logger(AppleStoreKitProvider.name);

  constructor(
    private readonly configService: ConfigService,
    /** Injected so tests can mock APPLE'S HTTP RESPONSES, not our logic. */
    private readonly fetchImpl: FetchLike = defaultFetch,
    private readonly now: () => Date = () => new Date(),
  ) {}

  // -------------------------------------------------------------------------
  // Configuration
  // -------------------------------------------------------------------------

  isConfigured(): boolean {
    return this.readConfig() !== null && this.verifier().isConfigured();
  }

  supports(capability: ProviderCapability): boolean {
    // NO CHECKOUT and NO REFUND, deliberately. Apple owns both. A server that
    // offered a "refund this Apple purchase" button would be lying: only Apple
    // can refund an Apple purchase, and it tells us afterwards via a REFUND
    // notification. See the `refund` absence in `IPaymentProvider`.
    return capability === 'VERIFY' || capability === 'WEBHOOK';
  }

  private readConfig(): IAppStoreServerApiConfig | null {
    const issuerId = this.configService.get<string>('APPLE_ISSUER_ID');
    const keyId = this.configService.get<string>('APPLE_KEY_ID');
    const privateKeyPem = this.configService.get<string>('APPLE_PRIVATE_KEY');
    const bundleId = this.configService.get<string>('APPLE_BUNDLE_ID');
    if (!issuerId || !keyId || !privateKeyPem || !bundleId) return null;
    return {
      issuerId,
      keyId,
      // A `.p8` in an env var arrives with literal "\n". Normalised once, here.
      privateKeyPem: privateKeyPem.replace(/\\n/g, '\n'),
      bundleId,
      useSandbox: this.configService.get<string>('APPLE_USE_SANDBOX') === 'true',
    };
  }

  private verifier(): AppleJwsVerifier {
    return new AppleJwsVerifier({
      rootFingerprintSha256: this.configService.get<string>('APPLE_ROOT_CA_G3_FINGERPRINT') ?? null,
      now: this.now,
    });
  }

  private client(config: IAppStoreServerApiConfig): AppStoreServerApiClient {
    return new AppStoreServerApiClient(config, this.fetchImpl, this.now);
  }

  private requireConfig(): IAppStoreServerApiConfig {
    const config = this.readConfig();
    if (!config) throw new PaymentProviderNotConfiguredException('Apple In-App Purchase');
    if (!this.verifier().isConfigured()) {
      throw new PaymentProviderNotConfiguredException('Apple In-App Purchase (root certificate fingerprint)');
    }
    return config;
  }

  // -------------------------------------------------------------------------
  // Verification
  // -------------------------------------------------------------------------

  /**
   * Verifies a StoreKit 2 purchase.
   *
   * `providerToken` is either a compact `JWSTransaction` (what
   * `Transaction.jwsRepresentation` gives the iOS app) or a bare
   * `transactionId`. Both paths converge on a signed transaction obtained or
   * confirmed FROM APPLE.
   */
  async verifyPurchase(input: IVerifyPurchaseInput): Promise<IVerifiedPurchase> {
    const config = this.requireConfig();
    const verifier = this.verifier();
    const client = this.client(config);

    // STEP 1 — obtain a signed transaction we trust.
    let signedTransaction: string;
    if (input.providerToken.split('.').length === 3) {
      // The client handed us a JWS. We do NOT take its word for currency: it is
      // verified below, and then re-confirmed against Apple in step 3.
      signedTransaction = input.providerToken;
    } else {
      const info = await client.getTransactionInfo(input.providerToken);
      signedTransaction = info.signedTransactionInfo;
    }

    const verified = verifier.verify<IAppleJwsTransactionPayload>(signedTransaction);
    if (!verified.verified || !verified.payload) {
      throw new AppleVerificationError(`Apple transaction JWS did not verify: ${verified.reason}`);
    }
    const transaction = verified.payload;

    // STEP 2 — THE BUNDLE CHECK. A genuinely Apple-signed receipt for another
    // developer's app verifies perfectly against Apple's chain. Only this
    // comparison distinguishes it from ours.
    if (transaction.bundleId !== config.bundleId) {
      throw new AppleVerificationError(
        `Apple transaction is for bundle "${transaction.bundleId}", not this application.`,
      );
    }

    // STEP 3 — CURRENT TRUTH FROM APPLE. The JWS proves Apple signed it once;
    // it says nothing about whether the subscription is alive now.
    const status = await client.getSubscriptionStatuses(transaction.originalTransactionId);
    const lastTransaction = status.data
      .flatMap((group) => group.lastTransactions)
      .find((t) => t.originalTransactionId === transaction.originalTransactionId);

    let renewalInfo: IAppleJwsRenewalInfoPayload | null = null;
    let appleStatus: number | null = null;
    if (lastTransaction) {
      appleStatus = lastTransaction.status;
      const verifiedRenewal = verifier.verify<IAppleJwsRenewalInfoPayload>(lastTransaction.signedRenewalInfo);
      // A renewal blob that does not verify is not a reason to fail the whole
      // purchase — it is a reason not to believe the renewal blob. The
      // subscription status itself came from an authenticated API call.
      if (verifiedRenewal.verified) renewalInfo = verifiedRenewal.payload;
      else this.logger.warn('Apple signedRenewalInfo failed verification; renewal fields ignored.');
    }

    return this.toVerifiedPurchase(transaction, renewalInfo, appleStatus, verified.digest);
  }

  // -------------------------------------------------------------------------
  // App Store Server Notifications V2
  // -------------------------------------------------------------------------

  /**
   * ASSN V2 HAS NO SIGNATURE HEADER. This surprises people and it is worth
   * stating plainly: Apple does not sign the HTTP request. It POSTs
   * `{"signedPayload": "<JWS>"}`, and THE BODY ITSELF IS THE SIGNATURE. So the
   * "signature verification" for Apple is verification of that JWS against the
   * pinned chain — which is strictly stronger than an HMAC header, because it
   * is asymmetric and there is no shared secret to leak.
   *
   * Consequence: an attacker POSTing to our webhook URL cannot forge anything
   * without Apple's private key, and the endpoint needs no IP allow-list to be
   * safe. It still gets one, in depth, at the deployment layer.
   */
  async verifyWebhookSignature(request: IWebhookRequest): Promise<IWebhookVerification> {
    if (!this.readConfig()) {
      return { verified: false, reason: 'Apple In-App Purchase is not configured.' };
    }
    const verifier = this.verifier();
    if (!verifier.isConfigured()) {
      return { verified: false, reason: 'APPLE_ROOT_CA_G3_FINGERPRINT is not configured.' };
    }

    let signedPayload: string | undefined;
    try {
      signedPayload = (JSON.parse(request.rawBody) as { signedPayload?: string }).signedPayload;
    } catch {
      return { verified: false, reason: 'Apple notification body is not valid JSON.' };
    }
    if (!signedPayload) return { verified: false, reason: 'Apple notification body has no signedPayload.' };

    const result = verifier.verify<IAppleNotificationPayload>(signedPayload);
    if (!result.verified) return { verified: false, reason: result.reason };

    // The outer JWS being Apple's is necessary but not sufficient: it must be
    // OUR app's notification. Same reasoning as step 2 of verifyPurchase.
    const bundleId = result.payload?.data?.bundleId ?? result.payload?.summary?.bundleId;
    const configuredBundle = this.readConfig()?.bundleId;
    if (bundleId && configuredBundle && bundleId !== configuredBundle) {
      return { verified: false, reason: 'Apple notification is for a different bundle id.' };
    }

    return { verified: true, reason: null };
  }

  async parseWebhook(request: IWebhookRequest): Promise<IProviderWebhookEvent> {
    const verifier = this.verifier();
    const body = JSON.parse(request.rawBody) as { signedPayload: string };
    const outer = verifier.verify<IAppleNotificationPayload>(body.signedPayload);
    if (!outer.verified || !outer.payload) {
      throw new AppleVerificationError(`Apple notification JWS did not verify: ${outer.reason}`);
    }
    const notification = outer.payload;

    // THE NESTED JWS IS VERIFIED SEPARATELY. The outer signature vouches for
    // the notification envelope; it does not vouch for a transaction blob
    // inside it. Apple signs both, so both are checked.
    let verifiedPurchase: IVerifiedPurchase | null = null;
    let transaction: IAppleJwsTransactionPayload | null = null;
    if (notification.data?.signedTransactionInfo) {
      const inner = verifier.verify<IAppleJwsTransactionPayload>(notification.data.signedTransactionInfo);
      if (!inner.verified || !inner.payload) {
        throw new AppleVerificationError(
          `Apple notification carries a signedTransactionInfo that did not verify: ${inner.reason}`,
        );
      }
      transaction = inner.payload;
      let renewalInfo: IAppleJwsRenewalInfoPayload | null = null;
      if (notification.data.signedRenewalInfo) {
        const renewal = verifier.verify<IAppleJwsRenewalInfoPayload>(notification.data.signedRenewalInfo);
        if (renewal.verified) renewalInfo = renewal.payload;
      }
      verifiedPurchase = this.toVerifiedPurchase(transaction, renewalInfo, null, inner.digest);
    }

    const kind = mapNotificationKind(notification.notificationType, notification.subtype);

    return {
      provider: this.providerName,
      // APPLE'S OWN DEDUPE KEY. `notificationUUID` is stable across Apple's
      // redeliveries — which is exactly what makes the unique index work.
      providerEventId: notification.notificationUUID,
      kind,
      rawEventType: notification.notificationType,
      rawEventSubtype: notification.subtype ?? null,
      signedAt: new Date(notification.signedDate),
      verifiedPurchase,
      refund:
        kind === 'REFUNDED' || kind === 'REFUND_REVERSED'
          ? {
              providerRefundId: null,
              providerTransactionId: transaction?.transactionId ?? '',
              // Apple reports the refunded amount as the transaction's own
              // price; there is no separate refund amount in the payload.
              amountMinor: transaction?.price != null ? milliToMinor(transaction.price) : null,
              currency: transaction?.currency ?? null,
              reason: transaction?.revocationReason != null ? `revocationReason=${transaction.revocationReason}` : null,
              occurredAt: new Date(transaction?.revocationDate ?? notification.signedDate),
              isReversal: kind === 'REFUND_REVERSED',
            }
          : null,
      providerOriginalTransactionId: transaction?.originalTransactionId ?? null,
      providerAccountRef: transaction?.appAccountToken ?? null,
    };
  }

  /**
   * Reads `notificationUUID` from an UNVERIFIED body so the dedupe row can be
   * written before verification runs. The row records
   * `signature_verified = false` and no entitlement is ever derived from it.
   * Returns null when the body is unusable, in which case the caller falls
   * back to a digest-based key and marks the event REJECTED.
   */
  peekEventId(rawBody: string): string | null {
    try {
      const signedPayload = (JSON.parse(rawBody) as { signedPayload?: string }).signedPayload;
      if (!signedPayload) return null;
      return unsafeDecodeJwsPayload<IAppleNotificationPayload>(signedPayload)?.notificationUUID ?? null;
    } catch {
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // Translation
  // -------------------------------------------------------------------------

  private toVerifiedPurchase(
    transaction: IAppleJwsTransactionPayload,
    renewalInfo: IAppleJwsRenewalInfoPayload | null,
    appleStatus: number | null,
    digest: string,
  ): IVerifiedPurchase {
    return {
      provider: this.providerName,
      providerTransactionId: transaction.transactionId,
      providerOriginalTransactionId: transaction.originalTransactionId,
      productRef: transaction.productId,
      providerAccountRef: transaction.appAccountToken ?? null,
      currency: (transaction.currency ?? 'USD').toUpperCase(),
      // APPLE'S `price` IS IN MILLI-UNITS, not minor units: a 99.00 charge is
      // 99000, not 9900. This is the ONE conversion site; getting it wrong
      // makes every transaction look 10x too large, and it is not the kind of
      // bug an integration test with round numbers catches.
      grossAmountMinor: transaction.price != null ? milliToMinor(transaction.price) : 0,
      countryCode: transaction.storefront ? alpha3ToAlpha2(transaction.storefront) : null,
      billingPeriod: inferBillingPeriod(transaction),
      purchasedAt: new Date(transaction.purchaseDate),
      expiresAt: transaction.expiresDate != null ? new Date(transaction.expiresDate) : null,
      status: mapAppleStatus(transaction, renewalInfo, appleStatus),
      autoRenewing: renewalInfo?.autoRenewStatus === 1,
      isSandbox: transaction.environment === 'Sandbox',
      verifiedPayloadDigest: digest,
    };
  }

  // -------------------------------------------------------------------------
  // Sprint 8 backward compatibility
  // -------------------------------------------------------------------------

  /**
   * KEPT AND STILL THROWING, on purpose. An Apple purchase is never initiated
   * by this server; there is nothing honest for `charge()` to do. Sprint 8's
   * adapter threw here for the same reason and was right to.
   */
  async charge(_input: IChargeInput): Promise<IChargeResult> {
    throw new PaymentProviderNotConfiguredException(
      'Apple In-App Purchase (charge() does not apply — purchases are client-initiated through StoreKit and verified server-side)',
    );
  }
}

export class AppleVerificationError extends Error {}

/**
 * Apple's `notificationType` x `subtype` life-cycle table, mapped to this
 * system's vocabulary. Transcribed from
 * https://developer.apple.com/documentation/appstoreservernotifications/notificationtype
 * (fetched 2026-08-16). Every branch is a decision; the `UNHANDLED` default is
 * for types Apple adds after this was written, which are acknowledged with 200
 * and acted on by nobody — the behaviour Apple's own guidance asks for.
 */
export function mapNotificationKind(
  type: AppleNotificationType,
  subtype: AppleNotificationSubtype | undefined,
): WebhookEventKind {
  switch (type) {
    case 'SUBSCRIBED':
      return 'PURCHASED';
    case 'DID_RENEW':
      // subtype BILLING_RECOVERY means the retry finally succeeded. Same
      // outcome for us — the subscription is alive again — so it is a RENEWED.
      return 'RENEWED';
    case 'DID_FAIL_TO_RENEW':
      // GRACE_PERIOD means Billing Grace Period is enabled and the customer
      // KEEPS ACCESS while Apple retries. Without it, the subscription is in
      // billing retry with no access.
      return subtype === 'GRACE_PERIOD' ? 'GRACE_PERIOD_STARTED' : 'BILLING_RETRY';
    case 'GRACE_PERIOD_EXPIRED':
      return 'GRACE_PERIOD_EXPIRED';
    case 'EXPIRED':
      return 'EXPIRED';
    case 'DID_CHANGE_RENEWAL_STATUS':
      // AUTO_RENEW_DISABLED is a CANCELLATION OF THE RENEWAL, not of access:
      // the customer keeps what they paid for until the period ends. Treating
      // it as an immediate revocation is the classic way to take away access a
      // customer has already paid for.
      return subtype === 'AUTO_RENEW_DISABLED' ? 'CANCELLED' : 'RENEWED';
    case 'REFUND':
      return 'REFUNDED';
    case 'REFUND_REVERSED':
      return 'REFUND_REVERSED';
    case 'REVOKE':
      // Family Sharing access withdrawn. Not a refund; entitlement ends.
      return 'REVOKED';
    case 'TEST':
      return 'TEST';
    case 'DID_CHANGE_RENEWAL_PREF':
    case 'OFFER_REDEEMED':
    case 'PRICE_INCREASE':
    case 'REFUND_DECLINED':
    case 'CONSUMPTION_REQUEST':
    case 'RENEWAL_EXTENDED':
    case 'RENEWAL_EXTENSION':
    case 'ONE_TIME_CHARGE':
    case 'EXTERNAL_PURCHASE_TOKEN':
    default:
      return 'UNHANDLED';
  }
}

/**
 * Apple's numeric subscription status (1..5) is the authoritative one when we
 * have it, because it came from an authenticated API call. Falling back to the
 * transaction blob's own fields is for the webhook path, where the API has not
 * been called.
 */
export function mapAppleStatus(
  transaction: IAppleJwsTransactionPayload,
  renewalInfo: IAppleJwsRenewalInfoPayload | null,
  appleStatus: number | null,
): CanonicalSubscriptionStatus {
  if (transaction.revocationDate != null) return 'REFUNDED';

  if (appleStatus != null) {
    switch (appleStatus) {
      case APPLE_STATUS_ACTIVE:
        return 'ACTIVE';
      case APPLE_STATUS_EXPIRED:
        return 'EXPIRED';
      case APPLE_STATUS_BILLING_RETRY:
        return 'PAST_DUE';
      case APPLE_STATUS_BILLING_GRACE_PERIOD:
        return 'GRACE_PERIOD';
      case APPLE_STATUS_REVOKED:
        return 'REFUNDED';
      default:
        break;
    }
  }

  if (renewalInfo?.gracePeriodExpiresDate != null) return 'GRACE_PERIOD';
  if (renewalInfo?.isInBillingRetryPeriod === true) return 'PAST_DUE';
  if (transaction.expiresDate != null && transaction.expiresDate <= Date.now()) return 'EXPIRED';
  return 'ACTIVE';
}

/**
 * Apple does not report the billing period as a field. It is derived from the
 * purchase/expiry span, bucketed generously — a "monthly" subscription is
 * 28..31 days depending on the month, and an exact comparison would
 * misclassify February.
 */
function inferBillingPeriod(transaction: IAppleJwsTransactionPayload): BillingPeriodValue | null {
  if (transaction.expiresDate == null) return null;
  const days = (transaction.expiresDate - transaction.purchaseDate) / 86_400_000;
  if (days <= 45) return 'MONTHLY';
  if (days <= 135) return 'QUARTERLY';
  return 'ANNUAL';
}

/** Apple's `price` is milli-units of the currency. 99000 -> 9900 minor units. */
function milliToMinor(price: number): number {
  return Math.round(price / 10);
}

/**
 * Apple storefronts are ISO-3166-1 ALPHA-3 (`EGY`, `SAU`); this system's
 * `countries` table is keyed on ALPHA-2. Only the launch markets plus the two
 * most common storefronts for expatriate customers are mapped; an unmapped
 * storefront returns null rather than a guess, and the country is then taken
 * from our own price catalogue instead.
 */
function alpha3ToAlpha2(storefront: string): string | null {
  const map: Record<string, string> = {
    EGY: 'EG',
    SAU: 'SA',
    ARE: 'AE',
    KWT: 'KW',
    USA: 'US',
    GBR: 'GB',
  };
  return map[storefront.toUpperCase()] ?? null;
}

const defaultFetch: FetchLike = (url, init) =>
  // eslint-disable-next-line @typescript-eslint/no-unsafe-return
  (globalThis as unknown as { fetch: FetchLike }).fetch(url, init);
