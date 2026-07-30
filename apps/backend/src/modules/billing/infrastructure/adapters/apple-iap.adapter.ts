import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type {
  IChargeInput,
  IChargeResult,
  IPaymentProviderAdapter,
} from '../../application/ports/payment-provider.port';
import { PaymentProviderNotConfiguredException } from '../../domain/billing.errors';

/**
 * Real interface implementation, honest about needing an App Store
 * Connect shared secret + server-to-server notification setup \u2014 same
 * posture as StripeAdapter. Structurally different from Stripe/Paymob/
 * Fawry: Apple IAP purchases are always INITIATED client-side (the iOS
 * app calls StoreKit directly, this backend never "charges" a card) \u2014
 * `charge()` here means "verify a receipt this backend was handed by
 * the client and record it," not "initiate a payment." That distinction
 * is already correctly modeled by this method staying a no-op stub
 * rather than pretending to move money the same way the other adapters do.
 */
@Injectable()
export class AppleIAPAdapter implements IPaymentProviderAdapter {
  readonly providerName = 'APPLE_IAP' as const;

  constructor(private readonly configService: ConfigService) {}

  async charge(_input: IChargeInput): Promise<IChargeResult> {
    const sharedSecret = this.configService.get<string>('APPLE_IAP_SHARED_SECRET');
    if (!sharedSecret) {
      throw new PaymentProviderNotConfiguredException('Apple In-App Purchase');
    }
    // Real integration point, pending APPLE_IAP_SHARED_SECRET + an iOS
    // Child/Parent app that actually exists to call StoreKit from \u2014 not
    // built speculatively ahead of that app.
    throw new PaymentProviderNotConfiguredException('Apple In-App Purchase');
  }
}
