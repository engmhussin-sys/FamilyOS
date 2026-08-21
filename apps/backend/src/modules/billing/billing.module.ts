import { Module, forwardRef } from '@nestjs/common';

import { GrowthCaptureModule } from '../analytics/growth-capture.module';

import { BillingController } from './presentation/controllers/billing.controller';
import { StripeWebhookController } from './presentation/controllers/stripe-webhook.controller';
import { PaymentWebhookController } from './presentation/controllers/payment-webhook.controller';
import { SubscriptionController } from './presentation/controllers/subscription.controller';
import { BillingOperationsController } from './presentation/controllers/billing-operations.controller';
import { OperatorGrantService } from './application/services/operator-grant.service';
import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
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
 * ================= ONE ENTITLEMENT SERVICE (SPRINT F1, P0) =================
 *
 * This comment used to say there were TWO, and that «new code calls the
 * singular one» — which is a warning, not a constraint, and the warning was
 * correct: they disagreed. `EntitlementsService` said `{TRIALING, ACTIVE}` and
 * `EntitlementService` said `{TRIALING, ACTIVE, GRACE_PERIOD}` while reading the
 * `entitlements` table, so a paying household in its 7-day grace window was
 * refused on four surfaces and a REFUNDED household kept them.
 *
 * `EntitlementService` (SINGULAR) is now the only implementation of
 * `hasFeature` in `src/`: it reads the materialised `entitlements` table, and
 * falls back — for families that predate Phase D and for every family that
 * subscribed through `SubscriptionService`, which writes no entitlement row —
 * to a computation whose status set is `ENTITLEMENT_STATUS_LEDGER` in
 * `domain/subscription-status.ts`, stated once, per status, with reasons.
 *
 * `EntitlementsService` (PLURAL) is a zero-logic delegate to it, kept only as
 * the DI token four modules already inject. Both are still exported for that
 * reason; only one of them decides anything, and
 * `test/authz/entitlement-single-authority.guard.spec.ts` fails the build if a
 * second implementation reappears anywhere under `src/`.
 */
@Module({
  // PHASE D (GROWTH). The CAPTURE half only, which imports nothing — the five
  // commercial growth events are emitted from the paths that already own the
  // fact, and revenue is still summed from `payment_transactions` and never
  // from an analytics event.
  // AuditModule for AuditService, AuthModule for USER_REPOSITORY — both for
  // ONE consumer: `OperatorGrantService`, which resolves a household from the
  // parent's email using the SAME lookup login performs, and writes the audit
  // row that makes a comped plan answerable months later.
  //
  // `forwardRef` ON AuthModule IS LOAD-BEARING, and it was put here by a
  // failing test: the module graph already contains
  // Auth -> Children -> Billing (Children asks Billing whether a family may
  // add a second child), so importing AuthModule directly closed the cycle and
  // Nest resolved it to `undefined` — "The module at index [2] of the
  // BillingModule imports array is undefined". The alternative was to
  // reimplement `findPrimaryFamilyMembership` here, which would have given an
  // operator grant its own idea of which household an email belongs to. One
  // lookup, resolved late.
  imports: [GrowthCaptureModule, AuditModule, forwardRef(() => AuthModule)],
  controllers: [
    BillingController,
    StripeWebhookController,
    PaymentWebhookController,
    SubscriptionController,
    BillingOperationsController,
  ],
  providers: [
    // The operator comp surface. Delete this line, its controller, its service
    // and its DTOs to remove the feature entirely — nothing else depends on it.
    OperatorGrantService,
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
