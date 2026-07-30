export type SubscriptionPlanTier = 'FREE' | 'PREMIUM' | 'FAMILY' | 'ENTERPRISE';
export type SubscriptionStatusValue = 'TRIALING' | 'ACTIVE' | 'PAST_DUE' | 'CANCELED' | 'EXPIRED';
export type InvoiceStatusValue = 'DRAFT' | 'OPEN' | 'PAID' | 'VOID' | 'UNCOLLECTIBLE';
export type PaymentProviderValue = 'STRIPE' | 'PAYMOB' | 'FAWRY' | 'MANUAL' | 'APPLE_IAP' | 'GOOGLE_PLAY';

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
