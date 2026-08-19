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

import { getStartOfBusinessDay } from '../../../../common/time/family-date';
import { quietHoursClassOf } from '../../../../shared/notifications/notification-class';
import { forAudience } from '../../../../shared/notifications/notification-source-key';
import type { NotificationContext, RecentNotificationFact } from './notification-context';
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
export const URGENCY_BY_TYPE: Readonly<Record<string, number>> = Object.freeze({
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
  // PHASE F (`PF-E-003`) — the parent-facing goal types, and the reward the
  // CHILD is told about. Each of these was a copy key with no row in this
  // table, which meant `DEFAULT_URGENCY` and a measured suppression; see
  // `ACHIEVEMENT_BASELINE_BY_TYPE` below for the half that actually sank them.
  // The parent's «your child finished a goal» is the same fact as the child's
  // own DAILY_GOAL_COMPLETED and carries the same urgency; the stalled one is
  // lower because a nudge has all of tomorrow to be useful.
  GOAL_COMPLETED_PARENT: 0.35,
  GOAL_STALLED_PARENT: 0.25,
  REWARD_GRANTED_CHILD: 0.4,
  BADGE_EARNED_PARENT: 0.35,
  // Moments. High urgency and LOW durability at the same time — the pair of
  // properties that makes them SUPPRESS-class overnight rather than DEFER.
  HYDRATION_REMINDER: 0.5,
  STUDY_REMINDER: 0.55,
  EXERCISE_ENCOURAGEMENT: 0.3,
  QUIET_HOURS_DIGEST: 0.4,
  // Classified in `notification-class.ts` ahead of their producers; listed here
  // for the same reason it lists them — so the number is chosen by the person
  // who understands the type rather than by the default, on the day the
  // producer ships.
  RUNTIME_ALERT: 0.4,
  SUBSCRIPTION_EXPIRED: 0.4,
  PAYMENT_SUCCEEDED: 0.15,
  AI_RECOMMENDATION: 0.25,
  FAMILY_INSIGHT: 0.2,
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
export const ACHIEVEMENT_BASELINE_BY_TYPE: Readonly<Record<string, number>> = Object.freeze({
  BADGE_EARNED: 0.75,
  LEVEL_UP: 0.75,
  STREAK_ACHIEVED: 0.7,
  ACHIEVEMENT_VERIFIED: 0.7,
  ACHIEVEMENT_REJECTED: 0.6,
  LEARNING_GOAL_ACHIEVED: 0.7,
  DAILY_GOAL_COMPLETED: 0.6,
  REWARD_GRANTED: 0.5,
  /**
   * PHASE F (`PF-E-003`) — THE ROW WHOSE ABSENCE WAS THE DEFECT, AND THE SECOND
   * TIME THIS TABLE HAS BEEN INCOMPLETE IN EXACTLY THE SAME WAY.
   *
   * The docstring above already tells the BADGE_EARNED version of this story:
   * a type that NAMES an achievement scored zero on the achievement axis
   * because no payload happened to be attached, and fell under the floor. The
   * golden suite then measured the identical shape on the parent side —
   * `GOAL_COMPLETED_PARENT` composed correctly, scored ≈23 against a floor of
   * 25, and was suppressed every single time. A parent who is never told their
   * child completed a goal is the product loop failing silently.
   *
   * The value is the CHILD's own `DAILY_GOAL_COMPLETED` baseline, deliberately:
   * «a child completed a goal» is one fact with one worth, and letting the two
   * audiences disagree about it would mean the axis measures the recipient
   * rather than the achievement. The stalled variant is lower but NOT zero —
   * it is still news about the child's day, and zero is what this table has
   * twice been wrong by.
   */
  GOAL_COMPLETED_PARENT: 0.6,
  GOAL_STALLED_PARENT: 0.3,
  REWARD_GRANTED_CHILD: 0.5,
  BADGE_EARNED_PARENT: 0.75,
  /**
   * EXPLICIT ZEROS, and they are the point of the guard test rather than an
   * oversight it tolerates. «Drink water» celebrates nothing and «protection is
   * off» is not a celebration either; writing the zero down is how
   * `notification-scoring-coverage.spec.ts` can tell a considered zero from a
   * missing row, which is the exact distinction `PF-E-003` turned on.
   */
  HYDRATION_REMINDER: 0,
  STUDY_REMINDER: 0,
  EXERCISE_ENCOURAGEMENT: 0,
  ACCESSIBILITY_DISABLED: 0,
  PROTECTION_BYPASS_ATTEMPT: 0,
  CHILD_WELLBEING_CHECKIN: 0,
  POLICY_VIOLATION: 0,
  SCREEN_TIME_EXCEEDED: 0,
  CHILD_REQUEST: 0,
  RUNTIME_ALERT: 0,
  QUIET_HOURS_DIGEST: 0,
  SUBSCRIPTION_EXPIRING: 0,
  SUBSCRIPTION_EXPIRED: 0,
  PAYMENT_FAILED: 0,
  PAYMENT_SUCCEEDED: 0,
  AI_RECOMMENDATION: 0,
  FAMILY_INSIGHT: 0,
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
 *
 * ==========================================================================
 * «TODAY» IS THE FAMILY'S OWN DAY, NOT A ROLLING TWENTY-FOUR HOURS.
 * ==========================================================================
 *
 * WHAT WAS THERE: `const dayStartMs = context.now.getTime() - 24*60*60*1000`,
 * and a `note` that called the result `today=n/6`. It was not today. It was a
 * SLIDING WINDOW that never resets, and the difference is the entire product
 * meaning of a daily budget: a household at its maximum at 20:00 was still at
 * its maximum at 09:00 the next morning, because the window had dragged the
 * previous evening along with it. `child-signal-producer.e2e.spec.ts` §5 names
 * the case in its own title — «the NEXT family-local day is a different cause,
 * and is told again» — and asks for it at a `now` LESS than 24 hours after the
 * day-1 notification, which is precisely the interval a rolling window gets
 * wrong and a real day gets right.
 *
 * IT WAS ALSO UNDEFINED RATHER THAN MERELY WRONG, in the same way
 * `evaluateFatigue`'s `setHours(0,0,0,0)` was before `businessDayStart` became
 * a REQUIRED parameter of it: nothing in the arithmetic named a calendar, so
 * the answer belonged to no household in particular. `notification-context.ts`
 * has documented `timeZone` as «every calendar question — quiet hours, THE
 * DAILY CAP'S DAY BOUNDARY, a deadline in local time» since the field existed;
 * this term simply did not read it.
 *
 * THE BOUNDARY IS THE FAMILY'S LOCAL MIDNIGHT, from the family's own timezone —
 * resolved ONCE, from `families.timezone`, by `FamilyDateService.timeZoneOf`
 * (the one reader of that column) and carried on `context.timeZone`.
 * `getStartOfBusinessDay` is the exact primitive `FamilyDateService.getStartOfBusinessDay`
 * delegates to, and it is the same call `SmartNotificationEngineService` makes
 * to feed `evaluateFatigue`'s `businessDayStart` — so the term that RANKS and
 * the guard that REFUSES now count over the same day. It is imported as the
 * pure function rather than as the injectable because `domain/engine` is
 * framework-free by construction and a scoring function that reached for a
 * Nest provider (and through it a database) would stop being reproducible from
 * the row it was computed for.
 *
 * STILL PURE. `context.now` remains the only instant; no clock is read here.
 *
 * THE HOURLY WINDOW STAYS ROLLING, deliberately: «how loud have the last sixty
 * minutes been» is a question about an elapsed hour, not about a calendar, and
 * a clock-hour bucket would make 13:59 and 14:01 answer differently for no
 * reason a household could perceive.
 */
function fatigue(
  context: NotificationContext,
  policy: NotificationPolicy,
  category: string,
): NotificationScoreComponent {
  const dayStartMs = getStartOfBusinessDay(context.now, context.timeZone).getTime();
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

  /**
   * ==========================================================================
   * «THIS EXACT THING» IS A CAUSE, NOT A TYPE — and the difference became
   * measurable the moment the history stopped being the wrong audience's.
   * ==========================================================================
   *
   * This function's own paragraph above already names what makes a
   * notification the same notification: `source_event_id`, the key the two
   * unique indexes are built on. The implementation used the TYPE as a proxy
   * for it, which was harmless only for as long as a CHILD candidate was being
   * compared against the PARENT's inbox — where a child type never appears, so
   * this term read zero for every child notification the product has ever
   * produced.
   *
   * With the history audience-scoped, the proxy started answering. And it
   * answered wrongly, measured against real PostgreSQL: a child who crossed
   * their hydration goal and their activity goal in one afternoon produced two
   * `DAILY_GOAL_COMPLETED` candidates with two different causes, and the
   * second took −40 for being «the same type within 5m» — «أكملت هدف شرب
   * الماء» and «أكملت هدف النشاط البدني» declared duplicates of each other,
   * scored 0, and the child was told about one of the two things they did.
   *
   * THE COMPARISON IS THEREFORE ON IDENTITY, in the audience's own key space:
   * `forAudience` composes the candidate's key exactly as `deliverNow`
   * composed the stored one, facet and clamp included, so the two strings are
   * the output of one function rather than of two conventions.
   *
   * A HISTORY ROW WITH NO KEY FALLS BACK TO THE TYPE PROXY. «Unknown identity»
   * is not «different cause», and a fact assembled without a key must not be
   * able to turn a genuine redelivery into a free notification.
   *
   * VOLUME IS NOT THIS TERM'S QUESTION. A type that legitimately repeats — a
   * second reward on a busy afternoon — is ranked down by FATIGUE_PENALTY,
   * which counts exactly that and counts it on three axes. Charging the same
   * repetition twice, once as fatigue and once as duplication, is how a
   * correct second notification comes to score below a floor.
   */
  const candidateKey = forAudience(context.event.sourceEventId, context.targetAudience);
  const isSameCause = (fact: RecentNotificationFact): boolean =>
    fact.type === type &&
    (fact.sourceEventId === undefined || fact.sourceEventId === null
      ? true
      : fact.sourceEventId === candidateKey);

  const recentSame = context.recentNotifications.filter(
    (n) => isSameCause(n) && context.now.getTime() - n.createdAt.getTime() < windowMs,
  );
  if (recentSame.length > 0) {
    return component('DUPLICATE_PENALTY', 1, policy.scoring.penaltyDuplicate, `same type within ${policy.duplicateWindowMinutes}m`);
  }
  // Outside the hard window but inside the cooldown: a softer penalty, so the
  // SAME cause reaching the door twice in half an hour — a retried outbox
  // message, a producer firing on both a scan and an event — is ranked below a
  // first one without being refused.
  const cooldownMinutes = policy.cooldownMinutesByType[type] ?? policy.defaultCooldownMinutes;
  const cooldownMs = cooldownMinutes * 60_000;
  const inCooldown = context.recentNotifications.some(
    (n) => isSameCause(n) && context.now.getTime() - n.createdAt.getTime() < cooldownMs,
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
