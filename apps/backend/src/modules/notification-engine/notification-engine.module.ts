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
 */

import { Module } from '@nestjs/common';

import { AiCoreModule } from '../ai-core/ai-core.module';
import { LifeIntelligenceModule } from '../life-intelligence/life-intelligence.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { NOTIFICATION_DECISION_PROVIDER } from '../notifications/application/ports/notification-decision.provider';
import { RuleBasedNotificationDecisionProvider } from '../notifications/application/providers/rule-based-notification-decision.provider';
import { NotificationComposerService } from './application/services/notification-composer.service';
import { NotificationContextAssembler } from './application/services/notification-context.assembler';
import { SmartNotificationEngineService } from './application/services/smart-notification-engine.service';
import { NotificationAnalyticsController } from './presentation/controllers/notification-analytics.controller';
import { NotificationPolicyController } from './presentation/controllers/notification-policy.controller';

@Module({
  imports: [NotificationsModule, LifeIntelligenceModule, AiCoreModule],
  controllers: [NotificationAnalyticsController, NotificationPolicyController],
  providers: [
    NotificationContextAssembler,
    NotificationComposerService,
    SmartNotificationEngineService,
    // THE SEAM. One binding, one implementation, and the implementation is
    // deterministic — CONTEXT §3 principle 2: the AI advises, it does not
    // decide whether to notify.
    { provide: NOTIFICATION_DECISION_PROVIDER, useClass: RuleBasedNotificationDecisionProvider },
  ],
  exports: [SmartNotificationEngineService, NOTIFICATION_DECISION_PROVIDER],
})
export class NotificationEngineModule {}
