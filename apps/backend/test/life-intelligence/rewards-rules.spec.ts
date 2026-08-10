import { computeLevelFromXp, evaluateRewardRules } from '../../src/modules/life-intelligence/application/services/rewards-rules';
import { IRewardRule } from '../../src/modules/life-intelligence/domain/rewards.types';

describe('evaluateRewardRules (pure rule component)', () => {
  const salahStreakRule: IRewardRule = {
    id: 'rule-1',
    familyId: null,
    triggerEngine: 'faith',
    triggerCondition: { practiceType: 'SALAH', streakDays: 7 },
    rewardType: 'BADGE',
    rewardAmountOrBadgeId: 'salah-week-streak',
    isActive: true,
  };
  const hydrationCoinsRule: IRewardRule = {
    id: 'rule-2',
    familyId: 'family-1',
    triggerEngine: 'health',
    triggerCondition: { metric: 'hydration_target_reached' },
    rewardType: 'COINS',
    rewardAmountOrBadgeId: '20',
    isActive: true,
  };

  it('grants exactly when every condition key matches the event payload', () => {
    const grants = evaluateRewardRules([salahStreakRule], {
      engine: 'faith',
      type: 'practice_logged',
      payload: { practiceType: 'SALAH', streakDays: 7 },
    });
    expect(grants).toHaveLength(1);
    expect(grants[0]).toEqual({ rewardType: 'BADGE', amountOrBadgeId: 'salah-week-streak', source: 'reward_rule:rule-1' });
  });

  it('does NOT grant when only some condition keys match', () => {
    const grants = evaluateRewardRules([salahStreakRule], {
      engine: 'faith',
      type: 'practice_logged',
      payload: { practiceType: 'SALAH', streakDays: 3 },
    });
    expect(grants).toHaveLength(0);
  });

  it('ignores rules for a different engine entirely', () => {
    const grants = evaluateRewardRules([salahStreakRule], {
      engine: 'health',
      type: 'practice_logged',
      payload: { practiceType: 'SALAH', streakDays: 7 },
    });
    expect(grants).toHaveLength(0);
  });

  it('ignores inactive rules even when the condition matches', () => {
    const grants = evaluateRewardRules([{ ...salahStreakRule, isActive: false }], {
      engine: 'faith',
      type: 'practice_logged',
      payload: { practiceType: 'SALAH', streakDays: 7 },
    });
    expect(grants).toHaveLength(0);
  });

  it('evaluates multiple rules independently, granting all matches', () => {
    const grants = evaluateRewardRules([salahStreakRule, hydrationCoinsRule], {
      engine: 'health',
      type: 'hydration_event',
      payload: { metric: 'hydration_target_reached' },
    });
    expect(grants).toHaveLength(1);
    expect(grants[0].rewardType).toBe('COINS');
  });

  it('returns an empty array, never throws, when no rules exist', () => {
    expect(evaluateRewardRules([], { engine: 'health', type: 'x', payload: {} })).toEqual([]);
  });
});

describe('computeLevelFromXp (pure rule component)', () => {
  it('returns level 1 for 0 XP and every threshold boundary correctly', () => {
    expect(computeLevelFromXp(0)).toBe(1);
    expect(computeLevelFromXp(99)).toBe(1);
    expect(computeLevelFromXp(100)).toBe(2);
    expect(computeLevelFromXp(249)).toBe(2);
    expect(computeLevelFromXp(250)).toBe(3);
  });

  it('never exceeds the max defined level even for huge XP values', () => {
    expect(computeLevelFromXp(1_000_000)).toBe(11);
  });

  it('never returns a level below 1 for negative or zero input', () => {
    expect(computeLevelFromXp(0)).toBeGreaterThanOrEqual(1);
    expect(computeLevelFromXp(-50)).toBe(1);
  });
});
