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

@Injectable()
export class PaymentProviderRegistry implements IPaymentProviderRegistry {
  private readonly adapters: Record<PaymentProviderValue, IPaymentProviderAdapter>;

  constructor(
    manualAdapter: ManualPaymentAdapter,
    stripeAdapter: StripeAdapter,
    paymobAdapter: PaymobAdapter,
    fawryAdapter: FawryAdapter,
  ) {
    this.adapters = {
      MANUAL: manualAdapter,
      STRIPE: stripeAdapter,
      PAYMOB: paymobAdapter,
      FAWRY: fawryAdapter,
    };
  }

  getAdapter(provider: PaymentProviderValue): IPaymentProviderAdapter {
    return this.adapters[provider];
  }
}
