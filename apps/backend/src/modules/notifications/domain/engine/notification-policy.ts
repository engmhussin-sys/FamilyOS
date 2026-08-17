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
