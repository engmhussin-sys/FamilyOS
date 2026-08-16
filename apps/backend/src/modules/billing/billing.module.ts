import { Module } from '@nestjs/common';

import { BillingController } from './presentation/controllers/billing.controller';
import { StripeWebhookController } from './presentation/controllers/stripe-webhook.controller';
import { PaymentWebhookController } from './presentation/controllers/payment-webhook.controller';
import { SubscriptionController } from './presentation/controllers/subscription.controller';
import { StripeWebhookService } from './application/services/stripe-webhook.service';
import { PlanService } from './application/services/plan.service';
import { TrialManager } from './application/services/trial-manager.service';
import { EntitlementsService } from './application/services/entitlements.service';
import { EntitlementService } from './application/services/entitlement.service';
import { PricingService } from './application/services/pricing.service';
import { PaymentVerificationService } from './application/services/payment-verification.service';
import { PaymentWebhookService } from './application/services/payment-webhook.service';
import { InvoiceService } from './application/services/invoice.service';
import { PaymentService } from './application/services/payment.service';
import { SubscriptionService } from './application/services/subscription.service';
import { PrismaBillingRepository } from './infrastructure/prisma-billing.repository';
import { PrismaPaymentRepository } from './infrastructure/prisma-payment.repository';
import { ManualPaymentAdapter } from './infrastructure/adapters/manual-payment.adapter';
import { StripeAdapter } from './infrastructure/adapters/stripe.adapter';
import { PaymobProvider } from './infrastructure/adapters/paymob.provider';
import { FawryProvider } from './infrastructure/adapters/fawry.provider';
import { MoyasarProvider } from './infrastructure/adapters/moyasar.provider';
import { AppleStoreKitProvider } from './infrastructure/adapters/apple-storekit.provider';
import { GooglePlayProvider } from './infrastructure/adapters/google-play.provider';
import { PaymentProviderRegistry } from './infrastructure/adapters/payment-provider.registry';
import { BILLING_REPOSITORY } from './application/ports/billing.repository.port';
import { PAYMENT_REPOSITORY } from './application/ports/payment.repository.port';
import { PAYMENT_PROVIDER_REGISTRY } from './application/ports/payment-provider.port';

/**
 * THE BILLING PLATFORM — Sprint 8, extended by PHASE D.
 *
 * ============================ REUSE, NOT REPLACE ============================
 *
 * There is ONE subscription module in this application and this is it. Phase D
 * added no rival service: `SubscriptionService`, `TrialManager`, `PlanService`,
 * `InvoiceService`, `PaymentService`, `EntitlementsService` and
 * `StripeWebhookService` are the Sprint 8 originals — still registered, still
 * exported, still working, still covered by their original tests. What Phase D
 * ADDED sits beside them (`PricingService`, `EntitlementService`,
 * `PaymentVerificationService`, `PaymentWebhookService`); what it REBUILT is
 * the provider layer, which A1-Backend-Audit §22 explicitly classified as
 * REBUILD rather than EXTEND because the old port's entire contract was a
 * single `charge(subscriptionId, amountCents, currency)`.
 *
 * ======================= THE ARCHITECTURAL INVARIANT =======================
 *
 * Business logic imports `PAYMENT_PROVIDER_REGISTRY` and never a concrete
 * adapter. Seven adapters are registered below; not one of them is injected
 * into a service. `test/billing/provider-neutrality.spec.ts` reads the source
 * of the application layer and fails on a provider literal, so this stays true
 * after everyone who wrote it has moved on.
 *
 * ========================= TWO ENTITLEMENT SERVICES =========================
 *
 * `EntitlementsService` (PLURAL, Sprint 8) computes access live from
 * `subscription.status` + `PlanDefinition.features`.
 * `EntitlementService` (SINGULAR, Phase D) reads the materialised
 * `entitlements` table and falls back to that same computation for families
 * that predate Phase D. Both are exported during the transition; new code
 * calls the singular one. Stated here rather than left for a reader to
 * discover, because two similarly-named services is precisely the thing that
 * quietly becomes two sources of truth.
 */
@Module({
  controllers: [BillingController, StripeWebhookController, PaymentWebhookController, SubscriptionController],
  providers: [
    // -- Sprint 8, unchanged --
    PlanService,
    TrialManager,
    EntitlementsService,
    InvoiceService,
    PaymentService,
    SubscriptionService,
    StripeWebhookService,
    // -- Phase D --
    PricingService,
    EntitlementService,
    PaymentVerificationService,
    PaymentWebhookService,
    // -- provider adapters: seven, behind one interface --
    ManualPaymentAdapter,
    StripeAdapter,
    PaymobProvider,
    FawryProvider,
    MoyasarProvider,
    AppleStoreKitProvider,
    GooglePlayProvider,
    PaymentProviderRegistry,
    { provide: BILLING_REPOSITORY, useClass: PrismaBillingRepository },
    { provide: PAYMENT_REPOSITORY, useClass: PrismaPaymentRepository },
    { provide: PAYMENT_PROVIDER_REGISTRY, useClass: PaymentProviderRegistry },
  ],
  exports: [
    EntitlementsService,
    EntitlementService,
    PricingService,
    SubscriptionService,
    PlanService,
    TrialManager,
    BILLING_REPOSITORY,
    PAYMENT_REPOSITORY,
  ],
})
export class BillingModule {}
