import type {
  IPaymentProvider,
  IProviderWebhookEvent,
  IVerifiedPurchase,
  IVerifyPurchaseInput,
  IWebhookRequest,
  IWebhookVerification,
  ProviderCapability,
} from '../../application/ports/payment-provider.port';
import { PaymentProviderNotConfiguredException } from '../../domain/billing.errors';

/**
 * PHASE D — THE `IPaymentProvider` SURFACE FOR THE TWO SPRINT 8 ADAPTERS THAT
 * PHASE D DOES NOT REBUILD.
 *
 * `StripeAdapter` and `ManualPaymentAdapter` predate this phase. Stripe is out
 * of scope (it is the INTERNATIONAL provider; Phase D's markets are Egypt and
 * Saudi Arabia) and Manual is already real and already correct. Neither should
 * be rewritten, and neither should be left unable to satisfy the interface
 * every other provider now implements — that would force a `switch` back into
 * the registry, which is exactly what the interface exists to prevent.
 *
 * This helper gives both of them an HONEST implementation of the three new
 * members. «Honest» means: it refuses, loudly, with a message naming the
 * provider and the reason — never a silent `{verified: true}` and never a
 * fabricated `IVerifiedPurchase`.
 */
export function unsupportedVerify(providerLabel: string): IPaymentProvider['verifyPurchase'] {
  return async (_input: IVerifyPurchaseInput): Promise<IVerifiedPurchase> => {
    throw new PaymentProviderNotConfiguredException(
      `${providerLabel} (server-side purchase verification is not implemented for this provider)`,
    );
  };
}

export function refusingWebhookVerifier(providerLabel: string): IPaymentProvider['verifyWebhookSignature'] {
  return async (_request: IWebhookRequest): Promise<IWebhookVerification> => ({
    verified: false,
    reason: `${providerLabel} has no configured webhook signature scheme in this deployment — the callback is refused, not skipped.`,
  });
}

export function refusingWebhookParser(providerLabel: string): IPaymentProvider['parseWebhook'] {
  return async (_request: IWebhookRequest): Promise<IProviderWebhookEvent> => {
    throw new PaymentProviderNotConfiguredException(`${providerLabel} (webhook parsing is not implemented)`);
  };
}

/** Neither of these two providers advertises any Phase D capability. */
export function noCapabilities(_capability: ProviderCapability): boolean {
  return false;
}
