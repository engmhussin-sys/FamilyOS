import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Anthropic from '@anthropic-ai/sdk';

import type { ILlmClient, ILlmCompletionParams } from '../application/ports/llm-client.port';

const DEFAULT_MODEL = 'claude-sonnet-5';
const MAX_TOKENS = 1024;
const REQUEST_TIMEOUT_MS = 20_000;

@Injectable()
export class AnthropicLlmClient implements ILlmClient {
  private readonly logger = new Logger(AnthropicLlmClient.name);
  private readonly client: Anthropic;
  private readonly model: string;

  constructor(private readonly configService: ConfigService) {
    const apiKey = this.configService.get<string>('ANTHROPIC_API_KEY');
    if (!apiKey) {
      this.logger.warn(
        'ANTHROPIC_API_KEY is not set — the AI Parenting Assistant will fail on first use. ' +
          'See apps/backend/.env.example.',
      );
    }
    this.client = new Anthropic({ apiKey, timeout: REQUEST_TIMEOUT_MS });
    this.model = this.configService.get<string>('AI_ASSISTANT_MODEL') ?? DEFAULT_MODEL;
  }

  async complete({ systemPrompt, userMessage }: ILlmCompletionParams): Promise<string> {
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: MAX_TOKENS,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }],
    });

    // Validate the shape before trusting it downstream, per this project's
    // AI-engineering standard: don't assume the response always has the
    // expected block type.
    const textBlock = response.content.find(
      (block): block is Anthropic.TextBlock => block.type === 'text',
    );

    if (!textBlock) {
      throw new Error('Anthropic response contained no text block.');
    }

    return textBlock.text;
  }
}
