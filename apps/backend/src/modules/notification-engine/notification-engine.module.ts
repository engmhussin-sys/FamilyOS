/**
 * PHASE F (`F6-002`) — THE DECISION LAYER'S MODULE, AND WHY IT IS ITS OWN.
 *
 * It could have gone in `NotificationsModule`, and it must not: that module owns
 * the notification TABLES and is imported by `LifeIntelligenceModule`, which
 * owns `SmartNotificationIntegrationService` — the pipeline this layer calls.
 * Putting the layer in `NotificationsModule` would make the graph
 * `notifications -> life-intelligence -> notifications`, and the only cure for
 * that is `forwardRef`, which is how a module boundary stops meaning anything.
 *
 * So the direction is one-way and it reads correctly: this module DEPENDS ON the
 * pipeline and on the tables, and nothing depends on it except the producers
 * that want a decision made. `LifeIntelligenceModule` is unchanged.
 *
 * WHAT IT PROVIDES, and the shape of the seam:
 *
 *   `NOTIFICATION_DECISION_PROVIDER` -> `RuleBasedNotificationDecisionProvider`
 *
 * ONE LINE. That is the entire cost of replacing the deterministic engine with
 * an `AiNotificationDecisionProvider`, and
 * `test/notifications/notification-provider-swap.e2e.spec.ts` proves it by
 * overriding this exact token and asserting the rest of the pipeline behaves
 * identically. A seam that requires touching a second file is not a seam.
 *
 * ---------------------------------------------------------------------------
 * PHASE F (`F6-003`, closing `PF-E-001`) — WHERE THE PROVIDERS ACTUALLY LIVE
 * NOW, AND WHY THE PARAGRAPH ABOVE IS STILL TRUE.
 *
 * F6-002 shipped this module with no producer wired to it, and the question of
 * WHO CALLS THE ENGINE was therefore never asked of the module graph. It has an
 * answer this phase had to find: two of the six producers —
 * `RewardsEngineService` and `DigitalWellbeingEngineService` — are inside
 * `LifeIntelligenceModule`, the module this one imports. Injecting the engine
 * into them from here would close the loop `life-intelligence ->
 * notification-engine -> life-intelligence`, and `forwardRef` is not an answer,
 * it is a way of not having one.
 *
 * So the four provider REGISTRATIONS moved into `LifeIntelligenceModule` (which
 * already imported everything they need) and this module now IMPORTS and
 * RE-EXPORTS them. Nothing else changed: the source files are still here, the
 * two controllers are still here, every existing importer of this module gets
 * the same `SmartNotificationEngineService` singleton it got before, and the
 * `NOTIFICATION_DECISION_PROVIDER` seam is one binding in one file exactly as
 * it was — `notification-provider-swap.e2e.spec.ts` overrides the same token
 * and is unmodified by this phase.
 * ---------------------------------------------------------------------------
 */

import { Module } from '@nestjs/common';

import { AiCoreModule } from '../ai-core/ai-core.module';
import { LifeIntelligenceModule } from '../life-intelligence/life-intelligence.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { NotificationAnalyticsController } from './presentation/controllers/notification-analytics.controller';
import { NotificationPolicyController } from './presentation/controllers/notification-policy.controller';

@Module({
  imports: [NotificationsModule, LifeIntelligenceModule, AiCoreModule],
  controllers: [NotificationAnalyticsController, NotificationPolicyController],
  providers: [],
  // RE-EXPORTED AS A MODULE, not re-provided. A second `providers` entry would
  // build a SECOND engine with its own composer and its own assembler, and the
  // two would write to the same ledger while disagreeing about nothing visible
  // — the worst kind of duplicate, because it works. Nest re-exports a
  // provider only by re-exporting the module that owns it, so that is what
  // this line does, and `LifeIntelligenceModule`'s export list is the contract.
  exports: [LifeIntelligenceModule],
})
export class NotificationEngineModule {}
