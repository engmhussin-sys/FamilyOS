import { Injectable } from '@nestjs/common';

import type {
  IPaymentProviderAdapter,
  IPaymentProviderRegistry,
} from '../../application/ports/payment-provider.port';
import type { PaymentProviderValue } from '../../domain/billing.types';
import { ManualPaymentAdapter } from './manual-payment.adapter';
import { StripeAdapter } from './stripe.adapter';
import { PaymobAdapter } from './paymob.adapter';
import { FawryAdapter } from './fawry.adapter';
import { AppleIAPAdapter } from './apple-iap.adapter';
import { GooglePlayBillingAdapter } from './google-play-billing.adapter';

@Injectable()
export class PaymentProviderRegistry implements IPaymentProviderRegistry {
  private readonly adapters: Record<PaymentProviderValue, IPaymentProviderAdapter>;

  constructor(
    manualAdapter: ManualPaymentAdapter,
    stripeAdapter: StripeAdapter,
    paymobAdapter: PaymobAdapter,
    fawryAdapter: FawryAdapter,
    appleIapAdapter: AppleIAPAdapter,
    googlePlayAdapter: GooglePlayBillingAdapter,
  ) {
    this.adapters = {
      MANUAL: manualAdapter,
      STRIPE: stripeAdapter,
      PAYMOB: paymobAdapter,
      FAWRY: fawryAdapter,
      APPLE_IAP: appleIapAdapter,
      GOOGLE_PLAY: googlePlayAdapter,
    };
  }

  getAdapter(provider: PaymentProviderValue): IPaymentProviderAdapter {
    return this.adapters[provider];
  }
}
