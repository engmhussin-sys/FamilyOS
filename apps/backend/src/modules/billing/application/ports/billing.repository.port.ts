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
  createSubscription(input: ICreateSubscriptionInput): Promise<ISubscriptionRecord>;
  updateSubscriptionStatus(
    subscriptionId: string,
    status: SubscriptionStatusValue,
    extra?: { canceledAt?: Date; currentPeriodStart?: Date; currentPeriodEnd?: Date },
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
}
