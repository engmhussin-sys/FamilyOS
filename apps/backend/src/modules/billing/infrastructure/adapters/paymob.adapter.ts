import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type {
  IChargeInput,
  IChargeResult,
  IPaymentProviderAdapter,
} from '../../application/ports/payment-provider.port';
import { PaymentProviderNotConfiguredException } from '../../domain/billing.errors';

/** Same posture as StripeAdapter \u2014 see that class's docstring. */
@Injectable()
export class PaymobAdapter implements IPaymentProviderAdapter {
  readonly providerName = 'PAYMOB' as const;

  constructor(private readonly configService: ConfigService) {}

  async charge(_input: IChargeInput): Promise<IChargeResult> {
    const apiKey = this.configService.get<string>('PAYMOB_API_KEY');
    if (!apiKey) {
      throw new PaymentProviderNotConfiguredException('Paymob');
    }
    throw new PaymentProviderNotConfiguredException('Paymob');
  }
}
