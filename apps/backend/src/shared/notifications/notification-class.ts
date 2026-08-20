/**
 * PHASE D (`PC-D-005`) — THE QUIET-HOURS CLASSIFICATION.
 *
 * THE DEFECT THIS FILE EXISTS FOR. `smart-notification-integration.service.ts`
 * returned `decision: isDeferrable ? 'DEFER' : 'SUPPRESS'` and then returned.
 * `DEFER` wrote no row, enqueued nothing and scheduled nothing: the
 * notification was DROPPED. With the default policy of 21:00-07:00 that is ten
 * hours of every day — 41.6% — in which a reward a child actually earned, or a
 * safety event, was silently discarded forever.
 *
 * Fixing that required answering a question the codebase had never asked: WHICH
 * notifications deserve which treatment. «Defer everything» would wake a parent
 * at 07:00 with a queue; «deliver everything» would make quiet hours a lie.
 * So every notification type is classified here, once, explicitly:
 *
 *   SUPPRESS  the occurrence is worth nothing later. Dropped WITH A RECORDED
 *             REASON — dropped-and-logged is a decision; dropped-and-silent is
 *             the bug this phase closes.
 *   DEFER     still valid, just not now. Held in `notification_deliveries` and
 *             released at the end of the family's quiet hours. THE DEFAULT.
 *   DELIVER   bypasses quiet hours entirely. SAFETY-CRITICAL ONLY. Every
 *             member carries a written justification below and the list is
 *             asserted to stay short by `test/notifications/notification-class.spec.ts`.
 *
 * WHY A TABLE AND NOT A PREDICATE. `priority === 'CRITICAL'` was the old,
 * implicit rule, and it is the wrong axis: priority describes how loud a
 * notification is, not whether the fact it carries decays overnight. A
 * `HYDRATION_REMINDER` and a `REWARD_GRANTED` are both NORMAL and their correct
 * quiet-hours behaviours are opposites. The type is the axis; the table is the
 * statement.
 *
 * FRAMEWORK-FREE ON PURPOSE, exactly like `notification-source-key.ts` beside
 * it: producers in four different modules and the tests all import the same
 * one, with no DI graph in between and therefore no way for one caller to get a
 * different answer than another.
 */

/** The three behaviours, and there is no fourth. */
export type QuietHoursClass = 'SUPPRESS' | 'DEFER' | 'DELIVER';

/**
 * THE DEFAULT FOR AN UNKNOWN TYPE, and it is `DEFER` for one reason: the
 * failure this phase closes is a notification vanishing. A type nobody
 * classified must therefore fail towards being KEPT. `SUPPRESS` as a default
 * would re-create `PC-D-005` for every producer added after today, silently,
 * and `DELIVER` would let a forgotten type wake a household at 03:00.
 *
 * `test/notifications/notification-class.spec.ts` reads every notification type
 * literal in `src/` and fails if one of them is relying on this default, so the
 * default is a safety net and never an answer.
 */
export const DEFAULT_QUIET_HOURS_CLASS: QuietHoursClass = 'DEFER';

/** One row of the matrix: the class, plus the sentence that argues for it. */
export interface NotificationClassEntry {
  readonly quietHours: QuietHoursClass;
  /** PARENT, CHILD, or BOTH when one type legitimately reaches both. */
  readonly audience: 'PARENT' | 'CHILD' | 'BOTH';
  /** The product family this type belongs to — the axis the per-category cap counts on. */
  readonly category:
    | 'REWARD'
    | 'ACHIEVEMENT'
    | 'GOAL'
    | 'REMINDER'
    | 'SAFETY'
    | 'SUBSCRIPTION'
    | 'PAYMENT'
    | 'AI'
    | 'INSIGHT'
    | 'SYSTEM';
  /** Required, and read by the test that keeps the DELIVER list honest. */
  readonly why: string;
}

/**
 * THE MATRIX.
 *
 * Types marked `(no producer yet)` are classified in advance DELIBERATELY: the
 * billing and AI surfaces are being built by other work streams, and a
 * classification that arrives after the producer is a classification that
 * arrives after the first production incident. The entry costs nothing and
 * removes the "what should this do at 02:00?" question from that author's plate.
 */
export const NOTIFICATION_CLASSES: Readonly<Record<string, NotificationClassEntry>> = {
  // -- SAFETY: the entire DELIVER list, and nothing else is in it ------------

  ACCESSIBILITY_DISABLED: {
    quietHours: 'DELIVER',
    audience: 'PARENT',
    category: 'SAFETY',
    why:
      'The Accessibility Service IS the enforcement surface. While it is off, every screen-time policy, every block rule and every usage measurement in this product is inert. Holding this until 07:00 means the protection the family is paying for was absent all night and the parent was not told. It is also the one alert with a plausible adversarial cause — a child turning it off at 23:00 precisely because nobody is awake.',
  },
  PROTECTION_BYPASS_ATTEMPT: {
    quietHours: 'DELIVER',
    audience: 'PARENT',
    category: 'SAFETY',
    why:
      'An ACTIVE attempt to defeat protection, not a passive state. Same argument as ACCESSIBILITY_DISABLED with the intent made explicit: deferring an alert about circumvention until after the quiet window rewards the circumvention with exactly the delay it was timed for.',
  },
  CHILD_WELLBEING_CHECKIN: {
    quietHours: 'DELIVER',
    audience: 'PARENT',
    category: 'SAFETY',
    why:
      'The distress-escalation alert (`distress-escalation.service.ts`). A child signalling distress at 01:00 is the single case in this product where waking a parent is unambiguously the correct outcome, and `docs/11 §11.4` already required it in words. This is that requirement expressed as data.',
  },

  // -- SAFETY, but not DELIVER: the distinction the matrix exists to make ----

  POLICY_VIOLATION: {
    quietHours: 'DEFER',
    audience: 'PARENT',
    category: 'SAFETY',
    why:
      'A policy violation is a REPORT, not an emergency. There is no action a parent takes at 02:00 that they cannot take at 07:00, and CONTEXT §3 principle 7 (NO PUNITIVE UX) argues against a product whose night-time behaviour is to page a parent about a rule.',
  },
  SCREEN_TIME_EXCEEDED: {
    quietHours: 'DEFER',
    audience: 'PARENT',
    category: 'SAFETY',
    why:
      'The limit has already been enforced by the device agent by the time this fires. The notification carries information, not a decision, and information keeps until morning.',
  },
  CHILD_REQUEST: {
    quietHours: 'DEFER',
    audience: 'PARENT',
    category: 'SAFETY',
    why:
      'A child asking for more time is a conversation, and it is already NORMAL priority in `digital-wellbeing-engine.service.ts`. Deferring it loses nothing; the child sees the pending state in their own app.',
  },
  RUNTIME_ALERT: {
    quietHours: 'DEFER',
    audience: 'PARENT',
    category: 'SYSTEM',
    why:
      'The generic fallback type of `createForFamilyOwner`. It is deliberately NOT DELIVER: an unnamed alert has by definition not argued for waking anyone, and the two named runtime alerts that HAVE argued for it are listed above under their own types.',
  },

  // -- REWARD / ACHIEVEMENT / GOAL: the reason DEFER had to be built ---------

  REWARD_GRANTED: {
    quietHours: 'DEFER',
    audience: 'PARENT',
    category: 'REWARD',
    why:
      'The defect in one line: a reward the child ACTUALLY EARNED, announced into a ten-hour hole. The fact does not decay — the child earned it and the ledger row is permanent — so the notification must not either.',
  },
  REWARD_GRANTED_CHILD: {
    quietHours: 'DEFER',
    audience: 'CHILD',
    category: 'REWARD',
    why:
      'PF-E-006: the child half of a reward, which had no type, no sentence and no producer — a child earned something, was paid, and was told nothing. Same argument as REWARD_GRANTED one audience over, and the reason it is a separate type rather than the same one is that the two audiences must be capped and scored independently: a parent at their daily maximum must not be able to silence the child’s own news about their own work.',
  },
  BADGE_EARNED: {
    quietHours: 'DEFER',
    audience: 'CHILD',
    category: 'ACHIEVEMENT',
    why:
      'A badge is permanent. Seeing it at 07:00 is the product working; never seeing it is the product lying about a reward it granted.',
  },
  BADGE_EARNED_PARENT: {
    quietHours: 'DEFER',
    audience: 'PARENT',
    category: 'ACHIEVEMENT',
    why:
      'The parent half of a badge, which `rewards-engine.service.ts` has notified since Sprint 16.2 and which had no row here because it shared the CHILD type name. Same argument as BADGE_EARNED: a badge is permanent, seeing it at 07:00 is the product working, never seeing it is the product lying about a reward it granted.',
  },
  LEVEL_UP: {
    quietHours: 'DEFER',
    audience: 'CHILD',
    category: 'ACHIEVEMENT',
    why: 'Same as BADGE_EARNED — a level is a durable fact about the child, not a moment.',
  },
  ACHIEVEMENT_VERIFIED: {
    quietHours: 'DEFER',
    audience: 'BOTH',
    category: 'ACHIEVEMENT',
    why:
      'A parent verified an achievement; the child is owed the answer. Late is acceptable, never is not.',
  },
  ACHIEVEMENT_REJECTED: {
    quietHours: 'DEFER',
    audience: 'CHILD',
    category: 'ACHIEVEMENT',
    why:
      'Deferred rather than suppressed BECAUSE it is the unwelcome one: dropping only the negative outcome would make the notification stream a systematically optimistic view of the child’s week.',
  },
  STREAK_ACHIEVED: {
    quietHours: 'DEFER',
    audience: 'CHILD',
    category: 'ACHIEVEMENT',
    why: 'A streak milestone is a fact about days already lived. It survives the night.',
  },
  DAILY_GOAL_COMPLETED: {
    quietHours: 'DEFER',
    audience: 'CHILD',
    category: 'GOAL',
    why:
      'The goal was completed; the completion row exists. The notification is the receipt, and a receipt is still a receipt in the morning.',
  },
  LEARNING_GOAL_ACHIEVED: {
    quietHours: 'DEFER',
    audience: 'BOTH',
    category: 'GOAL',
    why: 'Same as DAILY_GOAL_COMPLETED, on the Education/Faith engine.',
  },

  // -- PHASE F (`PF-E-003`) — the parent-facing halves, which had copy and no row

  GOAL_COMPLETED_PARENT: {
    quietHours: 'DEFER',
    audience: 'PARENT',
    category: 'GOAL',
    why:
      'PF-E-003, and the defect is what this row is for: `COPY_CATALOGUE` has carried the sentence the product advertises («محمد أكمل هدفه في سورة الملك، وهذه ثالث مرة هذا الأسبوع») since F6-002, and this table had no entry for it — so its category was the raw type string, its per-category cap counted against nothing, and its quiet-hours class was the unconsidered default. Same fact as DAILY_GOAL_COMPLETED, told to the other audience: the completion row exists and the receipt is still a receipt in the morning.',
  },
  GOAL_STALLED_PARENT: {
    quietHours: 'DEFER',
    audience: 'PARENT',
    category: 'GOAL',
    why:
      'The «بدأ محمد هدف العلوم ولم يكمله» sentence. DEFER rather than SUPPRESS even though it describes a day that is over, because the ACTION it invites — a nudge — belongs to the next morning rather than to the night the goal stalled in, and because dropping only the unwelcome half of the goal surface would make the parent stream a systematically optimistic view of the week (the ACHIEVEMENT_REJECTED argument, one audience over).',
  },

  // -- REMINDER: the entire SUPPRESS list, and why it is the whole of it -----

  HYDRATION_REMINDER: {
    quietHours: 'SUPPRESS',
    audience: 'CHILD',
    category: 'REMINDER',
    why:
      'THE TEST OF THE SUPPRESS CLASS: does the notification describe a MOMENT or a FACT? «You have been on your device 90 minutes and are behind on water» is a statement about the last ninety minutes. Delivered at 07:00 it is false — the child was asleep — and acting on it is impossible. Deferring it would be delivering a lie, which is worse than dropping it. Dropped WITH a recorded reason, and the underlying condition re-fires tomorrow on its own signal.',
  },
  STUDY_REMINDER: {
    quietHours: 'SUPPRESS',
    audience: 'CHILD',
    category: 'REMINDER',
    why:
      'Fires because the child’s USUAL STUDY WINDOW has started. That window is over by the end of quiet hours; the notification’s only premise has expired. Tomorrow’s window produces tomorrow’s reminder.',
  },
  EXERCISE_ENCOURAGEMENT: {
    quietHours: 'SUPPRESS',
    audience: 'CHILD',
    category: 'REMINDER',
    why:
      '«You have not logged activity TODAY yet» — and by 07:00 today is a different day, on which the streak has already either survived or broken. The deferred copy would be factually wrong about the one number it contains.',
  },

  // -- The digest itself ----------------------------------------------------

  QUIET_HOURS_DIGEST: {
    quietHours: 'DELIVER',
    audience: 'BOTH',
    category: 'SYSTEM',
    why:
      'Not a real DELIVER member: this type is PRODUCED BY the release path, after quiet hours have ended, and can never be evaluated inside the window. It is classified DELIVER so that a re-entrant evaluation cannot defer the thing whose job is to end a deferral — a digest that defers itself is an infinite loop with a table behind it.',
  },

  // -- Classified ahead of their producers ----------------------------------

  SUBSCRIPTION_EXPIRING: {
    quietHours: 'DEFER',
    audience: 'PARENT',
    category: 'SUBSCRIPTION',
    why:
      '(no producer yet — billing is another work stream.) A renewal date is days away by construction; there is no version of this that justifies 02:00.',
  },
  SUBSCRIPTION_EXPIRED: {
    quietHours: 'DEFER',
    audience: 'PARENT',
    category: 'SUBSCRIPTION',
    why:
      '(no producer yet.) Loss of features is real and must be told, but the features were lost at the moment of expiry and telling the parent seven hours later changes nothing about it.',
  },
  PAYMENT_FAILED: {
    quietHours: 'DEFER',
    audience: 'PARENT',
    category: 'PAYMENT',
    why:
      '(no producer yet.) The strongest DEFER candidate to argue about, and still DEFER: a card that failed at 23:00 cannot be fixed faster by waking its owner, the provider’s own dunning window is measured in days, and a payment notification at 03:00 is indistinguishable in tone from the phishing message it will be mistaken for.',
  },
  PAYMENT_SUCCEEDED: {
    quietHours: 'DEFER',
    audience: 'PARENT',
    category: 'PAYMENT',
    why: '(no producer yet.) A receipt. The lowest-urgency notification this product will ever send.',
  },
  AI_RECOMMENDATION: {
    quietHours: 'SUPPRESS',
    audience: 'PARENT',
    category: 'AI',
    why:
      '(no producer yet.) CONTEXT §3 principle 2: the AI ADVISES. An advisory whose window passed is not owed to anybody, the Coach recomputes it on its next run from the same data, and a deferred queue of stale advice is exactly the morning flood this phase exists to prevent. The recommendation itself is NOT lost — it is readable in the app; only its push is dropped.',
  },
  FAMILY_INSIGHT: {
    quietHours: 'SUPPRESS',
    audience: 'PARENT',
    category: 'INSIGHT',
    why:
      '(no producer yet.) `FamilyInsightService` output is a periodic recomputation over a window. Holding one overnight delivers a superseded insight next to the fresh one that is already in the app.',
  },
} as const;

/**
 * THE ONE LOOKUP. `priority` is accepted and deliberately NOT used to override
 * the table: the old implicit rule (`CRITICAL` bypasses quiet hours) is
 * PRESERVED only as a floor for types nobody has classified, so that the two
 * services which bypass the fatigue guard entirely today
 * (`RuntimeAlertService`, `DigitalWellbeingEngineService.recordCriticalEvent`)
 * keep their current behaviour rather than having it changed by a refactor
 * whose subject is deferral.
 *
 * The ORDER matters and is the whole semantics:
 *   1. an explicit classification wins, always — including when it DOWNGRADES a
 *      CRITICAL type to DEFER, which is the point of POLICY_VIOLATION;
 *   2. otherwise a CRITICAL priority is DELIVER, preserving today’s rule;
 *   3. otherwise DEFER.
 */
export function quietHoursClassOf(
  type: string,
  priority?: 'CRITICAL' | 'HIGH' | 'NORMAL' | 'LOW',
): QuietHoursClass {
  const entry = NOTIFICATION_CLASSES[type];
  if (entry) return entry.quietHours;
  if (priority === 'CRITICAL') return 'DELIVER';
  return DEFAULT_QUIET_HOURS_CLASS;
}

/** Every type the matrix classifies, for the exhaustiveness test and the report. */
export function classifiedNotificationTypes(): readonly string[] {
  return Object.keys(NOTIFICATION_CLASSES);
}

/** The DELIVER members, so a test can assert the list stays short. */
export function deliverClassTypes(): readonly string[] {
  return Object.entries(NOTIFICATION_CLASSES)
    .filter(([, entry]) => entry.quietHours === 'DELIVER')
    .map(([type]) => type);
}

/**
 * The category a cap counts against. Falls back to the type itself, which is
 * what `NotificationFatigueGuard` has always used, so an unclassified type
 * behaves exactly as it did before this file existed.
 */
export function notificationCategoryOf(type: string): string {
  return NOTIFICATION_CLASSES[type]?.category ?? type;
}
