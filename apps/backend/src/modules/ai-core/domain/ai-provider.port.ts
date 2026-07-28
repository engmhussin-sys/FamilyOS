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
}

export interface IAIProvider {
  /** Returns the model's plain-text reply, or throws on any failure. */
  complete(request: IAIProviderRequest): Promise<string>;
}
