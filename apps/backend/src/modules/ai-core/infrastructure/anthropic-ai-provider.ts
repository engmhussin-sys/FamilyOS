import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Anthropic from '@anthropic-ai/sdk';

import type { IAIProvider, IAIProviderRequest } from '../domain/ai-provider.port';

const DEFAULT_MODEL = 'claude-sonnet-5';
const MAX_TOKENS = 1024;
const REQUEST_TIMEOUT_MS = 20_000;

/**
 * The ONLY file in the entire backend that imports @anthropic-ai/sdk —
 * moved unchanged (renamed) from the old ai-assistant module's
 * AnthropicLlmClient, now implementing the shared IAIProvider port
 * instead of the feature-specific ILlmClient it used to. Every future
 * engine (Behavioral, Safety, Recommendation) built on
 * AiCoreOrchestratorService reuses THIS adapter — swapping providers
 * means writing one new class here, not touching any feature module.
 */
@Injectable()
export class AnthropicAIProvider implements IAIProvider {
  private readonly logger = new Logger(AnthropicAIProvider.name);
  private readonly client: Anthropic;
  private readonly model: string;

  constructor(private readonly configService: ConfigService) {
    const apiKey = this.configService.get<string>('ANTHROPIC_API_KEY');
    if (!apiKey) {
      this.logger.warn(
        'ANTHROPIC_API_KEY is not set — AI features will fail on first use. ' +
          'See apps/backend/.env.example.',
      );
    }
    this.client = new Anthropic({ apiKey, timeout: REQUEST_TIMEOUT_MS });
    this.model = this.configService.get<string>('AI_ASSISTANT_MODEL') ?? DEFAULT_MODEL;
  }

  async complete({ systemPrompt, userMessage }: IAIProviderRequest): Promise<string> {
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: MAX_TOKENS,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }],
    });

    const textBlock = response.content.find(
      (block): block is Anthropic.TextBlock => block.type === 'text',
    );

    if (!textBlock) {
      throw new Error('Anthropic response contained no text block.');
    }

    return textBlock.text;
  }
}
