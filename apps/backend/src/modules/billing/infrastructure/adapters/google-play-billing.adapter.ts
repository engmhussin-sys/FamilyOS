import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type {
  IChargeInput,
  IChargeResult,
  IPaymentProviderAdapter,
} from '../../application/ports/payment-provider.port';
import { PaymentProviderNotConfiguredException } from '../../domain/billing.errors';

/** Same posture as AppleIAPAdapter \u2014 Google Play Billing purchases are
 * also client-initiated; this backend's role is verifying a purchase
 * token via the Google Play Developer API, not initiating a charge. */
@Injectable()
export class GooglePlayBillingAdapter implements IPaymentProviderAdapter {
  readonly providerName = 'GOOGLE_PLAY' as const;

  constructor(private readonly configService: ConfigService) {}

  async charge(_input: IChargeInput): Promise<IChargeResult> {
    const serviceAccountKey = this.configService.get<string>('GOOGLE_PLAY_SERVICE_ACCOUNT_KEY');
    if (!serviceAccountKey) {
      throw new PaymentProviderNotConfiguredException('Google Play Billing');
    }
    throw new PaymentProviderNotConfiguredException('Google Play Billing');
  }
}
