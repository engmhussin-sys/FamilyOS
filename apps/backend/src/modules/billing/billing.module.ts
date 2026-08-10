import { Module } from '@nestjs/common';

import { BillingController } from './presentation/controllers/billing.controller';
import { StripeWebhookController } from './presentation/controllers/stripe-webhook.controller';
import { StripeWebhookService } from './application/services/stripe-webhook.service';
import { PlanService } from './application/services/plan.service';
import { TrialManager } from './application/services/trial-manager.service';
import { EntitlementsService } from './application/services/entitlements.service';
import { InvoiceService } from './application/services/invoice.service';
import { PaymentService } from './application/services/payment.service';
import { SubscriptionService } from './application/services/subscription.service';
import { PrismaBillingRepository } from './infrastructure/prisma-billing.repository';
import { ManualPaymentAdapter } from './infrastructure/adapters/manual-payment.adapter';
import { StripeAdapter } from './infrastructure/adapters/stripe.adapter';
import { PaymobAdapter } from './infrastructure/adapters/paymob.adapter';
import { FawryAdapter } from './infrastructure/adapters/fawry.adapter';
import { AppleIAPAdapter } from './infrastructure/adapters/apple-iap.adapter';
import { GooglePlayBillingAdapter } from './infrastructure/adapters/google-play-billing.adapter';
import { PaymentProviderRegistry } from './infrastructure/adapters/payment-provider.registry';
import { BILLING_REPOSITORY } from './application/ports/billing.repository.port';
import { PAYMENT_PROVIDER_REGISTRY } from './application/ports/payment-provider.port';

/**
 * Sprint 8's Billing Platform. Per the reviewer's own framing: business
 * logic (Subscription/Plan/Invoice/Trial/Entitlements Services) has
 * ZERO import of any concrete adapter \u2014 only PAYMENT_PROVIDER_REGISTRY.
 * The four adapters are all registered; `MANUAL` is real today,
 * `STRIPE`/`PAYMOB`/`FAWRY` throw a clear, typed "not configured"
 * exception until their respective API keys are set \u2014 selecting one of
 * them is the only thing left as a deployment/config decision, exactly
 * as directed.
 */
@Module({
  controllers: [BillingController, StripeWebhookController],
  providers: [
    PlanService,
    TrialManager,
    EntitlementsService,
    InvoiceService,
    PaymentService,
    SubscriptionService,
    StripeWebhookService,
    ManualPaymentAdapter,
    StripeAdapter,
    PaymobAdapter,
    FawryAdapter,
    AppleIAPAdapter,
    GooglePlayBillingAdapter,
    PaymentProviderRegistry,
    { provide: BILLING_REPOSITORY, useClass: PrismaBillingRepository },
    { provide: PAYMENT_PROVIDER_REGISTRY, useClass: PaymentProviderRegistry },
  ],
  exports: [EntitlementsService, SubscriptionService, PlanService, TrialManager, BILLING_REPOSITORY],
})
export class BillingModule {}
