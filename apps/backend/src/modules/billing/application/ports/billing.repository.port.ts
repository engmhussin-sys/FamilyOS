import type {
  IInvoiceRecord,
  InvoiceStatusValue,
  IPlanDefinition,
  ISubscriptionRecord,
  PaymentProviderValue,
  SubscriptionPlanTier,
  SubscriptionStatusValue,
} from '../../domain/billing.types';

export const BILLING_REPOSITORY = Symbol('BILLING_REPOSITORY');

export interface ICreateSubscriptionInput {
  familyId: string;
  planTier: SubscriptionPlanTier;
  provider: PaymentProviderValue;
  status: SubscriptionStatusValue;
  trialEndsAt?: Date;
}

export interface IBillingRepository {
  findAllActivePlans(): Promise<IPlanDefinition[]>;
  findPlanByTier(tier: SubscriptionPlanTier): Promise<IPlanDefinition | null>;

  findSubscriptionByFamily(familyId: string): Promise<ISubscriptionRecord | null>;
  /** CLOSES A REAL GAP (previously NOT VERIFIED in the master audit,
   * confirmed as genuinely missing: zero payment webhook architecture
   * existed at all). Needed to map an incoming provider webhook event
   * back to our own subscription record. */
  findSubscriptionByProviderSubscriptionId(providerSubscriptionId: string): Promise<ISubscriptionRecord | null>;
  createSubscription(input: ICreateSubscriptionInput): Promise<ISubscriptionRecord>;
  updateSubscriptionStatus(
    subscriptionId: string,
    status: SubscriptionStatusValue,
    extra?: { canceledAt?: Date; currentPeriodStart?: Date; currentPeriodEnd?: Date; trialEndsAt?: Date },
  ): Promise<void>;

  createInvoice(input: {
    subscriptionId: string;
    amountCents: number;
    currency: string;
    status: InvoiceStatusValue;
    providerInvoiceId?: string;
  }): Promise<IInvoiceRecord>;
  markInvoicePaid(invoiceId: string, paidAt: Date): Promise<void>;
  listInvoicesForSubscription(subscriptionId: string): Promise<IInvoiceRecord[]>;

  /** CLOSES A REAL GAP (previously explicitly flagged: "DISCOUNT
   * codes are not yet supported"). */
  setPendingDiscount(subscriptionId: string, discountPercent: number): Promise<void>;
  clearPendingDiscount(subscriptionId: string): Promise<void>;
}
