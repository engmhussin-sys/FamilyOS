import { Inject, Injectable, Logger } from '@nestjs/common';

import {
  AI_PROVIDER_PRIMARY,
  AI_PROVIDER_SECONDARY,
  AiChainExhaustedError,
  type IAIProvider,
  type IAIProviderAdapter,
  type IAIProviderRequest,
} from '../domain/ai-provider.port';
import { CircuitBreaker, CircuitBreakerOpenException } from './circuit-breaker';
import { AiBudgetService } from './ai-budget.service';

/** §3.3's table: five failures in a row opens, 120 seconds before a half-open
 * probe. Held one level ABOVE the adapters so an adapter swap does not reset
 * the operational policy. */
const CHAIN_FAILURE_THRESHOLD = 5;
const CHAIN_COOLDOWN_MS = 120_000;

export interface ChainRingState {
  readonly id: string;
  readonly configured: boolean;
  readonly circuitState: string;
}

/**
 * B8 — THE FALLBACK CHAIN. `primary → secondary → deterministic template`.
 *
 * THIS IS THE ONLY CLASS BOUND TO `AI_PROVIDER`. Every existing caller —
 * `AiCoreOrchestratorService`, `RecommendationEngineService`,
 * `AiDiagnosticsService`, `FamilyCommunicationService`,
 * `RewardSuggestionService`, `ReadinessCheckService` — injects the same token
 * it always injected, with the same `complete(request): Promise<string>`
 * signature it always called. NOT ONE LINE of those six services changed to
 * gain multi-provider failover, and that is the whole argument for having had a
 * port in the first place: PA-B-027 was a wiring defect, so it got a wiring fix.
 *
 * THE FOUR GATES, IN ORDER, EACH WITH ITS OWN REASON FOR EXISTING:
 *
 *   0. BUDGET (§9.3). Asked once, before any network call, never per ring —
 *      a family that is over budget is over budget for the whole chain.
 *      Exhausted + caller has a deterministic answer ⇒ return it, degraded,
 *      no error. Exhausted + no deterministic answer ⇒ the chain still runs,
 *      because refusing to answer a parent's question to save $0.001 is not a
 *      trade this product makes; the cap's job is to stop BULK spend, and bulk
 *      spend is exactly the traffic that has a deterministic fallback.
 *
 *   1. CONFIGURED. An unconfigured ring is SKIPPED, not failed. Without this
 *      a single-provider deployment would trip the secondary's breaker on
 *      every request and report a permanent outage of something it never had.
 *
 *   2. BREAKER. Per-ring, keyed by `adapter.id`. An open breaker means the
 *      chain moves to the next ring IMMEDIATELY rather than paying that ring's
 *      timeout first — which is the entire point of a breaker inside a chain,
 *      and the difference between a 200 ms failover and a 20 s one.
 *
 *   3. DETERMINISTIC TEMPLATE. The terminal ring, supplied by the caller as
 *      `request.deterministicFallback`. When present, `complete()` NEVER
 *      throws — degraded mode is a returned string (§9.3). When absent it
 *      throws `AiChainExhaustedError`, which is what `/ai-assistant/ask`
 *      needs: an open-ended parenting question has no template, and answering
 *      it with one would be a worse failure than a 503.
 *
 * WHAT IT DOES NOT DO, DELIBERATELY: it does not retry within a ring. Each
 * adapter already owns its own retry policy (`MAX_RETRIES` in the Anthropic
 * SDK client), and a second retry loop here would multiply, not add — three
 * SDK attempts times three chain attempts is nine 20-second calls behind one
 * parent tapping a button once.
 */
@Injectable()
export class FallbackAiProvider implements IAIProvider {
  private readonly logger = new Logger(FallbackAiProvider.name);
  private readonly chain: readonly IAIProviderAdapter[];
  private readonly breakers = new Map<string, CircuitBreaker>();

  constructor(
    @Inject(AI_PROVIDER_PRIMARY) primary: IAIProviderAdapter,
    @Inject(AI_PROVIDER_SECONDARY) secondary: IAIProviderAdapter,
    private readonly budget: AiBudgetService,
  ) {
    this.chain = Object.freeze([primary, secondary]);
    for (const ring of this.chain) {
      this.breakers.set(ring.id, new CircuitBreaker(CHAIN_FAILURE_THRESHOLD, CHAIN_COOLDOWN_MS));
    }
  }

  async complete(request: IAIProviderRequest): Promise<string> {
    const fallback = request.deterministicFallback;

    if (fallback !== undefined && !(await this.budget.hasBudget())) {
      this.degraded(request, 'BUDGET_EXHAUSTED');
      return fallback;
    }

    const attempted: string[] = [];
    let lastError: unknown = null;

    for (const ring of this.chain) {
      if (!ring.isConfigured()) continue;

      const breaker = this.breakers.get(ring.id);
      // Unreachable — every ring gets a breaker in the constructor. Kept rather
      // than asserted away so a future third ring added without one degrades to
      // "no breaker" instead of throwing on `undefined.execute`.
      if (!breaker) continue;

      attempted.push(ring.id);
      try {
        const answer = await breaker.execute(() => ring.complete(request));
        if (attempted.length > 1) {
          this.logger.warn(
            JSON.stringify({ event: 'ai_provider_failover', servedBy: ring.id, attempted }),
          );
        }
        return answer;
      } catch (err) {
        lastError = err;
        this.logger.warn(
          JSON.stringify({
            event: 'ai_provider_failure',
            provider: ring.id,
            open: err instanceof CircuitBreakerOpenException,
            message: err instanceof Error ? err.message : String(err),
          }),
        );
      }
    }

    if (fallback !== undefined) {
      this.degraded(request, attempted.length === 0 ? 'NO_PROVIDER_CONFIGURED' : 'CHAIN_EXHAUSTED');
      return fallback;
    }

    throw new AiChainExhaustedError(attempted, lastError);
  }

  /** Operational read for `SystemDiagnosticsController` / readiness. Never
   * exposes a key, a model name is enough. */
  getChainState(): ChainRingState[] {
    return this.chain.map((ring) => ({
      id: ring.id,
      configured: ring.isConfigured(),
      circuitState: this.breakers.get(ring.id)?.getState() ?? 'UNKNOWN',
    }));
  }

  private degraded(request: IAIProviderRequest, reason: string): void {
    this.logger.log(
      JSON.stringify({
        event: 'ai_degraded_mode',
        reason,
        sourceFeature: request.sourceFeature ?? 'unattributed',
      }),
    );
  }
}
