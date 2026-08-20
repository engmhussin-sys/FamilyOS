/**
 * PHASE F (`F6-002` §3) — THE SCORE, AND THE CLAIM THAT IT IS NOT A BLACK BOX.
 *
 * «Explainable» is a testable property, not an adjective, and these are the
 * tests that make it one:
 *
 *   1. THE ARITHMETIC RECONCILES. The stored components sum to the stored
 *      total. An explanation that does not add up is worse than none, because
 *      it is trusted.
 *   2. EVERY COMPONENT IS PRESENT, EVERY TIME. A component that vanishes when
 *      its reading is zero is a component nobody can see the absence of.
 *   3. THE SIGNS ARE RIGHT. The three penalties subtract and the five signals
 *      add, asserted against `NOTIFICATION_PENALTY_COMPONENTS` rather than
 *      against a hand-written list.
 *   4. EACH TERM MOVES THE SCORE IN THE DIRECTION IT CLAIMS TO. Changing one
 *      fact in the context changes the score, and by the right sign.
 *   5. A WORKED EXAMPLE reproduces exactly, so the number in the phase report
 *      is the number the code produces.
 */
import {
  NOTIFICATION_PENALTY_COMPONENTS,
  NOTIFICATION_SCORE_COMPONENTS,
} from '../../src/modules/notifications/domain/engine/notification-decision.types';
import {
  bandForScore,
  explainScore,
  scoreNotification,
} from '../../src/modules/notifications/domain/engine/notification-scoring';
import {
  DEFAULT_NOTIFICATION_POLICY,
  resolveNotificationPolicy,
} from '../../src/modules/notifications/domain/engine/notification-policy';
import type { NotificationContext } from '../../src/modules/notifications/domain/engine/notification-context';
import { resolveTargetAudience } from '../../src/modules/notifications/domain/engine/notification-copy';

const NOW = new Date('2026-03-10T14:00:00.000Z');

function ctx(overrides: Partial<NotificationContext> = {}): NotificationContext {
  const base: NotificationContext = {
    familyId: '11111111-1111-1111-1111-111111111111',
    childId: '22222222-2222-2222-2222-222222222222',
    /**
     * STATED, NOT ASSUMED. `targetAudience` is what decides WHICH INBOX the
     * assembler fills `recentNotifications` from, so a fixture that left it
     * implicit would be a fixture that does not say which of the two streams
     * it is scoring. Derived from the event type below by the SAME function the
     * assembler and the provider use, and overridable, so a case that overrides
     * `event.eventType` gets that type's real audience rather than this one's.
     */
    targetAudience: 'PARENT',
    childAgeYears: 12,
    toneBand: '11-13',
    safetyBand: '12-14',
    locale: 'ar',
    timeZone: 'Africa/Cairo',
    countryCode: 'EG',
    event: {
      eventType: 'REWARD_GRANTED',
      cause: null,
      sourceEventId: 'evt:test',
      trigger: 'DOMAIN_EVENT',
      variables: {},
    },
    recentActivity: { completionsToday: 1, minutesSinceLastActivity: 20, isEngagedNow: true },
    recentNotifications: [],
    goal: null,
    reward: null,
    streak: null,
    preferences: { parentCategories: {}, childCategories: {}, parentAppetite: 0.6 },
    quietHours: { startHHMM: '21:00', endHHMM: '07:00', isActiveNow: false, localTimeHHMM: '16:00' },
    subscription: { plan: 'FREE', isActive: false },
    now: NOW,
    childDisplayName: 'محمد',
  };
  const merged = { ...base, ...overrides };
  return {
    ...merged,
    targetAudience:
      overrides.targetAudience ?? resolveTargetAudience(merged.event.eventType, merged.childId !== null),
  };
}

const policy = DEFAULT_NOTIFICATION_POLICY;

describe('PHASE F — explainable scoring', () => {
  it('emits ALL eight components on every decision, in a stable order', () => {
    const score = scoreNotification(ctx(), policy, 'REWARD');
    expect(score.components.map((c) => c.name)).toEqual([...NOTIFICATION_SCORE_COMPONENTS]);
  });

  it('the stored components reconcile to the stored total — the explanation adds up', () => {
    const cases: NotificationContext[] = [
      ctx(),
      ctx({ reward: { kind: 'COINS', amount: 200, isMilestone: true } }),
      ctx({ quietHours: { startHHMM: '21:00', endHHMM: '07:00', isActiveNow: true, localTimeHHMM: '23:30' } }),
      ctx({
        recentNotifications: [
          { type: 'REWARD_GRANTED', category: 'REWARD', priority: 'NORMAL', createdAt: new Date(NOW.getTime() - 60_000) },
        ],
      }),
      ctx({ goal: { title: 'سورة الملك', completedUnits: 4, totalUnits: 5, minutesRemaining: 5 } }),
    ];
    for (const c of cases) {
      const score = scoreNotification(c, policy, 'REWARD');
      const sum = score.components.reduce((acc, comp) => acc + comp.contribution, 0);
      expect(score.total).toBe(Math.max(0, Math.min(100, Math.round(sum))));
      // And the printed form contains one line per component plus the total, so
      // a human reads the same numbers the database holds.
      const printed = explainScore(score);
      for (const comp of score.components) expect(printed).toContain(comp.name);
      expect(printed).toContain(`TOTAL: ${score.total}`);
    }
  });

  it('the three penalties SUBTRACT and the five signals ADD', () => {
    const score = scoreNotification(
      ctx({
        quietHours: { startHHMM: '21:00', endHHMM: '07:00', isActiveNow: true, localTimeHHMM: '23:30' },
        recentNotifications: [
          { type: 'REWARD_GRANTED', category: 'REWARD', priority: 'NORMAL', createdAt: new Date(NOW.getTime() - 60_000) },
          { type: 'BADGE_EARNED', category: 'ACHIEVEMENT', priority: 'NORMAL', createdAt: new Date(NOW.getTime() - 120_000) },
        ],
      }),
      policy,
      'REWARD',
    );
    for (const comp of score.components) {
      if (NOTIFICATION_PENALTY_COMPONENTS.has(comp.name)) {
        expect(comp.contribution).toBeLessThanOrEqual(0);
      } else {
        expect(comp.contribution).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('every component carries the FACT that produced it, not just a number', () => {
    const score = scoreNotification(
      ctx({ goal: { title: 'العلوم', completedUnits: 4, totalUnits: 5, minutesRemaining: 12 } }),
      policy,
      'GOAL',
    );
    const deadline = score.components.find((c) => c.name === 'DEADLINE_PROXIMITY');
    expect(deadline?.note).toBe('12 minutes remaining');
    const fatigue = score.components.find((c) => c.name === 'FATIGUE_PENALTY');
    expect(fatigue?.note).toContain('today=0/6');
    const dup = score.components.find((c) => c.name === 'DUPLICATE_PENALTY');
    expect(dup?.note).toBe('no recent notification of this type');
  });

  describe('each term moves the score in the direction it claims', () => {
    const baseline = scoreNotification(ctx(), policy, 'REWARD').total;

    it('URGENCY: a safety type outranks a reward', () => {
      const safety = scoreNotification(
        ctx({ event: { ...ctx().event, eventType: 'ACCESSIBILITY_DISABLED' } }),
        policy,
        'SAFETY',
      ).total;
      expect(safety).toBeGreaterThan(baseline);
    });

    it('URGENCY: a streak two hours from breaking outranks the same streak with ten', () => {
      const near = scoreNotification(
        ctx({ streak: { days: 6, atRisk: true, hoursUntilBreak: 2 } }),
        policy,
        'ACHIEVEMENT',
      ).total;
      const far = scoreNotification(
        ctx({ streak: { days: 6, atRisk: true, hoursUntilBreak: 10 } }),
        policy,
        'ACHIEVEMENT',
      ).total;
      expect(near).toBeGreaterThan(far);
    });

    it('RELEVANCE: an idle, disengaged child scores lower than a present one', () => {
      const idle = scoreNotification(
        ctx({ recentActivity: { completionsToday: 0, minutesSinceLastActivity: null, isEngagedNow: false } }),
        policy,
        'REWARD',
      ).total;
      expect(idle).toBeLessThan(baseline);
    });

    it('ACHIEVEMENT_VALUE: a milestone outranks a routine grant, logarithmically not linearly', () => {
      const routine = scoreNotification(
        ctx({ reward: { kind: 'COINS', amount: 5, isMilestone: false } }),
        policy,
        'REWARD',
      ).total;
      const big = scoreNotification(
        ctx({ reward: { kind: 'COINS', amount: 200, isMilestone: false } }),
        policy,
        'REWARD',
      ).total;
      const milestone = scoreNotification(
        ctx({ reward: { kind: 'BADGE', amount: 1, isMilestone: true } }),
        policy,
        'REWARD',
      ).total;
      expect(big).toBeGreaterThan(routine);
      expect(milestone).toBeGreaterThan(routine);
      // Forty times the coins is nowhere near forty times the score.
      expect(big - routine).toBeLessThan(policy.scoring.weightAchievement);
    });

    it('DEADLINE_PROXIMITY: five minutes left outranks ninety, and a passed deadline scores zero', () => {
      const soon = scoreNotification(
        ctx({ goal: { title: 'ج', completedUnits: 4, totalUnits: 5, minutesRemaining: 5 } }),
        policy,
        'GOAL',
      );
      const later = scoreNotification(
        ctx({ goal: { title: 'ج', completedUnits: 4, totalUnits: 5, minutesRemaining: 90 } }),
        policy,
        'GOAL',
      );
      const passed = scoreNotification(
        ctx({ goal: { title: 'ج', completedUnits: 4, totalUnits: 5, minutesRemaining: -5 } }),
        policy,
        'GOAL',
      );
      expect(soon.total).toBeGreaterThan(later.total);
      expect(passed.components.find((c) => c.name === 'DEADLINE_PROXIMITY')?.contribution).toBe(0);
      // A missing deadline reads ZERO, not a guessed midpoint — an honest
      // absence, which is this codebase's standing rule.
      const none = scoreNotification(ctx(), policy, 'GOAL');
      expect(none.components.find((c) => c.name === 'DEADLINE_PROXIMITY')?.note).toBe(
        'no deadline on this goal',
      );
    });

    it('FATIGUE_PENALTY: a household already at five of six today scores lower', () => {
      const recent = Array.from({ length: 5 }, (_, i) => ({
        type: `T${i}`,
        category: 'REWARD',
        priority: 'NORMAL' as const,
        createdAt: new Date(NOW.getTime() - (i + 2) * 3 * 60 * 60 * 1000),
      }));
      const tired = scoreNotification(ctx({ recentNotifications: recent }), policy, 'REWARD').total;
      expect(tired).toBeLessThan(baseline);
    });

    it('DUPLICATE_PENALTY: the heaviest penalty, and it is heaviest on purpose', () => {
      const dup = scoreNotification(
        ctx({
          recentNotifications: [
            { type: 'REWARD_GRANTED', category: 'REWARD', priority: 'NORMAL', createdAt: new Date(NOW.getTime() - 60_000) },
          ],
        }),
        policy,
        'REWARD',
      );
      expect(dup.components.find((c) => c.name === 'DUPLICATE_PENALTY')?.contribution).toBe(
        -policy.scoring.penaltyDuplicate,
      );
      expect(policy.scoring.penaltyDuplicate).toBeGreaterThan(policy.scoring.penaltyFatigue);
      expect(policy.scoring.penaltyDuplicate).toBeGreaterThan(policy.scoring.penaltyQuietHours);
    });

    it('QUIET_HOURS_PENALTY: applied inside the window — but NEVER to a DELIVER-class safety alert', () => {
      const quiet = { startHHMM: '21:00', endHHMM: '07:00', isActiveNow: true, localTimeHHMM: '02:00' };
      const reward = scoreNotification(ctx({ quietHours: quiet }), policy, 'REWARD');
      expect(reward.components.find((c) => c.name === 'QUIET_HOURS_PENALTY')?.contribution).toBe(
        -policy.scoring.penaltyQuietHours,
      );

      const alert = scoreNotification(
        ctx({ quietHours: quiet, event: { ...ctx().event, eventType: 'ACCESSIBILITY_DISABLED' } }),
        policy,
        'SAFETY',
      );
      const penalty = alert.components.find((c) => c.name === 'QUIET_HOURS_PENALTY');
      expect(penalty?.contribution).toBe(0);
      expect(penalty?.note).toContain('DELIVER class');
    });
  });

  it('bands on the configured thresholds, and SUPPRESS is the floor', () => {
    const cfg = policy.scoring;
    expect(bandForScore(cfg.thresholdHigh, cfg)).toBe('HIGH');
    expect(bandForScore(cfg.thresholdHigh - 1, cfg)).toBe('MEDIUM');
    expect(bandForScore(cfg.thresholdMedium, cfg)).toBe('MEDIUM');
    expect(bandForScore(cfg.thresholdMedium - 1, cfg)).toBe('LOW');
    expect(bandForScore(cfg.thresholdLow, cfg)).toBe('LOW');
    expect(bandForScore(cfg.thresholdLow - 1, cfg)).toBe('SUPPRESS');
    expect(bandForScore(0, cfg)).toBe('SUPPRESS');
  });

  it('respects a family that RECONFIGURED its thresholds', () => {
    const onDefaults = scoreNotification(ctx(), policy, 'REWARD');
    expect(onDefaults.band).not.toBe('SUPPRESS');

    // A household that raised its whole ladder. The SAME context, the SAME
    // arithmetic, a different verdict — because the threshold is read from
    // configuration rather than from a constant, which is the claim under test.
    const strict = resolveNotificationPolicy({
      'notification.score.thresholdHigh': '95',
      'notification.score.thresholdMedium': '90',
      'notification.score.thresholdLow': '85',
    });
    const score = scoreNotification(ctx(), strict, 'REWARD');
    expect(score.total).toBe(onDefaults.total);
    expect(score.band).toBe('SUPPRESS');
  });

  /**
   * THE WORKED EXAMPLE reproduced in §«نموذج التقييم» of the phase report.
   * Pinned exactly, so the report and the code cannot drift apart silently.
   */
  it('worked example — a 12-year-old, one verse from finishing سورة الملك, 5 minutes left, 19:40 local', () => {
    const worked = ctx({
      event: {
        eventType: 'LEARNING_GOAL_ACHIEVED',
        cause: null,
        sourceEventId: 'evt:worked-example',
        trigger: 'DEADLINE_WATCH',
        variables: { unitNoun: 'آيات' },
      },
      goal: { title: 'سورة الملك', completedUnits: 4, totalUnits: 5, minutesRemaining: 5 },
      recentActivity: { completionsToday: 2, minutesSinceLastActivity: 3, isEngagedNow: true },
      recentNotifications: [
        { type: 'DAILY_GOAL_COMPLETED', category: 'GOAL', priority: 'NORMAL', createdAt: new Date(NOW.getTime() - 5 * 60 * 60 * 1000) },
      ],
      quietHours: { startHHMM: '21:00', endHHMM: '07:00', isActiveNow: false, localTimeHHMM: '19:40' },
    });
    const score = scoreNotification(worked, policy, 'GOAL');

    const by = (name: string) => score.components.find((c) => c.name === name)!;
    expect(by('URGENCY').contribution).toBe(10.5);
    expect(by('RELEVANCE').contribution).toBe(19.92);
    expect(by('ACHIEVEMENT_VALUE').contribution).toBe(14);
    expect(by('DEADLINE_PROXIMITY').contribution).toBe(15);
    expect(by('PARENT_PREFERENCE').contribution).toBe(9);
    expect(by('FATIGUE_PENALTY').contribution).toBe(-12.5);
    expect(by('DUPLICATE_PENALTY').contribution).toBe(0);
    expect(by('QUIET_HOURS_PENALTY').contribution).toBe(0);
    expect(score.total).toBe(56);
    expect(score.band).toBe('MEDIUM');
  });
});
