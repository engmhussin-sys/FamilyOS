import { evaluateSmartNotificationCandidates, type ISmartNotificationSignals } from '../../src/modules/life-intelligence/application/services/smart-notification-decision-engine';

describe("evaluateSmartNotificationCandidates (Sprint 16 — the brief's own \"most important point\")", () => {
  const baseSignals: ISmartNotificationSignals = {
    currentHourOfDay: 15,
    screenMinutesLast90: 20,
    isCurrentlyInBlockedOrCriticalApp: false,
    hydration: { actualMl: 800, targetMl: 1000 },
    studyTask: null,
    exerciseStreak: null,
  };

  it('produces ZERO candidates when nothing is signal-worthy', () => {
    expect(evaluateSmartNotificationCandidates(baseSignals)).toEqual([]);
  });

  describe("brief's worked example 1: extended usage + low hydration + not in a blocked app", () => {
    it('fires HYDRATION_REMINDER when all three conditions hold', () => {
      const signals: ISmartNotificationSignals = {
        ...baseSignals,
        screenMinutesLast90: 90,
        hydration: { actualMl: 300, targetMl: 1000 },
      };
      const result = evaluateSmartNotificationCandidates(signals);
      expect(result.some((c) => c.type === 'HYDRATION_REMINDER')).toBe(true);
    });

    it('does NOT fire when the child is currently in a blocked/critical app', () => {
      const signals: ISmartNotificationSignals = {
        ...baseSignals,
        screenMinutesLast90: 90,
        hydration: { actualMl: 300, targetMl: 1000 },
        isCurrentlyInBlockedOrCriticalApp: true,
      };
      const result = evaluateSmartNotificationCandidates(signals);
      expect(result.some((c) => c.type === 'HYDRATION_REMINDER')).toBe(false);
    });

    it('does NOT fire when hydration is already adequate, even with extended usage', () => {
      const signals: ISmartNotificationSignals = { ...baseSignals, screenMinutesLast90: 90, hydration: { actualMl: 900, targetMl: 1000 } };
      const result = evaluateSmartNotificationCandidates(signals);
      expect(result.some((c) => c.type === 'HYDRATION_REMINDER')).toBe(false);
    });

    it('does NOT fire when usage is short, even with low hydration', () => {
      const signals: ISmartNotificationSignals = { ...baseSignals, screenMinutesLast90: 10, hydration: { actualMl: 200, targetMl: 1000 } };
      const result = evaluateSmartNotificationCandidates(signals);
      expect(result.some((c) => c.type === 'HYDRATION_REMINDER')).toBe(false);
    });
  });

  describe("brief's worked example 2: homework incomplete + usual study window + not in a blocked app", () => {
    it('fires STUDY_REMINDER when all conditions hold', () => {
      const signals: ISmartNotificationSignals = { ...baseSignals, studyTask: { isIncomplete: true, usualStudyWindowStarted: true } };
      const result = evaluateSmartNotificationCandidates(signals);
      expect(result.some((c) => c.type === 'STUDY_REMINDER')).toBe(true);
    });

    it('does NOT fire when the study window has not started yet', () => {
      const signals: ISmartNotificationSignals = { ...baseSignals, studyTask: { isIncomplete: true, usualStudyWindowStarted: false } };
      const result = evaluateSmartNotificationCandidates(signals);
      expect(result.some((c) => c.type === 'STUDY_REMINDER')).toBe(false);
    });

    it('does NOT fire when homework is already complete', () => {
      const signals: ISmartNotificationSignals = { ...baseSignals, studyTask: { isIncomplete: false, usualStudyWindowStarted: true } };
      const result = evaluateSmartNotificationCandidates(signals);
      expect(result.some((c) => c.type === 'STUDY_REMINDER')).toBe(false);
    });

    it('BOUNDARY CASE: null studyTask (no data) never fires, never crashes', () => {
      const signals: ISmartNotificationSignals = { ...baseSignals, studyTask: null };
      expect(() => evaluateSmartNotificationCandidates(signals)).not.toThrow();
      expect(evaluateSmartNotificationCandidates(signals).some((c) => c.type === 'STUDY_REMINDER')).toBe(false);
    });
  });

  describe("brief's worked example 3: 3+ day streak + today incomplete", () => {
    it('fires EXERCISE_ENCOURAGEMENT at exactly the 3-day threshold', () => {
      const signals: ISmartNotificationSignals = { ...baseSignals, exerciseStreak: { streakDays: 3, todayComplete: false } };
      const result = evaluateSmartNotificationCandidates(signals);
      expect(result.some((c) => c.type === 'EXERCISE_ENCOURAGEMENT')).toBe(true);
    });

    it('does NOT fire below the 3-day threshold', () => {
      const signals: ISmartNotificationSignals = { ...baseSignals, exerciseStreak: { streakDays: 2, todayComplete: false } };
      const result = evaluateSmartNotificationCandidates(signals);
      expect(result.some((c) => c.type === 'EXERCISE_ENCOURAGEMENT')).toBe(false);
    });

    it("does NOT fire when today's activity is already complete", () => {
      const signals: ISmartNotificationSignals = { ...baseSignals, exerciseStreak: { streakDays: 10, todayComplete: true } };
      const result = evaluateSmartNotificationCandidates(signals);
      expect(result.some((c) => c.type === 'EXERCISE_ENCOURAGEMENT')).toBe(false);
    });
  });

  it('can produce MULTIPLE candidates simultaneously when multiple rules independently match', () => {
    const signals: ISmartNotificationSignals = {
      currentHourOfDay: 16,
      screenMinutesLast90: 90,
      isCurrentlyInBlockedOrCriticalApp: false,
      hydration: { actualMl: 200, targetMl: 1000 },
      studyTask: { isIncomplete: true, usualStudyWindowStarted: true },
      exerciseStreak: { streakDays: 5, todayComplete: false },
    };
    const result = evaluateSmartNotificationCandidates(signals);
    expect(result.length).toBe(3);
  });

  it('every candidate has non-empty, real title/body text — never a placeholder', () => {
    const signals: ISmartNotificationSignals = { ...baseSignals, screenMinutesLast90: 90, hydration: { actualMl: 100, targetMl: 1000 } };
    const result = evaluateSmartNotificationCandidates(signals);
    for (const candidate of result) {
      expect(candidate.title.length).toBeGreaterThan(0);
      expect(candidate.body.length).toBeGreaterThan(5);
    }
  });
});
