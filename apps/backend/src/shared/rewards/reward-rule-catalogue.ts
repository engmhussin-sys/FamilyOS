/**
 * THE REWARD-RULE CATALOGUE — B4 (PA-B-015).
 *
 * WHAT WAS WRONG. `RewardRule` had exactly one writer in the whole backend:
 * `prisma-reward-program.repository.ts:111`, which materialises companion rows
 * for an F4 `RewardProgram`. There was no controller, no seed and no INSERT in
 * any migration. `RewardsEngineService.processTriggerEvent` therefore ran
 * `evaluateRewardRules([], event)` on every habit, hydration, activity, faith
 * and education completion in production and returned 0 — and because
 * `RewardsCompletionConsumer` emits `REWARD_GRANTED` only inside
 * `if (granted > 0)`, the whole chain after it was dead too: no ledger row, no
 * timeline entry, no notification. Seven domains were wired end to end and
 * granted nothing.
 *
 * WHAT THIS FILE IS. The framework-free source of truth for:
 *   1. `RULE_EVENT_TYPES`  — which event types a rule may be written against.
 *   2. `RULE_ENGINES`      — which engines exist (the `trigger_engine` column).
 *   3. `PLATFORM_DEFAULT_REWARD_RULES` — the rules every family gets for free.
 *
 * Same discipline as `program-taxonomy.ts`: the code copy validates a request
 * without a round trip, migration `0007` seeds the database copy FROM this
 * list, and `test/rewards/reward-rule-catalogue.spec.ts` asserts the two are
 * identical row for row so they cannot drift.
 *
 * SEEDED-PER-FAMILY vs RESOLVED-LAZILY — THE DECISION, AND WHY.
 * The defaults below are inserted ONCE, with `family_id IS NULL`, and resolved
 * lazily at evaluation time. They are NOT copied into each family on family
 * creation. Three reasons, in order of weight:
 *
 *   1. THE READ PATH ALREADY DID IT. `listActiveRewardRules` has always
 *      selected `OR: [{ familyId }, { familyId: null }]`, and `RewardRule` is
 *      registered SHARED_NULL in `tenant-model-registry.ts:117` precisely so a
 *      platform row is visible to every tenant. Seeding per family would have
 *      built a second mechanism next to one that already works — CONTEXT §3
 *      principle 1.
 *   2. RETROACTIVITY. A per-family copy reaches only families created after the
 *      copy exists. Every family already in the database would have kept
 *      granting nothing, which is the exact defect being closed.
 *   3. ONE ROW TO FIX. Correcting a default value is one UPDATE, not one UPDATE
 *      per family, and it takes effect on the next completion.
 *
 * The cost of lazy resolution is that a family cannot "edit a default" in
 * place. It does not need to: `RewardRuleService.create` writes a FAMILY-OWNED
 * rule, and `selectApplicableRules` gives family-owned rules precedence over
 * platform rules for the same engine (see `rewards-rules.ts`). Configuring one
 * rule for an engine is how a family takes ownership of that engine's policy.
 */

import { PLATFORM_BADGES } from './badge-catalogue';

/**
 * The engines a rule may be attached to. These are the values already written
 * into `RewardRule.trigger_engine` by the existing producers
 * (`COMPLETION_KIND_TO_REWARD_ENGINE` in `shared/events/completion-event.ts`
 * and the F4 companion-row writer) — this list REUSES them, it does not invent
 * a parallel vocabulary.
 */
export const RULE_ENGINES = [
  'habit-builder',
  'health',
  'learning',
  'faith',
  'smart-tasks',
  'reward-program',
] as const;

export type RuleEngine = (typeof RULE_ENGINES)[number];

const RULE_ENGINE_SET: ReadonlySet<string> = new Set(RULE_ENGINES);

export function isRuleEngine(value: string): value is RuleEngine {
  return RULE_ENGINE_SET.has(value);
}

/**
 * THE ALLOW-LIST, AND WHY IT IS AN ALLOW-LIST.
 *
 * Every entry here is an event type whose producer composes a DETERMINISTIC
 * idempotency key from server-known values. The engine refuses to grant a
 * type-scoped rule when the trigger carries no key (`rewards-rules.ts`), so
 * putting a keyless event type in this list would be the only way to reopen
 * PA-B-013 — and it cannot be done by configuration, only by editing this file
 * under review.
 *
 * The legacy, KEYLESS trigger names still emitted by the domain engines for
 * backwards compatibility (`habit_completed`, `hydration_event`,
 * `practice_logged`) are DELIBERATELY ABSENT. No managed rule can ever be
 * written against them, so the same real-world completion can no longer be paid
 * twice — once through the keyed name and once through the keyless one.
 */
export const RULE_EVENT_TYPES = [
  // -- the completion catalogue (`shared/events/event-types.ts`) --
  'HABIT_COMPLETED',
  'TASK_COMPLETED',
  'DAILY_GOAL_COMPLETED',
  'HYDRATION_GOAL_COMPLETED',
  'ACTIVITY_GOAL_COMPLETED',
  'EDUCATION_PROGRESS',
  'MEMORIZATION_COMPLETED',
  'STREAK_ACHIEVED',
  'ACHIEVEMENT_VERIFIED',
  // -- keyed engine-internal names, emitted by the direct `IRewardTriggerWriter`
  //    seam the domain services call on the `/self/*` and parent routes --
  'EDUCATION_TASK_COMPLETED',
  'FAITH_PRACTICE_COMPLETED',
  'LEARNING_GOAL_ACHIEVED',
] as const;

export type RuleEventType = (typeof RULE_EVENT_TYPES)[number];

const RULE_EVENT_TYPE_SET: ReadonlySet<string> = new Set(RULE_EVENT_TYPES);

export function isRuleEventType(value: string): value is RuleEventType {
  return RULE_EVENT_TYPE_SET.has(value);
}

/**
 * How much evidence a rule demands before it pays. Ranked, because the check is
 * "at least this strong", not "exactly this".
 *
 * The values are `CompletionEvent.verifiedBy`'s own union — reused, not
 * redefined. `SELF` is the product's normal case (a child ticks their own
 * habit); a parent who wants a stronger bar sets `minVerifiedBy: 'PARENT'` on
 * the rule and the engine stops paying for self-asserted completions.
 */
export const VERIFICATION_RANK: Readonly<Record<string, number>> = {
  SELF: 0,
  SENSOR: 1,
  SYSTEM: 2,
  PARENT: 3,
};

export const MIN_VERIFIED_BY_VALUES = ['SELF', 'SENSOR', 'SYSTEM', 'PARENT'] as const;
export type MinVerifiedBy = (typeof MIN_VERIFIED_BY_VALUES)[number];

/** Bounds on what a parent may configure. Not taste — a rule paying 100,000 XP
 * per habit tick would make every level threshold meaningless in one day. */
export const RULE_AMOUNT_MIN = 1;
export const RULE_AMOUNT_MAX = 1000;
export const RULE_MAX_PER_DAY_MAX = 50;
export const RULE_MAX_PER_WEEK_MAX = 200;
/** How many family-owned rules one family may hold. A cap, not a product
 * limit: it bounds the per-completion evaluation cost. */
export const RULE_MAX_PER_FAMILY = 60;

interface RewardRuleDefaultBase {
  /** Stable, human-readable id — also the seed row's deterministic UUID input. */
  readonly key: string;
  readonly triggerEngine: RuleEngine;
  readonly eventType: RuleEventType;
  readonly triggerCondition: Readonly<Record<string, string | number | boolean>>;
  readonly maxPerDay: number | null;
  readonly maxPerWeek: number | null;
  /** FK into `reward_program_categories.code` — a TABLE, never an enum. */
  readonly category: string;
  readonly labelAr: string;
}

/** XP and COINS pay a NUMBER, and `reward_amount_or_badge_id` holds its decimal
 * form. Bounded by `RULE_AMOUNT_MIN`/`MAX`. */
export interface AmountRewardRuleDefault extends RewardRuleDefaultBase {
  readonly rewardType: 'XP' | 'COINS';
  readonly amount: number;
  readonly badgeKey?: never;
}

/**
 * BADGE pays an IDENTITY, not a number: `reward_amount_or_badge_id` holds a
 * `badge_definitions.key`, which `findBadgeByKey` resolves before
 * `awardBadgeIfNotAlready` can insert anything.
 *
 * A DISCRIMINATED UNION RATHER THAN AN OPTIONAL `amount`, because the two
 * shapes are not interchangeable and the engine already proves it: the BADGE
 * branch of `processTriggerEvent` never calls `Number(grant.amountOrBadgeId)`
 * and the XP/COINS branch bails out on `!Number.isFinite(amount)`. A badge rule
 * carrying an amount, or an XP rule carrying a badge key, is a mistake TypeScript
 * can catch here instead of a rule that silently never pays in production.
 *
 * `maxPerDay`/`maxPerWeek` are ALWAYS null on a badge rule. The cap counts
 * ledger rows per rule per business day, and a badge whose award is refused by
 * `child_badge_awards (child_id, badge_id)` never reaches `applyEarn` at all —
 * so a cap on a once-ever grant is a number that can never be read.
 */
export interface BadgeRewardRuleDefault extends RewardRuleDefaultBase {
  readonly rewardType: 'BADGE';
  readonly badgeKey: string;
  readonly amount?: never;
  readonly maxPerDay: null;
  readonly maxPerWeek: null;
}

export type RewardRuleDefault = AmountRewardRuleDefault | BadgeRewardRuleDefault;

/** What the rule's `reward_amount_or_badge_id` column holds — the one column
 * that means two different things depending on `reward_type`. Callers that
 * compare a seeded row against this catalogue must go through here rather than
 * reading `.amount`, which does not exist on a badge rule. */
export function ruleRewardValue(rule: RewardRuleDefault): string {
  return rule.rewardType === 'BADGE' ? rule.badgeKey : String(rule.amount);
}

/**
 * THE DEFAULT ECONOMY. A family that configures nothing gets all of it.
 *
 * Calibration, stated so it can be argued with rather than guessed at:
 * `LEVEL_XP_THRESHOLDS` puts level 2 at 100 XP and level 3 at 250. A child
 * doing three habits, hitting their hydration goal and logging one study
 * session earns 10*3 + 15 + 20 = 65 XP on a full day, so a first level-up lands
 * on day two of real use — soon enough to feel earned, slow enough that the
 * ladder is not exhausted in a week. Streaks pay COINS rather than XP because
 * coins buy something in the Family Store and XP only buys a number.
 */
export const PLATFORM_DEFAULT_REWARD_RULES: readonly RewardRuleDefault[] = [
  // ---- Habits -------------------------------------------------------------
  {
    key: 'default:habit:completed',
    triggerEngine: 'habit-builder',
    eventType: 'HABIT_COMPLETED',
    triggerCondition: {},
    rewardType: 'XP',
    amount: 10,
    maxPerDay: 10,
    maxPerWeek: 60,
    category: 'HABITS',
    labelAr: 'إتمام عادة',
  },
  {
    key: 'default:habit:streak',
    triggerEngine: 'habit-builder',
    eventType: 'STREAK_ACHIEVED',
    triggerCondition: {},
    rewardType: 'COINS',
    amount: 15,
    maxPerDay: 3,
    maxPerWeek: 10,
    category: 'HABITS',
    labelAr: 'سلسلة عادات متصلة',
  },
  {
    // `/events/batch` routes `DAILY_GOAL_COMPLETED` to the `habit-builder`
    // engine (`TYPE_SPECS.DAILY_GOAL_COMPLETED.completionKind = 'HABIT'`), while
    // `HealthEngineService` fires the same event NAME against the `health`
    // engine on the direct path. Two engines, two rules, deliberately: without
    // this row the device-aggregated daily goal — the edge-first path CONTEXT
    // §3.4 asks for — would still pay nothing.
    key: 'default:habit:daily-goal',
    triggerEngine: 'habit-builder',
    eventType: 'DAILY_GOAL_COMPLETED',
    triggerCondition: {},
    rewardType: 'XP',
    amount: 20,
    maxPerDay: 2,
    maxPerWeek: 14,
    category: 'HABITS',
    labelAr: 'هدف يومي مكتمل',
  },
  // ---- Smart Tasks --------------------------------------------------------
  {
    key: 'default:task:completed',
    triggerEngine: 'smart-tasks',
    eventType: 'TASK_COMPLETED',
    triggerCondition: {},
    rewardType: 'XP',
    amount: 10,
    maxPerDay: 10,
    maxPerWeek: 60,
    category: 'FAMILY_CONTRIBUTION',
    labelAr: 'إتمام مهمة',
  },
  // ---- Health / Hydration / Activity --------------------------------------
  {
    key: 'default:hydration:goal',
    triggerEngine: 'health',
    eventType: 'HYDRATION_GOAL_COMPLETED',
    triggerCondition: {},
    rewardType: 'XP',
    amount: 15,
    maxPerDay: 1,
    maxPerWeek: 7,
    category: 'HEALTH',
    labelAr: 'هدف شرب الماء اليومي',
  },
  {
    key: 'default:activity:goal',
    triggerEngine: 'health',
    eventType: 'ACTIVITY_GOAL_COMPLETED',
    triggerCondition: {},
    rewardType: 'XP',
    amount: 20,
    maxPerDay: 1,
    maxPerWeek: 7,
    category: 'FITNESS',
    labelAr: 'هدف النشاط البدني اليومي',
  },
  {
    key: 'default:health:daily-goal-hydration',
    triggerEngine: 'health',
    eventType: 'DAILY_GOAL_COMPLETED',
    triggerCondition: { metric: 'hydration' },
    rewardType: 'XP',
    amount: 15,
    maxPerDay: 1,
    maxPerWeek: 7,
    category: 'HEALTH',
    labelAr: 'هدف شرب الماء اليومي',
  },
  {
    key: 'default:health:daily-goal-activity',
    triggerEngine: 'health',
    eventType: 'DAILY_GOAL_COMPLETED',
    triggerCondition: { metric: 'activity' },
    rewardType: 'XP',
    amount: 20,
    maxPerDay: 1,
    maxPerWeek: 7,
    category: 'FITNESS',
    labelAr: 'هدف النشاط البدني اليومي',
  },
  {
    key: 'default:health:streak',
    triggerEngine: 'health',
    eventType: 'STREAK_ACHIEVED',
    triggerCondition: {},
    rewardType: 'COINS',
    amount: 20,
    maxPerDay: 2,
    maxPerWeek: 8,
    category: 'HEALTH',
    labelAr: 'سلسلة صحية متصلة',
  },
  // ---- Education / Learning ----------------------------------------------
  {
    key: 'default:education:progress',
    triggerEngine: 'learning',
    eventType: 'EDUCATION_PROGRESS',
    triggerCondition: {},
    rewardType: 'XP',
    amount: 20,
    maxPerDay: 5,
    maxPerWeek: 30,
    category: 'STUDY',
    labelAr: 'تقدّم دراسي',
  },
  {
    key: 'default:education:session',
    triggerEngine: 'learning',
    eventType: 'EDUCATION_TASK_COMPLETED',
    triggerCondition: {},
    rewardType: 'XP',
    amount: 20,
    maxPerDay: 5,
    maxPerWeek: 30,
    category: 'STUDY',
    labelAr: 'جلسة تعلّم',
  },
  {
    key: 'default:learning:goal',
    triggerEngine: 'learning',
    eventType: 'LEARNING_GOAL_ACHIEVED',
    triggerCondition: {},
    rewardType: 'COINS',
    amount: 50,
    maxPerDay: 3,
    maxPerWeek: 10,
    category: 'STUDY',
    labelAr: 'تحقيق هدف تعليمي',
  },
  {
    key: 'default:learning:streak',
    triggerEngine: 'learning',
    eventType: 'STREAK_ACHIEVED',
    triggerCondition: {},
    rewardType: 'COINS',
    amount: 20,
    maxPerDay: 2,
    maxPerWeek: 8,
    category: 'STUDY',
    labelAr: 'سلسلة تعلّم متصلة',
  },
  // ---- Faith / Quran ------------------------------------------------------
  {
    key: 'default:faith:memorization',
    triggerEngine: 'faith',
    eventType: 'MEMORIZATION_COMPLETED',
    triggerCondition: {},
    rewardType: 'XP',
    amount: 25,
    maxPerDay: 5,
    maxPerWeek: 30,
    category: 'QURAN',
    labelAr: 'إتمام حفظ',
  },
  {
    key: 'default:faith:practice',
    triggerEngine: 'faith',
    eventType: 'FAITH_PRACTICE_COMPLETED',
    triggerCondition: {},
    rewardType: 'XP',
    amount: 15,
    maxPerDay: 6,
    maxPerWeek: 42,
    category: 'RELIGION',
    labelAr: 'أداء عبادة',
  },
  {
    key: 'default:faith:streak',
    triggerEngine: 'faith',
    eventType: 'STREAK_ACHIEVED',
    triggerCondition: {},
    rewardType: 'COINS',
    amount: 20,
    maxPerDay: 2,
    maxPerWeek: 8,
    category: 'RELIGION',
    labelAr: 'سلسلة عبادة متصلة',
  },
  // ---- Badges -------------------------------------------------------------
  // Derived, never hand-written: see PLATFORM_DEFAULT_BADGE_RULES below.
  ...PLATFORM_BADGES.map(
    (badge): BadgeRewardRuleDefault => ({
      key: `default:badge:${badge.key}`,
      triggerEngine: badge.criteria.triggerEngine,
      eventType: badge.criteria.eventType,
      triggerCondition: badge.criteria.triggerCondition,
      rewardType: 'BADGE',
      badgeKey: badge.key,
      maxPerDay: null,
      maxPerWeek: null,
      category: badge.category,
      labelAr: badge.ruleLabelAr,
    }),
  ),
];

/**
 * THE BADGE HALF OF THE DEFAULTS, addressable on its own.
 *
 * These rows are DERIVED from `PLATFORM_BADGES`, one rule per badge, so the
 * catalogue and its demand cannot drift: adding a badge adds its rule, and
 * there is no way to write a rule pointing at a key that has no definition.
 * They live in `PLATFORM_DEFAULT_REWARD_RULES` above like every other default
 * — `/reward-rules/catalogue` shows a parent what their family inherits, and a
 * badge they can earn belongs in that answer.
 *
 * THE SHADOWING CONSEQUENCE, stated because it is a real product edge and not
 * an oversight: `selectApplicableRules` gives a family that owns ANY active
 * rule for an engine full ownership of that engine, so a parent who writes one
 * custom habit rule also stops inheriting the habit badges. That is the
 * precedence rule B4 chose deliberately («coarse and explicable beats clever
 * and surprising when the output is money-shaped»), and reproducing it for
 * badges keeps one mechanism rather than two. It is not weakened here.
 */
export const PLATFORM_DEFAULT_BADGE_RULES: readonly BadgeRewardRuleDefault[] =
  PLATFORM_DEFAULT_REWARD_RULES.filter(
    (rule): rule is BadgeRewardRuleDefault => rule.rewardType === 'BADGE',
  );

/**
 * Deterministic UUIDs for the seeded platform rows, so the migration is
 * re-runnable (`ON CONFLICT DO NOTHING`) and a test can assert a specific row
 * exists. `00000000-0000-4b40-8000-0000000000NN` — version nibble 4, variant
 * nibble 8, index in the last two hex digits. Not random, by design.
 */
export function platformRuleId(index: number): string {
  const suffix = index.toString(16).padStart(12, '0');
  return `00000000-0000-4b40-8000-${suffix}`;
}

/** Categories the client named that migration 0006 did not already seed.
 * Added as ROWS in `reward_program_categories`, never as enum members — the
 * table exists precisely so a nineteenth category is an INSERT. */
export const ADDITIONAL_REWARD_CATEGORIES: readonly {
  readonly code: string;
  readonly labelAr: string;
  readonly streakKind: string;
  readonly sortOrder: number;
}[] = [
  { code: 'RELIGION', labelAr: 'دين', streakKind: 'quran', sortOrder: 200 },
  { code: 'FITNESS', labelAr: 'لياقة بدنية', streakKind: 'exercise', sortOrder: 210 },
  { code: 'FAMILY_CONTRIBUTION', labelAr: 'مساهمة أسرية', streakKind: 'behaviour', sortOrder: 220 },
  { code: 'CUSTOM', labelAr: 'مخصص من الوالد', streakKind: 'learning', sortOrder: 230 },
];
