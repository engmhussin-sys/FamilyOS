/** PHASE D: `BASIC` added — CONTEXT.md §6 names four consumer tiers. */
export type SubscriptionPlanTier = 'FREE' | 'BASIC' | 'PREMIUM' | 'FAMILY' | 'ENTERPRISE';
/**
 * The PERSISTED spelling — what the `SubscriptionStatus` PostgreSQL enum
 * holds. PHASE D added PENDING / GRACE_PERIOD / REFUNDED and deliberately did
 * NOT rename TRIALING or CANCELED; the brief's `TRIAL` / `CANCELLED`
 * vocabulary lives in `subscription-status.ts`, which owns the one
 * bidirectional mapping. This alias is kept identical to
 * `PersistedSubscriptionStatus` so every Sprint 8 caller still compiles.
 */
export type SubscriptionStatusValue =
  | 'TRIALING'
  | 'ACTIVE'
  | 'PAST_DUE'
  | 'CANCELED'
  | 'EXPIRED'
  | 'PENDING'
  | 'GRACE_PERIOD'
  | 'REFUNDED';
export type InvoiceStatusValue = 'DRAFT' | 'OPEN' | 'PAID' | 'VOID' | 'UNCOLLECTIBLE';
/** PHASE D: `MOYASAR` added — the Saudi card/mada gateway slot (Q16). */
export type PaymentProviderValue =
  | 'STRIPE'
  | 'PAYMOB'
  | 'FAWRY'
  | 'MANUAL'
  | 'APPLE_IAP'
  | 'GOOGLE_PLAY'
  | 'MOYASAR';

export interface IPlanDefinition {
  id: string;
  tier: SubscriptionPlanTier;
  name: string;
  priceCents: number;
  currency: string;
  billingIntervalMonths: number;
  features: string[];
  isActive: boolean;
}

export interface ISubscriptionRecord {
  id: string;
  familyId: string;
  planTier: SubscriptionPlanTier;
  status: SubscriptionStatusValue;
  provider: PaymentProviderValue;
  providerSubscriptionId: string | null;
  trialEndsAt: Date | null;
  currentPeriodStart: Date | null;
  currentPeriodEnd: Date | null;
  canceledAt: Date | null;
  /** CLOSES A REAL GAP (previously explicitly flagged: "DISCOUNT
   * codes are not yet supported"). See Subscription's own schema
   * docstring for the exact, deliberately narrow semantic. */
  pendingDiscountPercent: number | null;
}

export interface IInvoiceRecord {
  id: string;
  subscriptionId: string;
  amountCents: number;
  currency: string;
  status: InvoiceStatusValue;
  providerInvoiceId: string | null;
  issuedAt: Date;
  paidAt: Date | null;
}

/** Sprint 8's set of gate-able capabilities. Deliberately a plain string
 * union, not derived from PlanDefinition.features at compile time — the
 * DB-stored feature lists are data; this is the fixed vocabulary code
 * is allowed to check against, so a typo in a DB row's features array
 * fails safe (unrecognized key = not entitled) rather than silently
 * granting access to a misspelled feature name. */
export type EntitlementKey =
  | 'ai_diagnostics'
  | 'family_insights'
  | 'multiple_children'
  | 'unlimited_devices_per_child'
  | 'behavioral_trend_analysis'
  | 'priority_support';
