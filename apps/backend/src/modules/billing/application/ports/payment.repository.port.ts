import type { BillingPeriodValue } from './payment-provider.port';
import type { EntitlementKey, PaymentProviderValue, SubscriptionPlanTier } from '../../domain/billing.types';
import type { CanonicalSubscriptionStatus } from '../../domain/subscription-status';
import type { VatMode } from '../../domain/money';

export const PAYMENT_REPOSITORY = Symbol('PAYMENT_REPOSITORY');

/**
 * PHASE D — THE PERSISTENCE SEAM FOR EVERYTHING FINANCIAL.
 *
 * Separate from `IBillingRepository` (Sprint 8) rather than bolted onto it,
 * for a reason worth stating: the Sprint 8 repository's operations are
 * READ-MOSTLY CONFIGURATION and simple state (`findPlanByTier`,
 * `updateSubscriptionStatus`). Everything below is APPEND-ONLY FINANCIAL
 * RECORD, defended by database unique constraints, and every method here
 * returns enough information for the caller to know whether it WON or LOST the
 * idempotency race. Mixing the two would blur the one property that matters.
 *
 * THE `wasCreated` CONVENTION. Every insert that participates in idempotency
 * returns `{ record, wasCreated }`. `wasCreated === false` means the unique
 * index rejected the insert because an equivalent row already exists — which
 * is a SUCCESS, not an error, and the caller must not re-apply side effects.
 * This is the same shape the reward ledger's `ON CONFLICT DO NOTHING` path
 * already uses, and it is why a duplicate webhook grants nothing twice.
 */

export interface ICountryConfig {
  readonly code: string;
  readonly nameEn: string;
  readonly nameAr: string;
  readonly currencyCode: string;
  readonly vatBasisPoints: number;
  readonly vatMode: VatMode;
  readonly defaultProvider: PaymentProviderValue;
  readonly isActive: boolean;
  readonly minorUnits: number;
}

export interface ISubscriptionPriceRecord {
  readonly id: string;
  readonly planTier: SubscriptionPlanTier;
  readonly countryCode: string;
  readonly currencyCode: string;
  readonly billingPeriod: BillingPeriodValue;
  readonly amountMinor: number;
  readonly vatMode: VatMode;
  readonly storeProductId: string | null;
  readonly isActive: boolean;
}

export interface ITrialRecord {
  readonly id: string;
  readonly familyId: string;
  readonly planTier: SubscriptionPlanTier;
  readonly startedAt: Date;
  readonly endsAt: Date;
  readonly source: string;
  readonly convertedAt: Date | null;
  readonly cancelledAt: Date | null;
}

export interface IPaymentTransactionRecord {
  readonly id: string;
  readonly familyId: string;
  readonly subscriptionId: string | null;
  readonly provider: PaymentProviderValue;
  readonly providerTransactionId: string;
  readonly providerOriginalTransactionId: string | null;
  readonly productRef: string | null;
  readonly planTier: SubscriptionPlanTier | null;
  readonly billingPeriod: BillingPeriodValue | null;
  readonly countryCode: string | null;
  readonly currency: string;
  readonly grossAmountMinor: number;
  readonly vatAmountMinor: number;
  readonly netAmountMinor: number;
  readonly status: 'PENDING' | 'SUCCEEDED' | 'FAILED' | 'REFUNDED' | 'CHARGEBACK';
  readonly idempotencyKey: string;
  readonly occurredAt: Date;
  readonly verifiedAt: Date | null;
  readonly isSandbox: boolean;
}

export interface IRefundRecord {
  readonly id: string;
  readonly familyId: string;
  readonly paymentTransactionId: string;
  readonly provider: PaymentProviderValue;
  readonly providerRefundId: string | null;
  readonly amountMinor: number;
  readonly currency: string;
  readonly reason: string | null;
  readonly status: 'PENDING' | 'COMPLETED' | 'DECLINED' | 'REVERSED';
  readonly idempotencyKey: string;
  readonly occurredAt: Date;
}

export interface IEntitlementRecord {
  readonly id: string;
  readonly familyId: string;
  readonly featureKey: string;
  readonly planTier: SubscriptionPlanTier;
  readonly source: PaymentProviderValue;
  readonly subscriptionId: string | null;
  readonly status: 'ACTIVE' | 'REVOKED' | 'EXPIRED';
  readonly validFrom: Date;
  readonly validUntil: Date | null;
  readonly revokedAt: Date | null;
  readonly revokedReason: string | null;
}

export type WebhookOutcomeValue =
  | 'RECEIVED'
  | 'PROCESSED'
  | 'IGNORED'
  | 'REJECTED_SIGNATURE'
  | 'REJECTED_VALIDATION'
  | 'DUPLICATE'
  | 'FAILED';

export interface IWebhookEventRecord {
  readonly id: string;
  readonly familyId: string | null;
  readonly provider: PaymentProviderValue;
  readonly providerEventId: string;
  readonly eventType: string;
  readonly eventSubtype: string | null;
  readonly signatureVerified: boolean;
  readonly outcome: WebhookOutcomeValue;
  readonly payloadDigest: string;
  readonly providerSignedAt: Date | null;
  readonly receivedAt: Date;
  readonly processedAt: Date | null;
}

/** `wasCreated === false` means the unique index won. See the file docstring. */
export interface IIdempotentInsert<T> {
  readonly record: T;
  readonly wasCreated: boolean;
}

export interface IPaymentRepository {
  // -- price catalogue (GLOBAL) --
  findCountry(countryCode: string): Promise<ICountryConfig | null>;
  listActiveCountries(): Promise<ICountryConfig[]>;
  findPrice(params: {
    planTier: SubscriptionPlanTier;
    countryCode: string;
    billingPeriod: BillingPeriodValue;
  }): Promise<ISubscriptionPriceRecord | null>;
  findPriceByStoreProductId(storeProductId: string): Promise<ISubscriptionPriceRecord | null>;
  listPricesForCountry(countryCode: string): Promise<ISubscriptionPriceRecord[]>;

  // -- trial (one per family, DB-enforced) --
  findTrial(familyId: string): Promise<ITrialRecord | null>;
  /**
   * `wasCreated === false` means this family has already had its lifetime
   * trial. The rule is the UNIQUE index on `trials.family_id`, not a
   * `SELECT`-then-`INSERT` — that is a race, and it is the race a determined
   * user wins by tapping twice.
   */
  createTrialIfNone(input: {
    familyId: string;
    planTier: SubscriptionPlanTier;
    endsAt: Date;
    source: string;
  }): Promise<IIdempotentInsert<ITrialRecord>>;
  markTrialConverted(familyId: string, at: Date): Promise<void>;

  // -- store account linking (the cross-tenant defence) --
  findFamilyByProviderAccountRef(
    provider: PaymentProviderValue,
    providerAccountRef: string,
  ): Promise<string | null>;
  linkProviderAccount(input: {
    familyId: string;
    provider: PaymentProviderValue;
    providerAccountRef: string;
  }): Promise<IIdempotentInsert<{ familyId: string }>>;

  // -- append-only financial record --
  recordPaymentTransaction(input: {
    familyId: string;
    subscriptionId: string | null;
    provider: PaymentProviderValue;
    providerTransactionId: string;
    providerOriginalTransactionId: string | null;
    productRef: string | null;
    planTier: SubscriptionPlanTier | null;
    billingPeriod: BillingPeriodValue | null;
    countryCode: string | null;
    currency: string;
    grossAmountMinor: number;
    vatAmountMinor: number;
    netAmountMinor: number;
    status: IPaymentTransactionRecord['status'];
    idempotencyKey: string;
    occurredAt: Date;
    verifiedAt: Date | null;
    verifiedPayloadDigest: string | null;
    isSandbox: boolean;
  }): Promise<IIdempotentInsert<IPaymentTransactionRecord>>;

  findPaymentTransaction(
    provider: PaymentProviderValue,
    providerTransactionId: string,
  ): Promise<IPaymentTransactionRecord | null>;

  listPaymentTransactions(familyId: string): Promise<IPaymentTransactionRecord[]>;

  /**
   * The ONLY permitted mutation of a payment transaction, and the database
   * trigger installed by migration 0014 rejects anything else — including a
   * status regression. See that migration's section 7.
   */
  advancePaymentStatus(
    paymentTransactionId: string,
    status: IPaymentTransactionRecord['status'],
    verifiedAt?: Date,
  ): Promise<void>;

  recordRefund(input: {
    familyId: string;
    paymentTransactionId: string;
    provider: PaymentProviderValue;
    providerRefundId: string | null;
    amountMinor: number;
    currency: string;
    reason: string | null;
    status: IRefundRecord['status'];
    idempotencyKey: string;
    occurredAt: Date;
  }): Promise<IIdempotentInsert<IRefundRecord>>;

  listRefunds(familyId: string): Promise<IRefundRecord[]>;

  // -- entitlements --
  /**
   * Idempotent UPSERT on `(family_id, feature_key)`. A redelivered renewal
   * EXTENDS `valid_until`; it never creates a second, contradictory grant.
   */
  grantEntitlement(input: {
    familyId: string;
    featureKey: EntitlementKey;
    planTier: SubscriptionPlanTier;
    source: PaymentProviderValue;
    subscriptionId: string | null;
    validFrom: Date;
    validUntil: Date | null;
  }): Promise<IEntitlementRecord>;

  revokeEntitlements(familyId: string, reason: string, at: Date): Promise<number>;

  listEntitlements(familyId: string): Promise<IEntitlementRecord[]>;

  findEntitlement(familyId: string, featureKey: EntitlementKey): Promise<IEntitlementRecord | null>;

  // -- webhook dedupe --
  /**
   * THE DEDUPE INSERT. `wasCreated === false` means this exact provider event
   * has been seen before and the caller must return 200 WITHOUT re-processing
   * — Q17's «insert first with ON CONFLICT DO NOTHING; a duplicate means 200 OK
   * immediately with no reprocessing».
   */
  recordWebhookEvent(input: {
    provider: PaymentProviderValue;
    providerEventId: string;
    eventType: string;
    eventSubtype: string | null;
    signatureVerified: boolean;
    outcome: WebhookOutcomeValue;
    payloadDigest: string;
    providerSignedAt: Date | null;
    familyId: string | null;
  }): Promise<IIdempotentInsert<IWebhookEventRecord>>;

  finaliseWebhookEvent(
    id: string,
    outcome: WebhookOutcomeValue,
    familyId: string | null,
    failureReason: string | null,
  ): Promise<void>;

  // -- subscription (Phase D columns) --
  findSubscriptionByOriginalTransactionId(
    providerOriginalTransactionId: string,
  ): Promise<{ id: string; familyId: string; lastProviderEventAt: Date | null } | null>;

  /**
   * THE OUT-OF-ORDER GUARD, as a conditional UPDATE.
   *
   * Returns FALSE when `eventAt` is not strictly newer than the stored
   * `last_provider_event_at` — meaning this event is stale and must not be
   * applied. Q17: «ordering is not guaranteed: `subscription.cancelled` may
   * arrive before `subscription.created`. Processing therefore depends on the
   * final state plus the provider's timestamp, not on an assumed sequence; the
   * older event does not overwrite the newer.»
   *
   * The comparison happens INSIDE the UPDATE's WHERE clause, so two concurrent
   * deliveries cannot both pass it.
   */
  applySubscriptionStateIfNewer(input: {
    subscriptionId: string;
    eventAt: Date;
    status: CanonicalSubscriptionStatus;
    currentPeriodStart?: Date | null;
    currentPeriodEnd?: Date | null;
    gracePeriodEndsAt?: Date | null;
    autoRenewing?: boolean;
    canceledAt?: Date | null;
    providerProductId?: string | null;
  }): Promise<boolean>;

  attachProviderLineage(input: {
    subscriptionId: string;
    providerOriginalTransactionId: string;
    providerProductId: string | null;
    countryCode: string | null;
    currencyCode: string | null;
    billingPeriod: BillingPeriodValue | null;
    subscriptionPriceId: string | null;
  }): Promise<void>;
}
