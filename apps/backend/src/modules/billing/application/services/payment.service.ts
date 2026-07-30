import { Inject, Injectable } from '@nestjs/common';

import {
  PAYMENT_PROVIDER_REGISTRY,
  type IChargeResult,
  type IPaymentProviderRegistry,
} from '../ports/payment-provider.port';
import type { PaymentProviderValue } from '../../domain/billing.types';

@Injectable()
export class PaymentService {
  constructor(
    @Inject(PAYMENT_PROVIDER_REGISTRY) private readonly registry: IPaymentProviderRegistry,
  ) {}

  async charge(
    provider: PaymentProviderValue,
    subscriptionId: string,
    amountCents: number,
    currency: string,
  ): Promise<IChargeResult> {
    const adapter = this.registry.getAdapter(provider);
    return adapter.charge({ subscriptionId, amountCents, currency });
  }
}
