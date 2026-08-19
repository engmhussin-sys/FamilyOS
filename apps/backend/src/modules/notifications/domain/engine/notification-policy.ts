/**
 * PHASE F (`F6-002`) — THE POLICY, AS CONFIGURATION RATHER THAN AS CONSTANTS.
 *
 * WHAT WAS THERE. `DEFAULT_FATIGUE_POLICY` — five numbers, `const`, in a source
 * file, with a docstring promising they were «easily-adjustable-later». They
 * were adjustable by a deploy. A household in Riyadh whose quiet hours are
 * 23:00-06:00 got 21:00-07:00 like everyone else, and an operator who wanted to
 * loosen a cap during Ramadan had to ship a release.
 *
 * WHAT THIS IS NOT. It is not a second fatigue guard. `evaluateFatigue` remains
 * the ONE function that decides whether a candidate is refused, and this file
 * produces its `IFatiguePolicy` input — plus the four rules the guard never
 * had (hourly cap, category suppression, parent preference, child preference),
 * which are checked HERE, before the guard, and reported in the guard's own
 * vocabulary so a downstream reader never has to know which of the two said no.
 *
 * THE SHAPE IS `growth-settings.ts`'s, deliberately: a SCHEMA with a default, a
 * bound and an Arabic description per key, so the same admin surface pattern
 * applies and an operator cannot set `maxPerDay = 0` and mute a household by
 * mistyping. The values live in `notification_policy_settings` (migration 0018),
 * per family, and every key is optional — a household with no row behaves
 * exactly as it did before this file existed, which is the property that lets
 * this ship without a backfill.
 *
 * FRAMEWORK-FREE. One type-only import, to the guard whose input this builds.
 */

import type { IFatiguePolicy } from '../../../life-intelligence/application/services/notification-fatigue-guard';

/**
 * THE SCORING WEIGHTS AND THRESHOLDS, also configuration.
 *
 * They are here rather than in `notification-scoring.ts` for the reason the caps
 * are here: a threshold that can only be changed by a deploy is a threshold
 * nobody tunes, and an engine whose weights are invisible to the operator who
 * has to explain its output is a black box wearing an explanation.
 */
export interface NotificationScoringConfig {
  readonly weightUrgency: number;
  readonly weightRelevance: number;
  readonly weightAchievement: number;
  readonly weightDeadline: number;
  readonly weightParentPreference: number;
  readonly penaltyFatigue: number;
  readonly penaltyDuplicate: number;
  readonly penaltyQuietHours: number;
  /** At or above this total, the band is HIGH. */
  readonly thresholdHigh: number;
  /** At or above this, MEDIUM. */
  readonly thresholdMedium: number;
  /** At or above this, LOW. Below it, SUPPRESS — the floor. */
  readonly thresholdLow: number;
}

export interface NotificationPolicy {
  /** NEW in F6. The guard had a daily cap and no hourly one, so six
   * notifications inside four minutes were legal as long as the seventh waited
   * for tomorrow. */
  readonly maxPerHour: number;
  readonly maxPerDay: number;
  readonly categoryMaxPerDay: number;
  /** Applied to any type with no entry in `cooldownMinutesByType`. Before F6 an
   * unlisted type had NO cooldown at all — the three types Sprint 16 happened to
   * name were the only ones protected. */
  readonly defaultCooldownMinutes: number;
  readonly cooldownMinutesByType: Readonly<Record<string, number>>;
  readonly duplicateWindowMinutes: number;
  readonly quietHoursStart: string;
  readonly quietHoursEnd: string;
  /**
   * Types that bypass the caps entirely. NOT a free list: it is intersected with
   * the DELIVER class of `notification-class.ts`, so an operator cannot promote
   * `HYDRATION_REMINDER` into an alarm that ignores every limit. Configuration
   * bounded by a written product decision, which is the only kind of
   * configuration worth having on a safety path.
   */
  readonly priorityOverrideTypes: readonly string[];
  /** Categories the household has switched off wholesale. */
  readonly suppressedCategories: readonly string[];
  readonly scoring: NotificationScoringConfig;
}

/**
 * THE DEFAULTS, AND THEY ARE THE OLD NUMBERS.
 *
 * `maxPerDay`, `categoryMaxPerDay`, the three cooldowns, the duplicate window
 * and both quiet-hours strings are byte-for-byte `DEFAULT_FATIGUE_POLICY` and
 * `NOTIFICATION_DEDUPE_WINDOW_MS`. That is not laziness: this phase adds a
 * configuration layer, and a configuration layer that also changes the values it
 * is configuring makes every behaviour change in this release unattributable.
 *
 * The genuinely new numbers are `maxPerHour` (3) and `defaultCooldownMinutes`
 * (30), and both are argued for on their own keys below.
 *
 * ---------------------------------------------------------------------------
 * SPRINT F1 — THOSE TWO NUMBERS WERE NEVER ENFORCED, AND THIS IS THE COMMIT
 * THAT DECIDES TO KEEP THEM.
 *
 * `toFatiguePolicy` — the bridge this file's own docstring describes — had NO
 * CALL SITE ANYWHERE IN `src/` until `SmartNotificationEngineService` gained
 * one. `evaluateFatigue` was reached only through
 * `SmartNotificationIntegrationService.evaluateAndDeliver`, which passes no
 * policy, so the guard used `DEFAULT_FATIGUE_POLICY`, in which `hourlyMax` and
 * `defaultCooldownMinutes` are BOTH `undefined`. Measured against a real
 * PostgreSQL: two `REWARD_GRANTED` twenty minutes apart, both delivered, no
 * `COOLDOWN` on either row.
 *
 * So neither number has ever been calibrated against a working implementation,
 * and «the value the tests happen to pass with» is not an argument. Both are
 * KEPT, and here is why each is right rather than merely incumbent:
 *
 *   `defaultCooldownMinutes = 30`, i.e. HALF THE ROLLING HOUR `maxPerHour`
 *   governs. That is what makes the two rules one rule instead of two
 *   competing ones: with a thirty-minute per-type cooldown, ONE type can
 *   contribute at most 2 notifications to any rolling hour — which is exactly
 *   `categoryMaxPerDay` (2), the per-type ceiling this product already chose
 *   for a whole day. A shorter cooldown would let a single misbehaving producer
 *   spend the household's hourly budget on its own; a longer one would start
 *   deciding, silently and terminally, that a child's SECOND real achievement
 *   of the afternoon is not worth mentioning. Thirty minutes is also longer
 *   than any human retry loop and six times the duplicate window (5 min), so
 *   the two rules answer visibly different questions: `DUPLICATE` means «this
 *   is the same event twice», `COOLDOWN` means «this is a second real event too
 *   soon after the first».
 *
 *   `maxPerHour = 3`, i.e. HALF `maxPerDay` (6). A household cannot spend its
 *   entire daily budget in under two hours, which is the burst-then-blackout
 *   shape the hourly rule exists to prevent, and it still permits three
 *   different kinds of genuinely good news in one busy afternoon.
 *
 * BOTH REMAIN PER-FAMILY KNOBS with the bounds declared below. What changed is
 * that setting one now does something.
 */
export const DEFAULT_NOTIFICATION_POLICY: NotificationPolicy = Object.freeze({
  maxPerHour: 3,
  maxPerDay: 6,
  categoryMaxPerDay: 2,
  defaultCooldownMinutes: 30,
  cooldownMinutesByType: Object.freeze({
    HYDRATION_REMINDER: 120,
    STUDY_REMINDER: 90,
    EXERCISE_ENCOURAGEMENT: 180,
  }),
  duplicateWindowMinutes: 5,
  quietHoursStart: '21:00',
  quietHoursEnd: '07:00',
  priorityOverrideTypes: Object.freeze([
    'ACCESSIBILITY_DISABLED',
    'PROTECTION_BYPASS_ATTEMPT',
    'CHILD_WELLBEING_CHECKIN',
  ]),
  suppressedCategories: Object.freeze([]),
  scoring: Object.freeze({
    weightUrgency: 30,
    weightRelevance: 20,
    weightAchievement: 20,
    weightDeadline: 15,
    weightParentPreference: 15,
    penaltyFatigue: 25,
    penaltyDuplicate: 40,
    penaltyQuietHours: 20,
    thresholdHigh: 70,
    thresholdMedium: 45,
    thresholdLow: 25,
  }),
});

export type PolicySettingType = 'INT' | 'TIME' | 'CSV' | 'RATE';

export interface PolicySettingSchema {
  readonly key: string;
  readonly type: PolicySettingType;
  readonly min: number | null;
  readonly max: number | null;
  readonly descriptionAr: string;
}

/**
 * THE CLOSED VOCABULARY. A key not on this list is refused on write, the way
 * `GROWTH_SETTING_SCHEMAS` refuses one — because a settings table that accepts
 * any string is a settings table where a typo silently does nothing forever.
 */
export const NOTIFICATION_POLICY_SCHEMAS: readonly PolicySettingSchema[] = Object.freeze([
  {
    key: 'notification.cap.maxPerHour',
    type: 'INT',
    min: 1,
    max: 20,
    descriptionAr:
      'أقصى عدد إشعارات لطفل واحد خلال ساعة. الافتراضي ٣: الحدّ اليومي وحده كان يسمح بستّة إشعارات في أربع دقائق ثمّ صمتٍ تامّ لبقيّة اليوم.',
  },
  {
    key: 'notification.cap.maxPerDay',
    type: 'INT',
    min: 1,
    max: 50,
    descriptionAr: 'أقصى عدد إشعارات لطفل واحد في يوم الأسرة (business day). الافتراضي ٦ — نفس رقم Sprint 16.',
  },
  {
    key: 'notification.cap.categoryMaxPerDay',
    type: 'INT',
    min: 1,
    max: 20,
    descriptionAr: 'أقصى عدد إشعارات من نفس الفئة (category) في اليوم. الافتراضي ٢.',
  },
  {
    key: 'notification.cooldown.defaultMinutes',
    type: 'INT',
    min: 0,
    max: 1440,
    descriptionAr:
      'فترة التهدئة لأيّ نوع لا يملك قيمة خاصّة. الافتراضي ٣٠ دقيقة: قبل هذه المرحلة كان النوع غير المذكور بلا تهدئة إطلاقًا.',
  },
  {
    key: 'notification.duplicate.windowMinutes',
    type: 'INT',
    min: 1,
    max: 120,
    descriptionAr:
      'نافذة اعتبار الإشعار مكرّرًا. الافتراضي ٥ دقائق، ومساوٍ عمدًا لعرض bucket في `notification-source-key.ts`.',
  },
  {
    key: 'notification.quietHours.start',
    type: 'TIME',
    min: null,
    max: null,
    descriptionAr: 'بداية ساعات الهدوء بتوقيت الأسرة (HH:MM). الافتراضي 21:00.',
  },
  {
    key: 'notification.quietHours.end',
    type: 'TIME',
    min: null,
    max: null,
    descriptionAr: 'نهاية ساعات الهدوء بتوقيت الأسرة (HH:MM). الافتراضي 07:00، وهي اللحظة التي تُطلق فيها الإشعارات المؤجَّلة.',
  },
  {
    key: 'notification.suppressedCategories',
    type: 'CSV',
    min: null,
    max: null,
    descriptionAr: 'فئات أوقفتها الأسرة بالكامل (REWARD, REMINDER, …). فئة SAFETY لا يمكن إيقافها — يتجاهلها المحلّل.',
  },
  {
    key: 'notification.score.thresholdHigh',
    type: 'INT',
    min: 1,
    max: 100,
    descriptionAr: 'الحدّ الذي تصبح عنده الأولوية HIGH. الافتراضي ٧٠.',
  },
  {
    key: 'notification.score.thresholdMedium',
    type: 'INT',
    min: 1,
    max: 100,
    descriptionAr: 'الحدّ الذي تصبح عنده الأولوية MEDIUM. الافتراضي ٤٥.',
  },
  {
    key: 'notification.score.thresholdLow',
    type: 'INT',
    min: 0,
    max: 100,
    descriptionAr: 'أرضيّة الإرسال. أقلّ منها ⇒ SUPPRESS. الافتراضي ٢٥.',
  },
]);

const SCHEMA_BY_KEY: ReadonlyMap<string, PolicySettingSchema> = new Map(
  NOTIFICATION_POLICY_SCHEMAS.map((s) => [s.key, s]),
);

/** `SAFETY` is not switchable. An operator or a parent can silence rewards and
 * reminders; the category that carries «protection is off» is not a preference.
 * Enforced here rather than trusted to the settings UI. */
export const UNSUPPRESSABLE_CATEGORIES: ReadonlySet<string> = new Set(['SAFETY']);

export class NotificationPolicySettingError extends Error {}

const HHMM = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;

/**
 * Validate one stored value. Called on WRITE (so a bad value never reaches the
 * table) and tolerated on READ (so one bad legacy row degrades to the default
 * for that key rather than muting a household).
 */
export function parsePolicySetting(key: string, raw: string): number | string | readonly string[] {
  const schema = SCHEMA_BY_KEY.get(key);
  if (!schema) {
    throw new NotificationPolicySettingError(
      `Unknown notification policy setting "${key}". Settings are a closed vocabulary; add it to NOTIFICATION_POLICY_SCHEMAS.`,
    );
  }
  if (schema.type === 'TIME') {
    if (!HHMM.test(raw)) {
      throw new NotificationPolicySettingError(`Invalid time for "${key}": expected HH:MM, got "${raw}"`);
    }
    return raw;
  }
  if (schema.type === 'CSV') {
    return raw
      .split(',')
      .map((v) => v.trim().toUpperCase())
      .filter((v) => v.length > 0 && !UNSUPPRESSABLE_CATEGORIES.has(v));
  }
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    throw new NotificationPolicySettingError(`Invalid number for "${key}": "${raw}"`);
  }
  if (schema.min !== null && n < schema.min) {
    throw new NotificationPolicySettingError(`Invalid value for "${key}": below minimum ${schema.min}`);
  }
  if (schema.max !== null && n > schema.max) {
    throw new NotificationPolicySettingError(`Invalid value for "${key}": above maximum ${schema.max}`);
  }
  return schema.type === 'INT' ? Math.trunc(n) : n;
}

/**
 * Build the effective policy for one household from the defaults plus whatever
 * rows exist. TOTAL and NEVER THROWING: a stored value that no longer validates
 * (a bound tightened after it was written) falls back to the default for that
 * key alone. The alternative is a household that receives nothing because one
 * row is stale, which is the failure this whole phase is about.
 */
export function resolveNotificationPolicy(
  overrides: Readonly<Record<string, string>> = {},
): NotificationPolicy {
  const base = DEFAULT_NOTIFICATION_POLICY;
  const read = <T>(key: string, fallback: T): T => {
    const raw = overrides[key];
    if (raw === undefined) return fallback;
    try {
      return parsePolicySetting(key, raw) as unknown as T;
    } catch {
      return fallback;
    }
  };

  const scoring: NotificationScoringConfig = {
    ...base.scoring,
    thresholdHigh: read('notification.score.thresholdHigh', base.scoring.thresholdHigh),
    thresholdMedium: read('notification.score.thresholdMedium', base.scoring.thresholdMedium),
    thresholdLow: read('notification.score.thresholdLow', base.scoring.thresholdLow),
  };

  return Object.freeze({
    maxPerHour: read('notification.cap.maxPerHour', base.maxPerHour),
    maxPerDay: read('notification.cap.maxPerDay', base.maxPerDay),
    categoryMaxPerDay: read('notification.cap.categoryMaxPerDay', base.categoryMaxPerDay),
    defaultCooldownMinutes: read('notification.cooldown.defaultMinutes', base.defaultCooldownMinutes),
    cooldownMinutesByType: base.cooldownMinutesByType,
    duplicateWindowMinutes: read('notification.duplicate.windowMinutes', base.duplicateWindowMinutes),
    quietHoursStart: read('notification.quietHours.start', base.quietHoursStart),
    quietHoursEnd: read('notification.quietHours.end', base.quietHoursEnd),
    priorityOverrideTypes: base.priorityOverrideTypes,
    suppressedCategories: read<readonly string[]>(
      'notification.suppressedCategories',
      base.suppressedCategories,
    ),
    scoring,
  });
}

/**
 * THE BRIDGE TO THE EXISTING GUARD.
 *
 * This is the whole of «reuse the fatigue guard rather than replace it»: the
 * configured policy becomes the guard's own input type, and `evaluateFatigue` is
 * still the function that answers. The four fields the guard gained in F6
 * (`hourlyMax`, `defaultCooldownMinutes`, `duplicateWindowMs`,
 * `unlistedTypeCooldown`) are OPTIONAL there, so every existing caller —
 * including `QuietHoursReleaseService`, which passes no policy at all — keeps
 * `DEFAULT_FATIGUE_POLICY`'s exact previous behaviour.
 */
/**
 * ============================================================================
 * THE ONE TYPE WHOSE TWO OCCURRENCES ARE NEVER A REPEAT.
 * ============================================================================
 *
 * SPRINT F1, written the moment `defaultCooldownMinutes` stopped being inert.
 *
 * `DAILY_GOAL_COMPLETED` is the only type in this product whose two occurrences
 * are GUARANTEED to be two different facts. The product has exactly two daily
 * goals — the hydration target and the activity target, both crossed and
 * measured by `HealthEngineService`, both named in `notification-nouns.ts`,
 * whose header carries the evidence that those two are the whole list. A child
 * who drinks their water and then goes running has done TWO things, and a
 * cooldown keyed on the TYPE could only ever silence the second of them.
 * MEASURED: `test/notifications/daily-goal-completed.e2e.spec.ts §2.2` fires
 * both crossings and demands both messages, and it is the test that made this
 * decision necessary rather than theoretical.
 *
 * IT IS THE SAME PRINCIPLE `DUPLICATE_PENALTY` WAS FIXED ON — «THIS EXACT
 * THING» IS A CAUSE, NOT A TYPE — applied to the one type where a type-keyed
 * cooldown would have re-opened it. Stated per type rather than by weakening
 * `defaultCooldownMinutes`, because for every OTHER type in this product a
 * second occurrence inside thirty minutes really is a repeat.
 *
 * AND THE TYPE IS STILL BOUNDED WITHOUT IT: `categoryMaxPerDay` is 2, which is
 * exactly the number of daily goals that exist, so this type cannot produce a
 * third message in one day whatever this table says.
 *
 * WHY IT IS NOT IN `DEFAULT_NOTIFICATION_POLICY.cooldownMinutesByType`.
 * `notification-policy.spec.ts` pins that map BYTE-FOR-BYTE to the pre-F6
 * `DEFAULT_FATIGUE_POLICY`, and that invariant is about the BRIDGE: every
 * caller reached through `toFatiguePolicy` must see exactly the numbers Sprint
 * 16 shipped. This exemption belongs to the NEW gate that enforces the cooldown
 * for the first time, so it is applied there — by name, once — and the bridge
 * keeps its guarantee.
 */
export const COOLDOWN_EXEMPT_TYPES: Readonly<Record<string, number>> = Object.freeze({
  DAILY_GOAL_COMPLETED: 0,
});

/**
 * ============================================================================
 * THE TYPES WHOSE OCCURRENCE CANNOT COME BACK, AND THE DATABASE FACT THAT SAYS
 * SO PER ENTRY.
 * ============================================================================
 *
 * WHAT WAS MEASURED, from persisted `notification_decisions` rows against a
 * real PostgreSQL, at `maxPerHour = 3`. A twelve-year-old crossed their
 * hydration goal at 12:00 and their activity goal at 12:05. The hydration
 * crossing spent the whole hour on the CHILD's own inbox:
 *
 *   BADGE_EARNED          aud=CHILD  SEND  score=42  fatigue  0      today=0/6 hour=0/3
 *   REWARD_GRANTED_CHILD  aud=CHILD  SEND  score=30  fatigue −8.33   today=1/6 hour=1/3
 *   DAILY_GOAL_COMPLETED  aud=CHILD  SEND  score=26  fatigue −16.67  today=2/6 hour=2/3
 *
 * and then the activity crossing arrived into a full hour:
 *
 *   BADGE_EARNED          aud=CHILD  SUPPRESS SCORE_BELOW_FLOOR score=17
 *                                    fatigue −25  today=3/6 hour=3/3 category=1/2
 *   BADGE_EARNED_PARENT   aud=PARENT SEND     score=25
 *                                    fatigue −16.67 today=2/6 hour=2/3 category=1/2
 *
 * THE TWO BADGES ARE NOT THE SAME BADGE. `first_hydration_goal` and
 * `first_activity_goal` are two different rows of `badge_definitions`, awarded
 * once each in this child's entire life. The child was told about neither the
 * second badge nor anything else that afternoon; the PARENT's row for the very
 * same badge scored eight points higher purely because the parent's inbox had
 * been quieter, and was decided SEND.
 *
 * A DAILY RECEIPT LOSING TO VOLUME IS RIGHT. A ONCE-EVER BADGE LOSING TO
 * ARRIVAL ORDER IS NOT. `DAILY_GOAL_COMPLETED` at 12:05 can be earned again
 * tomorrow; `REWARD_GRANTED_CHILD` names a grant the child can earn again this
 * afternoon. `first_activity_goal` happens exactly once and is then gone
 * forever — so a cap whose whole purpose is «you have heard enough of THIS
 * KIND of thing lately» is answering a question that does not apply, and the
 * cost of its wrong answer is permanent rather than a deferral.
 *
 * ---------------------------------------------------------------------------
 * WHAT «ONCE-EVER» IS ALLOWED TO MEAN HERE, AND WHY IT IS A DATABASE FACT.
 * ---------------------------------------------------------------------------
 *
 * `child_badge_awards (child_id, badge_id)` is UNIQUE, and
 * `RewardsEngineService` writes the ledger row, the timeline entry and the two
 * notifications ONLY when that insert actually succeeded. So «this child will
 * never see this notification again» is enforced by PostgreSQL, not asserted
 * by a copy-writer. THAT is the bar for a row in this table, and every entry
 * below therefore names the constraint that holds it up. `badge-catalogue.ts`
 * makes the same argument from the other side: every badge in the product is a
 * FIRST-TIME milestone precisely because the unique constraint is the only
 * badge shape the engine can express correctly.
 *
 * THE CANDIDATES THAT WERE CONSIDERED AND REFUSED, because a table like this
 * is only narrow if the refusals are written down too:
 *
 *   `LEVEL_UP`               recurs. A child reaches level 2, then 3, then 4;
 *                            `ACHIEVEMENT_BASELINE_BY_TYPE` gives it the same
 *                            0.75 as a badge, which is exactly the «high
 *                            achievement value» predicate this table refuses to
 *                            be. Value is not permanence.
 *   `STREAK_ACHIEVED`        recurs — `HealthEngineService` fires it at 3, 7,
 *                            14 and 30 days, and again on the next streak.
 *   `LEARNING_GOAL_ACHIEVED` recurs per goal, and a child may create goals
 *                            without limit.
 *   `DAILY_GOAL_COMPLETED`   recurs by definition; it is `COOLDOWN_EXEMPT_TYPES`'
 *                            entry for a DIFFERENT reason (two goals in one
 *                            day, not one fact in one lifetime) and it must
 *                            keep taking the fatigue penalty. It is the CONTROL
 *                            that proves this exemption is narrow.
 *   `ACHIEVEMENT_VERIFIED`   recurs; a parent verifies many achievements.
 *
 * ---------------------------------------------------------------------------
 * WHY THE EXEMPTION IS FROM ALL THREE LOADS AND NOT ONLY THE HOUR.
 * ---------------------------------------------------------------------------
 *
 * The hour is where it was measured, but the hour is not what is wrong with it.
 * What is wrong is that a VOLUME reading is being used to rank a fact that has
 * no second chance, and the day (`maxPerDay = 6`) and the per-type day
 * (`categoryMaxPerDay = 2`) are volume readings too. Exempting only `hourLoad`
 * would move the same defect to a busy day and to a child who earns their third
 * first-ever badge on the afternoon they discover the app — the identical
 * report, one axis over, and no better argument for keeping it.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS DOES NOT WEAKEN THE ANTI-SPAM GUARD, AND THE BOUND IS THE SAME
 * CONSTRAINT.
 * ---------------------------------------------------------------------------
 *
 * A child buried in notifications is a real harm, and an exemption with no
 * ceiling would be a hole. This one has a ceiling, and it is the SAME UNIQUE
 * INDEX that earned the exemption: `child_badge_awards (child_id, badge_id)`
 * times the number of rows in `badge_definitions`. That is `lifetimeMaxPerChild`
 * below — nine messages, per audience, in a childhood. Not nine per day, per
 * week or per year. Every OTHER type this child can receive keeps every cap it
 * had, and a badge is still subject to the DUPLICATE rule and to both unique
 * delivery indexes.
 *
 * ---------------------------------------------------------------------------
 * QUIET HOURS ARE DELIBERATELY NOT EXEMPTED, AND THAT IS NOT AN OVERSIGHT.
 * ---------------------------------------------------------------------------
 *
 * DEFERRAL IS NOT LOSS. `notification-class.ts` already classes both badge
 * types `DEFER` with the sentence this whole file agrees with — «a badge is
 * permanent; seeing it at 07:00 is the product working; never seeing it is the
 * product lying about a reward it granted». A badge held until 07:00 is still
 * told, so quiet hours cost the child nothing that matters, whereas waking a
 * nine-year-old at 02:30 to say «you earned a badge» is the exact harm the
 * window exists to prevent. Promoting a badge to the DELIVER class would also
 * put it beside `PROTECTION_BYPASS_ATTEMPT`, which is a claim about SAFETY that
 * a badge cannot make.
 *
 * `QUIET_HOURS_PENALTY` therefore still applies to these types in full, and the
 * verdict is still DEFER. The provider's `scoreOnArrival` already computes the
 * band on the score the notification will carry in the MORNING, so the quiet
 * hours cannot turn that deferral into a suppression — which is the only thing
 * that would have made an exemption necessary here.
 */
export interface OnceEverGuarantee {
  /** The database object whose UNIQUE constraint makes a second occurrence
   * impossible. Not prose: the row a support engineer can go and read. */
  readonly enforcedBy: string;
  /** Why that constraint means THIS notification cannot come round again. */
  readonly reason: string;
  /** How many of this type one child can receive in a lifetime, given that
   * constraint. The ceiling that keeps the exemption from being a hole. */
  readonly lifetimeMaxPerChild: number;
}

export const ONCE_EVER_TYPES: Readonly<Record<string, OnceEverGuarantee>> = Object.freeze({
  BADGE_EARNED: Object.freeze({
    enforcedBy: 'child_badge_awards (child_id, badge_id) UNIQUE',
    reason:
      'The child half of a badge. RewardsEngineService notifies only when the INSERT into child_badge_awards actually succeeded, so this exact sentence about this exact badge can reach this child once and never again. Every badge in badge-catalogue.ts is a first-time milestone for precisely this reason.',
    lifetimeMaxPerChild: 9,
  }),
  BADGE_EARNED_PARENT: Object.freeze({
    enforcedBy: 'child_badge_awards (child_id, badge_id) UNIQUE',
    reason:
      'The parent half of the same award, issued from the same successful INSERT under the same badgeKey. It is listed for the SAME guarantee rather than by association: leaving it out would keep the asymmetry alive pointing the other way, because a parent inbox that happened to be the busy one would then lose a badge the child was told about.',
    lifetimeMaxPerChild: 9,
  }),
});

/** Is this type one whose occurrence a UNIQUE constraint guarantees cannot
 * recur? Read by the scorer's fatigue term and by the engine's cap gate, so the
 * two layers cannot disagree about which types the table names. */
export function isOnceEverType(type: string): boolean {
  return Object.prototype.hasOwnProperty.call(ONCE_EVER_TYPES, type);
}

/**
 * The cooldown exemption the once-ever table implies, in
 * `cooldownMinutesByType`'s own shape so the gate applies both tables the same
 * way.
 *
 * MEASURED, in the same run as the fatigue defect above: the parent's second
 * badge of the afternoon was decided SEND and then refused at the gate with
 * `outcome_reason = COOLDOWN`, because `defaultCooldownMinutes = 30` is keyed
 * on the TYPE and both badges are `BADGE_EARNED_PARENT`. That is
 * `COOLDOWN_EXEMPT_TYPES`' own argument — «a cooldown keyed on the TYPE could
 * only ever silence the second of them» — arriving at a type where the second
 * one is not merely a different fact but an unrepeatable one.
 */
export const ONCE_EVER_COOLDOWN_EXEMPTIONS: Readonly<Record<string, number>> = Object.freeze(
  Object.fromEntries(Object.keys(ONCE_EVER_TYPES).map((type) => [type, 0])),
);

export function toFatiguePolicy(policy: NotificationPolicy): IFatiguePolicy {
  return {
    cooldownMinutesByType: policy.cooldownMinutesByType,
    dailyMax: policy.maxPerDay,
    categoryDailyMax: policy.categoryMaxPerDay,
    quietHoursStart: policy.quietHoursStart,
    quietHoursEnd: policy.quietHoursEnd,
    hourlyMax: policy.maxPerHour,
    defaultCooldownMinutes: policy.defaultCooldownMinutes,
    duplicateWindowMs: policy.duplicateWindowMinutes * 60_000,
  };
}
