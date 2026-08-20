import { Module } from '@nestjs/common';

import { GrowthCaptureModule } from '../analytics/growth-capture.module';
import { ChildrenModule } from '../children/children.module';
import { ScreenTimeModule } from '../screen-time/screen-time.module';
import { PairingModule } from '../pairing/pairing.module';
import { AiContextManagerService } from './application/services/ai-context-manager.service';
import { AiCoreOrchestratorService } from './application/services/ai-core-orchestrator.service';
import { AiDiagnosticsService } from './application/services/ai-diagnostics.service';
import { KnowledgeEngineService } from './application/services/knowledge-engine.service';
import { MemoryEngineService } from './application/services/memory-engine.service';
import { RuleEngineService } from './application/services/rule-engine.service';
import { DecisionEngineService } from './application/services/decision-engine.service';
import { SafetyEngineService } from './application/services/safety-engine.service';
import { RecommendationEngineService } from './application/services/recommendation-engine.service';
import { BehavioralIntelligenceEngineService } from './application/services/behavioral-intelligence-engine.service';
import { AiAlertsController } from './presentation/controllers/ai-alerts.controller';
import { AiCoreController } from './presentation/controllers/ai-core.controller';
import { AiPlatformController } from './presentation/controllers/ai-platform.controller';
import { AnthropicAIProvider } from './infrastructure/anthropic-ai-provider';
import { OpenAiProvider } from './infrastructure/openai-ai-provider';
import { FallbackAiProvider } from './infrastructure/fallback-ai-provider';
import { AiBudgetService } from './infrastructure/ai-budget.service';
import { PrismaCoachSignalRepository } from './infrastructure/prisma-coach-signal.repository';
import { ParentCoachService } from './application/services/parent-coach.service';
import { ChildCoachService } from './application/services/child-coach.service';
import { ChildSafetyFilterService } from './application/services/child-safety-filter.service';
import { DistressEscalationService } from './application/services/distress-escalation.service';
import { ParentCoachController } from './presentation/controllers/parent-coach.controller';
import { ChildCoachController } from './presentation/controllers/child-coach.controller';
import { COACH_SIGNAL_PROVIDER } from './domain/coach.types';
import { AiCostCalculator } from './infrastructure/ai-cost-calculator';
import { AiUsageTrackingService } from './infrastructure/ai-usage-tracking.service';
import { PrismaAiAlertRepository } from './infrastructure/prisma-ai-alert.repository';
import { PrismaAiMemoryRepository } from './infrastructure/prisma-ai-memory.repository';
import { AI_PROVIDER, AI_PROVIDER_PRIMARY, AI_PROVIDER_SECONDARY } from './domain/ai-provider.port';
import { AI_ALERT_REPOSITORY } from './domain/ai-alert.types';
import { AI_MEMORY_REPOSITORY } from './domain/memory.types';

/**
 * Sprint 7: the Internal AI Platform. Every engine
 * (Knowledge/Memory/Rule/Decision/Safety/Recommendation/Behavioral) is
 * registered here. `AI_PROVIDER` remains the ONLY seam to an external
 * LLM (Decision-068, unchanged) \u2014 RecommendationEngineService is the
 * only one of these seven engines that touches it, and only for
 * rephrasing already-decided text (see that service's own docstring).
 * The other six have zero AI_PROVIDER dependency \u2014 removing every
 * external provider leaves Knowledge/Memory/Rule/Decision/Safety/
 * Behavioral fully operational, satisfying "the system must continue
 * operating if every external provider is disconnected" as a structural
 * fact (no code path in those six ever calls AI_PROVIDER), not a promise.
 */
@Module({
  imports: [ChildrenModule, ScreenTimeModule, PairingModule, GrowthCaptureModule],
  controllers: [
    AiCoreController,
    AiPlatformController,
    ParentCoachController,
    ChildCoachController,
    AiAlertsController,
  ],
  providers: [
    AiContextManagerService,
    AiCoreOrchestratorService,
    AiDiagnosticsService,
    KnowledgeEngineService,
    MemoryEngineService,
    RuleEngineService,
    DecisionEngineService,
    SafetyEngineService,
    RecommendationEngineService,
    BehavioralIntelligenceEngineService,
    // B8 — THE FALLBACK CHAIN, WIRED HERE AND NOWHERE ELSE (PA-B-027).
    //
    // Before B8 this was one line: `{ provide: AI_PROVIDER, useClass:
    // AnthropicAIProvider }`. That single binding was the entire defect Phase A
    // found — CONTEXT §2 locks «Anthropic Primary، OpenAI Fallback» and this
    // file hardcoded one vendor, so an Anthropic outage took `/ai-assistant/ask`
    // down completely. The fix is four lines of WIRING. Not one of the six
    // services that inject `AI_PROVIDER` changed, because none of them ever
    // knew which vendor was behind the token — which is what a provider port is
    // FOR, and the return on having built one in Sprint 4.
    { provide: AI_PROVIDER_PRIMARY, useClass: AnthropicAIProvider },
    { provide: AI_PROVIDER_SECONDARY, useClass: OpenAiProvider },
    { provide: AI_PROVIDER, useClass: FallbackAiProvider },
    AnthropicAIProvider,
    OpenAiProvider,
    AiCostCalculator,
    AiUsageTrackingService,
    AiBudgetService,
    { provide: AI_MEMORY_REPOSITORY, useClass: PrismaAiMemoryRepository },
    // THE ONE WRITER OF `ai_alerts`, and the parent's reader. Bound here rather
    // than exported as a class so that `ai-core` keeps its «engines depend on
    // ports» shape: `DistressEscalationService` injects the SYMBOL and has no
    // idea Prisma is behind it.
    { provide: AI_ALERT_REPOSITORY, useClass: PrismaAiAlertRepository },
    // B8 — the coach. READ-ONLY by construction: `PrismaCoachSignalRepository`
    // contains no write operation on any model, and `ai-boundary.spec.ts`
    // enforces that across every file under this module.
    { provide: COACH_SIGNAL_PROVIDER, useClass: PrismaCoachSignalRepository },
    ParentCoachService,
    ChildCoachService,
    ChildSafetyFilterService,
    DistressEscalationService,
  ],
  exports: [
    AiCoreOrchestratorService,
    AiContextManagerService,
    AiDiagnosticsService,
    KnowledgeEngineService,
    MemoryEngineService,
    RuleEngineService,
    DecisionEngineService,
    SafetyEngineService,
    RecommendationEngineService,
    BehavioralIntelligenceEngineService,
    // Sprint 9: ReadinessCheckService needs the raw provider to run its
    // own liveness ping — exported now, wasn't needed by any consumer
    // before this.
    AI_PROVIDER,
    // AUTHORIZED PARTIAL AI-CORE UNFREEZE (AI Cost Tracking): exported
    // so an InternalAdminGuard-protected endpoint can surface real
    // cost data — same protection discipline as
    // GET /analytics/dashboard-metrics.
    AiUsageTrackingService,
    // B8: exported so `SystemDiagnosticsController` can report per-family spend
    // and chain health, and so the parent app can render §12's transparency
    // panel without a second source of truth for the cap.
    AiBudgetService,
    ParentCoachService,
    ChildCoachService,
    ChildSafetyFilterService,
    DistressEscalationService,
  ],
})
export class AiCoreModule {}
