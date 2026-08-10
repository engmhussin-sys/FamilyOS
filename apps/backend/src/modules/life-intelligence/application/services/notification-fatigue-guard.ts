/**
 * Sprint 16 (Smart Daily Life Layer) — CLOSES A REAL GAP: zero
 * notification fatigue protection existed anywhere in this codebase.
 * The brief's own explicit requirement: cooldown, daily maximum,
 * category maximum, duplicate prevention, quiet hours, priority,
 * escalation policy — "must never annoy the child or parent."
 *
 * Deliberately a PURE function taking recent notification history as
 * a plain input array (not querying the database itself) — same
 * "pure decision logic, separate from I/O" discipline as
 * PatternDetectionService/AnomalyDetectionService from Sprint 14.
 * The caller (a real service, querying the existing Notification
 * table — no new table needed) is responsible for fetching that
 * history; this function only decides.
 */

export interface IRecentNotification {
  type: string;
  priority: 'CRITICAL' | 'HIGH' | 'NORMAL' | 'LOW';
  createdAt: Date;
}

export interface ICandidateNotification {
  type: string;
  priority: 'CRITICAL' | 'HIGH' | 'NORMAL' | 'LOW';
  title: string;
  body: string;
}

export interface IFatiguePolicy {
  cooldownMinutesByType: Record<string, number>;
  dailyMax: number;
  categoryDailyMax: number;
  quietHoursStart: string;
  quietHoursEnd: string;
}

/** A reasonable, explicitly-stated, easily-adjustable-later default
 * policy — the brief's own "rules must be editable in the future"
 * requirement, honored by keeping every number as a named, documented
 * constant rather than scattered magic numbers. */
export const DEFAULT_FATIGUE_POLICY: IFatiguePolicy = {
  cooldownMinutesByType: {
    HYDRATION_REMINDER: 120,
    STUDY_REMINDER: 90,
    EXERCISE_ENCOURAGEMENT: 180,
  },
  dailyMax: 6,
  categoryDailyMax: 2,
  quietHoursStart: '21:00',
  quietHoursEnd: '07:00',
};

export interface IFatigueDecision {
  allowed: boolean;
  blockedReason?: 'COOLDOWN' | 'DAILY_MAX' | 'CATEGORY_MAX' | 'DUPLICATE' | 'QUIET_HOURS';
}

/**
 * The single decision point every candidate notification passes
 * through before being sent. now/currentLocalTime are passed in
 * explicitly (not read from Date.now() internally) — keeps this
 * function pure and deterministic, fully testable without faking the
 * system clock.
 */
export function evaluateFatigue(
  candidate: ICandidateNotification,
  recentHistory: IRecentNotification[],
  now: Date,
  currentLocalTimeHHMM: string,
  policy: IFatiguePolicy = DEFAULT_FATIGUE_POLICY,
): IFatigueDecision {
  // CRITICAL bypasses quiet hours (escalation policy) but NOT
  // duplicate prevention or cooldown — a genuine critical event
  // firing twice in one minute due to a client retry is still a
  // duplicate, not two real events.
  if (candidate.priority !== 'CRITICAL' && isWithinQuietHours(currentLocalTimeHHMM, policy)) {
    return { allowed: false, blockedReason: 'QUIET_HOURS' };
  }

  const todayStart = new Date(now);
  todayStart.setHours(0, 0, 0, 0);
  const todayHistory = recentHistory.filter((n) => n.createdAt >= todayStart);

  // Duplicate prevention: the exact same type sent within the last 5
  // minutes is treated as a duplicate (e.g. a retried request, a race
  // between two triggers), not a second real notification — tighter
  // than the per-type cooldown below, which governs normal repeat
  // frequency, not near-simultaneous duplicates.
  const DUPLICATE_WINDOW_MS = 5 * 60 * 1000;
  const isDuplicate = recentHistory.some(
    (n) => n.type === candidate.type && now.getTime() - n.createdAt.getTime() < DUPLICATE_WINDOW_MS,
  );
  if (isDuplicate) {
    return { allowed: false, blockedReason: 'DUPLICATE' };
  }

  if (todayHistory.length >= policy.dailyMax) {
    return { allowed: false, blockedReason: 'DAILY_MAX' };
  }

  const categoryCountToday = todayHistory.filter((n) => n.type === candidate.type).length;
  if (categoryCountToday >= policy.categoryDailyMax) {
    return { allowed: false, blockedReason: 'CATEGORY_MAX' };
  }

  const cooldownMinutes = policy.cooldownMinutesByType[candidate.type];
  if (cooldownMinutes !== undefined) {
    const lastOfType = recentHistory
      .filter((n) => n.type === candidate.type)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
    if (lastOfType) {
      const minutesSince = (now.getTime() - lastOfType.createdAt.getTime()) / 60_000;
      if (minutesSince < cooldownMinutes) {
        return { allowed: false, blockedReason: 'COOLDOWN' };
      }
    }
  }

  return { allowed: true };
}

/** Handles the overnight-wraparound case (e.g. 21:00-07:00) correctly
 * — a plain start<time<end comparison would be wrong whenever the
 * window crosses midnight. */
function isWithinQuietHours(currentHHMM: string, policy: IFatiguePolicy): boolean {
  const current = toMinutes(currentHHMM);
  const start = toMinutes(policy.quietHoursStart);
  const end = toMinutes(policy.quietHoursEnd);

  if (start <= end) {
    return current >= start && current < end;
  }
  return current >= start || current < end;
}

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}
