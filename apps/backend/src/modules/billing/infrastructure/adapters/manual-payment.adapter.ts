import { Injectable } from '@nestjs/common';

import type {
  IChargeInput,
  IChargeResult,
  IPaymentProviderAdapter,
} from '../../application/ports/payment-provider.port';

/**
 * The only adapter that's genuinely production-usable today, with no
 * external configuration needed — matches Fawry/instapay-style markets
 * where a parent transfers payment manually and an admin (or a support
 * flow, not built here) confirms it. `charge()` always succeeds
 * immediately since there is no external gateway round-trip to fail —
 * "success" here means "this manual charge is now on record," not
 * "money was electronically moved."
 */
@Injectable()
export class ManualPaymentAdapter implements IPaymentProviderAdapter {
  readonly providerName = 'MANUAL' as const;

  async charge(input: IChargeInput): Promise<IChargeResult> {
    return {
      success: true,
      providerChargeId: `manual-${input.subscriptionId}-${Date.now()}`,
      failureReason: null,
    };
  }
}
