import type { PaymentProviderValue } from '../../domain/billing.types';

export const PAYMENT_PROVIDER_REGISTRY = Symbol('PAYMENT_PROVIDER_REGISTRY');

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

/**
 * The ONE seam every payment provider crosses. Business logic
 * (SubscriptionService, InvoiceService, EntitlementsService) NEVER
 * imports a concrete adapter — only this interface, resolved through
 * `IPaymentProviderRegistry` by the `PaymentProvider` enum value stored
 * on the subscription. This is the literal mechanism behind "only the
 * provider configuration should remain unresolved": swapping Stripe for
 * Paymob means registering a different adapter under the same enum key,
 * touching zero business-logic files.
 */
export interface IPaymentProviderAdapter {
  readonly providerName: PaymentProviderValue;
  charge(input: IChargeInput): Promise<IChargeResult>;
}

/** Resolves the configured adapter for a given provider enum value.
 * Deliberately a registry, not a single injected adapter — a
 * subscription's `provider` field is data (can differ per family), not
 * a single global choice baked into DI at startup. */
export interface IPaymentProviderRegistry {
  getAdapter(provider: PaymentProviderValue): IPaymentProviderAdapter;
}
