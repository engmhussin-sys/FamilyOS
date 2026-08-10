import { mapBehavioralTrendToScore, mapRiskToSafetyScore } from '../../src/modules/life-intelligence/application/services/safety-behavior-rules';

describe('mapRiskToSafetyScore (pure)', () => {
  it('inverts risk into safety correctly at the extremes', () => {
    expect(mapRiskToSafetyScore(0)).toBe(100);
    expect(mapRiskToSafetyScore(100)).toBe(0);
  });

  it('inverts correctly at a realistic mid-range value', () => {
    expect(mapRiskToSafetyScore(25)).toBe(75);
    expect(mapRiskToSafetyScore(75)).toBe(25);
  });

  it('clamps to 0-100 even if given an out-of-range input — never crashes or returns a nonsensical score', () => {
    expect(mapRiskToSafetyScore(150)).toBe(0);
    expect(mapRiskToSafetyScore(-10)).toBe(100);
  });
});

describe('mapBehavioralTrendToScore (pure)', () => {
  it('maps every real trend value to the documented score', () => {
    expect(mapBehavioralTrendToScore('IMPROVING')).toBe(90);
    expect(mapBehavioralTrendToScore('STABLE')).toBe(70);
    expect(mapBehavioralTrendToScore('WORSENING')).toBe(30);
  });

  it('returns null (not a guessed number) for INSUFFICIENT_DATA — the exact false-precision this Digital Twin design avoids everywhere else', () => {
    expect(mapBehavioralTrendToScore('INSUFFICIENT_DATA')).toBeNull();
  });

  it('IMPROVING scores strictly higher than STABLE, which scores strictly higher than WORSENING', () => {
    const improving = mapBehavioralTrendToScore('IMPROVING')!;
    const stable = mapBehavioralTrendToScore('STABLE')!;
    const worsening = mapBehavioralTrendToScore('WORSENING')!;
    expect(improving).toBeGreaterThan(stable);
    expect(stable).toBeGreaterThan(worsening);
  });
});
