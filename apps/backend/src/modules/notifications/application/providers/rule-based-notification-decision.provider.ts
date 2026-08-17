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
import { scoreNotification } from '../../domain/engine/notification-scoring';

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
  readonly when: (c: NotificationContext) => boolean;
}

const COPY_RULES: readonly CopyRule[] = Object.freeze([
  {
    key: 'GOAL_DEADLINE_NEAR',
    when: (c) =>
      c.goal !== null &&
      c.goal.minutesRemaining !== null &&
      c.goal.minutesRemaining > 0 &&
      c.goal.minutesRemaining <= 30 &&
      c.goal.completedUnits < c.goal.totalUnits,
  },
  {
    key: 'GOAL_ALMOST_DONE',
    when: (c) =>
      c.goal !== null &&
      c.goal.totalUnits > 0 &&
      c.goal.completedUnits > 0 &&
      c.goal.totalUnits - c.goal.completedUnits === 1,
  },
  {
    key: 'STREAK_AT_RISK',
    when: (c) => c.streak !== null && c.streak.atRisk && c.streak.days > 0,
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
      );
    }

    // ---- 3..5. Score, band, verdict ---------------------------------------
    const score = scoreNotification(context, policy, category);
    const { verdict, reason, band } = this.verdictFor(context, score);

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
  ): { verdict: NotificationDecisionVerdict; reason: NotificationDecisionReason; band: NotificationPriorityBand } {
    if (score.band === 'SUPPRESS') {
      return { verdict: 'SUPPRESS', reason: 'SCORE_BELOW_FLOOR', band: 'SUPPRESS' };
    }
    if (context.quietHours.isActiveNow) {
      const klass = quietHoursClassOf(context.event.eventType);
      if (klass === 'SUPPRESS') {
        // The premise expires overnight — `HYDRATION_REMINDER`'s whole argument.
        return { verdict: 'SUPPRESS', reason: 'QUIET_HOURS_CLASS_SUPPRESS', band: score.band };
      }
      return { verdict: 'DEFER', reason: 'QUIET_HOURS_ACTIVE', band: score.band };
    }
    return {
      verdict: 'SEND',
      reason: score.band === 'LOW' ? 'SCORE_IN_DEFER_BAND' : 'SCORE_ABOVE_SEND_THRESHOLD',
      band: score.band,
    };
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

    // A child-facing contextual rule beats the plain type key: «أنجزت ٤ من ٥
    // آيات — هل تكمل الأخيرة الآن؟» is a better sentence than «أنهيت هدفك»,
    // and it is available only because the context carries the goal.
    if (audience === 'CHILD') {
      for (const rule of COPY_RULES) {
        if (rule.when(context)) return { key: rule.key, variables };
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
      priority: priorityForBand(band),
      providerId: this.id,
    };
    return { decision, copyKey: copy.key, copyVariables: copy.variables };
  }
}
