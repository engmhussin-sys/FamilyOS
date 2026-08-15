import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { IAIProviderAdapter, IAIProviderRequest } from '../domain/ai-provider.port';
import { AiUsageTrackingService } from './ai-usage-tracking.service';

const DEFAULT_MODEL = 'gpt-4o-mini';
const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const MAX_TOKENS = 1024;
const REQUEST_TIMEOUT_MS = 20_000;

interface OpenAiChatChoice {
  readonly message?: { readonly content?: string | null };
  readonly finish_reason?: string;
}

interface OpenAiChatResponse {
  readonly choices?: readonly OpenAiChatChoice[];
  readonly usage?: {
    readonly prompt_tokens?: number;
    readonly completion_tokens?: number;
  };
}

/**
 * B8 — THE SECONDARY RING (PA-B-027 closed).
 *
 * Phase A found the exact gap this file fills: CONTEXT §2 locks
 * «Anthropic Primary، OpenAI Fallback», and `ai-core.module.ts:52` bound
 * `AI_PROVIDER` to one hardcoded class, so an Anthropic outage took
 * `/ai-assistant/ask` down completely. That was a WIRING defect, and B8 fixes
 * it at the wiring: no business logic anywhere in this repository changed to
 * gain a second provider, because no business logic ever knew there was a first
 * one.
 *
 * IT DELIBERATELY DOES NOT IMPORT AN SDK, AND THAT IS THE POINT.
 * `anthropic-ai-provider.ts` remains the only file in the entire backend that
 * imports a vendor SDK — a property this project has held since Sprint 4 and
 * that the boundary spec asserts. Adding `openai` to `package.json` to reach
 * one HTTP endpoint would have bought a 4 MB dependency, a second supply-chain
 * surface, and a second thing to keep pinned, in exchange for a `fetch` call
 * that is thirty lines long. The OpenAI Chat Completions API is a documented,
 * stable HTTP contract; this class speaks it directly.
 *
 * NOT CONFIGURED IS NOT AN ERROR. Without `OPENAI_API_KEY` this ring reports
 * `isConfigured() === false` and `FallbackAiProvider` skips it — it does not
 * call it, does not fail it, and does not trip its breaker. A deployment that
 * runs single-provider therefore behaves EXACTLY as it did before B8, which is
 * why adding this file changed no existing test.
 */
@Injectable()
export class OpenAiProvider implements IAIProviderAdapter {
  readonly id = 'openai';

  private readonly logger = new Logger(OpenAiProvider.name);
  private readonly apiKey: string | undefined;
  private readonly baseUrl: string;
  private readonly model: string;

  constructor(
    private readonly configService: ConfigService,
    private readonly usageTracking: AiUsageTrackingService,
  ) {
    this.apiKey = this.configService.get<string>('OPENAI_API_KEY');
    this.baseUrl = this.configService.get<string>('OPENAI_BASE_URL') ?? DEFAULT_BASE_URL;
    this.model = this.configService.get<string>('OPENAI_MODEL') ?? DEFAULT_MODEL;
  }

  isConfigured(): boolean {
    return typeof this.apiKey === 'string' && this.apiKey.length > 0;
  }

  async complete({ systemPrompt, userMessage, sourceFeature, timeoutMs }: IAIProviderRequest): Promise<string> {
    if (!this.isConfigured()) {
      throw new Error('OpenAI provider is not configured (OPENAI_API_KEY is unset).');
    }

    // The timeout is enforced HERE rather than trusted to the server: an open
    // socket that never answers is the failure mode a fallback chain exists
    // for, and a chain whose first ring can hang forever is not a chain.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs ?? REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          max_tokens: MAX_TOKENS,
          // The one real shape difference from Anthropic, absorbed here and
          // ONLY here: OpenAI carries the system prompt as an ordinary first
          // message rather than as a separate top-level field.
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userMessage },
          ],
        }),
      });

      if (!response.ok) {
        throw new Error(`OpenAI request failed with HTTP ${response.status}.`);
      }

      const body = (await response.json()) as OpenAiChatResponse;
      const text = body.choices?.[0]?.message?.content;
      if (typeof text !== 'string' || !text.trim()) {
        throw new Error('OpenAI response contained no text content.');
      }

      this.trackCost(body.usage?.prompt_tokens ?? 0, body.usage?.completion_tokens ?? 0, sourceFeature);
      return text;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Read-only, for diagnostics — never exposes the API key. */
  getProviderInfo(): { provider: string; model: string; configured: boolean } {
    return { provider: this.id, model: this.model, configured: this.isConfigured() };
  }

  private trackCost(inputTokens: number, outputTokens: number, sourceFeature?: string): void {
    this.logger.log(
      JSON.stringify({
        event: 'ai_provider_usage',
        provider: this.id,
        model: this.model,
        inputTokens,
        outputTokens,
      }),
    );
    // Same fire-and-forget discipline as the Anthropic adapter: a usage-log
    // write failure must never surface as an AI failure to a user.
    void this.usageTracking.record(this.model, inputTokens, outputTokens, sourceFeature);
  }
}
