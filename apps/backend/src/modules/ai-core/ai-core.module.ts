import { Module } from '@nestjs/common';

import { ChildrenModule } from '../children/children.module';
import { ScreenTimeModule } from '../screen-time/screen-time.module';
import { AiContextManagerService } from './application/services/ai-context-manager.service';
import { AiCoreOrchestratorService } from './application/services/ai-core-orchestrator.service';
import { AnthropicAIProvider } from './infrastructure/anthropic-ai-provider';
import { AI_PROVIDER } from './domain/ai-provider.port';

/**
 * Decision-068's AI Module Boundary. Feature modules (AiAssistantModule
 * today; future Behavioral/Safety/Recommendation engines) import THIS
 * module and depend on AiCoreOrchestratorService — never on
 * AnthropicAIProvider or @anthropic-ai/sdk directly. See
 * docs/architecture/ai-core-engine-boundary.md for the full in/out scope.
 */
@Module({
  imports: [ChildrenModule, ScreenTimeModule],
  providers: [
    AiContextManagerService,
    AiCoreOrchestratorService,
    { provide: AI_PROVIDER, useClass: AnthropicAIProvider },
  ],
  exports: [AiCoreOrchestratorService, AiContextManagerService],
})
export class AiCoreModule {}
