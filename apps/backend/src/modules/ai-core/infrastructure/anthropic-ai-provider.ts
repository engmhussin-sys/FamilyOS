import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Anthropic from '@anthropic-ai/sdk';

import type { IAIProvider, IAIProviderRequest } from '../domain/ai-provider.port';
import { CircuitBreaker } from './circuit-breaker';
import { AiUsageTrackingService } from './ai-usage-tracking.service';

const DEFAULT_MODEL = 'claude-sonnet-5';
const MAX_TOKENS = 1024;
const REQUEST_TIMEOUT_MS = 20_000;
const MAX_RETRIES = 2; // explicit, matching the SDK's own default \u2014 named here so it's a reviewable decision, not an implicit library default
const CIRCUIT_BREAKER_FAILURE_THRESHOLD = 5;
const CIRCUIT_BREAKER_COOLDOWN_MS = 30_000;

/**
 * Sprint 9's "AI Production Validation" applied directly to this file —
 * no new provider, the existing one hardened:
 *   - Timeout: already had one (REQUEST_TIMEOUT_MS); now paired with an
 *     explicit MAX_RETRIES so the SDK's retry behavior is a reviewable
 *     constant, not an implicit default.
 *   - Circuit Breaker: wraps every `complete()` call — after 5
 *     consecutive failures, further calls fail immediately for 30s
 *     instead of each queueing its own 20s timeout against a provider
 *     that's already known to be down.
 *   - Cost Tracking: real per-call `usage.input_tokens`/`output_tokens`
 *     is logged (structured log line, unchanged) AND now ALSO written
 *     to real queryable storage (AiUsageTrackingService/AiUsageLog) —
 *     the exact follow-up this docstring itself used to flag as
 *     missing ("a real follow-up if per-family AI cost attribution is
 *     ever needed"). AUTHORIZED PARTIAL AI-CORE UNFREEZE: this and
 *     the two new files it depends on (ai-cost-calculator.ts,
 *     ai-usage-tracking.service.ts) are the ONLY changes made under
 *     this explicit, scoped exception to the standing Architecture
 *     Freeze — granted specifically for AI Cost Tracking, nothing
 *     else. Zero change to any AI decision-making logic (Rule/
 *     Decision/Safety/Behavioral/Recommendation engines untouched).
 *   - Prompt/Model Version Tracking: `getProviderInfo()` exposes a
 *     fixed, reviewable record of what model this deployment targets
 *     — for `SystemDiagnosticsController` to surface later if needed.
 *     Full prompt-version history (not just current model name)
 *     remains a real, separate, unbuilt gap — out of this specific
 *     unfreeze's scope.
 *
 * Still the ONLY file in the entire backend that imports
 * @anthropic-ai/sdk — unchanged from Sprint 4's original design.
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

  constructor(
    private readonly configService: ConfigService,
    private readonly usageTracking: AiUsageTrackingService,
  ) {
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

  async complete({ systemPrompt, userMessage, sourceFeature }: IAIProviderRequest): Promise<string> {
    return this.circuitBreaker.execute(async () => {
      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: MAX_TOKENS,
        system: systemPrompt,
        messages: [{ role: 'user', content: userMessage }],
      });

      this.trackCost(response.usage, sourceFeature);

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

  private trackCost(usage: { input_tokens: number; output_tokens: number }, sourceFeature?: string): void {
    // Structured log line — UNCHANGED, still real-time-aggregable by
    // any log processor exactly as before.
    this.logger.log(
      JSON.stringify({
        event: 'ai_provider_usage',
        model: this.model,
        inputTokens: usage.input_tokens,
        outputTokens: usage.output_tokens,
      }),
    );

    // AUTHORIZED PARTIAL AI-CORE UNFREEZE (AI Cost Tracking) — ALSO
    // written to real, queryable storage now. Fire-and-forget from
    // this call site's perspective: the AI response is already on
    // its way back to the caller by the time this resolves/rejects,
    // and AiUsageTrackingService.record() itself catches any storage
    // failure internally (see its own docstring) — a DB hiccup here
    // must never surface as an AI-feature failure to the end user.
    void this.usageTracking.record(this.model, usage.input_tokens, usage.output_tokens, sourceFeature);
  }
}
