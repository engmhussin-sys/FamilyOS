/**
 * PHASE F (`F6-002`) — THE ONE INPUT SHAPE, AND THE PRIVACY ARGUMENT FOR EVERY
 * FIELD IN IT.
 *
 * WHAT WAS THERE. `ISmartNotificationSignals` (six fields, hydration and screen
 * time only), `IRecentNotification[]`, a `familyId` string, a `childId` string,
 * a timezone fetched inside the service, and a `priority` the producer asserted.
 * Six different shapes, assembled at four different call sites, none of which
 * could see what the others knew. A decision engine that cannot see the child's
 * age cannot choose words for a seven-year-old, and a decision engine that
 * cannot see the goal cannot say «باقي لك ٥ دقائق».
 *
 * WHY THIS FILE IS MOSTLY COMMENTS. CONTEXT §3 principle 8 (PRIVACY BY DESIGN)
 * names data minimisation and purpose limitation as non-negotiable, and this is
 * CHILDREN'S DATA. A context object is exactly where minimisation dies quietly:
 * one `include: { child: true }` and the notification layer is holding a date of
 * birth, a PIN hash and a device list forever. So the rule applied here is:
 *
 *   A FIELD EXISTS ONLY IF A NAMED DECISION OR A NAMED SENTENCE CONSUMES IT,
 *   AND THE COMMENT SAYS WHICH.
 *
 * Every field below carries `WHY` (what consumes it) and, where the raw source
 * is more sensitive than the field, `NOT` (what was deliberately left behind).
 * `test/notifications/notification-context.spec.ts` reads this file and fails if
 * a field is added without a `WHY:` line — a comment convention is worthless
 * unless something enforces it.
 *
 * FRAMEWORK-FREE, like the rest of `domain/engine`. The assembler that fills it
 * lives in `notification-engine/`; this is only the contract.
 */

import type { AgeBand } from '../../../ai-core/domain/age-band';
import type { NotificationTrigger } from './notification-decision.types';
/** TYPE-ONLY, and it must stay that way: `notification-nouns.ts` reads
 * `NotificationLocale` from this file, so a VALUE import in either direction
 * would be a real module cycle. Both sides are erased at compile time. */
import type { GoalUnitKind } from './notification-nouns';
import type { ToneBand } from './notification-tone';

/**
 * The two locales this product ships. Arabic FIRST — CONTEXT §1: «اللغة الأولى:
 * العربية (RTL حقيقي، لا ترجمة)» — so `ar` is the fallback when a locale is
 * unknown, not `en`.
 */
export const NOTIFICATION_LOCALES = ['ar', 'en'] as const;
export type NotificationLocale = (typeof NOTIFICATION_LOCALES)[number];

/** Arabic is the default. A family with `locale = 'fr'` gets Arabic, not a
 * crash and not English. */
export function resolveLocale(raw: string | null | undefined): NotificationLocale {
  if (!raw) return 'ar';
  const head = raw.toLowerCase().split(/[-_]/)[0];
  return head === 'en' ? 'en' : 'ar';
}

/**
 * WHY: the copy catalogue is keyed on the product category, and so is the
 * per-category cap and the parent's per-category preference switch. Kept as the
 * `notification-class.ts` category string rather than a second enum, so there is
 * one category vocabulary in this codebase.
 */
export type NotificationCategory = string;

/**
 * The event that started this. Deliberately NOT the full `DomainEventEnvelope`:
 * an envelope carries a device id, a raw payload and an idempotency key, none of
 * which any notification decision reads.
 */
export interface NotificationEventFacts {
  /** WHY: selects the copy key and the `notification-class.ts` row. */
  readonly eventType: string;
  /**
   * THE SPECIFIC DOMAIN CAUSE BEHIND A GENERIC EVENT TYPE — `F1-002`.
   *
   * WHY: the copy key, and nothing else. `REWARD_GRANTED` / `REWARD_GRANTED_CHILD`
   * are the types the product PAYS on, and four different things earn them: a
   * streak milestone, a daily goal, a learning goal, a verified achievement.
   * Every one of those arrived at this door as the single word `REWARD_GRANTED`,
   * so a child who kept a seven-day streak and a child whose parent confirmed
   * «الآيات 1–5 من سورة الملك» read the identical sentence, and four written,
   * scored, deep-linked copy variants were unreachable from production.
   *
   * It is the ORIGINATING DOMAIN EVENT TYPE (`STREAK_ACHIEVED`,
   * `ACHIEVEMENT_VERIFIED`, …), carried through unchanged — never a new
   * vocabulary invented at the notification layer, and never a value a client
   * chose. `null` when the producer has no more specific cause than the type
   * itself, which is the honest answer for every producer that is not a reward.
   *
   * IT DOES NOT TOUCH `notifications.type`, DELIBERATELY. The scorer
   * (`notification-scoring.ts`), the quiet-hours matrix
   * (`notification-class.ts`) and the analytics all read `type`; this fact
   * varies only the COPY KEY, through `COPY_RULES`, and the chosen key is
   * recorded on `notification_decisions.copy_key` so «why did this child read
   * that sentence?» has an answer in a row.
   *
   * NOT: the payload it came from, the aggregate id, the device. One enum-shaped
   * token, never rendered — no template references it, and
   * `hasEnumOrPlaceholderLeak` would refuse the string if one ever did.
   */
  readonly cause: string | null;
  /** WHY: `notification-source-key.ts` composes idempotency from the cause; the
   * engine must pass the producer's key through unchanged, never invent one. */
  readonly sourceEventId: string;
  /** WHY: which of the eight causes fired, persisted so «what set this off» is a
   * column and not an inference from the type name. */
  readonly trigger: NotificationTrigger;
  /**
   * WHY: the numbers that appear INSIDE the sentence — «٤ من ٥ آيات»،
   * «٥ دقائق». A closed record of primitives rather than `unknown`, so a
   * producer cannot smuggle a free-form object with a child's location into the
   * copy layer.
   * NOT: the raw device payload, the app package name, any free-form text the
   * device supplied.
   */
  readonly variables: Readonly<Record<string, string | number>>;
}

/**
 * WHY: the fatigue guard's cooldown/daily/category caps read history, and the
 * DUPLICATE_PENALTY component reads «have we said this recently».
 * NOT: the titles and bodies of past notifications. The decision needs to know
 * THAT a `BADGE_EARNED` went out at 19:04, never what it said.
 */
export interface RecentNotificationFact {
  readonly type: string;
  readonly category: NotificationCategory;
  readonly priority: 'CRITICAL' | 'HIGH' | 'NORMAL' | 'LOW';
  readonly createdAt: Date;
}

/**
 * WHY: RELEVANCE. A nudge sent to a child who has done nothing all day is a
 * different message from one sent to a child two items from finishing, and the
 * engine cannot tell them apart from the event alone.
 * NOT: which apps, which sites, which locations. Counts and one boolean; the
 * decision does not need the behaviour, only its shape.
 */
export interface RecentActivityFacts {
  /** Completions recorded on the family's own business day. */
  readonly completionsToday: number;
  /** Minutes since the child's last recorded interaction, or `null` when the
   * child has no activity today at all — an honest absence, never 0. */
  readonly minutesSinceLastActivity: number | null;
  /** WHY: the fatigue guard's own «is the child even here» input, and the
   * reason a reminder is not sent into a blocked app. */
  readonly isEngagedNow: boolean;
}

/**
 * WHY: ACHIEVEMENT_VALUE and the goal sentences («أنجزت ٤ من ٥ آيات»).
 * NOT: the goal's full curriculum row, its evidence attachments, its history.
 */
export interface GoalFacts {
  /** A stable, non-PII label used verbatim inside copy («سورة الملك»). It is
   * the goal's own title, which the parent wrote and the child sees in the app
   * already — nothing new is exposed by repeating it back. */
  readonly title: string;
  readonly completedUnits: number;
  readonly totalUnits: number;
  /** WHY: DEADLINE_PROXIMITY. `null` for a goal with no deadline — the
   * component then contributes zero rather than a guessed urgency. */
  readonly minutesRemaining: number | null;
  /**
   * SPRINT F1 — WHAT `completedUnits` AND `totalUnits` ARE COUNTING.
   *
   * WHY: `COPY_CATALOGUE.GOAL_ALMOST_DONE` interpolates `{unitNoun}` in three of
   * its four tone bands («أنجزت ٤ من ٥ آيات»), and without it the renderer
   * treats the template as leaking and degrades the whole sentence to `GENERIC`.
   * The noun cannot come from the producer, because it has to agree with the
   * household's LOCALE and with the COUNT — `notification-nouns.ts` carries the
   * Arabic rule and the whole argument. So the producer states the KIND and the
   * copy layer says the word.
   *
   * NOT: the activity code, the target spec, the program row. One token from a
   * closed union, never rendered — `hasEnumOrPlaceholderLeak` would refuse it if
   * a template ever named it.
   *
   * Absent (or `null`) is the honest answer for a producer whose units have no
   * noun: `StalledGoalService` passes a target's ayah count for the SCORER and
   * says nothing about it to anybody, so it supplies none.
   */
  readonly unitKind?: GoalUnitKind | null;
}

/**
 * WHY: ACHIEVEMENT_VALUE. A 5-coin routine grant and a 200-coin milestone are
 * not equally worth interrupting a parent for, and before this the engine could
 * not tell them apart.
 * NOT: the ledger row, the balance, the redemption history.
 */
export interface RewardFacts {
  readonly kind: string;
  readonly amount: number;
  /** WHY: a badge/level is permanent and scores higher than a routine grant. */
  readonly isMilestone: boolean;
}

/**
 * WHY: URGENCY and the streak sentences («أنت على بعد خطوة من الحفاظ على
 * سلسلتك»). A streak at risk with two hours left is the single most
 * time-sensitive non-safety notification this product sends.
 */
export interface StreakFacts {
  readonly days: number;
  readonly atRisk: boolean;
  /** Hours until the streak breaks on the FAMILY'S calendar, `null` when not at
   * risk. */
  readonly hoursUntilBreak: number | null;
}

/**
 * WHY: PARENT_PREFERENCE, and the two `POLICY_*_PREFERENCE_OFF` refusals.
 * These are switches a human set; the engine must obey them and must be able to
 * say that it did.
 */
export interface NotificationPreferenceFacts {
  /** Category -> the parent wants it. Absent key = the default, which is ON. */
  readonly parentCategories: Readonly<Record<string, boolean>>;
  /** Category -> the child wants it. Absent key = ON. */
  readonly childCategories: Readonly<Record<string, boolean>>;
  /** 0..1. How strongly this household has signalled it wants to hear things —
   * derived from explicit settings only, NEVER from inferred engagement. */
  readonly parentAppetite: number;
}

/**
 * WHY: the quiet-hours penalty and the DEFER verdict.
 * NOT: a second copy of the family's schedule. `startHHMM`/`endHHMM` are the
 * policy's own two strings and `isActiveNow` is computed ONCE, by
 * `FamilyDateService` + `family-date.ts`, so no consumer re-derives a local time
 * — which is exactly the `PA-B-002` defect that made a Cairo family's quiet
 * hours run 00:00-10:00.
 */
export interface QuietHoursFacts {
  readonly startHHMM: string;
  readonly endHHMM: string;
  readonly isActiveNow: boolean;
  /** The family's local wall-clock time, already resolved. */
  readonly localTimeHHMM: string;
}

/**
 * WHY: `SUBSCRIPTION_TIER_EXCLUDED`. Some notification categories are a paid
 * capability, and the engine refusing them explicitly is better than a paywall
 * discovered at the delivery layer.
 * NOT: the invoice, the card, the provider, the renewal date. One word.
 */
export interface SubscriptionFacts {
  readonly plan: string;
  readonly isActive: boolean;
}

/**
 * THE UNIFIED CONTEXT.
 *
 * Assembled once per event, consumed by the decision provider, the tone engine
 * and the copy catalogue. Immutable — every field is `readonly` — because a
 * context a service can mutate is a context the persisted explanation no longer
 * describes.
 */
export interface NotificationContext {
  /** WHY: tenancy. Every read and every write in this pipeline is scoped by it
   * (F2/R8), and it is the first column of both idempotency indexes. */
  readonly familyId: string;
  /** WHY: routing (child messages vs parent notifications), history lookup and
   * the per-child caps. `null` for a family-level notification with no child. */
  readonly childId: string | null;
  /**
   * WHY: the tone band and the safety ceiling. An INTEGER YEAR, computed by
   * `businessAgeInYears` on the family's calendar.
   * NOT: `Child.dateOfBirth`. The date of birth is a direct identifier and the
   * notification layer has no use for it — an age in whole years answers every
   * question the copy asks and cannot be used to re-identify a child.
   */
  readonly childAgeYears: number | null;
  /** WHY: derived once from `childAgeYears`, carried so the copy layer and the
   * safety filter cannot disagree about which band a child is in. */
  readonly toneBand: ToneBand;
  /** WHY: `ChildSafetyFilterService`'s length ceilings are keyed on the
   * AI-architecture bands (`6-8`…`15-17`), which are NOT the tone bands. Both
   * are carried so neither is re-derived from the other with an off-by-one. */
  readonly safetyBand: AgeBand;
  /** WHY: which column of the copy catalogue to read. Arabic first. */
  readonly locale: NotificationLocale;
  /** WHY: every calendar question — quiet hours, the daily cap's day boundary,
   * a deadline in local time. One family, one calendar (B2). */
  readonly timeZone: string;
  /**
   * WHY: analytics filtering by country, which the Admin dashboard requires.
   * `null` when the household has no billing country yet — an honest absence
   * rather than a guess from an IP address, which this product does not collect.
   */
  readonly countryCode: string | null;

  readonly event: NotificationEventFacts;
  readonly recentActivity: RecentActivityFacts;
  readonly recentNotifications: readonly RecentNotificationFact[];
  readonly goal: GoalFacts | null;
  readonly reward: RewardFacts | null;
  readonly streak: StreakFacts | null;
  readonly preferences: NotificationPreferenceFacts;
  readonly quietHours: QuietHoursFacts;
  readonly subscription: SubscriptionFacts;

  /** WHY: every decision in this codebase that has a right answer takes `now`
   * as a parameter rather than reading the clock (B2/PHASE D). This one is no
   * different, and the persisted score must be reproducible from the row. */
  readonly now: Date;

  /**
   * WHY: the parent-facing sentence «محمد أكمل هدفه» names the child, and a
   * parent notification that says «طفلك» when the household has three children
   * is a notification that fails its own purpose.
   * NOT: last name, avatar, gender, device. The FIRST NAME ONLY, and it is
   * never written to a log line, never included in an FCM payload (the push
   * stays a pointer — docs/06 §8.3), and never sent to the AI rephraser.
   * `null` for child-facing copy, which never needs to name its own reader.
   */
  readonly childDisplayName: string | null;
}
