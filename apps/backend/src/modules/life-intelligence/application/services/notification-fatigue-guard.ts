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
 *
 * PHASE E (`PD-N-004`) — THE ONE IMPORT, and it is to a framework-free data
 * table (`shared/notifications/notification-class.ts`), never to a service.
 * The function stays pure: it reads a constant, performs no I/O, and every
 * caller still gets the same answer for the same inputs. Importing it is the
 * point — the quiet-hours question now has ONE answer in this codebase,
 * instead of a justified table in one file and a `priority !== 'CRITICAL'`
 * shortcut quietly overriding it in another.
 */
import { quietHoursClassOf } from '../../../../shared/notifications/notification-class';

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
  /** Sprint 16.1 Phase 3 (Smart Notification Integration) — CLOSES A
   * REAL GAP: without this, there was no way to route a candidate to
   * the correct recipient per the brief's own explicit "Parent vs
   * Child" separation — a child must NEVER receive an unsupervised
   * system message (this field alone doesn't enforce that; the
   * integration layer routes CHILD-targeted candidates through
   * FamilyCommunicationService.draftAiMessage, which enforces the
   * real approval gate). */
  targetAudience: 'PARENT' | 'CHILD';
}

export interface IFatiguePolicy {
  cooldownMinutesByType: Record<string, number>;
  dailyMax: number;
  categoryDailyMax: number;
  quietHoursStart: string;
  quietHoursEnd: string;

  /**
   * PHASE F (`F6-002`) — THE THREE FIELDS THAT MAKE THIS POLICY CONFIGURATION
   * INSTEAD OF A CONSTANT, AND WHY ALL THREE ARE OPTIONAL.
   *
   * Every caller written before F6 — `SmartNotificationIntegrationService` and
   * `QuietHoursReleaseService`, both of which pass no policy argument at all —
   * must keep `DEFAULT_FATIGUE_POLICY`'s exact previous behaviour. An absent
   * field is therefore not «zero», it is «this rule did not exist for you», and
   * each branch below is written that way. The values come from
   * `notifications/domain/engine/notification-policy.ts` via `toFatiguePolicy`,
   * which resolves them per family from `notification_policy_settings`.
   *
   * The guard stays a PURE function of (candidate, history, clock, policy).
   * Nothing here reads a database or a wall clock.
   */

  /**
   * Ceiling per rolling 60 minutes. THE GAP IT CLOSES: `dailyMax` alone made
   * six notifications inside four minutes legal, followed by silence for the
   * rest of the day — a burst and then a blackout, which is the exact shape of
   * the complaint an anti-fatigue guard exists to prevent. Undefined = no
   * hourly ceiling, precisely as before F6.
   */
  hourlyMax?: number;

  /**
   * Cooldown for a type with no entry in `cooldownMinutesByType`. Undefined =
   * no cooldown for unlisted types, which was the pre-F6 behaviour: the three
   * types Sprint 16 happened to name were the only ones with any cooldown at
   * all, so `REWARD_GRANTED` and every type added after it had none.
   */
  defaultCooldownMinutes?: number;

  /** The sliding duplicate window. Undefined = the five minutes this function
   * has always used, and which `NOTIFICATION_DEDUPE_WINDOW_MS` also states. */
  duplicateWindowMs?: number;
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
  /** PHASE F — `HOURLY_MAX` is the one new member, and it is added to the union
   * rather than folded into `DAILY_MAX` because `QuietHoursReleaseService`
   * writes this value straight into `notification_deliveries.resolution_reason`
   * and an operator reading «DAILY_MAX» about a household that received two
   * notifications would be reading a lie. `ResolutionReason` gained the same
   * member in the same commit. */
  blockedReason?: 'COOLDOWN' | 'DAILY_MAX' | 'HOURLY_MAX' | 'CATEGORY_MAX' | 'DUPLICATE' | 'QUIET_HOURS';
}

/**
 * The single decision point every candidate notification passes
 * through before being sent. now/currentLocalTime are passed in
 * explicitly (not read from Date.now() internally) — keeps this
 * function pure and deterministic, fully testable without faking the
 * system clock.
 *
 * B2 (PA-B-002), THE SERVER-LOCAL CLASS. `businessDayStart` is new and
 * REQUIRED, and its absence was a real defect of a DIFFERENT kind from the UTC
 * bugs elsewhere in this sprint.
 *
 * The daily and per-category caps used to bound "today" with
 * `new Date(now); todayStart.setHours(0, 0, 0, 0)`. `setHours` reads the
 * CONTAINER's timezone. `process.env.TZ` is unset in this image, so it happens
 * to equal UTC — today, on this host, by accident. Deploy the same image to a
 * host configured for `Africa/Cairo` and every family's daily cap silently
 * resets at a different moment, with no code change and no way to tell from the
 * code that it had happened. That is not a timezone bug, it is a behaviour that
 * has no definition.
 *
 * It is now a required parameter, computed by the caller from
 * `Family.timezone`, so the day a cap counts over is a stated fact rather than
 * an ambient property of the machine. It is required rather than defaulted for
 * the same reason: a default would be silently accepted by the next call site.
 */
export function evaluateFatigue(
  candidate: ICandidateNotification,
  recentHistory: IRecentNotification[],
  now: Date,
  currentLocalTimeHHMM: string,
  businessDayStart: Date,
  policy: IFatiguePolicy = DEFAULT_FATIGUE_POLICY,
): IFatigueDecision {
  // PHASE E (`PD-N-004`) — THE BYPASS IS DECIDED BY THE MATRIX, NOT BY
  // `priority`.
  //
  // This line read `candidate.priority !== 'CRITICAL'`, which is the implicit
  // rule Phase D's `notification-class.ts` was written to replace and whose
  // docstring explains why it is the wrong axis: priority describes how LOUD a
  // notification is, not whether the fact it carries survives the night. Left
  // in place it silently overrode the table — `SCREEN_TIME_EXCEEDED` is
  // classified DEFER with a written justification and is raised at CRITICAL
  // priority by its producer, so a screen-time limit went through at 02:00
  // BECAUSE of a field that was never meant to answer this question.
  //
  // `quietHoursClassOf` preserves the old rule exactly where nothing has
  // overridden it: an UNCLASSIFIED type at CRITICAL priority still resolves to
  // DELIVER, so every caller that predates the matrix behaves identically. What
  // changes is that an explicit classification now wins, which is the entire
  // reason the classification exists.
  //
  // Bypassing quiet hours still does NOT bypass duplicate prevention or
  // cooldown here — a genuine critical event firing twice in a minute from a
  // client retry is still a duplicate, not two real events. (The full
  // safety bypass, caps included, is applied one layer up in
  // `evaluateAndDeliver`, which never reaches this function for a DELIVER-class
  // type; the rule below is what protects a direct caller of this pure
  // function.)
  if (quietHoursClassOf(candidate.type, candidate.priority) !== 'DELIVER' && isWithinQuietHours(currentLocalTimeHHMM, policy)) {
    return { allowed: false, blockedReason: 'QUIET_HOURS' };
  }

  const todayHistory = recentHistory.filter((n) => n.createdAt >= businessDayStart);

  // Duplicate prevention: the exact same type sent within the last 5
  // minutes is treated as a duplicate (e.g. a retried request, a race
  // between two triggers), not a second real notification — tighter
  // than the per-type cooldown below, which governs normal repeat
  // frequency, not near-simultaneous duplicates.
  //
  // PHASE F — the five minutes is now the DEFAULT rather than the only value.
  // It stays exactly five minutes for every caller that does not configure it,
  // which is all of them today, and it stays deliberately equal to
  // `NOTIFICATION_DEDUPE_WINDOW_MS`'s bucket width so the product behaviour and
  // the database backstop keep agreeing.
  const DUPLICATE_WINDOW_MS = policy.duplicateWindowMs ?? 5 * 60 * 1000;
  const isDuplicate = recentHistory.some(
    (n) => n.type === candidate.type && now.getTime() - n.createdAt.getTime() < DUPLICATE_WINDOW_MS,
  );
  if (isDuplicate) {
    return { allowed: false, blockedReason: 'DUPLICATE' };
  }

  if (todayHistory.length >= policy.dailyMax) {
    return { allowed: false, blockedReason: 'DAILY_MAX' };
  }

  // PHASE F — THE HOURLY CEILING, and it is checked AFTER the daily one on
  // purpose: when a household is over both, «you have had six today» is the
  // more useful thing for an operator to read than «you have had three in the
  // last hour», and the reason is written into `resolution_reason`.
  //
  // A ROLLING sixty minutes, not a clock hour. A clock hour would let three
  // notifications at 10:58 be followed by three more at 11:01 — six in four
  // minutes, which is the exact burst this rule exists to prevent, arriving
  // legally through the rule meant to stop it.
  if (policy.hourlyMax !== undefined) {
    const hourAgo = now.getTime() - 60 * 60 * 1000;
    const lastHourCount = recentHistory.filter((n) => n.createdAt.getTime() >= hourAgo).length;
    if (lastHourCount >= policy.hourlyMax) {
      return { allowed: false, blockedReason: 'HOURLY_MAX' };
    }
  }

  const categoryCountToday = todayHistory.filter((n) => n.type === candidate.type).length;
  if (categoryCountToday >= policy.categoryDailyMax) {
    return { allowed: false, blockedReason: 'CATEGORY_MAX' };
  }

  // PHASE F — an unlisted type now falls back to `defaultCooldownMinutes` when
  // one is configured. Before this, `cooldownMinutesByType` named three types
  // and every other type in the product — `REWARD_GRANTED`, `BADGE_EARNED`,
  // every safety type — had NO cooldown whatsoever; the daily and category caps
  // were the only thing between a misbehaving producer and a stream. Still
  // `undefined` when nobody configured it, so pre-F6 behaviour is unchanged.
  const cooldownMinutes = policy.cooldownMinutesByType[candidate.type] ?? policy.defaultCooldownMinutes;
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
 * window crosses midnight.
 *
 * B2: this logic was always right. What was wrong was `currentHHMM`, which the
 * caller built from `now.getHours()` — the container's clock. With the default
 * 21:00-07:00 policy evaluated against UTC, a Cairo family's quiet hours ran
 * 00:00-10:00 LOCAL in summer: notifications silenced all morning and fully
 * permitted in the three hours before local midnight. Inverted precisely at the
 * boundary the feature exists to protect. */
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
