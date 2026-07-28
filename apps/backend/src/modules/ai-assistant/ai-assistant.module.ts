import { Module } from '@nestjs/common';

import { ChildrenModule } from '../children/children.module';
import { ScreenTimeModule } from '../screen-time/screen-time.module';
import { AiAssistantController } from './presentation/controllers/ai-assistant.controller';
import { AiAssistantService } from './application/services/ai-assistant.service';
import { AnthropicLlmClient } from './infrastructure/anthropic-llm.client';
import { LLM_CLIENT } from './application/ports/llm-client.port';

@Module({
  imports: [ChildrenModule, ScreenTimeModule],
  controllers: [AiAssistantController],
  providers: [
    AiAssistantService,
    { provide: LLM_CLIENT, useClass: AnthropicLlmClient },
  ],
})
export class AiAssistantModule {}
