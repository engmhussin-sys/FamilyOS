/**
 * THE BADGE CATALOGUE — the reference data `badge_definitions` never had.
 *
 * ===========================================================================
 * WHAT WAS WRONG, MEASURED AGAINST A REAL DATABASE BEFORE THIS FILE EXISTED.
 * ===========================================================================
 *
 * `badge_definitions` had NO WRITER anywhere: no seed, no INSERT in migrations
 * 0001..0025, no admin route. `findBadgeByKey`
 * (`prisma-rewards.repository.ts:327`) therefore returned `null` for every key
 * it was ever asked for, and `awardBadgeIfNotAlready` two lines below it —
 * live, correct, guarded by a real UNIQUE constraint — was unreachable with a
 * real badge id. `test/architecture/dormant-schema.guard.spec.ts` declares the
 * table DEFERRED_FEATURE for exactly this reason.
 *
 * THE AUDIT UNDERSTATED IT. The catalogue was only half the hole. The ONLY
 * code path that can award a badge is `RewardsEngineService.processTriggerEvent`
 * handling a grant whose `rewardType === 'BADGE'`, and such a grant can only
 * come from a `RewardRule` with `reward_type = 'BADGE'`. There were ZERO of
 * those too, and there was no way to create one:
 *
 *   - `CreateRewardRuleDto.rewardType` is `@IsIn(['XP', 'COINS'])`, with a
 *     comment saying BADGE is withheld precisely because no badge catalogue
 *     exists — the two gaps were each other's stated justification.
 *   - The F4 companion-rule writer (`prisma-reward-program.repository.ts:89`)
 *     derives its reward type from `RewardSpec`, and `PROGRAM_REWARD_TYPES`
 *     has no BADGE member.
 *   - Migration 0007 seeded 16 platform defaults, all XP or COINS.
 *
 * So seeding definitions alone would have produced a catalogue nobody looks
 * up — the same defect pointing the other way. THE DEFINITIONS AND THE DEMAND
 * FOR THEM LAND TOGETHER, in one migration, from this one list, and
 * `test/rewards/badge-catalogue.e2e.spec.ts` fails if either side grows a row
 * the other does not have.
 *
 * ===========================================================================
 * WHY A MIGRATION AND NOT A RUNTIME SERVICE.
 * ===========================================================================
 *
 * A badge definition is DEPLOYMENT-LEVEL reference data, not tenant data:
 * `badge_definitions` has no `family_id` and no RLS policy, one row is shared
 * by every family in every country, and `child_badge_awards (child_id,
 * badge_id)` is UNIQUE — so a child earns a given badge exactly once, ever,
 * and the identity of that badge must be stable across the whole fleet. That
 * is the same shape as `countries` and `currencies` (migration 0014),
 * `quran_surahs` and `reward_program_categories` (0006), the platform reward
 * rules (0007) and `scheduled_jobs` (0011, 0015, 0016, 0024) — every one of
 * them seeded by a migration from a framework-free TypeScript list exactly
 * like this one, and re-runnable by `ON CONFLICT`.
 *
 * ===========================================================================
 * BILINGUAL COPY, AND WHY ARABIC IS THE COLUMN.
 * ===========================================================================
 *
 * `notification-copy.ts` rule 1: «ARABIC IS FIRST-CLASS, not a translation.
 * `ar` is the fallback locale, and an `en` variant that is missing falls back
 * to `ar`, never the other way round.» This file keeps the same
 * `Record<locale, {title, description}>` shape for the same reason.
 *
 * `BadgeDefinition` has ONE `title` column and ONE `description` column, and
 * both of them are rendered verbatim to a child: `GET
 * /self/achievements/badges` returns `row.badge.title` and the child app prints
 * it with no catalogue of its own, and `rewards-engine.service.ts` feeds the
 * same string into `BADGE_EARNED` / `BADGE_EARNED_PARENT` as `{badgeTitle}` —
 * inside an Arabic sentence. THE SEEDED COLUMN IS THEREFORE THE ARABIC ONE.
 * The English copy lives here, next to it, in the shape the render path would
 * need on the day one of those two readers takes a locale; it is deliberately
 * NOT a second pair of columns, because a column no reader can reach is the
 * dormant-schema defect this whole exercise is about.
 *
 * ===========================================================================
 * THE SET, AND THE PRODUCT DECISION BEHIND IT.
 * ===========================================================================
 *
 * Every badge here is a FIRST-TIME MILESTONE, one per domain the platform
 * already pays for. That is not a stylistic choice — it is the only badge
 * shape the existing engine can express correctly:
 *
 *   `awardBadgeIfNotAlready` inserts into `child_badge_awards`, whose
 *   `(child_id, badge_id)` UNIQUE constraint refuses the second insert, and
 *   `rewards-engine.service.ts` only writes a ledger row, a timeline entry and
 *   a notification when that insert actually succeeded. A rule that fires on
 *   every habit completion therefore pays its badge on the FIRST one and is
 *   silently idempotent forever after — «first habit» is what the database
 *   already enforces, so it is what the badge should say.
 *
 * A counter badge («30 habits») would need a count the engine never computes,
 * and a code-level check-then-insert to award it — the exact anti-pattern the
 * unique constraint exists to avoid. Those are a separate feature, not a row
 * in this list.
 *
 * `isGroupAchievement` is FALSE on every row, deliberately and not by default.
 * The flag has one reader — `prisma-digital-twin.repository.ts:23` counts
 * awards of group badges into the family's collaboration signal — and the only
 * thing that could earn one is `FamilyChallenge`, which
 * `dormant-schema.guard.spec.ts` declares DEFERRED_FEATURE because no module
 * can create a challenge. Seeding a group badge today would seed a badge no
 * child could ever be awarded.
 */

import type { RuleEngine, RuleEventType } from './reward-rule-catalogue';

/** The two locales the notification pipeline already renders. Kept structurally
 * identical to `notification-copy.ts`'s `LocalisedTemplate`. */
export type BadgeLocale = 'ar' | 'en';

export interface BadgeCopy {
  /** What the child reads. Short enough to sit inside «كسبت وسام {badgeTitle} 🏅». */
  readonly title: string;
  /** One warm sentence naming what they actually did. Never «أحسنت!» alone. */
  readonly description: string;
}

/**
 * What earns the badge, in machine-readable form. Seeded into
 * `badge_definitions.criteria`, which was otherwise going to be `{}`.
 *
 * It is not decoration: `badge-catalogue.e2e.spec.ts` asserts that the
 * `(triggerEngine, eventType, triggerCondition)` written here matches a real
 * `reward_rules` row with `reward_type = 'BADGE'` and this badge's key, so a
 * badge whose criteria describe a trigger nothing fires fails the build.
 */
export interface BadgeCriteria {
  /** FIRST — awarded on the first qualifying completion, enforced by the
   * `(child_id, badge_id)` unique constraint rather than by a count. */
  readonly occurrence: 'FIRST';
  readonly triggerEngine: RuleEngine;
  readonly eventType: RuleEventType;
  readonly triggerCondition: Readonly<Record<string, string | number | boolean>>;
  /** How the row gets written. The only mechanism that exists today. */
  readonly awardedBy: 'platform_reward_rule';
}

export interface BadgeDefinitionSeed {
  /** `badge_definitions.key` — UNIQUE, and the value a `RewardRule` stores in
   * `reward_amount_or_badge_id`. Stable forever: it is the join between a rule
   * and a definition, and renaming it would orphan every award. */
  readonly key: string;
  readonly copy: Readonly<Record<BadgeLocale, BadgeCopy>>;
  readonly criteria: BadgeCriteria;
  readonly isGroupAchievement: boolean;
  /** Which reward category the badge's rule is filed under, so a parent
   * browsing `/reward-rules` sees badges beside the XP rules for the same
   * domain. FK into `reward_program_categories.code`. */
  readonly category: string;
  /** The rule's Arabic label in the parent's rule list. */
  readonly ruleLabelAr: string;
}

export const PLATFORM_BADGES: readonly BadgeDefinitionSeed[] = [
  // ---- Habits -------------------------------------------------------------
  {
    key: 'first_habit',
    copy: {
      ar: {
        title: 'أول عادة',
        description: 'أتممت أول عادة لك. البداية أصعب خطوة، وقد قطعتها.',
      },
      en: {
        title: 'First Habit',
        description: 'You finished your very first habit. Starting is the hardest part, and you did it.',
      },
    },
    criteria: {
      occurrence: 'FIRST',
      triggerEngine: 'habit-builder',
      eventType: 'HABIT_COMPLETED',
      triggerCondition: {},
      awardedBy: 'platform_reward_rule',
    },
    isGroupAchievement: false,
    category: 'HABITS',
    ruleLabelAr: 'وسام أول عادة',
  },
  {
    key: 'first_streak',
    copy: {
      ar: {
        title: 'سلسلة لا تنقطع',
        description: 'واصلت عادتك أيامًا متتالية. الاستمرار هو ما يصنع الفرق.',
      },
      en: {
        title: 'Streak Started',
        description: 'You kept a habit going several days in a row. Sticking with it is what counts.',
      },
    },
    criteria: {
      occurrence: 'FIRST',
      triggerEngine: 'habit-builder',
      eventType: 'STREAK_ACHIEVED',
      triggerCondition: {},
      awardedBy: 'platform_reward_rule',
    },
    isGroupAchievement: false,
    category: 'HABITS',
    ruleLabelAr: 'وسام أول سلسلة متصلة',
  },
  // ---- Smart Tasks --------------------------------------------------------
  {
    key: 'first_task',
    copy: {
      ar: {
        title: 'يد تساعد',
        description: 'أنجزت أول مهمة في البيت. مساعدتك ملحوظة ومقدَّرة.',
      },
      en: {
        title: 'Helping Hand',
        description: 'You finished your first task at home. Your help was noticed.',
      },
    },
    criteria: {
      occurrence: 'FIRST',
      triggerEngine: 'smart-tasks',
      eventType: 'TASK_COMPLETED',
      triggerCondition: {},
      awardedBy: 'platform_reward_rule',
    },
    isGroupAchievement: false,
    category: 'FAMILY_CONTRIBUTION',
    ruleLabelAr: 'وسام أول مهمة',
  },
  // ---- Health / Hydration / Activity --------------------------------------
  {
    key: 'first_hydration_goal',
    copy: {
      ar: {
        title: 'كأس بعد كأس',
        description: 'أكملت هدف الماء ليوم كامل. جسمك يشكرك على ذلك.',
      },
      en: {
        title: 'Cup After Cup',
        description: 'You hit your water goal for a whole day. Your body thanks you.',
      },
    },
    criteria: {
      occurrence: 'FIRST',
      triggerEngine: 'health',
      eventType: 'HYDRATION_GOAL_COMPLETED',
      triggerCondition: {},
      awardedBy: 'platform_reward_rule',
    },
    isGroupAchievement: false,
    category: 'HEALTH',
    ruleLabelAr: 'وسام أول هدف ماء',
  },
  {
    key: 'first_activity_goal',
    copy: {
      ar: {
        title: 'جسم يتحرك',
        description: 'بلغت هدف نشاطك اليومي لأول مرة. حركتك اليوم كانت كافية.',
      },
      en: {
        title: 'On the Move',
        description: 'You reached your daily activity goal for the first time. Today you moved enough.',
      },
    },
    criteria: {
      occurrence: 'FIRST',
      triggerEngine: 'health',
      eventType: 'ACTIVITY_GOAL_COMPLETED',
      triggerCondition: {},
      awardedBy: 'platform_reward_rule',
    },
    isGroupAchievement: false,
    category: 'FITNESS',
    ruleLabelAr: 'وسام أول هدف نشاط',
  },
  // ---- Education / Learning ----------------------------------------------
  {
    key: 'first_study_session',
    copy: {
      ar: {
        title: 'أول جلسة مذاكرة',
        description: 'أنهيت أول جلسة تعلّم كاملة. التركيز مهارة، وقد بدأت تتقنها.',
      },
      en: {
        title: 'First Study Session',
        description: 'You finished a full study session. Focus is a skill, and you have started building it.',
      },
    },
    criteria: {
      occurrence: 'FIRST',
      triggerEngine: 'learning',
      eventType: 'EDUCATION_TASK_COMPLETED',
      triggerCondition: {},
      awardedBy: 'platform_reward_rule',
    },
    isGroupAchievement: false,
    category: 'STUDY',
    ruleLabelAr: 'وسام أول جلسة تعلّم',
  },
  {
    key: 'first_learning_goal',
    copy: {
      ar: {
        title: 'هدف محقَّق',
        description: 'وصلت إلى أول هدف تعليمي وضعته لنفسك. خطّطت ثم أتممت.',
      },
      en: {
        title: 'Goal Reached',
        description: 'You reached the first learning goal you set for yourself. You planned it, then you finished it.',
      },
    },
    criteria: {
      occurrence: 'FIRST',
      triggerEngine: 'learning',
      eventType: 'LEARNING_GOAL_ACHIEVED',
      triggerCondition: {},
      awardedBy: 'platform_reward_rule',
    },
    isGroupAchievement: false,
    category: 'STUDY',
    ruleLabelAr: 'وسام أول هدف تعليمي',
  },
  // ---- Faith / Quran ------------------------------------------------------
  {
    key: 'first_memorization',
    copy: {
      ar: {
        title: 'أول ما حفظت',
        description: 'أتممت أول مقطع حفظ. ما تحفظه يبقى معك.',
      },
      en: {
        title: 'First Memorised',
        description: 'You completed your first memorisation. What you memorise stays with you.',
      },
    },
    criteria: {
      occurrence: 'FIRST',
      triggerEngine: 'faith',
      eventType: 'MEMORIZATION_COMPLETED',
      triggerCondition: {},
      awardedBy: 'platform_reward_rule',
    },
    isGroupAchievement: false,
    category: 'QURAN',
    ruleLabelAr: 'وسام أول حفظ',
  },
  {
    key: 'first_faith_practice',
    copy: {
      ar: {
        title: 'أول خطوة',
        description: 'سجّلت أول عبادة لك. القليل الدائم خير من الكثير المنقطع.',
      },
      en: {
        title: 'First Step',
        description: 'You logged your first act of worship. A little, kept up, beats a lot done once.',
      },
    },
    criteria: {
      occurrence: 'FIRST',
      triggerEngine: 'faith',
      eventType: 'FAITH_PRACTICE_COMPLETED',
      triggerCondition: {},
      awardedBy: 'platform_reward_rule',
    },
    isGroupAchievement: false,
    category: 'RELIGION',
    ruleLabelAr: 'وسام أول عبادة',
  },
];

/**
 * Deterministic UUIDs for the seeded definitions, so the migration is
 * re-runnable and a test can assert a specific row. Same discipline as
 * `platformRuleId`, in its own block so the two id spaces cannot collide:
 * `00000000-0000-4b41-8000-0000000000NN` — version nibble 4, variant nibble 8,
 * `4b41` where the rules use `4b40`.
 */
export function platformBadgeId(index: number): string {
  const suffix = index.toString(16).padStart(12, '0');
  return `00000000-0000-4b41-8000-${suffix}`;
}

const BADGE_KEY_SET: ReadonlySet<string> = new Set(PLATFORM_BADGES.map((b) => b.key));

/** Used by the ratchet test and by anything that wants to reject an unknown
 * key before it reaches a query that would simply return `null`. */
export function isPlatformBadgeKey(value: string): boolean {
  return BADGE_KEY_SET.has(value);
}

export function findPlatformBadge(key: string): BadgeDefinitionSeed | undefined {
  return PLATFORM_BADGES.find((b) => b.key === key);
}
