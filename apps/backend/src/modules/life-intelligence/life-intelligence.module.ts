import { Module } from '@nestjs/common';

import { ChildrenModule } from '../children/children.module';
import { PairingModule } from '../pairing/pairing.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { AiCoreModule } from '../ai-core/ai-core.module';
import { ConsentCheckModule } from '../consent-check/consent-check.module';
import { BillingModule } from '../billing/billing.module';
import { GrowthCaptureModule } from '../analytics/growth-capture.module';
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
import { QuietHoursReleaseService } from './application/services/quiet-hours-release.service';
// SPRINT F1 — the producer `GOAL_STALLED_PARENT` never had. Registered HERE,
// beside the two other producers that call `handleEvent` (`RewardsEngineService`,
// `DigitalWellbeingEngineService`), rather than in the scheduler: the scheduler
// owns WHEN a sweep runs, this module owns WHAT the sweep asks and says.
import { StalledGoalService } from './application/services/stalled-goal.service';
// SPRINT F1 — the producer the five CHILD copy keys never had
// (`HYDRATION_REMINDER`, `STUDY_REMINDER`, `EXERCISE_ENCOURAGEMENT`,
// `GOAL_DEADLINE_NEAR`, `STREAK_AT_RISK`). Registered beside `StalledGoalService`
// for the same reason: this module owns WHAT a sweep asks and says.
import { ChildSignalService } from './application/services/child-signal.service';
import { SmartNotificationIntegrationService } from './application/services/smart-notification-integration.service';
import { BaselineCalculatorService } from './application/services/baseline-calculator.service';
import { PatternDetectionService } from './application/services/pattern-detection.service';
import { AnomalyDetectionService } from './application/services/anomaly-detection.service';
import { LifeIntelligenceController } from './presentation/controllers/life-intelligence.controller';
import { RewardRulesController } from './presentation/controllers/reward-rules.controller';
import { RewardRuleService } from './application/services/reward-rule.service';
import { LIFE_TIMELINE_WRITER } from './domain/life-timeline.types';
import { REWARD_TRIGGER_WRITER } from './domain/reward-trigger.types';
// PHASE F (`F6-003`) — the decision layer's providers are REGISTERED here. The
// files stay in `notification-engine/`; only the DI registration moved, and the
// block comment on `@Module` below argues why.
import { NOTIFICATION_DECISION_PROVIDER } from '../notifications/application/ports/notification-decision.provider';
import { RuleBasedNotificationDecisionProvider } from '../notifications/application/providers/rule-based-notification-decision.provider';
import { NotificationContextAssembler } from '../notification-engine/application/services/notification-context.assembler';
import { NotificationComposerService } from '../notification-engine/application/services/notification-composer.service';
import { SmartNotificationEngineService } from '../notification-engine/application/services/smart-notification-engine.service';

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
 *
 * ---------------------------------------------------------------------------
 * PHASE F (`F6-003`, closing `PF-E-001`) \u2014 WHY THE DECISION LAYER IS REGISTERED
 * IN THIS MODULE.
 *
 * `NotificationEngineModule` was created in F6-002 with a one-way dependency:
 * `notification-engine -> life-intelligence -> notifications`. That direction is
 * correct and is preserved. What F6-002 did not have to solve, because it wired
 * no producer, is that TWO OF THE PRODUCERS LIVE IN THIS MODULE \u2014
 * `RewardsEngineService` (badge, level-up, and the direct `/self/*` grant path)
 * and `DigitalWellbeingEngineService` (five critical event types). Injecting
 * `SmartNotificationEngineService` into them from `notification-engine` would
 * make the graph `life-intelligence -> notification-engine ->
 * life-intelligence`, and the only cure for that is `forwardRef`, which is how a
 * module boundary stops meaning anything.
 *
 * So the four providers are registered HERE instead, and nothing else changes:
 * the FILES stay in `notification-engine/`, `NotificationEngineModule` keeps its
 * two controllers and re-exports the engine, and every existing importer
 * resolves the same singleton. The engine's own dependencies were already
 * satisfiable from this injector \u2014 `NotificationsModule` (the tables and the
 * ledger) and `AiCoreModule` (the two safety filters and `AI_PROVIDER`) are
 * imported above and were before this phase.
 *
 * WHY NOT A GLOBAL MODULE, and why not a port + token. Both work and both hide
 * the fact being stated: the decision layer sits BETWEEN the domain engines and
 * the delivery pipeline, and both of those are in this module. A token would
 * have let the graph stay decorative while the real coupling went underground.
 * `NOTIFICATION_DECISION_PROVIDER` \u2014 the seam that actually matters \u2014 is
 * untouched and still swappable with one `overrideProvider` line
 * (`notification-provider-swap.e2e.spec.ts` proves it against this registration
 * exactly as it did against the old one).
 * ---------------------------------------------------------------------------
 */
@Module({
  imports: [ChildrenModule, PairingModule, NotificationsModule, AiCoreModule, ConsentCheckModule, BillingModule, GrowthCaptureModule],
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
    QuietHoursReleaseService,
    StalledGoalService,
    ChildSignalService,
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
    // PHASE F (`F6-003`) — the decision layer. Four providers, zero new files.
    NotificationContextAssembler,
    NotificationComposerService,
    SmartNotificationEngineService,
    // THE SEAM, unchanged from F6-002: one binding, one deterministic
    // implementation. CONTEXT §3 principle 2 — the AI advises, it does not
    // decide whether to notify.
    { provide: NOTIFICATION_DECISION_PROVIDER, useClass: RuleBasedNotificationDecisionProvider },
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
    QuietHoursReleaseService,
    // SPRINT F1 — exported so `SchedulerModule`'s rollover job reaches THIS
    // instance rather than constructing a second producer with its own engine.
    StalledGoalService,
    // SPRINT F1 — exported for the same reason `StalledGoalService` is: a future
    // family-local scheduled sweep must reach THIS instance rather than
    // constructing a second producer with its own engine.
    ChildSignalService,
    RewardRuleService,
    LIFE_TIMELINE_WRITER,
    REWARD_TRIGGER_WRITER,
    // PHASE F (`F6-003`) — exported so `EventsModule`'s consumers and
    // `NotificationEngineModule`'s controllers reach the SAME instance, not a
    // second one with its own view of the ledger.
    SmartNotificationEngineService,
    NOTIFICATION_DECISION_PROVIDER,
  ],
})
export class LifeIntelligenceModule {}
