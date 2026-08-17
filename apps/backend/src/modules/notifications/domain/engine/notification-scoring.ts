/**
 * PHASE F (`F6-002`) — THE SCORE, AND THE ARGUMENT THAT IT IS NOT A BLACK BOX.
 *
 * WHAT WAS THERE. Three `if` statements. `screenMinutesLast90 >= 90 &&
 * hydrationRatio < 0.5` produced a hydration nudge; two more produced a study
 * nudge and an exercise nudge; everything else in the product produced a
 * notification by calling `notifyEvent` directly with a `priority` string it
 * chose itself. There was no ranking, no comparison between two candidates, and
 * no answer to «why this one and not that one».
 *
 * WHY A WEIGHTED SUM AND NOT A MODEL. CONTEXT §3 principle 2 (AI ADVISORY
 * FIRST) and the brief are the same sentence: the decision of WHETHER to notify
 * is deterministic. A weighted sum has the property a household actually needs
 * — a human can read the row and reconstruct the arithmetic — and an
 * `AiNotificationDecisionProvider` can replace this whole file later WITHOUT
 * the rest of the pipeline noticing, because it returns the same
 * `NotificationDecision` shape with the same `components` array. That is what
 * the provider port is for; this is the deterministic implementation of it.
 *
 * THE FORMULA, once, in words:
 *
 *   score = urgency + relevance + achievementValue + deadlineProximity
 *           + parentPreference
 *           − fatiguePenalty − duplicatePenalty − quietHoursPenalty
 *
 * Each term is a 0..1 reading of the context multiplied by a weight from
 * `NotificationScoringConfig` (which is per-family configuration, not a
 * constant). The sum is clamped to 0..100 and banded. Every term is emitted as
 * a `NotificationScoreComponent` carrying its raw reading, its weight, its
 * contribution AND an English `note` naming the fact that produced it — so the
 * persisted explanation is readable without this source file open.
 *
 * PURE. No clock, no I/O, no `Date.now()`. `context.now` is the only instant.
 */

import { quietHoursClassOf } from '../../../../shared/notifications/notification-class';
import type { NotificationContext } from './notification-context';
import type { NotificationPolicy, NotificationScoringConfig } from './notification-policy';
import {
  NOTIFICATION_PENALTY_COMPONENTS,
  type NotificationPriorityBand,
  type NotificationScore,
  type NotificationScoreComponent,
  type NotificationScoreComponentName,
} from './notification-decision.types';

/**
 * URGENCY per notification type. The one place «how time-sensitive is this
 * kind of thing, before we look at the data» is written down.
 *
 * A TABLE, not a predicate over `priority`, for exactly the reason
 * `notification-class.ts` gives about its own table: `priority` is what a
 * producer asserted about its own message, and a producer that raises
 * everything to CRITICAL should not thereby win the ranking. Types not listed
 * fall to `DEFAULT_URGENCY`, which is the middle rather than the top.
 */
const URGENCY_BY_TYPE: Readonly<Record<string, number>> = Object.freeze({
  // Safety: the only 1.0s in the product, and they are the DELIVER class.
  ACCESSIBILITY_DISABLED: 1,
  PROTECTION_BYPASS_ATTEMPT: 1,
  CHILD_WELLBEING_CHECKIN: 1,
  // Time-bounded but not safety.
  CHILD_REQUEST: 0.7,
  SCREEN_TIME_EXCEEDED: 0.5,
  POLICY_VIOLATION: 0.5,
  PAYMENT_FAILED: 0.5,
  SUBSCRIPTION_EXPIRING: 0.3,
  // Facts, not moments — they survive the night by construction, which is
  // precisely why `notification-class.ts` defers rather than suppresses them.
  REWARD_GRANTED: 0.4,
  BADGE_EARNED: 0.35,
  LEVEL_UP: 0.35,
  STREAK_ACHIEVED: 0.35,
  DAILY_GOAL_COMPLETED: 0.35,
  LEARNING_GOAL_ACHIEVED: 0.35,
  ACHIEVEMENT_VERIFIED: 0.4,
  ACHIEVEMENT_REJECTED: 0.4,
  // Moments. High urgency and LOW durability at the same time — the pair of
  // properties that makes them SUPPRESS-class overnight rather than DEFER.
  HYDRATION_REMINDER: 0.5,
  STUDY_REMINDER: 0.55,
  EXERCISE_ENCOURAGEMENT: 0.3,
});

const DEFAULT_URGENCY = 0.4;

/**
 * INTRINSIC ACHIEVEMENT VALUE per type, and this table exists because leaving it
 * out was a MEASURED defect rather than a hypothetical one.
 *
 * The first draft scored `ACHIEVEMENT_VALUE` only from an attached reward or a
 * completed goal, so `BADGE_EARNED` — a permanent fact about a child, and one
 * `notification-class.ts` argues in writing must never be lost — contributed
 * ZERO on that axis and fell under the floor as soon as the household had ONE
 * other notification that day. `smart-notification-engine.e2e.spec.ts` caught it
 * on the multi-channel case: a badge earned an hour after a reward was
 * suppressed with `SCORE_BELOW_FLOOR`.
 *
 * The lesson is the one `notification-class.ts` states about its own table: a
 * notification's worth is a property of WHAT HAPPENED, and the payload a
 * producer happens to attach is evidence, not the fact. A type that names an
 * achievement HAS achievement value whether or not anyone passed a coin count.
 */
const ACHIEVEMENT_BASELINE_BY_TYPE: Readonly<Record<string, number>> = Object.freeze({
  BADGE_EARNED: 0.75,
  LEVEL_UP: 0.75,
  STREAK_ACHIEVED: 0.7,
  ACHIEVEMENT_VERIFIED: 0.7,
  ACHIEVEMENT_REJECTED: 0.6,
  LEARNING_GOAL_ACHIEVED: 0.7,
  DAILY_GOAL_COMPLETED: 0.6,
  REWARD_GRANTED: 0.5,
});

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function component(
  name: NotificationScoreComponentName,
  raw: number,
  weight: number,
  note: string,
): NotificationScoreComponent {
  const bounded = clamp01(raw);
  const magnitude = Math.round(bounded * weight * 100) / 100;
  // `magnitude === 0 ? 0` rather than `-magnitude`, because `-0` is a real
  // JavaScript value that survives into a JSONB column and reads as a negative
  // contribution of nothing. An explanation a human squints at is an
  // explanation that has failed at its one job.
  const signed =
    NOTIFICATION_PENALTY_COMPONENTS.has(name) && magnitude !== 0 ? -magnitude : magnitude;
  return {
    name,
    raw: Math.round(bounded * 1000) / 1000,
    weight,
    contribution: signed,
    note,
  };
}

/** URGENCY — how time-sensitive, from the type table plus a streak that is
 * actually about to break. */
function urgency(context: NotificationContext, cfg: NotificationScoringConfig): NotificationScoreComponent {
  const base = URGENCY_BY_TYPE[context.event.eventType] ?? DEFAULT_URGENCY;
  const streak = context.streak;
  if (streak?.atRisk && streak.hoursUntilBreak !== null) {
    // A streak with two hours left is more urgent than one with ten. Linear
    // over a twelve-hour horizon, which is the longest lead time on which
    // «tonight» is still a meaningful word.
    const proximity = clamp01((12 - streak.hoursUntilBreak) / 12);
    const raised = Math.max(base, 0.4 + 0.6 * proximity);
    return component(
      'URGENCY',
      raised,
      cfg.weightUrgency,
      `streak of ${streak.days} days breaks in ${streak.hoursUntilBreak}h`,
    );
  }
  return component('URGENCY', base, cfg.weightUrgency, `type baseline for ${context.event.eventType}`);
}

/**
 * RELEVANCE — is this the right moment for THIS child.
 *
 * Three readings, averaged: is the child engaged right now, has the child done
 * anything today, and has this child heard from us recently about anything at
 * all. A nudge to a child who is present and mid-effort is relevant; the same
 * nudge to a child who has not opened the app in nine hours is a poke.
 */
function relevance(context: NotificationContext, cfg: NotificationScoringConfig): NotificationScoreComponent {
  const engaged = context.recentActivity.isEngagedNow ? 1 : 0.35;
  const idleMinutes = context.recentActivity.minutesSinceLastActivity;
  // `null` = no activity at all today. That is a REAL reading (0.2), not a
  // missing one — an honest absence, never a guessed midpoint.
  const recency = idleMinutes === null ? 0.2 : clamp01(1 - idleMinutes / 240);
  const progress = context.recentActivity.completionsToday > 0 ? 1 : 0.5;
  const raw = (engaged + recency + progress) / 3;
  return component(
    'RELEVANCE',
    raw,
    cfg.weightRelevance,
    `engaged=${context.recentActivity.isEngagedNow} idleMin=${idleMinutes ?? 'none'} completions=${context.recentActivity.completionsToday}`,
  );
}

/**
 * ACHIEVEMENT_VALUE — is there something real to celebrate.
 *
 * A milestone outranks a routine grant, and a large grant outranks a small one,
 * but the curve is logarithmic: 200 coins is not forty times more worth
 * interrupting a parent for than 5 coins.
 */
function achievement(context: NotificationContext, cfg: NotificationScoringConfig): NotificationScoreComponent {
  // The type's own worth, before any payload is considered. Zero for a
  // reminder, which is correct: «drink water» celebrates nothing.
  const baseline = ACHIEVEMENT_BASELINE_BY_TYPE[context.event.eventType] ?? 0;
  const reward = context.reward;

  if (!reward) {
    const goal = context.goal;
    if (goal && goal.totalUnits > 0 && goal.completedUnits >= goal.totalUnits) {
      return component(
        'ACHIEVEMENT_VALUE',
        Math.max(baseline, 0.8),
        cfg.weightAchievement,
        `goal "${goal.title}" completed`,
      );
    }
    return component(
      'ACHIEVEMENT_VALUE',
      baseline,
      cfg.weightAchievement,
      baseline > 0
        ? `type baseline for ${context.event.eventType}`
        : 'no reward or completion attached',
    );
  }

  const magnitude = clamp01(Math.log10(Math.max(1, reward.amount) + 1) / 2.5);
  const raw = reward.isMilestone ? Math.max(0.85, magnitude) : Math.max(baseline, magnitude);
  return component(
    'ACHIEVEMENT_VALUE',
    raw,
    cfg.weightAchievement,
    `${reward.kind} amount=${reward.amount} milestone=${reward.isMilestone}`,
  );
}

/**
 * DEADLINE_PROXIMITY — the «باقي لك ٥ دقائق» term.
 *
 * Zero when there is no deadline, which is the honest reading and NOT a
 * midpoint: a goal with no deadline is not half-urgent. Full weight inside the
 * last fifteen minutes, decaying linearly over two hours, and zero past the
 * deadline — a notification about a window that has already closed is the
 * `HYDRATION_REMINDER` mistake in a different costume.
 */
function deadline(context: NotificationContext, cfg: NotificationScoringConfig): NotificationScoreComponent {
  const minutes = context.goal?.minutesRemaining ?? null;
  if (minutes === null) {
    return component('DEADLINE_PROXIMITY', 0, cfg.weightDeadline, 'no deadline on this goal');
  }
  if (minutes <= 0) {
    return component('DEADLINE_PROXIMITY', 0, cfg.weightDeadline, 'deadline already passed');
  }
  const raw = minutes <= 15 ? 1 : clamp01((120 - minutes) / 105);
  return component('DEADLINE_PROXIMITY', raw, cfg.weightDeadline, `${minutes} minutes remaining`);
}

/**
 * PARENT_PREFERENCE — what the household asked for.
 *
 * A switched-OFF category never reaches this function (the provider refuses it
 * with `POLICY_PARENT_PREFERENCE_OFF` before scoring), so this term expresses
 * the softer signal: how much this household has said it wants to hear, and
 * whether it has explicitly kept THIS category on.
 */
function preference(context: NotificationContext, cfg: NotificationScoringConfig, category: string): NotificationScoreComponent {
  const explicit = context.preferences.parentCategories[category];
  const appetite = clamp01(context.preferences.parentAppetite);
  const raw = explicit === true ? Math.max(0.8, appetite) : appetite;
  return component(
    'PARENT_PREFERENCE',
    raw,
    cfg.weightParentPreference,
    `appetite=${appetite} explicit=${explicit === undefined ? 'default' : String(explicit)}`,
  );
}

/**
 * FATIGUE_PENALTY — how close this household already is to its own caps.
 *
 * NOT a second fatigue guard, and the distinction matters: `evaluateFatigue`
 * decides REFUSAL and runs after this, in the pipeline. This term makes a
 * marginal notification lose to a strong one when the household has already had
 * four today — which is a ranking question the guard, being a boolean, cannot
 * answer.
 */
function fatigue(
  context: NotificationContext,
  policy: NotificationPolicy,
  category: string,
): NotificationScoreComponent {
  const dayStartMs = context.now.getTime() - 24 * 60 * 60 * 1000;
  const today = context.recentNotifications.filter((n) => n.createdAt.getTime() >= dayStartMs);
  const hourAgo = context.now.getTime() - 60 * 60 * 1000;
  const lastHour = today.filter((n) => n.createdAt.getTime() >= hourAgo).length;
  const sameCategory = today.filter((n) => n.category === category).length;

  const dayLoad = clamp01(today.length / Math.max(1, policy.maxPerDay));
  const hourLoad = clamp01(lastHour / Math.max(1, policy.maxPerHour));
  const categoryLoad = clamp01(sameCategory / Math.max(1, policy.categoryMaxPerDay));
  const raw = Math.max(dayLoad, hourLoad, categoryLoad);

  return component(
    'FATIGUE_PENALTY',
    raw,
    policy.scoring.penaltyFatigue,
    `today=${today.length}/${policy.maxPerDay} hour=${lastHour}/${policy.maxPerHour} category=${sameCategory}/${policy.categoryMaxPerDay}`,
  );
}

/**
 * DUPLICATE_PENALTY — have we said this exact thing recently.
 *
 * Deliberately the HEAVIEST penalty (40 by default, against a 100-point scale):
 * a duplicate is not a low-value notification, it is a wrong one. The database
 * still has the final word — `notifications (family_id, source_event_id,
 * user_id)` refuses a redelivered cause no matter what this term says — but a
 * score that ignored repetition would rank a repeat as highly as the original
 * and put the explanation at odds with the outcome.
 */
function duplicate(context: NotificationContext, policy: NotificationPolicy): NotificationScoreComponent {
  const windowMs = policy.duplicateWindowMinutes * 60_000;
  const type = context.event.eventType;
  const recentSame = context.recentNotifications.filter(
    (n) => n.type === type && context.now.getTime() - n.createdAt.getTime() < windowMs,
  );
  if (recentSame.length > 0) {
    return component('DUPLICATE_PENALTY', 1, policy.scoring.penaltyDuplicate, `same type within ${policy.duplicateWindowMinutes}m`);
  }
  // Outside the hard window but inside the cooldown: a softer penalty, so a
  // type that repeats legitimately (a second reward on a busy afternoon) is
  // ranked below a first one without being refused.
  const cooldownMinutes = policy.cooldownMinutesByType[type] ?? policy.defaultCooldownMinutes;
  const cooldownMs = cooldownMinutes * 60_000;
  const inCooldown = context.recentNotifications.some(
    (n) => n.type === type && context.now.getTime() - n.createdAt.getTime() < cooldownMs,
  );
  return component(
    'DUPLICATE_PENALTY',
    inCooldown ? 0.5 : 0,
    policy.scoring.penaltyDuplicate,
    inCooldown ? `same type within ${cooldownMinutes}m cooldown` : 'no recent notification of this type',
  );
}

/**
 * QUIET_HOURS_PENALTY — and it is a PENALTY, not a veto.
 *
 * The veto lives in `notification-class.ts` + `evaluateFatigue` and produces
 * DEFER; this term expresses that a notification arriving into a quiet window
 * is worth less than the same notification at 17:00, so that a marginal one
 * falls below the floor and is dropped with a reason instead of queuing up for
 * a 07:00 flood. A DELIVER-class type takes NO penalty — a safety alert is not
 * worth less at 02:00, it is worth more, and this is the one place that has to
 * be stated rather than assumed.
 */
function quietHours(context: NotificationContext, cfg: NotificationScoringConfig): NotificationScoreComponent {
  if (!context.quietHours.isActiveNow) {
    return component('QUIET_HOURS_PENALTY', 0, cfg.penaltyQuietHours, 'outside quiet hours');
  }
  const klass = quietHoursClassOf(context.event.eventType);
  if (klass === 'DELIVER') {
    return component('QUIET_HOURS_PENALTY', 0, cfg.penaltyQuietHours, 'DELIVER class — safety bypasses quiet hours');
  }
  return component(
    'QUIET_HOURS_PENALTY',
    1,
    cfg.penaltyQuietHours,
    `quiet hours ${context.quietHours.startHHMM}-${context.quietHours.endHHMM} local=${context.quietHours.localTimeHHMM}`,
  );
}

export function bandForScore(total: number, cfg: NotificationScoringConfig): NotificationPriorityBand {
  if (total >= cfg.thresholdHigh) return 'HIGH';
  if (total >= cfg.thresholdMedium) return 'MEDIUM';
  if (total >= cfg.thresholdLow) return 'LOW';
  return 'SUPPRESS';
}

/**
 * THE SCORER. Pure, total, and it returns its own arithmetic.
 *
 * `category` is passed in rather than re-derived so that the fatigue and
 * preference terms count against the SAME category the cap and the copy use —
 * there is one category vocabulary (`notification-class.ts`) and this function
 * does not get a private opinion about it.
 */
export function scoreNotification(
  context: NotificationContext,
  policy: NotificationPolicy,
  category: string,
): NotificationScore {
  const cfg = policy.scoring;
  const components: readonly NotificationScoreComponent[] = [
    urgency(context, cfg),
    relevance(context, cfg),
    achievement(context, cfg),
    deadline(context, cfg),
    preference(context, cfg, category),
    fatigue(context, policy, category),
    duplicate(context, policy),
    quietHours(context, cfg),
  ];

  const raw = components.reduce((sum, c) => sum + c.contribution, 0);
  const total = Math.max(0, Math.min(100, Math.round(raw)));

  return { total, band: bandForScore(total, cfg), components };
}

/**
 * THE HUMAN-READABLE FORM, and it is deliberately ENGLISH and deliberately one
 * line per component.
 *
 * A support engineer reading a decision row should not have to open this file
 * to know why. This is what `notification_decisions.explanation` renders to in
 * the admin surface, and `notification-scoring.spec.ts` asserts that the printed
 * numbers actually add up to the stored total — an explanation that does not
 * reconcile is worse than none, because it is trusted.
 */
export function explainScore(score: NotificationScore): string {
  const lines = score.components.map(
    (c) =>
      `${c.name}: raw=${c.raw} × weight=${c.weight} => ${c.contribution >= 0 ? '+' : ''}${c.contribution} (${c.note})`,
  );
  lines.push(`TOTAL: ${score.total} => band ${score.band}`);
  return lines.join('\n');
}
