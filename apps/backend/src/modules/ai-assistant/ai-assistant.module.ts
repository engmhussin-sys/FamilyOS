import { Module } from '@nestjs/common';

import { AiCoreModule } from '../ai-core/ai-core.module';
import { AiAssistantController } from './presentation/controllers/ai-assistant.controller';
import { AiAssistantService } from './application/services/ai-assistant.service';

/**
 * Per Decision-068: imports AiCoreModule instead of ChildrenModule/
 * ScreenTimeModule directly, and no longer wires an LLM_CLIENT provider
 * itself — that binding lives entirely in AiCoreModule now. This module
 * is left with exactly one responsibility: the HTTP surface
 * (POST /ai-assistant/ask) for one specific AI capability.
 */
@Module({
  imports: [AiCoreModule],
  controllers: [AiAssistantController],
  providers: [AiAssistantService],
})
export class AiAssistantModule {}
