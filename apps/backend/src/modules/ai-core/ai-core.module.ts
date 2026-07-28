import { Module } from '@nestjs/common';

import { ChildrenModule } from '../children/children.module';
import { ScreenTimeModule } from '../screen-time/screen-time.module';
import { PairingModule } from '../pairing/pairing.module';
import { AiContextManagerService } from './application/services/ai-context-manager.service';
import { AiCoreOrchestratorService } from './application/services/ai-core-orchestrator.service';
import { AiDiagnosticsService } from './application/services/ai-diagnostics.service';
import { AiCoreController } from './presentation/controllers/ai-core.controller';
import { AnthropicAIProvider } from './infrastructure/anthropic-ai-provider';
import { AI_PROVIDER } from './domain/ai-provider.port';

/**
 * Decision-068's AI Module Boundary. Feature modules (AiAssistantModule
 * today; future Behavioral/Safety/Recommendation engines) import THIS
 * module and depend on AiCoreOrchestratorService — never on
 * AnthropicAIProvider or @anthropic-ai/sdk directly. See
 * docs/architecture/ai-core-engine-boundary.md for the full in/out scope.
 *
 * Sprint 4 (Track A) addition: imports PairingModule for
 * TRUST_SIGNAL_PROVIDER/RISK_SIGNAL_PROVIDER (AiDiagnosticsService) and
 * PairingOrchestratorService (the ownership check). One-way dependency
 * only — PairingModule does NOT import AiCoreModule or AiAssistantModule
 * anywhere, so this introduces no circular import. AiCoreModule now has
 * its own controller (AiCoreController) for genuinely ai-core-level
 * capabilities, distinct from AiAssistantModule's feature-specific one.
 */
@Module({
  imports: [ChildrenModule, ScreenTimeModule, PairingModule],
  controllers: [AiCoreController],
  providers: [
    AiContextManagerService,
    AiCoreOrchestratorService,
    AiDiagnosticsService,
    { provide: AI_PROVIDER, useClass: AnthropicAIProvider },
  ],
  exports: [AiCoreOrchestratorService, AiContextManagerService, AiDiagnosticsService],
})
export class AiCoreModule {}
