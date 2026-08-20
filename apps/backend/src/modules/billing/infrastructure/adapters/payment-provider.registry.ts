import { Injectable, NotFoundException } from '@nestjs/common';

import type {
  IPaymentProvider,
  IPaymentProviderRegistry,
} from '../../application/ports/payment-provider.port';
import type { PaymentProviderValue } from '../../domain/billing.types';
import { ManualPaymentAdapter } from './manual-payment.adapter';
import { StripeAdapter } from './stripe.adapter';
import { PaymobProvider } from './paymob.provider';
import { FawryProvider } from './fawry.provider';
import { MoyasarProvider } from './moyasar.provider';
import { AppleStoreKitProvider } from './apple-storekit.provider';
import { GooglePlayProvider } from './google-play.provider';

/**
 * PHASE D — SEVEN PROVIDERS, ONE INTERFACE, ZERO `switch` IN BUSINESS LOGIC.
 *
 * A1-Backend-Audit singled out the Sprint 8 design of this class as something
 * done right: «the registry resolves the adapter from a DATA FIELD, not from
 * DI». That is kept verbatim, because it is what lets an Egyptian family on
 * Paymob and a Saudi family on Moyasar coexist inside one deployment — the
 * provider is a column on `subscriptions`, not a global startup choice.
 *
 * What changed is the VALUE TYPE. Every entry now satisfies the full
 * `IPaymentProvider` — verification, webhook signature, webhook parsing,
 * capability reporting — so a caller asks a provider WHAT IT CAN DO instead of
 * asking WHICH provider it is. There is no `if (provider === 'APPLE_IAP')`
 * anywhere in `SubscriptionService`, `EntitlementService` or
 * `PaymentVerificationService`, and `test/billing/provider-neutrality.spec.ts`
 * asserts that by reading the source of those files.
 *
 * The record is exhaustive over `PaymentProviderValue` BY TYPE: adding an
 * eighth value to the enum without registering an adapter is a compile error,
 * not a runtime `undefined` discovered by a customer mid-purchase.
 */
@Injectable()
export class PaymentProviderRegistry implements IPaymentProviderRegistry {
  private readonly adapters: Record<PaymentProviderValue, IPaymentProvider>;

  constructor(
    manualAdapter: ManualPaymentAdapter,
    stripeAdapter: StripeAdapter,
    paymobProvider: PaymobProvider,
    fawryProvider: FawryProvider,
    moyasarProvider: MoyasarProvider,
    appleProvider: AppleStoreKitProvider,
    googlePlayProvider: GooglePlayProvider,
  ) {
    this.adapters = {
      MANUAL: manualAdapter,
      STRIPE: stripeAdapter,
      PAYMOB: paymobProvider,
      FAWRY: fawryProvider,
      MOYASAR: moyasarProvider,
      APPLE_IAP: appleProvider,
      GOOGLE_PLAY: googlePlayProvider,
    };
  }

  getAdapter(provider: PaymentProviderValue): IPaymentProvider {
    const adapter = this.adapters[provider];
    if (!adapter) {
      // PHASE D: previously this returned `undefined` and the caller
      // dereferenced it, producing a TypeError deep inside a payment path. A
      // named exception is not merely nicer — it is the difference between a
      // diagnosable misconfiguration and a 500 during a purchase.
      throw new NotFoundException(`No payment provider adapter is registered for "${provider}".`);
    }
    return adapter;
  }

  all(): readonly IPaymentProvider[] {
    return Object.values(this.adapters);
  }
}
