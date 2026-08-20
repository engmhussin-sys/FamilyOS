import { Global, Module } from '@nestjs/common';

import { NotificationEngineModule } from '../notification-engine/notification-engine.module';
import { BillingNotificationProducer } from './application/services/billing-notification.producer';

/**
 * SPRINT F1 — BILLING'S ONE DOOR TO THE SMART NOTIFICATION ENGINE, IN ITS OWN
 * MODULE, AND THE REASON IS A DEPENDENCY CYCLE THAT IS REAL AND MEASURED.
 *
 * `BillingModule` CANNOT import `NotificationEngineModule`. The graph is:
 *
 *     BillingModule -> NotificationEngineModule -> LifeIntelligenceModule
 *                   -> BillingModule
 *
 * because `LifeIntelligenceModule` imports `BillingModule` for
 * `EntitlementsService` (`family-insight.service.ts:6`) and
 * `NotificationEngineModule` re-exports `LifeIntelligenceModule` (its own
 * header explains why the engine's providers had to move there). Adding the
 * import edge was TRIED before this module was written, and Nest answers:
 *
 *     The module at index [0] of the ChildrenModule "imports" array is
 *     undefined. Potential causes: A circular dependency between modules.
 *     Scope [RootTestModule -> BillingModule -> NotificationEngineModule
 *            -> LifeIntelligenceModule]
 *
 * `forwardRef` is not the answer to that, for the reason
 * `growth-capture.module.ts` already writes down: a `forwardRef` between four
 * modules fails at runtime rather than at compile time, and fails in whichever
 * module happened to load second.
 *
 * SO THE MODULE IS SPLIT ALONG THE LINE THAT ALREADY EXISTED — the same
 * decision, for the same reason, that `GrowthCaptureModule` records for the
 * analytics half that four producers had to depend on:
 *
 *   `BillingModule`               owns the subscription, the providers, the
 *                                 webhook ingestion and the entitlement. It
 *                                 imports nothing new and did not move.
 *   THIS MODULE                   owns the ONE service that turns a billing
 *                                 fact into a `handleEvent` call. It imports
 *                                 the engine and is imported by nothing.
 *
 * WHY `@Global` RATHER THAN AN IMPORT IN `BillingModule`. Because an import in
 * `BillingModule` IS the cycle above. `PaymentWebhookService` needs this
 * producer at the exact moment a card is declined, and `@Global` is how Nest
 * expresses «available to every module without an import edge» — the same
 * mechanism `AuditModule`, `PrismaModule`, `RedisModule` and `TimeModule`
 * already use here for cross-cutting services. NO PROVIDER CYCLE IS CREATED,
 * which is the property that actually matters: the injection chain is
 * `PaymentWebhookService -> BillingNotificationProducer ->
 * SmartNotificationEngineService -> assembler/composer/ledger/pipeline`, and
 * not one of those depends on anything in `BillingModule`.
 *
 * REGISTERED IN `app.module.ts` AFTER `NotificationEngineModule`, next to
 * `BillingModule`, and nothing imports it — if it is ever removed from that
 * list, `PaymentWebhookService` fails to resolve at BOOT rather than going
 * quiet in production, which is the failure mode
 * `notification-producer-chain.guard.spec.ts` exists because of.
 */
@Global()
@Module({
  imports: [NotificationEngineModule],
  providers: [BillingNotificationProducer],
  exports: [BillingNotificationProducer],
})
export class BillingNotificationsModule {}
