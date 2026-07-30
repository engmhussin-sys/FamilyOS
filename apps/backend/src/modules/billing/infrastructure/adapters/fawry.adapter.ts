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
export class FawryAdapter implements IPaymentProviderAdapter {
  readonly providerName = 'FAWRY' as const;

  constructor(private readonly configService: ConfigService) {}

  async charge(_input: IChargeInput): Promise<IChargeResult> {
    const apiKey = this.configService.get<string>('FAWRY_API_KEY');
    if (!apiKey) {
      throw new PaymentProviderNotConfiguredException('Fawry');
    }
    throw new PaymentProviderNotConfiguredException('Fawry');
  }
}
