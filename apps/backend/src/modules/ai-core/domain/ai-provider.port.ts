/**
 * Decision-068's Provider abstraction. Every AI feature (today: the
 * Parenting Assistant; future: Behavioral/Safety/Recommendation engines
 * per that decision's layer diagram) reaches an LLM ONLY through this
 * port — never by importing a provider SDK directly. This is what makes
 * "External AI providers are adapters only" an enforced fact, not a
 * guideline: there is exactly one seam, and swapping Claude for another
 * provider (or a future local/edge model, Decision-068's "Own Models"
 * path) means writing one new adapter, not touching every feature.
 */
export const AI_PROVIDER = Symbol('AI_PROVIDER');

export interface IAIProviderRequest {
  systemPrompt: string;
  userMessage: string;
  /** AUTHORIZED PARTIAL AI-CORE UNFREEZE (AI Cost Tracking): optional,
   * honest-absence-by-default — which calling feature is making this
   * request (e.g. "ai-assistant"). Existing callers that don't pass
   * this continue to work unchanged; the usage log simply records no
   * attribution for them, never a guessed one. */
  sourceFeature?: string;
  /**
   * B8 — THE TERMINAL RING OF THE FALLBACK CHAIN, SUPPLIED BY THE CALLER.
   *
   * §3.3's chain is primary → secondary → deterministic template. The first two
   * rings live in `FallbackAiProvider`; the third one cannot, because a generic
   * provider has no idea what this particular caller's deterministic answer is.
   * Every real caller in this codebase ALREADY has one — `recommendation-engine`
   * has `RECOMMENDATION_COPY`, `reward-suggestion` has its Arabic rationale,
   * `parent-coach` has the rule engine's own sentence — and each of them
   * currently reimplements "on error, keep my text" in its own try/catch.
   *
   * Passing that text here moves the decision into one place and makes degraded
   * mode a RETURNED VALUE instead of an exception the caller must remember to
   * swallow (§9.3: «Degraded mode ≠ فشل»).
   *
   * WHEN IT IS ABSENT, NOTHING CHANGES. `complete()` still throws once every
   * provider has failed — which is what `/ai-assistant/ask` needs, because a
   * free-form parenting question has no deterministic answer and answering it
   * with a template would be worse than a 503.
   */
  deterministicFallback?: string;
  /**
   * Per-call ceiling, overriding the provider default. §3.3's own table gives
   * interactive use cases 12s and batch ones 25–60s; before B8 every call in
   * this codebase used one 20s constant regardless of whether a parent was
   * waiting on it.
   */
  timeoutMs?: number;
}

export interface IAIProvider {
  /** Returns the model's plain-text reply, or throws on any failure. */
  complete(request: IAIProviderRequest): Promise<string>;
}

/**
 * B8 — what a single RING of the chain is, as opposed to the chain itself.
 *
 * `AI_PROVIDER` stays the ONE seam every feature injects; nothing outside this
 * module's own wiring ever sees an `IAIProviderAdapter`. The distinction exists
 * so `FallbackAiProvider` can hold a typed list of rings and ask each one its
 * `id` (for metrics and circuit-breaker keys) and its `isConfigured()` (for
 * skipping), without any feature gaining the ability to reach past the chain
 * and address one vendor directly — which is the failure mode a "provider
 * abstraction" usually dies of.
 */
export interface IAIProviderAdapter extends IAIProvider {
  /** 'anthropic' | 'openai' — stable, used in logs and metrics. */
  readonly id: string;
  /** False when this deployment holds no credentials for it. A ring that is not
   * configured is SKIPPED, not failed: skipping must not trip its breaker, and
   * an unconfigured secondary must not read as an outage on a dashboard. */
  isConfigured(): boolean;
}

/** Ring tokens. Multi-provider wiring needs names for the individual adapters;
 * these are them, and they are injected in exactly one place
 * (`ai-core.module.ts`). */
export const AI_PROVIDER_PRIMARY = Symbol('AI_PROVIDER_PRIMARY');
export const AI_PROVIDER_SECONDARY = Symbol('AI_PROVIDER_SECONDARY');

/** Raised by `FallbackAiProvider` when every configured ring failed AND the
 * caller supplied no `deterministicFallback`. Distinct from a raw provider
 * error so a caller can tell "the chain is exhausted" from "this one SDK
 * threw". */
export class AiChainExhaustedError extends Error {
  constructor(
    readonly attempted: readonly string[],
    readonly lastError: unknown,
  ) {
    super(
      `Every AI provider in the chain failed (tried: ${attempted.join(' → ') || 'none configured'}). ` +
        'No deterministicFallback was supplied by the caller.',
    );
    this.name = 'AiChainExhaustedError';
  }
}
