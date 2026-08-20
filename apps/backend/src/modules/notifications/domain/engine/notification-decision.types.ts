/**
 * PHASE F (`F6-002`) — THE VOCABULARY OF A NOTIFICATION DECISION.
 *
 * WHAT WAS MISSING. Every part of the decision already existed and none of it
 * was WRITTEN DOWN. `evaluateSmartNotificationCandidates` produced candidates,
 * `evaluateFatigue` refused some of them, `quietHoursClassOf` decided what
 * «refused» meant, and the only trace any of it left was a `logger.log` line
 * and an `INotificationOutcome` that vanished when the promise resolved. Ask
 * «why did this household not get the reward notification on Tuesday?» and the
 * honest answer was: nobody can know.
 *
 * This file is the answer's shape. It is FRAMEWORK-FREE on purpose — the same
 * discipline as `notification-class.ts` and `notification-source-key.ts` beside
 * it — because the provider, the persistence layer, the analytics reader and
 * the tests must all import the SAME definition of «a decision», not four
 * compatible ones.
 *
 * NOTHING HERE IS A SECOND ENGINE. A `NotificationDecision` is an EXPLANATION
 * plus a verdict; executing the verdict is still
 * `SmartNotificationIntegrationService`'s job, and the fatigue guard is still
 * the thing that says no. What changes is that the reasoning is now a value
 * that can be stored, queried and read by a human.
 */

/**
 * THE THREE VERDICTS, and there is no fourth. Deliberately the SAME three words
 * `INotificationOutcome.decision` already uses, so that «what the engine
 * decided» and «what the pipeline did» are comparable without a mapping table —
 * and so that a disagreement between them (engine says SEND, pipeline says
 * SUPPRESS/`DAILY_MAX`) is legible rather than hidden behind two vocabularies.
 */
export type NotificationDecisionVerdict = 'SEND' | 'DEFER' | 'SUPPRESS';

/**
 * THE PRIORITY BAND — how loud, as opposed to whether.
 *
 * It is derived from the SCORE, not from the producer's `priority` field, and
 * that separation is the point. `priority` is what a producer asserts about its
 * own message; the band is what this engine concluded after weighing the whole
 * context against the family's own policy. `SUPPRESS` is a member of the band
 * union rather than a separate flag because a notification scoring below the
 * floor has no loudness — it has no existence.
 */
export type NotificationPriorityBand = 'HIGH' | 'MEDIUM' | 'LOW' | 'SUPPRESS';

/**
 * WHAT SET THIS OFF. A closed union rather than free text, for
 * `growth-settings.ts`'s reason: a trigger you can only grep is a trigger you
 * cannot chart. Every member names a real cause that exists in this codebase
 * today; adding a ninth is a compile-time event for whoever adds the producer.
 */
export const NOTIFICATION_TRIGGERS = [
  /** A `domain_events` row reached a consumer (reward grants, goal completions). */
  'DOMAIN_EVENT',
  /** A periodic signal scan produced a candidate (hydration, study window). */
  'PERIODIC_SIGNAL',
  /** A streak is alive and at risk, or a milestone was crossed. */
  'STREAK_WATCH',
  /** A deadline on a goal is approaching. */
  'DEADLINE_WATCH',
  /** A safety condition on the device (protection off, bypass attempt). */
  'SAFETY_SIGNAL',
  /** A parent acted and the child is owed the answer (verify / reject). */
  'PARENT_ACTION',
  /** Billing / subscription lifecycle. */
  'SUBSCRIPTION_LIFECYCLE',
  /** The quiet-hours release path re-evaluating a held row. */
  'DEFERRAL_RELEASE',
] as const;

export type NotificationTrigger = (typeof NOTIFICATION_TRIGGERS)[number];

/**
 * ONE LINE OF THE ARITHMETIC.
 *
 * `raw` is the component's own 0..1 reading of the world, `weight` is how much
 * this product has decided that reading matters, and `contribution` is their
 * product — stored rather than recomputed so that a decision read back in six
 * months still adds up even if the weights have since been retuned. That is the
 * difference between an audit trail and a re-simulation.
 *
 * `note` is a SHORT ENGLISH FACT, never user-facing copy: it is read by an
 * operator in an admin table, and mixing it with the localisation layer would
 * make the explanation depend on whose browser is open.
 */
export interface NotificationScoreComponent {
  readonly name: NotificationScoreComponentName;
  readonly raw: number;
  readonly weight: number;
  readonly contribution: number;
  readonly note: string;
}

/**
 * The eight components: five that argue FOR sending and three that argue
 * against. Named as data so the persisted explanation can be validated, and so
 * a dashboard can group by «which penalty is suppressing the most messages».
 */
export const NOTIFICATION_SCORE_COMPONENTS = [
  'URGENCY',
  'RELEVANCE',
  'ACHIEVEMENT_VALUE',
  'DEADLINE_PROXIMITY',
  'PARENT_PREFERENCE',
  'FATIGUE_PENALTY',
  'DUPLICATE_PENALTY',
  'QUIET_HOURS_PENALTY',
] as const;

export type NotificationScoreComponentName = (typeof NOTIFICATION_SCORE_COMPONENTS)[number];

/** The three that SUBTRACT. Held as data so `scoreNotification` cannot get the
 * sign of one of them wrong without the test that reads this list failing. */
export const NOTIFICATION_PENALTY_COMPONENTS: ReadonlySet<NotificationScoreComponentName> = new Set(
  ['FATIGUE_PENALTY', 'DUPLICATE_PENALTY', 'QUIET_HOURS_PENALTY'],
);

/**
 * THE WHOLE OF THE ARITHMETIC, as a value.
 *
 * `total` is clamped to 0..100. It is stored as an INTEGER in the decision
 * ledger, because a score with a fractional tail invites someone to compare two
 * decisions that differ by 0.4 and conclude something.
 */
export interface NotificationScore {
  readonly total: number;
  readonly band: NotificationPriorityBand;
  readonly components: readonly NotificationScoreComponent[];
}

/**
 * WHY THE VERDICT IS WHAT IT IS — a closed reason vocabulary, and it is the
 * field a support engineer actually reads first.
 *
 * The `POLICY_*` members are the engine's OWN refusals (a category the parent
 * switched off, a child preference, a score below the floor). The fatigue
 * guard's own refusals — `COOLDOWN`, `DAILY_MAX`, `CATEGORY_MAX`, `DUPLICATE`,
 * `HOURLY_MAX` — are NOT duplicated here: they belong to the pipeline outcome,
 * not to the engine decision, and re-declaring them would create two places
 * where «why was it dropped» is answered.
 */
export const NOTIFICATION_DECISION_REASONS = [
  'SCORE_ABOVE_SEND_THRESHOLD',
  'SCORE_IN_DEFER_BAND',
  'SCORE_BELOW_FLOOR',
  'QUIET_HOURS_ACTIVE',
  'QUIET_HOURS_CLASS_SUPPRESS',
  'QUIET_HOURS_CLASS_DELIVER',
  'SAFETY_CRITICAL_OVERRIDE',
  'POLICY_CATEGORY_SUPPRESSED',
  'POLICY_PARENT_PREFERENCE_OFF',
  'POLICY_CHILD_PREFERENCE_OFF',
  'POLICY_PRIORITY_OVERRIDE',
  'SUBSCRIPTION_TIER_EXCLUDED',
] as const;

export type NotificationDecisionReason = (typeof NOTIFICATION_DECISION_REASONS)[number];

/**
 * THE DECISION. Everything a human needs in order to agree or disagree with the
 * engine, and nothing a human would need a second query for.
 *
 * `providerId` is on the record rather than inferred, because the entire point
 * of the provider abstraction is that a future `AiNotificationDecisionProvider`
 * can produce these rows too — and the first question anyone will ask of a
 * surprising decision is «which provider decided this».
 */
export interface NotificationDecision {
  readonly trigger: NotificationTrigger;
  readonly verdict: NotificationDecisionVerdict;
  readonly band: NotificationPriorityBand;
  readonly score: number;
  readonly reason: NotificationDecisionReason;
  readonly components: readonly NotificationScoreComponent[];
  /** The `notification-class.ts` type this decision resolves to — the thing the
   * pipeline, the matrix and the copy catalogue are all keyed on. */
  readonly notificationType: string;
  readonly category: string;
  readonly targetAudience: 'PARENT' | 'CHILD';
  /** The producer-level priority handed to `evaluateFatigue`, derived from the
   * band so that «how loud» has ONE origin. */
  readonly priority: 'CRITICAL' | 'HIGH' | 'NORMAL' | 'LOW';
  readonly providerId: string;
}

/**
 * The one place band -> `evaluateFatigue` priority is mapped.
 *
 * SUPPRESS maps to LOW rather than throwing, because this function is total and
 * a suppressed decision still gets persisted with a priority column. Nothing
 * reaches the guard with a SUPPRESS band — the engine returns before that — so
 * the value is a stored fact, never a behaviour.
 */
export function priorityForBand(
  band: NotificationPriorityBand,
): 'CRITICAL' | 'HIGH' | 'NORMAL' | 'LOW' {
  switch (band) {
    case 'HIGH':
      return 'HIGH';
    case 'MEDIUM':
      return 'NORMAL';
    case 'LOW':
    case 'SUPPRESS':
      return 'LOW';
  }
}
