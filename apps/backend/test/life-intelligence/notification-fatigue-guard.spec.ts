import { evaluateFatigue, DEFAULT_FATIGUE_POLICY, type IRecentNotification } from '../../src/modules/life-intelligence/application/services/notification-fatigue-guard';
import { getStartOfBusinessDay } from '../../src/common/time/family-date';

/**
 * CHANGED IN B2 (PA-B-002). `evaluateFatigue` gained a REQUIRED
 * `businessDayStart` argument, because the daily/category caps used to bound
 * "today" with `setHours(0,0,0,0)` — the CONTAINER's timezone, which is unset
 * in this image and therefore accidentally UTC. Every existing case below is
 * re-expressed with the UTC business day start, which is exactly what
 * `setHours` was silently producing here, so these assertions test the same
 * behaviour they always did. The new `describe` at the bottom tests the
 * behaviour that was previously impossible to express.
 */
describe('evaluateFatigue (Sprint 16 — CLOSES A REAL GAP: zero fatigue protection existed anywhere before this)', () => {
  const now = new Date('2026-08-10T12:00:00.000Z');
  const utcDayStart = (instant: Date): Date => getStartOfBusinessDay(instant, 'UTC');
  const candidate = { type: 'HYDRATION_REMINDER', priority: 'NORMAL' as const, title: 't', body: 'b', targetAudience: 'CHILD' as const };

  it('allows a candidate with no history at all', () => {
    const result = evaluateFatigue(candidate, [], now, '12:00', utcDayStart(now));
    expect(result.allowed).toBe(true);
  });

  describe('cooldown', () => {
    it('blocks the SAME type sent within its cooldown window', () => {
      const history: IRecentNotification[] = [
        { type: 'HYDRATION_REMINDER', priority: 'NORMAL', createdAt: new Date('2026-08-10T11:30:00.000Z') },
      ];
      const result = evaluateFatigue(candidate, history, now, '12:00', utcDayStart(now));
      expect(result).toEqual({ allowed: false, blockedReason: 'COOLDOWN' });
    });

    it('allows the same type once the cooldown window has fully passed', () => {
      const history: IRecentNotification[] = [
        { type: 'HYDRATION_REMINDER', priority: 'NORMAL', createdAt: new Date('2026-08-10T09:00:00.000Z') },
      ];
      const result = evaluateFatigue(candidate, history, now, '12:00', utcDayStart(now));
      expect(result.allowed).toBe(true);
    });

    it("a DIFFERENT type is unaffected by another type's cooldown", () => {
      const history: IRecentNotification[] = [
        { type: 'STUDY_REMINDER', priority: 'NORMAL', createdAt: new Date('2026-08-10T11:59:00.000Z') },
      ];
      const result = evaluateFatigue(candidate, history, now, '12:00', utcDayStart(now));
      expect(result.allowed).toBe(true);
    });
  });

  describe('duplicate prevention', () => {
    it('CRITICAL: blocks a near-duplicate (same type within 5 minutes), even for a type with no configured cooldown', () => {
      const noCooldownCandidate = { type: 'SOME_UNCONFIGURED_TYPE', priority: 'NORMAL' as const, title: 't', body: 'b', targetAudience: 'CHILD' as const };
      const history: IRecentNotification[] = [
        { type: 'SOME_UNCONFIGURED_TYPE', priority: 'NORMAL', createdAt: new Date('2026-08-10T11:58:00.000Z') },
      ];
      const result = evaluateFatigue(noCooldownCandidate, history, now, '12:00', utcDayStart(now));
      expect(result).toEqual({ allowed: false, blockedReason: 'DUPLICATE' });
    });

    it('does NOT treat a 10-minute-old notification as a duplicate (outside the 5-minute window)', () => {
      const noCooldownCandidate = { type: 'SOME_UNCONFIGURED_TYPE', priority: 'NORMAL' as const, title: 't', body: 'b', targetAudience: 'CHILD' as const };
      const history: IRecentNotification[] = [
        { type: 'SOME_UNCONFIGURED_TYPE', priority: 'NORMAL', createdAt: new Date('2026-08-10T11:50:00.000Z') },
      ];
      const result = evaluateFatigue(noCooldownCandidate, history, now, '12:00', utcDayStart(now));
      expect(result.allowed).toBe(true);
    });
  });

  describe('quiet hours (21:00-07:00, wraps past midnight)', () => {
    it('blocks a NORMAL priority candidate during quiet hours', () => {
      const result = evaluateFatigue(candidate, [], now, '22:00', utcDayStart(now));
      expect(result).toEqual({ allowed: false, blockedReason: 'QUIET_HOURS' });
    });

    it('blocks a NORMAL priority candidate in the early-morning portion of quiet hours (after midnight)', () => {
      const result = evaluateFatigue(candidate, [], now, '03:00', utcDayStart(now));
      expect(result).toEqual({ allowed: false, blockedReason: 'QUIET_HOURS' });
    });

    it('allows a NORMAL priority candidate right at the boundary (07:00, quiet hours end)', () => {
      const result = evaluateFatigue(candidate, [], now, '07:00', utcDayStart(now));
      expect(result.allowed).toBe(true);
    });

    it('CRITICAL: escalation policy — a CRITICAL priority candidate bypasses quiet hours', () => {
      const criticalCandidate = { type: 'PROTECTION_ALERT', priority: 'CRITICAL' as const, title: 't', body: 'b', targetAudience: 'PARENT' as const };
      const result = evaluateFatigue(criticalCandidate, [], now, '23:00', utcDayStart(now));
      expect(result.allowed).toBe(true);
    });

    it('CRITICAL still respects duplicate prevention even during quiet hours', () => {
      const criticalCandidate = { type: 'PROTECTION_ALERT', priority: 'CRITICAL' as const, title: 't', body: 'b', targetAudience: 'PARENT' as const };
      const history: IRecentNotification[] = [
        { type: 'PROTECTION_ALERT', priority: 'CRITICAL', createdAt: new Date('2026-08-10T22:58:00.000Z') },
      ];
      const nowLate = new Date('2026-08-10T23:00:00.000Z');
      const result = evaluateFatigue(criticalCandidate, history, nowLate, '23:00', utcDayStart(nowLate));
      expect(result).toEqual({ allowed: false, blockedReason: 'DUPLICATE' });
    });
  });

  describe('daily max', () => {
    it('blocks once dailyMax is reached, even for a type with room in its own category max', () => {
      const history: IRecentNotification[] = Array.from({ length: DEFAULT_FATIGUE_POLICY.dailyMax }, (_, i) => ({
        type: `TYPE_${i}`,
        priority: 'NORMAL' as const,
        createdAt: new Date('2026-08-10T08:00:00.000Z'),
      }));
      const result = evaluateFatigue(candidate, history, now, '12:00', utcDayStart(now));
      expect(result).toEqual({ allowed: false, blockedReason: 'DAILY_MAX' });
    });

    it("does NOT count YESTERDAY's notifications toward today's daily max", () => {
      const history: IRecentNotification[] = Array.from({ length: DEFAULT_FATIGUE_POLICY.dailyMax }, (_, i) => ({
        type: `TYPE_${i}`,
        priority: 'NORMAL' as const,
        createdAt: new Date('2026-08-09T08:00:00.000Z'),
      }));
      const result = evaluateFatigue(candidate, history, now, '12:00', utcDayStart(now));
      expect(result.allowed).toBe(true);
    });
  });

  describe('category max', () => {
    it('blocks once categoryDailyMax is reached for that specific type, even with room in dailyMax', () => {
      const history: IRecentNotification[] = Array.from({ length: DEFAULT_FATIGUE_POLICY.categoryDailyMax }, () => ({
        type: 'HYDRATION_REMINDER',
        priority: 'NORMAL' as const,
        createdAt: new Date('2026-08-10T02:00:00.000Z'),
      }));
      const result = evaluateFatigue(candidate, history, now, '12:00', utcDayStart(now));
      expect(result).toEqual({ allowed: false, blockedReason: 'CATEGORY_MAX' });
    });
  });
});
