import { ServiceUnavailableException } from '@nestjs/common';

/** Thrown by any provider adapter whose real API credentials/config
 * haven't been supplied yet (Stripe/Paymob/Fawry today). Deliberately a
 * distinct, clearly-named exception \u2014 a caller (or a future admin
 * dashboard) can catch this specifically to show "this payment method
 * isn't set up yet," rather than a generic failure. */
export class PaymentProviderNotConfiguredException extends ServiceUnavailableException {
  constructor(providerName: string) {
    super(
      `The ${providerName} payment provider is not configured. Set its API credentials via environment variables before selecting it.`,
    );
  }
}
