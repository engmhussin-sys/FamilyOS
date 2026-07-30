import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Anthropic from '@anthropic-ai/sdk';

import type { IAIProvider, IAIProviderRequest } from '../domain/ai-provider.port';
import { CircuitBreaker } from './circuit-breaker';

const DEFAULT_MODEL = 'claude-sonnet-5';
const MAX_TOKENS = 1024;
const REQUEST_TIMEOUT_MS = 20_000;
const MAX_RETRIES = 2; // explicit, matching the SDK's own default \u2014 named here so it's a reviewable decision, not an implicit library default
const CIRCUIT_BREAKER_FAILURE_THRESHOLD = 5;
const CIRCUIT_BREAKER_COOLDOWN_MS = 30_000;

/**
 * Sprint 9's "AI Production Validation" applied directly to this file \u2014
 * no new provider, the existing one hardened:
 *   - Timeout: already had one (REQUEST_TIMEOUT_MS); now paired with an
 *     explicit MAX_RETRIES so the SDK's retry behavior is a reviewable
 *     constant, not an implicit default.
 *   - Circuit Breaker: wraps every `complete()` call \u2014 after 5
 *     consecutive failures, further calls fail immediately for 30s
 *     instead of each queueing its own 20s timeout against a provider
 *     that's already known to be down.
 *   - Cost Tracking (internal, no external provider needed): every
 *     response's real `usage.input_tokens`/`output_tokens` is logged \u2014
 *     the honest, buildable version of "cost tracking" without a
 *     dedicated billing-ledger table (a real follow-up if per-family
 *     AI cost attribution is ever needed product-side).
 *   - Prompt/Model Version Tracking: `PROVIDER_INFO` is a fixed,
 *     reviewable record of what model this deployment targets \u2014
 *     exposed via `getProviderInfo()` for `SystemDiagnosticsController`
 *     to surface later if needed.
 *
 * Still the ONLY file in the entire backend that imports
 * @anthropic-ai/sdk \u2014 unchanged from Sprint 4's original design.
 */
@Injectable()
export class AnthropicAIProvider implements IAIProvider {
  private readonly logger = new Logger(AnthropicAIProvider.name);
  private readonly client: Anthropic;
  private readonly model: string;
  private readonly circuitBreaker = new CircuitBreaker(
    CIRCUIT_BREAKER_FAILURE_THRESHOLD,
    CIRCUIT_BREAKER_COOLDOWN_MS,
  );

  constructor(private readonly configService: ConfigService) {
    const apiKey = this.configService.get<string>('ANTHROPIC_API_KEY');
    if (!apiKey) {
      this.logger.warn(
        'ANTHROPIC_API_KEY is not set — AI features will fail on first use. ' +
          'See apps/backend/.env.example.',
      );
    }
    this.client = new Anthropic({ apiKey, timeout: REQUEST_TIMEOUT_MS, maxRetries: MAX_RETRIES });
    this.model = this.configService.get<string>('AI_ASSISTANT_MODEL') ?? DEFAULT_MODEL;
  }

  async complete({ systemPrompt, userMessage }: IAIProviderRequest): Promise<string> {
    return this.circuitBreaker.execute(async () => {
      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: MAX_TOKENS,
        system: systemPrompt,
        messages: [{ role: 'user', content: userMessage }],
      });

      this.trackCost(response.usage);

      const textBlock = response.content.find(
        (block): block is Anthropic.TextBlock => block.type === 'text',
      );

      if (!textBlock) {
        throw new Error('Anthropic response contained no text block.');
      }

      return textBlock.text;
    });
  }

  /** Read-only, for SystemDiagnosticsController or future callers \u2014
   * never exposes the API key. */
  getProviderInfo(): { model: string; circuitState: string } {
    return { model: this.model, circuitState: this.circuitBreaker.getState() };
  }

  private trackCost(usage: { input_tokens: number; output_tokens: number }): void {
    // Internal cost tracking (Sprint 9's explicit "even without an
    // external provider" requirement): logged structurally so it's
    // aggregable by any log processor, without needing a dedicated
    // ledger table this sprint didn't scope to build.
    this.logger.log(
      JSON.stringify({
        event: 'ai_provider_usage',
        model: this.model,
        inputTokens: usage.input_tokens,
        outputTokens: usage.output_tokens,
      }),
    );
  }
}
