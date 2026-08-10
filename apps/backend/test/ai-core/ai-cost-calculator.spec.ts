import { AiCostCalculator } from '../../src/modules/ai-core/infrastructure/ai-cost-calculator';

describe('AiCostCalculator (AUTHORIZED PARTIAL AI-CORE UNFREEZE — AI Cost Tracking)', () => {
  let calculator: AiCostCalculator;

  beforeEach(() => {
    calculator = new AiCostCalculator();
  });

  it('calculates the correct cost for claude-sonnet-5 at its real, sourced rate ($2/M input, $10/M output)', () => {
    // 1,000,000 input tokens at $2.00/M = $2.00 = 200 cents = 20,000,000 micro-cents
    const result = calculator.calculateCostMicroCents('claude-sonnet-5', 1_000_000, 0);
    expect(result).toBe(200_000_000);
  });

  it('calculates output tokens at the correct (higher) rate — $10/M vs $2/M input', () => {
    const result = calculator.calculateCostMicroCents('claude-sonnet-5', 0, 1_000_000);
    expect(result).toBe(1_000_000_000); // $10.00
  });

  it('combines input and output correctly for a realistic small call', () => {
    // A typical short exchange: 500 input tokens, 200 output tokens
    const result = calculator.calculateCostMicroCents('claude-sonnet-5', 500, 200);
    // 500 * 200 + 200 * 1000 = 100,000 + 200,000 = 300,000 micro-cents = 0.3 cents
    expect(result).toBe(300_000);
  });

  it('BOUNDARY CASE: zero tokens produces zero cost, never a crash', () => {
    expect(calculator.calculateCostMicroCents('claude-sonnet-5', 0, 0)).toBe(0);
  });

  it('CRITICAL PRECISION CHECK: a real small call never rounds down to a lost/zero cost', () => {
    // A single-token call is the smallest real case — must still
    // register as a non-zero, precise micro-cent value.
    const result = calculator.calculateCostMicroCents('claude-sonnet-5', 1, 1);
    expect(result).toBeGreaterThan(0);
    expect(result).toBe(1200); // 200 + 1000
  });

  it('falls back to claude-sonnet-5 pricing for an unrecognized model — never throws, never silently returns 0', () => {
    const known = calculator.calculateCostMicroCents('claude-sonnet-5', 1000, 500);
    const unknown = calculator.calculateCostMicroCents('some-future-model-not-yet-priced', 1000, 500);
    expect(unknown).toBe(known);
  });

  it('correctly differentiates pricing across all three known models', () => {
    const haiku = calculator.calculateCostMicroCents('claude-haiku-4-5-20251001', 1_000_000, 0);
    const sonnet = calculator.calculateCostMicroCents('claude-sonnet-5', 1_000_000, 0);
    const opus = calculator.calculateCostMicroCents('claude-opus-4-8', 1_000_000, 0);

    expect(haiku).toBeLessThan(sonnet);
    expect(sonnet).toBeLessThan(opus);
    expect(haiku).toBe(100_000_000); // $1.00/M
    expect(opus).toBe(500_000_000); // $5.00/M
  });
});
