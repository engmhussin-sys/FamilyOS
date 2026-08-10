import { Injectable } from '@nestjs/common';

/**
 * AUTHORIZED PARTIAL AI-CORE UNFREEZE (explicit user permission,
 * scoped to AI Cost Tracking only). Pure, deterministic — no AI call,
 * no external dependency.
 *
 * Pricing sourced from Anthropic's own published rates (verified via
 * web search, August 2026 — cite the search, don't invent numbers):
 * claude-sonnet-5 is $2.00/M input, $10.00/M output tokens as an
 * INTRODUCTORY rate through August 31, 2026, after which it becomes
 * $3.00/M input, $15.00/M output. HONEST LIMITATION stated plainly:
 * this file will be WRONG after that date until manually updated —
 * no code here can know the future price change on its own. Flagged
 * with a clear constant and comment specifically so it's easy to
 * find and update, not buried in a calculation.
 */
@Injectable()
export class AiCostCalculator {
  // Prices in MICRO-CENTS per token (1/1,000,000 of a cent) — chosen
  // specifically so calculateCostMicroCents can return a whole
  // integer with full precision, matching AiUsageLog's own
  // estimatedCostMicroCents column. E.g. $2.00/M input tokens =
  // 0.0002 cents/token = 200 micro-cents/token.
  private readonly PRICING_MICRO_CENTS_PER_TOKEN: Record<string, { input: number; output: number }> = {
    // Verified via web search, August 2026. Introductory rate — see
    // this class's own docstring for the expiry date and follow-up
    // needed after it passes.
    'claude-sonnet-5': { input: 200, output: 1000 },
    // Included for completeness (this deployment's own
    // AI_ASSISTANT_MODEL env var could point at either), same source.
    'claude-haiku-4-5-20251001': { input: 100, output: 500 },
    'claude-opus-4-8': { input: 500, output: 2500 },
  };

  /** Falls back to claude-sonnet-5's own rate for any model not in
   * the table above — an honest, stated approximation (never throws,
   * never silently returns 0) rather than blocking usage logging
   * entirely just because a new model name hasn't been priced here
   * yet. */
  calculateCostMicroCents(model: string, inputTokens: number, outputTokens: number): number {
    const pricing = this.PRICING_MICRO_CENTS_PER_TOKEN[model] ?? this.PRICING_MICRO_CENTS_PER_TOKEN['claude-sonnet-5'];
    return Math.round(inputTokens * pricing.input + outputTokens * pricing.output);
  }
}
