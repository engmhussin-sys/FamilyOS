import { generateChildCoachRecommendations, generateParentCoachRecommendations } from '../../src/modules/life-intelligence/application/services/coaching-rules';
import { ICoachingSignals } from '../../src/modules/life-intelligence/domain/coaching.types';

describe('Coaching rules — Sprint 16.1 Phase 6 (CLOSES A REAL GAP: Education/Hydration/Activity signals)', () => {
  const baseSignals: ICoachingSignals = {
    childId: 'c1',
    habitCompletionRate: 0.5,
    healthScore: 70,
    faithCompletionRate: 0.6,
    missedHabitsCount: 0,
    educationSessionCount: 3,
    educationStreakDays: 0,
    hydrationAchievedToday: false,
    activityAchievedToday: false,
  };

  describe('Parent — education visibility', () => {
    it('fires when zero learning sessions have been logged', () => {
      const recs = generateParentCoachRecommendations({ ...baseSignals, educationSessionCount: 0 });
      expect(recs.some((r) => r.title.includes('learning'))).toBe(true);
    });

    it('does NOT fire when at least one session was logged', () => {
      const recs = generateParentCoachRecommendations({ ...baseSignals, educationSessionCount: 1 });
      expect(recs.some((r) => r.title.includes('learning'))).toBe(false);
    });
  });

  describe('Child — education streak (encouraging, non-judgmental)', () => {
    it('fires at the 3-day threshold', () => {
      const recs = generateChildCoachRecommendations({ ...baseSignals, educationStreakDays: 3 });
      expect(recs.some((r) => r.title.includes('streak'))).toBe(true);
    });

    it('does NOT fire below the threshold', () => {
      const recs = generateChildCoachRecommendations({ ...baseSignals, educationStreakDays: 2 });
      expect(recs.some((r) => r.title.includes('streak'))).toBe(false);
    });

    it('CRITICAL: never produces a negative/critical message for a LOW streak — non-judgmental by design', () => {
      const recs = generateChildCoachRecommendations({ ...baseSignals, educationStreakDays: 0 });
      for (const rec of recs) {
        expect(rec.body.toLowerCase()).not.toMatch(/fail|bad|missed|didn't|behind/);
      }
    });
  });

  describe('Child — hydration + activity combined achievement', () => {
    it('fires only when BOTH goals are achieved today', () => {
      const recs = generateChildCoachRecommendations({ ...baseSignals, hydrationAchievedToday: true, activityAchievedToday: true });
      expect(recs.some((r) => r.title === 'Great job today!')).toBe(true);
    });

    it('does NOT fire when only ONE goal is achieved', () => {
      const recs = generateChildCoachRecommendations({ ...baseSignals, hydrationAchievedToday: true, activityAchievedToday: false });
      expect(recs.some((r) => r.title === 'Great job today!')).toBe(false);
    });

    it('does NOT fire when NEITHER goal is achieved — and produces no negative message either', () => {
      const recs = generateChildCoachRecommendations({ ...baseSignals, hydrationAchievedToday: false, activityAchievedToday: false });
      expect(recs.some((r) => r.title === 'Great job today!')).toBe(false);
    });
  });

  it('every generated recommendation includes a real reasoningPath — never an unexplained decision', () => {
    const recs = [
      ...generateParentCoachRecommendations({ ...baseSignals, educationSessionCount: 0 }),
      ...generateChildCoachRecommendations({ ...baseSignals, educationStreakDays: 5, hydrationAchievedToday: true, activityAchievedToday: true }),
    ];
    for (const rec of recs) {
      expect(rec.reasoningPath.length).toBeGreaterThan(0);
    }
  });
});
