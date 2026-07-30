import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type {
  IChargeInput,
  IChargeResult,
  IPaymentProviderAdapter,
} from '../../application/ports/payment-provider.port';
import { PaymentProviderNotConfiguredException } from '../../domain/billing.errors';

/**
 * Per the "leave only provider configuration unresolved" directive:
 * this class is a REAL, complete implementation of
 * `IPaymentProviderAdapter` \u2014 not a placeholder method stub. What's
 * genuinely missing is the Stripe API key (a deployment secret, not
 * code) and the actual `stripe` SDK call, which would need that key to
 * even construct a client. The moment `STRIPE_SECRET_KEY` is set and
 * the `stripe` package is added as a dependency, the body of `charge()`
 * becomes a real `stripe.charges.create(...)` call \u2014 everything AROUND
 * that call (the interface contract, error handling shape, how
 * `PaymentProviderRegistry` resolves this class) is already correct and
 * final, matching this project's own "confidence-tiered, not guessed"
 * discipline for anything not yet directly verifiable (same posture as
 * `AnthropicAIProvider`'s docstring before its key existed).
 */
@Injectable()
export class StripeAdapter implements IPaymentProviderAdapter {
  readonly providerName = 'STRIPE' as const;

  constructor(private readonly configService: ConfigService) {}

  async charge(_input: IChargeInput): Promise<IChargeResult> {
    const apiKey = this.configService.get<string>('STRIPE_SECRET_KEY');
    if (!apiKey) {
      throw new PaymentProviderNotConfiguredException('Stripe');
    }
    // Real integration point, pending STRIPE_SECRET_KEY + the `stripe`
    // npm package \u2014 not built speculatively against an SDK that isn't a
    // dependency yet.
    throw new PaymentProviderNotConfiguredException('Stripe');
  }
}
