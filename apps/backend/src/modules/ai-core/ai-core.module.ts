import { Module } from '@nestjs/common';

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
import { AiCoreController } from './presentation/controllers/ai-core.controller';
import { AiPlatformController } from './presentation/controllers/ai-platform.controller';
import { AnthropicAIProvider } from './infrastructure/anthropic-ai-provider';
import { PrismaAiMemoryRepository } from './infrastructure/prisma-ai-memory.repository';
import { AI_PROVIDER } from './domain/ai-provider.port';
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
  imports: [ChildrenModule, ScreenTimeModule, PairingModule],
  controllers: [AiCoreController, AiPlatformController],
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
    { provide: AI_PROVIDER, useClass: AnthropicAIProvider },
    { provide: AI_MEMORY_REPOSITORY, useClass: PrismaAiMemoryRepository },
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
  ],
})
export class AiCoreModule {}
