import { generateChildCoachRecommendations, generateFamilyCoachRecommendations, generateParentCoachRecommendations } from '../../src/modules/life-intelligence/application/services/coaching-rules';
import { computeGrowthScore } from '../../src/modules/life-intelligence/application/services/digital-twin-rules';
import { ICoachingSignals } from '../../src/modules/life-intelligence/domain/coaching.types';

describe('Coaching rules (pure)', () => {
  const baseSignals: ICoachingSignals = {
    childId: 'c1',
    habitCompletionRate: 0.5,
    healthScore: 70,
    faithCompletionRate: 0.6,
    missedHabitsCount: 0,
    // Sprint 16.1 Phase 6 — new required fields, neutral defaults so
    // existing tests below (which override specific fields via
    // spread) keep testing exactly what they tested before.
    educationSessionCount: 1,
    educationStreakDays: 0,
    hydrationAchievedToday: false,
    activityAchievedToday: false,
  };

  it('Parent Coach fires only when a real threshold is crossed, and cites it in reasoningPath', () => {
    const recs = generateParentCoachRecommendations({ ...baseSignals, missedHabitsCount: 3 });
    expect(recs).toHaveLength(1);
    expect(recs[0].track).toBe('PARENT');
    expect(recs[0].reasoningPath[0]).toContain('missedHabitsCount');
  });

  it('Parent Coach produces zero recommendations when nothing is wrong', () => {
    expect(generateParentCoachRecommendations(baseSignals)).toHaveLength(0);
  });

  it('Parent Coach can fire multiple independent recommendations', () => {
    const recs = generateParentCoachRecommendations({ ...baseSignals, missedHabitsCount: 5, healthScore: 20 });
    expect(recs).toHaveLength(2);
  });

  it('Child Coach only fires positive encouragement, never a criticism', () => {
    const recs = generateChildCoachRecommendations({ ...baseSignals, habitCompletionRate: 0.9 });
    expect(recs).toHaveLength(1);
    expect(recs[0].track).toBe('CHILD');
  });

  it('Family Coach suggests a shared challenge only when faith completion is genuinely low', () => {
    expect(generateFamilyCoachRecommendations({ ...baseSignals, faithCompletionRate: 0.9 })).toHaveLength(0);
    expect(generateFamilyCoachRecommendations({ ...baseSignals, faithCompletionRate: 0.3 })).toHaveLength(1);
  });
});

describe('computeGrowthScore (pure)', () => {
  it('averages only the non-null sub-scores', () => {
    const result = computeGrowthScore([
      { score: 80, inputs: {}, confidence: 'HIGH' },
      null,
      { score: 60, inputs: {}, confidence: 'HIGH' },
    ]);
    expect(result?.score).toBe(70);
  });

  it('returns null when every sub-score is null — never fabricates a number from nothing', () => {
    expect(computeGrowthScore([null, null, null])).toBeNull();
  });

  it('downgrades confidence when fewer sub-scores are present', () => {
    const lowConfidence = computeGrowthScore([{ score: 50, inputs: {}, confidence: 'HIGH' }, null, null, null, null, null, null]);
    const highConfidence = computeGrowthScore([
      { score: 50, inputs: {}, confidence: 'HIGH' }, { score: 50, inputs: {}, confidence: 'HIGH' },
      { score: 50, inputs: {}, confidence: 'HIGH' }, { score: 50, inputs: {}, confidence: 'HIGH' },
      { score: 50, inputs: {}, confidence: 'HIGH' },
    ]);
    expect(lowConfidence?.confidence).toBe('LOW');
    expect(highConfidence?.confidence).toBe('HIGH');
  });

  it('always shows how many sub-scores contributed, in the inputs — never a hidden formula', () => {
    const result = computeGrowthScore([{ score: 80, inputs: {}, confidence: 'HIGH' }, null]);
    expect(result?.inputs).toEqual({ contributingSubScores: 1, totalPossibleSubScores: 2 });
  });
});
