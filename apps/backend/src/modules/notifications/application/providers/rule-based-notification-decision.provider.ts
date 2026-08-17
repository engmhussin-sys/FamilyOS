/**
 * PHASE F (`F6-002`) — THE ONLY IMPLEMENTATION OF THE SEAM, AND IT IS
 * DETERMINISTIC.
 *
 * NO ML IS BUILT HERE and none is planned by this phase. CONTEXT §3 principle 2
 * and §5's own event path both put a rules engine at this position; the AI's
 * place in this pipeline is one step later and it is rephrasing, not deciding.
 *
 * WHAT THIS CLASS DOES, in order, and every step is reported in the returned
 * decision rather than logged and forgotten:
 *
 *   1. RESOLVE the notification type and its category from
 *      `notification-class.ts` — the existing matrix, not a second one.
 *   2. REFUSE, with a named reason, when a policy switch says so: a suppressed
 *      category, a parent preference off, a child preference off, a subscription
 *      tier that excludes the category. These are refusals a HUMAN configured
 *      and they are checked before any arithmetic, because scoring a
 *      notification the household has switched off would be arithmetic about
 *      nothing.
 *   3. OVERRIDE, with a named reason, for the DELIVER class. A safety alert is
 *      not scored against a fatigue penalty; `notification-class.ts` already
 *      argued that in prose and this is the same sentence as control flow.
 *   4. SCORE — `scoreNotification`, pure, returning its own arithmetic.
 *   5. BAND and VERDICT. SUPPRESS below the floor; DEFER when the quiet-hours
 *      matrix says the fact survives the night; SEND otherwise.
 *   6. CHOOSE THE COPY KEY, which is the one place a «smarter» provider would
 *      differ most visibly, and which is why it is part of the port's return
 *      value rather than a lookup the composer does on its own.
 *
 * A NOTE ON WHAT «DEFER» MEANS HERE. This provider returning DEFER does NOT
 * enqueue anything and does not stop the pipeline. The actual deferral — the
 * `notification_deliveries` row, the family-local `scheduled_for`, the release
 * — is `SmartNotificationIntegrationService`'s, unchanged, and the candidate is
 * handed to it exactly as a SEND is. The verdict is the engine's OPINION,
 * recorded so that a disagreement between opinion and outcome is visible; it is
 * not a second execution path. That is what «no second engine» means here.
 *
 * `@Injectable()` but stateless and side-effect free: every method is a pure
 * function of its arguments. It is a Nest provider only so it can be the thing
 * behind the token.
 */

import { Injectable } from '@nestjs/common';

import {
  notificationCategoryOf,
  quietHoursClassOf,
} from '../../../../shared/notifications/notification-class';
import type {
  NotificationDecisionOutput,
  NotificationDecisionProvider,
} from '../ports/notification-decision.provider';
import type { NotificationContext } from '../../domain/engine/notification-context';
import {
  priorityForBand,
  type NotificationDecision,
  type NotificationDecisionReason,
  type NotificationDecisionVerdict,
  type NotificationPriorityBand,
  type NotificationScore,
} from '../../domain/engine/notification-decision.types';
import type { NotificationPolicy } from '../../domain/engine/notification-policy';
import { COPY_CATALOGUE, GENERIC_COPY_KEY, ordinal } from '../../domain/engine/notification-copy';
import { bandForScore, scoreNotification } from '../../domain/engine/notification-scoring';

/**
 * Categories a FREE household does not receive. Deliberately EMPTY today and
 * deliberately present: the product has not decided which notification
 * categories are a paid capability (it is an open question in the Phase F
 * report), and the honest expression of «not decided» is an empty list with a
 * working mechanism, not a missing mechanism that a later commit has to invent
 * under time pressure. SAFETY could never be in it — see
 * `UNSUPPRESSABLE_CATEGORIES`.
 */
const PAID_ONLY_CATEGORIES: ReadonlySet<string> = new Set<string>();

/**
 * THE COPY-KEY RULES, as data.
 *
 * The point of this table is the brief's «make the copy data-driven so a new
 * category needs no engine change»: adding a sentence means adding a row to
 * `COPY_CATALOGUE` and, at most, a line here. It is ordered — the first
 * matching rule wins — because «the goal is nearly done AND its deadline is
 * close» has one best sentence, not two.
 */
interface CopyRule {
  readonly key: string;
  /**
   * WHO THIS RULE IS FOR, and it used to be implicit. Every rule in the first
   * version of this table was child-facing and `copyFor` hard-coded
   * `if (audience === 'CHILD')` around the loop — so the mechanism the file's
   * own docstring calls «the one place a smarter provider would differ most
   * visibly» was, in fact, unavailable to half the product's audiences. The
   * audience is now a property of the rule, which is what lets a PARENT rule
   * exist without a second loop being written beside the first.
   */
  readonly audience: 'PARENT' | 'CHILD';
  /**
   * `variables` is the MERGED set — the producer's, plus everything `copyFor`
   * derives from the context — because a rule that could only see the context
   * could not ask «did the producer supply a goal title?», which is precisely
   * the question the reward rule below has to ask.
   */
  readonly when: (c: NotificationContext, variables: Readonly<Record<string, string | number>>) => boolean;
}

/** A variable is USABLE in a sentence when it is present and would not render
 * as an empty hole. Mirrors `substitute`'s own «undefined / null / empty means
 * leave the placeholder alone» rule, so a rule can never select a template the
 * renderer will then reject as leaking. */
const usable = (value: string | number | undefined): boolean =>
  typeof value === 'number' ? Number.isFinite(value) : typeof value === 'string' && value.trim().length > 0;

const COPY_RULES: readonly CopyRule[] = Object.freeze([
  {
    key: 'GOAL_DEADLINE_NEAR',
    audience: 'CHILD',
    when: (c) =>
      c.goal !== null &&
      c.goal.minutesRemaining !== null &&
      c.goal.minutesRemaining > 0 &&
      c.goal.minutesRemaining <= 30 &&
      c.goal.completedUnits < c.goal.totalUnits,
  },
  {
    key: 'GOAL_ALMOST_DONE',
    audience: 'CHILD',
    when: (c) =>
      c.goal !== null &&
      c.goal.totalUnits > 0 &&
      c.goal.completedUnits > 0 &&
      c.goal.totalUnits - c.goal.completedUnits === 1,
  },
  {
    key: 'STREAK_AT_RISK',
    audience: 'CHILD',
    when: (c) => c.streak !== null && c.streak.atRisk && c.streak.days > 0,
  },
  /**
   * THE PARENT'S REWARD SENTENCE, WHEN THE CAUSE IS A GOAL THEY THEMSELVES SET.
   *
   * `COPY_CATALOGUE.REWARD_GRANTED_WITH_GOAL` carries the full argument for why
   * this is a sibling key rather than a re-use of `GOAL_COMPLETED_PARENT`. What
   * belongs HERE is why it is a RULE and not a branch inside the producer: the
   * producer states the EVENT (`REWARD_GRANTED`) and the FACTS it holds; which
   * sentence those facts deserve is this provider's decision, recorded on
   * `notification_decisions.copy_key` so that «why did the parent read that?»
   * has an answer in a row.
   *
   * BOTH VARIABLES ARE REQUIRED, and that is the whole safety property. A
   * producer that has the goal but not the points — or a reward whose rules paid
   * in coins only — falls through to `REWARD_GRANTED`, a complete sentence, and
   * NEVER to a half-filled template or to `GENERIC`. `points > 0` rather than
   * merely present, because «وحصل على ٠ نقطة» is a worse sentence than not
   * mentioning points at all.
   */
  {
    key: 'REWARD_GRANTED_WITH_GOAL',
    audience: 'PARENT',
    when: (c, v) =>
      c.event.eventType === 'REWARD_GRANTED' &&
      usable(v.childName) &&
      usable(v.goalTitle) &&
      typeof v.points === 'number' &&
      v.points > 0,
  },
]);

@Injectable()
export class RuleBasedNotificationDecisionProvider implements NotificationDecisionProvider {
  readonly id = 'rule-based';

  decide(context: NotificationContext, policy: NotificationPolicy): NotificationDecisionOutput {
    const notificationType = context.event.eventType;
    const category = notificationCategoryOf(notificationType);
    const audience = this.audienceFor(notificationType, context);

    // ---- 1. The refusals a human configured -------------------------------
    const configured = this.configuredRefusal(context, policy, category, audience);
    if (configured) {
      return this.output(context, category, audience, 'SUPPRESS', 'SUPPRESS', 0, configured, {
        total: 0,
        band: 'SUPPRESS',
        components: [],
      });
    }

    // ---- 2. The safety override -------------------------------------------
    // Checked BEFORE scoring, mirroring `evaluateAndDeliver`'s own ordering
    // (PHASE E): a DELIVER-class alert refused by an arithmetic penalty would be
    // `PD-N-004` re-opened one layer up.
    if (
      quietHoursClassOf(notificationType) === 'DELIVER' ||
      policy.priorityOverrideTypes.includes(notificationType)
    ) {
      const score = scoreNotification(context, policy, category);
      return this.output(
        context,
        category,
        audience,
        'SEND',
        'HIGH',
        Math.max(score.total, policy.scoring.thresholdHigh),
        'SAFETY_CRITICAL_OVERRIDE',
        score,
        // PHASE F (`F6-003`) — CRITICAL BY CONSTRUCTION, not by arithmetic.
        //
        // `priorityForBand('HIGH')` is `HIGH`, and `deliverNow` folds HIGH down
        // to NORMAL when it writes the row. So deriving this branch's priority
        // from its band would have stored `ACCESSIBILITY_DISABLED` — the alert
        // that says the entire enforcement surface is off — at the same
        // priority as a badge, and the parent app renders on that column.
        // Measured by `quiet-hours-deferral.e2e.spec.ts §8`, which has pinned
        // `priority = 'CRITICAL'` on that row since Phase E.
        //
        // The DELIVER class IS the statement «this is safety-critical»; letting
        // a weighted sum quietly demote it is `PD-N-004` in a third costume.
        'CRITICAL',
      );
    }

    // ---- 3..5. Score, band, verdict ---------------------------------------
    const score = scoreNotification(context, policy, category);
    const { verdict, reason, band } = this.verdictFor(context, score, policy);

    return this.output(context, category, audience, verdict, band, score.total, reason, score);
  }

  /**
   * The audience. `notification-class.ts` already states it per type, and this
   * method's only job is to resolve `BOTH` — which it does by asking whether
   * this particular context has a child at all. A `BOTH` type with no child is
   * a parent notification; with a child it is the child's, and the PARENT facet
   * is produced by the caller composing a second candidate with a `:parent`
   * source key, exactly as `deliverNow` already composes `:child`.
   */
  private audienceFor(type: string, context: NotificationContext): 'PARENT' | 'CHILD' {
    const declared = COPY_CATALOGUE[type]?.audience;
    if (declared) return declared;
    return context.childId ? 'CHILD' : 'PARENT';
  }

  private configuredRefusal(
    context: NotificationContext,
    policy: NotificationPolicy,
    category: string,
    audience: 'PARENT' | 'CHILD',
  ): NotificationDecisionReason | null {
    if (policy.suppressedCategories.includes(category)) return 'POLICY_CATEGORY_SUPPRESSED';
    if (audience === 'PARENT' && context.preferences.parentCategories[category] === false) {
      return 'POLICY_PARENT_PREFERENCE_OFF';
    }
    if (audience === 'CHILD' && context.preferences.childCategories[category] === false) {
      return 'POLICY_CHILD_PREFERENCE_OFF';
    }
    if (PAID_ONLY_CATEGORIES.has(category) && !context.subscription.isActive) {
      return 'SUBSCRIPTION_TIER_EXCLUDED';
    }
    return null;
  }

  private verdictFor(
    context: NotificationContext,
    score: NotificationScore,
    policy: NotificationPolicy,
  ): { verdict: NotificationDecisionVerdict; reason: NotificationDecisionReason; band: NotificationPriorityBand } {
    // THE QUIET-HOURS CLASS IS ASKED BEFORE THE FLOOR, and the order is a
    // reporting decision rather than a behavioural one: both branches suppress a
    // low-scoring reminder at 00:30, but only one of them tells the truth about
    // why. «Its premise expires overnight» is a permanent property of
    // `HYDRATION_REMINDER`; «it scored 11» is an accident of that household's
    // evening. A support engineer reading `SCORE_BELOW_FLOOR` would go looking
    // for a scoring bug that does not exist.
    if (context.quietHours.isActiveNow) {
      const klass = quietHoursClassOf(context.event.eventType);
      if (klass === 'SUPPRESS') {
        return { verdict: 'SUPPRESS', reason: 'QUIET_HOURS_CLASS_SUPPRESS', band: 'SUPPRESS' };
      }
      /**
       * PHASE F (`F6-003`) — THE LINE THAT WOULD HAVE RE-OPENED `PC-D-005`,
       * MEASURED THE DAY A PRODUCER WAS FINALLY WIRED TO THIS PROVIDER.
       *
       * What was here: `if (score.band === 'SUPPRESS') return SUPPRESS`. Read
       * with the penalty table beside it, that line says: inside quiet hours,
       * subtract 20 points and drop anything left under 25. A `REWARD_GRANTED`
       * in a bare household scores 38 by day and 18 at 22:00; a
       * `SCREEN_TIME_EXCEEDED` scores 31 and 11. So EVERY DEFER-CLASS TYPE IN
       * THE PRODUCT would have been DROPPED inside the ten-hour window instead
       * of queued — which is `PC-D-005` exactly, one layer up, in the layer
       * that was added to explain `PC-D-005`.
       *
       * It was invisible for a whole phase because nothing called this
       * provider. `quiet-hours-deferral.e2e.spec.ts §8` turned red on the first
       * commit that did.
       *
       * THE DISTINCTION THE FIX DRAWS. Inside quiet hours there are two
       * questions and they have different owners:
       *
       *   «should this exist at all?»  -> `notification-class.ts`. SUPPRESS
       *       means the premise expires overnight (a hydration nudge);
       *       DEFER means the fact survives the night (an earned reward).
       *   «how loud is it?»            -> the score.
       *
       * The quiet-hours penalty belongs to the second question and was
       * answering the first. So the band is now computed on the score the
       * notification WILL HAVE WHEN IT ARRIVES — in the morning, outside the
       * window — because the morning is when a parent reads it, and a fact
       * held until 07:00 is not worth less at 07:00 for having been true at
       * 22:00.
       *
       * `SCORE_BELOW_FLOOR` REMAINS REACHABLE HERE, and that matters: a
       * genuine duplicate (−40) or a household already at its caps (−25) still
       * falls under the floor on its own merits and is still dropped with a
       * reason. Only the hour itself has stopped being able to delete a fact.
       *
       * THE STORED SCORE IS UNCHANGED — it is still the true sum of the eight
       * components, so `notification_decisions.explanation` still reconciles to
       * `notification_decisions.score` and the penalty is still visible in the
       * row. What changed is which number the VERDICT reads.
       */
      const arrivalBand = bandForScore(this.scoreOnArrival(score), policy.scoring);
      if (arrivalBand === 'SUPPRESS') {
        return { verdict: 'SUPPRESS', reason: 'SCORE_BELOW_FLOOR', band: 'SUPPRESS' };
      }
      return { verdict: 'DEFER', reason: 'QUIET_HOURS_ACTIVE', band: arrivalBand };
    }

    if (score.band === 'SUPPRESS') {
      return { verdict: 'SUPPRESS', reason: 'SCORE_BELOW_FLOOR', band: 'SUPPRESS' };
    }
    return {
      verdict: 'SEND',
      reason: score.band === 'LOW' ? 'SCORE_IN_DEFER_BAND' : 'SCORE_ABOVE_SEND_THRESHOLD',
      band: score.band,
    };
  }

  /**
   * The score this notification will carry when it is actually delivered — i.e.
   * with the quiet-hours penalty removed, because by then the quiet hours are
   * over. Derived from the component the scorer already emits rather than by
   * re-running the scorer with a doctored context, so there is exactly one
   * arithmetic and this method cannot disagree with the stored explanation.
   */
  private scoreOnArrival(score: NotificationScore): number {
    const penalty = score.components.find((c) => c.name === 'QUIET_HOURS_PENALTY');
    return score.total - (penalty ? penalty.contribution : 0);
  }

  /**
   * The copy key, and the extra variables the SENTENCE needs but the PRODUCER
   * never knew about — «وهذه ثالث مرة هذا الأسبوع» being the clearest case: the
   * consumer that publishes `DAILY_GOAL_COMPLETED` has no idea how many times
   * this happened this week, and requiring it to would push notification
   * concerns into every producer in the product.
   */
  private copyFor(
    context: NotificationContext,
    audience: 'PARENT' | 'CHILD',
  ): { key: string; variables: Record<string, string | number> } {
    const variables: Record<string, string | number> = { ...context.event.variables };

    if (context.childDisplayName && audience === 'PARENT') {
      variables.childName = context.childDisplayName;
    }
    if (context.goal) {
      variables.goalTitle = context.goal.title;
      variables.done = context.goal.completedUnits;
      variables.total = context.goal.totalUnits;
      if (context.goal.minutesRemaining !== null) variables.minutes = context.goal.minutesRemaining;
    }
    if (context.streak) variables.days = context.streak.days;
    if (typeof variables.weekCount === 'number') {
      // The ordinal is rendered here, in the locale, rather than in the template
      // — Arabic ordinals below ten are irregular and a template cannot inflect.
      variables.weekCount = ordinal(variables.weekCount, context.locale);
    }

    // A contextual rule beats the plain type key: «أنجزت ٤ من ٥ آيات — هل تكمل
    // الأخيرة الآن؟» is a better sentence to a child than «أنهيت هدفك», and
    // «محمد أكمل الآيات 1–5 من سورة الملك اليوم وحصل على ٢٠ نقطة» is a better
    // sentence to a parent than «حصل محمد على مكافأة جديدة». Both are available
    // only because the facts reached this layer; when they did not, the plain
    // type key below is the honest sentence.
    for (const rule of COPY_RULES) {
      if (rule.audience === audience && rule.when(context, variables)) {
        return { key: rule.key, variables };
      }
    }

    const typeKey = context.event.eventType;
    if (COPY_CATALOGUE[typeKey]) return { key: typeKey, variables };
    return { key: GENERIC_COPY_KEY, variables };
  }

  private output(
    context: NotificationContext,
    category: string,
    audience: 'PARENT' | 'CHILD',
    verdict: NotificationDecisionVerdict,
    band: NotificationPriorityBand,
    score: number,
    reason: NotificationDecisionReason,
    scored: NotificationScore,
    /** Set ONLY by the DELIVER-class override. Everything else derives its
     * priority from the band, which is the single origin of «how loud». */
    priorityOverride?: 'CRITICAL' | 'HIGH' | 'NORMAL' | 'LOW',
  ): NotificationDecisionOutput {
    const copy = this.copyFor(context, audience);
    const decision: NotificationDecision = {
      trigger: context.event.trigger,
      verdict,
      band,
      score,
      reason,
      components: scored.components,
      notificationType: context.event.eventType,
      category,
      targetAudience: audience,
      priority: priorityOverride ?? priorityForBand(band),
      providerId: this.id,
    };
    return { decision, copyKey: copy.key, copyVariables: copy.variables };
  }
}
