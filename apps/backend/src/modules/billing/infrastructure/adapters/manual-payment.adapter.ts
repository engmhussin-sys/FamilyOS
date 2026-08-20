import { Injectable } from '@nestjs/common';

import type {
  IChargeInput,
  IChargeResult,
  IPaymentProvider,
  IPaymentProviderAdapter,
  ProviderKind,
} from '../../application/ports/payment-provider.port';
import {
  noCapabilities,
  refusingWebhookParser,
  refusingWebhookVerifier,
  unsupportedVerify,
} from './legacy-provider.mixin';

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
export class ManualPaymentAdapter implements IPaymentProvider, IPaymentProviderAdapter {
  readonly providerName = 'MANUAL' as const;
  /**
   * PHASE D. Kept exactly as it was — A1-Backend-Audit named this «the only
   * genuinely production-usable adapter today» and it still is. There is no
   * external system to verify against and no signature to check, so the three
   * Phase D members refuse honestly. A manual grant reaches the entitlement
   * layer through `EntitlementService.grantManual()`, which records
   * `source = MANUAL` and an operator id, not through a fake verification.
   */
  readonly kind: ProviderKind = 'MANUAL';

  /** No external configuration exists to be missing. */
  isConfigured(): boolean {
    return true;
  }

  readonly supports = noCapabilities;
  readonly verifyPurchase = unsupportedVerify('Manual payment');
  readonly verifyWebhookSignature = refusingWebhookVerifier('Manual payment');
  readonly parseWebhook = refusingWebhookParser('Manual payment');

  async charge(input: IChargeInput): Promise<IChargeResult> {
    return {
      success: true,
      providerChargeId: `manual-${input.subscriptionId}-${Date.now()}`,
      failureReason: null,
    };
  }
}
