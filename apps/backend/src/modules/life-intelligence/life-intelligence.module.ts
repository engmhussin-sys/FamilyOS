import { Module } from '@nestjs/common';

import { ChildrenModule } from '../children/children.module';
import { PairingModule } from '../pairing/pairing.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { AiCoreModule } from '../ai-core/ai-core.module';
import { ConsentCheckModule } from '../consent-check/consent-check.module';
import { BillingModule } from '../billing/billing.module';
import { HabitEngineService } from './application/services/habit-engine.service';
import { LifeTimelineService } from './application/services/life-timeline.service';
import { HealthEngineService } from './application/services/health-engine.service';
import { FaithEngineService } from './application/services/faith-engine.service';
import { LearningEngineService } from './application/services/learning-engine.service';
import { SmartTaskEngineService } from './application/services/smart-task-engine.service';
import { RewardsEngineService } from './application/services/rewards-engine.service';
import { FamilyCommunicationService } from './application/services/family-communication.service';
import { CoachingEngineService } from './application/services/coaching-engine.service';
import { DigitalTwinService } from './application/services/digital-twin.service';
import { FamilyInsightService } from './application/services/family-insight.service';
import { PrismaHabitRepository } from './infrastructure/repositories/prisma-habit.repository';
import { PrismaLifeTimelineRepository } from './infrastructure/repositories/prisma-life-timeline.repository';
import { PrismaHealthRepository } from './infrastructure/repositories/prisma-health.repository';
import { PrismaFaithRepository } from './infrastructure/repositories/prisma-faith.repository';
import { PrismaLearningRepository } from './infrastructure/repositories/prisma-learning.repository';
import { PrismaSmartTaskRepository } from './infrastructure/repositories/prisma-smart-task.repository';
import { PrismaRewardsRepository } from './infrastructure/repositories/prisma-rewards.repository';
import { PrismaCommunicationRepository } from './infrastructure/repositories/prisma-communication.repository';
import { PrismaDigitalTwinRepository } from './infrastructure/repositories/prisma-digital-twin.repository';
import { PrismaDigitalWellbeingRepository } from './infrastructure/repositories/prisma-digital-wellbeing.repository';
import { DigitalWellbeingEngineService } from './application/services/digital-wellbeing-engine.service';
import { SmartNotificationIntegrationService } from './application/services/smart-notification-integration.service';
import { BaselineCalculatorService } from './application/services/baseline-calculator.service';
import { PatternDetectionService } from './application/services/pattern-detection.service';
import { AnomalyDetectionService } from './application/services/anomaly-detection.service';
import { LifeIntelligenceController } from './presentation/controllers/life-intelligence.controller';
import { RewardRulesController } from './presentation/controllers/reward-rules.controller';
import { RewardRuleService } from './application/services/reward-rule.service';
import { LIFE_TIMELINE_WRITER } from './domain/life-timeline.types';
import { REWARD_TRIGGER_WRITER } from './domain/reward-trigger.types';

/**
 * Life Intelligence Platform (Architecture 1.0). A sibling to
 * `ai-core/`, never importing from or modifying it.
 *
 * SPRINT-BY-SPRINT SCOPE:
 * - Sprint 13: Habit Engine, Life Timeline.
 * - Sprint 15: Health Engine, Faith Engine.
 * - Sprint 16: Learning & Education Engine, Smart Tasks Engine.
 * - Sprint 17: Rewards Engine (+ Reward Rules), Family Communication
 *   Engine (+ AI Conversation approval gate).
 * - Sprint 18: Coaching Engine (3 tracks), Family Insight Engine,
 *   Digital Twin (composes Habit/Health/Faith/Learning/Social).
 * - Sprint 23: hardening pass \u2014 2 real IDOR fixes, 6 DTO validation
 *   fixes, 1 performance fix, device-childId verification gap closed,
 *   AppBlockRule feature built (in screen-time module, not here).
 * - Sprint 25: Digital Twin's Safety/Behavior Score gap closed \u2014
 *   reads through Digital Safety's existing exported public methods
 *   (RiskEvaluationService, BehavioralIntelligenceEngineService),
 *   zero modification to ai-core or pairing (Code Freeze respected).
 * - Edge-First Intelligence Architecture: Digital Wellbeing Engine
 *   (11th engine, beyond Architecture 1.0's original 10) \u2014 completes
 *   IAppUsageCollector/AppUsageLog/IBehaviorPatternDetector, all
 *   previously declared-not-implemented across earlier sprints. See
 *   docs/architecture/EDGE_FIRST_INTELLIGENCE_ARCHITECTURE.md.
 *   Digital Twin gained an independent `wellbeing` sub-score
 *   (deliberately excluded from growthScore's own average). Backend
 *   fully verified; Child App (Dart) and native Android (Kotlin)
 *   written but NOT TESTED \u2014 no real device/Flutter environment
 *   available in the sandbox that built this.
 *
 * ALL 10 ARCHITECTURE 1.0 ENGINES HAVE A SERVICE LAYER (PLUS THE 11TH
 * ABOVE), AND DIGITAL TWIN NOW COMPUTES ALL 7 ORIGINAL SUB-SCORES
 * (previously 5 of 7) PLUS THE NEW INDEPENDENT wellbeing SLOT.
 * Remaining work: cross-engine Reward Rule triggering (Habit/Faith/
 * Health don't yet call RewardsEngineService.processTriggerEvent
 * automatically), AI Provider wiring for Family Communication/Smart
 * Tasks/Coaching, and UI for the newer engines. See
 * docs/roadmap/REMAINING_ROADMAP_SPRINTS_24_31.md.
 *
 * STATUS: blocked by the same environment limitation documented in
 * docs/release/SPRINT13_BLOCKED_BY_PRISMA.md \u2014 remains fully
 * registered, unmasked.
 */
@Module({
  imports: [ChildrenModule, PairingModule, NotificationsModule, AiCoreModule, ConsentCheckModule, BillingModule],
  // B4 (PA-B-015): `RewardRulesController` is the controller Phase A found
  // missing. It reuses this module's existing `PrismaRewardsRepository` — the
  // same repository the grant path reads rules through — so there is exactly
  // one owner of the `reward_rules` table.
  controllers: [LifeIntelligenceController, RewardRulesController],
  providers: [
    HabitEngineService,
    LifeTimelineService,
    HealthEngineService,
    FaithEngineService,
    LearningEngineService,
    SmartTaskEngineService,
    RewardsEngineService,
    FamilyCommunicationService,
    CoachingEngineService,
    DigitalTwinService,
    FamilyInsightService,
    DigitalWellbeingEngineService,
    SmartNotificationIntegrationService,
    BaselineCalculatorService,
    PatternDetectionService,
    AnomalyDetectionService,
    PrismaHabitRepository,
    PrismaLifeTimelineRepository,
    PrismaHealthRepository,
    PrismaFaithRepository,
    PrismaLearningRepository,
    PrismaSmartTaskRepository,
    PrismaRewardsRepository,
    RewardRuleService,
    PrismaCommunicationRepository,
    PrismaDigitalTwinRepository,
    PrismaDigitalWellbeingRepository,
    { provide: LIFE_TIMELINE_WRITER, useExisting: LifeTimelineService },
    { provide: REWARD_TRIGGER_WRITER, useExisting: RewardsEngineService },
  ],
  exports: [
    HabitEngineService,
    LifeTimelineService,
    HealthEngineService,
    FaithEngineService,
    LearningEngineService,
    SmartTaskEngineService,
    RewardsEngineService,
    FamilyCommunicationService,
    CoachingEngineService,
    DigitalTwinService,
    FamilyInsightService,
    DigitalWellbeingEngineService,
    SmartNotificationIntegrationService,
    RewardRuleService,
    LIFE_TIMELINE_WRITER,
    REWARD_TRIGGER_WRITER,
  ],
})
export class LifeIntelligenceModule {}
