import { computeLevelFromXp, evaluateRewardRules, selectApplicableRules } from '../../src/modules/life-intelligence/application/services/rewards-rules';
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

/**
 * B4 (PA-B-015 · PA-B-013) — the three gates added to `evaluateRewardRules`,
 * and the tier precedence that lets platform defaults be resolved lazily.
 *
 * These are the properties that make "connect seven domains" safe rather than
 * merely possible, and they are pure functions, so they are tested without a
 * database and cannot be satisfied by a fixture that supplies what production
 * lacks.
 */
describe('evaluateRewardRules — B4 gates', () => {
  const base: IRewardRule = {
    id: 'r1',
    familyId: null,
    triggerEngine: 'habit-builder',
    triggerCondition: {},
    rewardType: 'XP',
    rewardAmountOrBadgeId: '10',
    isActive: true,
    eventType: 'HABIT_COMPLETED',
    maxPerDay: null,
    maxPerWeek: null,
    minVerifiedBy: null,
    category: 'HABITS',
    labelAr: 'إتمام عادة',
  };

  const keyed = (type: string, payload: Record<string, unknown> = {}) => ({
    engine: 'habit-builder',
    type,
    payload,
    idempotencyKey: 'habit-completion:h1:2026-08-14',
  });

  describe('gate 1 — event type (PA-B-013)', () => {
    it('matches only its own event type', () => {
      expect(evaluateRewardRules([base], keyed('HABIT_COMPLETED'))).toHaveLength(1);
      expect(evaluateRewardRules([base], keyed('STREAK_ACHIEVED'))).toHaveLength(0);
    });

    it('THE DOUBLE-PAY THAT B4 WOULD HAVE CAUSED: one completion fires two triggers on one engine', () => {
      // `HabitEngineService.completeHabit` fires the legacy keyless
      // `habit_completed` AND the contract `HABIT_COMPLETED` for a SINGLE
      // completion. A rule scoped to the ENGINE alone — every rule before B4 —
      // matches both, so connecting the chain would have paid twice for every
      // habit, and one of the two payments would have carried `applyEarn`'s
      // `nokey:<uuid>` fallback, which no unique index can ever catch.
      const engineScoped: IRewardRule = { ...base, eventType: null };
      const legacy = { engine: 'habit-builder', type: 'habit_completed', payload: {} };

      expect(evaluateRewardRules([engineScoped], legacy)).toHaveLength(1);
      expect(evaluateRewardRules([engineScoped], keyed('HABIT_COMPLETED'))).toHaveLength(1);
      // The typed rule answers exactly one of the two.
      expect(evaluateRewardRules([base], legacy)).toHaveLength(0);
      expect(evaluateRewardRules([base], keyed('HABIT_COMPLETED'))).toHaveLength(1);
    });

    it('a null event type stays a WILDCARD — F4 companion rows and pre-B4 rules keep working', () => {
      const companion: IRewardRule = {
        ...base,
        eventType: null,
        triggerEngine: 'reward-program',
        triggerCondition: { programId: 'p1', multiplierBps: 10000 },
      };
      const verified = {
        engine: 'reward-program',
        type: 'ACHIEVEMENT_VERIFIED',
        payload: { programId: 'p1', multiplierBps: 10000 },
        idempotencyKey: 'child:x:achv:y:x10000',
      };
      expect(evaluateRewardRules([companion], verified)).toHaveLength(1);
    });
  });

  describe('gate 2 — a typed rule never pays an unkeyed trigger', () => {
    it('refuses a trigger with no idempotency key', () => {
      expect(evaluateRewardRules([base], { engine: 'habit-builder', type: 'HABIT_COMPLETED', payload: {} })).toHaveLength(0);
    });

    it('but a WILDCARD rule still does — pre-B4 behaviour is untouched', () => {
      const wildcard: IRewardRule = { ...base, eventType: null };
      expect(evaluateRewardRules([wildcard], { engine: 'habit-builder', type: 'anything', payload: {} })).toHaveLength(1);
    });
  });

  describe('gate 3 — the verification floor', () => {
    const strict: IRewardRule = { ...base, minVerifiedBy: 'PARENT' };

    it('pays a PARENT-verified completion and refuses a SELF-asserted one', () => {
      expect(evaluateRewardRules([strict], keyed('HABIT_COMPLETED', { verifiedBy: 'PARENT' }))).toHaveLength(1);
      expect(evaluateRewardRules([strict], keyed('HABIT_COMPLETED', { verifiedBy: 'SELF' }))).toHaveLength(0);
      expect(evaluateRewardRules([strict], keyed('HABIT_COMPLETED', { verifiedBy: 'SENSOR' }))).toHaveLength(0);
    });

    it('treats a MISSING verifiedBy as the WEAKEST value, never the strongest', () => {
      // An unannotated producer must not accidentally satisfy a parent-approval
      // floor. Defaulting the other way would have made the floor decorative.
      expect(evaluateRewardRules([strict], keyed('HABIT_COMPLETED'))).toHaveLength(0);
      expect(evaluateRewardRules([base], keyed('HABIT_COMPLETED'))).toHaveLength(1);
    });

    it('is a FLOOR, not an equality — SYSTEM satisfies a SENSOR floor', () => {
      const sensorFloor: IRewardRule = { ...base, minVerifiedBy: 'SENSOR' };
      expect(evaluateRewardRules([sensorFloor], keyed('HABIT_COMPLETED', { verifiedBy: 'SYSTEM' }))).toHaveLength(1);
      expect(evaluateRewardRules([sensorFloor], keyed('HABIT_COMPLETED', { verifiedBy: 'SELF' }))).toHaveLength(0);
    });
  });
});

describe('selectApplicableRules — the two tiers', () => {
  const platform: IRewardRule = {
    id: 'p1', familyId: null, triggerEngine: 'habit-builder', triggerCondition: {},
    rewardType: 'XP', rewardAmountOrBadgeId: '10', isActive: true, eventType: 'HABIT_COMPLETED',
  };
  const family: IRewardRule = { ...platform, id: 'f1', familyId: 'fam-1', rewardAmountOrBadgeId: '77' };

  it('a family that configured NOTHING gets the platform defaults', () => {
    expect(selectApplicableRules([platform]).map((r) => r.id)).toEqual(['p1']);
  });

  it('a family rule SHADOWS the platform defaults for its engine — otherwise both would pay', () => {
    expect(selectApplicableRules([platform, family]).map((r) => r.id)).toEqual(['f1']);
  });

  it('shadowing is per ENGINE, not per event type — a habit rule does not silence health', () => {
    const healthPlatform: IRewardRule = { ...platform, id: 'p2', triggerEngine: 'health', eventType: 'HYDRATION_GOAL_COMPLETED' };
    expect(selectApplicableRules([platform, healthPlatform, family]).map((r) => r.id).sort()).toEqual(['f1', 'p2']);
  });

  it('OWNERSHIP IS EXISTENCE, NOT ACTIVITY — a deactivated family rule still opts the engine out', () => {
    // Deactivating your only rule means "pay nothing for this engine". If
    // ownership required an ACTIVE rule, switching it off would silently hand
    // the engine back to the defaults and keep paying — the opposite of what
    // the parent asked for. Removing the rule is the route back.
    const off: IRewardRule = { ...family, isActive: false };
    const applicable = selectApplicableRules([platform, off]);
    expect(applicable.map((r) => r.id)).toEqual(['f1']);
    // ...and the rule itself pays nothing, because it is inactive.
    expect(
      evaluateRewardRules(applicable, {
        engine: 'habit-builder', type: 'HABIT_COMPLETED', payload: {}, idempotencyKey: 'k',
      }),
    ).toHaveLength(0);
  });
});
