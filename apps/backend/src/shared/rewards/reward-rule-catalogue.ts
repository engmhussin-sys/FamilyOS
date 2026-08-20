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
 *
 * THAT SENTENCE WAS A COMMENT AND IT LET A REAL DEFECT THROUGH. It is true of
 * the keyed/keyless pair it was written about and says nothing about the case
 * that actually shipped: ONE producer firing TWO KEYED contract names for ONE
 * crossing, with a seeded rule waiting on each — 30 XP for one glass of water,
 * measured. The invariant is now `crossingCollisions()` below, checked by
 * `test/rewards/reward-rule-collision.spec.ts` against this file and by
 * `test/rewards/reward-rule-connection.e2e.spec.ts` against the seeded rows.
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
  // `default:health:daily-goal-hydration` and `default:health:daily-goal-activity`
  // WERE HERE. They are RETIRED — see `RETIRED_PLATFORM_RULES` below for the
  // measurement, the reason the two rows above are the survivors, and what
  // happened to the ledger rows the retired pair had already paid.
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
 * ===========================================================================
 * THE RETIRED PLATFORM RULES — WHAT WAS PAID TWICE, AND WHY THESE TWO LOST.
 * ===========================================================================
 *
 * THE MEASUREMENT, taken against real PostgreSQL through the Child App's own
 * hydration button (`POST /life-intelligence/self/health/hydration-logs`) with
 * a family that had configured nothing:
 *
 *   rewards_ledger_entries   EARN 15 XP  source `reward_rule:…0005`
 *                                        idem  `daily-goal:hydration:<child>:<day>:XP:…`
 *                            EARN 15 XP  source `reward_rule:…0003`
 *                                        idem  `child:<child>:hydration:<day>:XP:…`
 *   rewards_accounts.xp      30
 *
 * and the same shape on activity: 20 + 20, `rewards_accounts.xp = 40`. ONE
 * crossing, TWO payments. The two rules carried identical amounts, identical
 * caps, identical categories and BYTE-IDENTICAL `labelAr`, so nothing in the
 * parent's own catalogue screen could tell them apart either.
 *
 * THE DATABASE COULD NOT COLLAPSE IT, and that is the load-bearing detail:
 * `rewards_ledger_entries (child_id, idempotency_key)` is a UNIQUE CONSTRAINT,
 * but the key has the granting rule's id appended, so two rule ids produce two
 * different keys. A duplicate that survives the unique index is not a race the
 * database can win — it has to stop being seeded.
 *
 * WHY THE `*_GOAL_COMPLETED` NAMES SURVIVED AND `DAILY_GOAL_COMPLETED {metric}`
 * DID NOT. Three reasons, in order of weight:
 *
 *   1. BOTH DOORS EMIT THE SURVIVOR, ONLY ONE EMITS THE RETIREE.
 *      `HealthEngineService.logHydration` / `logActivity` now fire
 *      `HYDRATION_GOAL_COMPLETED` / `ACTIVITY_GOAL_COMPLETED` with a key from
 *      `composeIdempotencyKey`, which is the SAME call `EventIngestionService`
 *      makes for the device door — so the two doors produce a byte-identical
 *      key and the unique constraint refuses the second grant. The retired
 *      pair was reachable ONLY from the direct app door, with a hand-written
 *      key that could never collide with anything. Keeping the retiree would
 *      have left the device door unpaid or paid on a second, uncollidable key.
 *   2. THE BADGES ARE SEEDED AGAINST THE SURVIVOR. `first_hydration_goal` and
 *      `first_activity_goal` name `HYDRATION_GOAL_COMPLETED` /
 *      `ACTIVITY_GOAL_COMPLETED` in `badge-catalogue.ts`. Retiring those names
 *      would have re-broken the chain the health-engine fix had just connected.
 *   3. NOTHING ELSE CONSUMES `DAILY_GOAL_COMPLETED {metric: …}`. Checked, and
 *      it is not a claim: `evaluateRewardRules` matches on `triggerEngine`
 *      FIRST, and the only other seeded `DAILY_GOAL_COMPLETED` rule is
 *      `default:habit:daily-goal` on the `habit-builder` engine — which is
 *      where `/events/batch` routes that name
 *      (`TYPE_SPECS.DAILY_GOAL_COMPLETED.completionKind = 'HABIT'`). It is a
 *      different engine, a different trigger and a different real-world fact,
 *      and it is untouched. The event NAME itself is still emitted by
 *      `HealthEngineService` and still drives `announceDailyGoal` — this
 *      retires a REWARD RULE, not an event.
 *
 * THE ROWS ARE DEACTIVATED, NOT DELETED, and migration `0030` says so in SQL.
 * Every ledger row the retired pair ever paid records `source =
 * 'reward_rule:<id>'`, which is exactly why
 * `PrismaRewardsRepository.deactivateRewardRule` already documents «DEACTIVATE,
 * never DELETE» for a parent's own rules. A household that already earned 30 XP
 * for one crossing KEEPS those 30 XP and keeps a resolvable provenance row for
 * both halves: a child's earned history is not rewritten to make a catalogue
 * tidy, and `evaluateRewardRules` skips an inactive rule on its FIRST line, so
 * the next crossing pays once. There is no foreign key to orphan — `source` is
 * a provenance string — and that is the reason the row must stay readable.
 */
export const RETIRED_PLATFORM_RULES: readonly {
  readonly key: string;
  readonly id: string;
  readonly supersededByKey: string;
  readonly reason: string;
}[] = [
  {
    key: 'default:health:daily-goal-hydration',
    id: '00000000-0000-4b40-8000-000000000005',
    supersededByKey: 'default:hydration:goal',
    reason:
      'Paid a second 15 XP for the same hydration crossing as `default:hydration:goal`, on a key no other door can collide with.',
  },
  {
    key: 'default:health:daily-goal-activity',
    id: '00000000-0000-4b40-8000-000000000006',
    supersededByKey: 'default:activity:goal',
    reason:
      'Paid a second 20 XP for the same activity crossing as `default:activity:goal`, on a key no other door can collide with.',
  },
];

/**
 * ===========================================================================
 * ONE REAL-WORLD CROSSING, AND EVERY TRIGGER ITS PRODUCER FIRES FOR IT.
 * ===========================================================================
 *
 * WHY THIS TABLE HAD TO EXIST. The header of `RULE_EVENT_TYPES` states the
 * invariant this catalogue is built on — «the same real-world completion can no
 * longer be paid twice» — and it was a COMMENT. It held for the keyed/keyless
 * pair it was written about and said nothing about the case that actually
 * happened: ONE producer firing TWO KEYED contract names for ONE crossing, with
 * a seeded rule waiting on each.
 *
 * A rule-versus-rule check cannot see that. The two rules never match the same
 * trigger — they match two different triggers that describe one glass of water.
 * So the unit of the invariant is the CROSSING, and a crossing is only knowable
 * from its producer. This table is that knowledge, written down where the rules
 * are, and `test/rewards/reward-rule-collision.spec.ts` fails the build when a
 * crossing acquires a second paying rule.
 *
 * EVERY ENTRY IS COPIED FROM A PRODUCER, not inferred. The full set of reward
 * triggers in `src/` is fifteen calls across four services; these are the ones
 * where a single call site fires more than one, plus the single-trigger
 * crossings kept for completeness so a new co-emission is added HERE rather
 * than appearing in a diff nobody reads.
 *
 * THE KEYLESS LEGACY NAMES (`habit_completed`, `hydration_event`,
 * `practice_logged`) ARE LISTED. They are not in `RULE_EVENT_TYPES`, so no
 * managed rule can match them — and listing them is what makes that provable
 * here instead of assumed.
 */
export interface CrossingTrigger {
  readonly type: string;
  readonly payload: Readonly<Record<string, string | number | boolean>>;
}

/**
 * ONE CODE PATH THAT FIRES A CROSSING, AND THE TRIGGERS IT FIRES.
 *
 * WHY A CROSSING NEEDED MORE THAN ONE OF THESE, MEASURED. `producer` used to be
 * a single string, and every entry named the DIRECT one — the engine method the
 * app's own button calls. That left `crossingCollisions()` structurally blind to
 * the OUTBOX producers: `POST /events/batch` writes a domain event, the relay
 * delivers it, and a CONSUMER fires the same crossing from a different file. The
 * habit streak crossing has exactly that shape — `HabitEngineService`
 * `.completeHabit` and `StreakDetectionConsumer.handle` both decide «this child
 * reached seven days» — and this table could not say so, so no check built on it
 * could either. The measurement: 15 + 15 COINS for one seven-day streak, and
 * 10 + 10 XP for the habit tick under it.
 *
 * The triggers now hang off the PRODUCER rather than the crossing, because two
 * producers of one crossing do not always fire the same names or the same
 * payload shape: the streak consumer emits a `CompletionEvent` whose streak
 * facts live under `metadata`, so a rule conditioned on `{metric: 'habits'}`
 * would match the direct door and NOT the outbox door. That asymmetry is a fact
 * about this system, and it belongs here rather than in a ledger nobody reads
 * until a parent complains.
 */
export interface CrossingProducer {
  /** `file#method` — where the triggers below are fired. */
  readonly file: string;
  /** `DIRECT` = an engine method behind an HTTP route the app calls.
   *  `OUTBOX` = a consumer reacting to a delivered domain event. */
  readonly door: 'DIRECT' | 'OUTBOX';
  readonly triggers: readonly CrossingTrigger[];
}

export interface ProducerCrossing {
  /** The real-world fact, in one phrase. */
  readonly crossing: string;
  /** EVERY code path that fires it — never only the direct one. */
  readonly producers: readonly CrossingProducer[];
  readonly engine: RuleEngine;
}

/** Every trigger a crossing fires, across ALL of its producers. */
export function crossingTriggers(crossing: ProducerCrossing): readonly CrossingTrigger[] {
  return crossing.producers.flatMap((p) => p.triggers);
}

export const PRODUCER_CROSSINGS: readonly ProducerCrossing[] = [
  {
    crossing: 'a child ticks one habit',
    engine: 'habit-builder',
    producers: [
      {
        file: 'habit-engine.service.ts#completeHabit',
        door: 'DIRECT',
        triggers: [
          { type: 'habit_completed', payload: {} },
          { type: 'HABIT_COMPLETED', payload: {} },
        ],
      },
      {
        // THE DOOR THIS TABLE COULD NOT SEE. The same tick, aggregated on the
        // device and posted to `POST /events/batch`, reaches the Rewards Engine
        // through `RewardsCompletionConsumer` — a different file, the same
        // crossing, the same `default:habit:completed` rule. Both doors now
        // compose the key with `composeIdempotencyKey('HABIT_COMPLETED', …)`,
        // which is what makes the ledger's unique constraint able to refuse the
        // second grant instead of storing two legitimate rows.
        file: 'event-ingestion.service.ts -> RewardsCompletionConsumer',
        door: 'OUTBOX',
        triggers: [{ type: 'HABIT_COMPLETED', payload: {} }],
      },
    ],
  },
  {
    crossing: 'a habit streak milestone is reached',
    engine: 'habit-builder',
    producers: [
      {
        file: 'habit-engine.service.ts#completeHabit',
        door: 'DIRECT',
        triggers: [{ type: 'STREAK_ACHIEVED', payload: { metric: 'habits' } }],
      },
      {
        // THE OUTBOX HALF OF THE SAME MILESTONE. `StreakDetectionConsumer`
        // recomputes the streak from the SAME completion rows and fires the
        // SAME name — and its `CompletionEvent` payload carries the streak
        // facts under `metadata`, not as `metric`, which is why its trigger is
        // recorded with an empty payload rather than copied from the line above.
        file: 'streak-detection.consumer.ts#handle',
        door: 'OUTBOX',
        triggers: [{ type: 'STREAK_ACHIEVED', payload: {} }],
      },
    ],
  },
  {
    crossing: "a child crosses today's hydration target",
    engine: 'health',
    producers: [
      {
        file: 'health-engine.service.ts#logHydration',
        door: 'DIRECT',
        triggers: [
          { type: 'hydration_event', payload: { metric: 'hydration_target_reached' } },
          { type: 'DAILY_GOAL_COMPLETED', payload: { metric: 'hydration' } },
          { type: 'HYDRATION_GOAL_COMPLETED', payload: { metric: 'hydration' } },
        ],
      },
      {
        file: 'event-ingestion.service.ts -> RewardsCompletionConsumer',
        door: 'OUTBOX',
        triggers: [{ type: 'HYDRATION_GOAL_COMPLETED', payload: {} }],
      },
    ],
  },
  {
    crossing: "a child crosses today's 60-minute activity target",
    engine: 'health',
    producers: [
      {
        file: 'health-engine.service.ts#logActivity',
        door: 'DIRECT',
        triggers: [
          { type: 'DAILY_GOAL_COMPLETED', payload: { metric: 'activity' } },
          { type: 'ACTIVITY_GOAL_COMPLETED', payload: { metric: 'activity' } },
        ],
      },
      {
        file: 'event-ingestion.service.ts -> RewardsCompletionConsumer',
        door: 'OUTBOX',
        triggers: [{ type: 'ACTIVITY_GOAL_COMPLETED', payload: {} }],
      },
    ],
  },
  {
    crossing: 'a health streak milestone is reached',
    engine: 'health',
    producers: [
      {
        file: 'health-engine.service.ts#logHydration / #logActivity',
        door: 'DIRECT',
        triggers: [{ type: 'STREAK_ACHIEVED', payload: { metric: 'hydration' } }],
      },
    ],
  },
  {
    crossing: 'a child logs one faith practice',
    engine: 'faith',
    producers: [
      {
        file: 'faith-engine.service.ts#logPractice',
        door: 'DIRECT',
        triggers: [
          { type: 'practice_logged', payload: {} },
          { type: 'FAITH_PRACTICE_COMPLETED', payload: {} },
        ],
      },
    ],
  },
  {
    crossing: 'a child logs one learning session',
    engine: 'learning',
    producers: [
      {
        file: 'learning-engine.service.ts#logSession',
        door: 'DIRECT',
        triggers: [{ type: 'EDUCATION_TASK_COMPLETED', payload: {} }],
      },
    ],
  },
  {
    crossing: 'a learning goal is completed',
    engine: 'learning',
    producers: [
      {
        file: 'learning-engine.service.ts#completeGoal',
        door: 'DIRECT',
        triggers: [{ type: 'LEARNING_GOAL_ACHIEVED', payload: {} }],
      },
    ],
  },
  {
    crossing: 'a learning streak milestone is reached',
    engine: 'learning',
    producers: [
      {
        file: 'learning-engine.service.ts#logSession',
        door: 'DIRECT',
        triggers: [{ type: 'STREAK_ACHIEVED', payload: { metric: 'education' } }],
      },
    ],
  },
  {
    crossing: 'a device-aggregated daily goal arrives through POST /events/batch',
    engine: 'habit-builder',
    producers: [
      {
        file: 'event-ingestion.service.ts -> RewardsCompletionConsumer',
        door: 'OUTBOX',
        triggers: [{ type: 'DAILY_GOAL_COMPLETED', payload: {} }],
      },
    ],
  },
];

/**
 * The rule-matching predicate `evaluateRewardRules` uses, in the only form a
 * catalogue check can reuse: engine, then event type, then subset-match on the
 * trigger condition. It deliberately IGNORES `isActive`, caps and the
 * verification floor — a rule that is merely switched off or capped is still a
 * rule that CAN match the crossing, and «it happens not to pay today» is not an
 * invariant.
 */
export function ruleMatchesTrigger(
  rule: RewardRuleDefault,
  engine: string,
  trigger: CrossingTrigger,
): boolean {
  if (rule.triggerEngine !== engine) return false;
  if (rule.eventType !== trigger.type) return false;
  return Object.entries(rule.triggerCondition).every(([k, v]) => trigger.payload[k] === v);
}

/** Every seeded rule that can be granted for one crossing, across all of the
 * triggers EVERY producer of that crossing fires — the direct engine method and
 * the outbox consumer alike. Reading only the direct producer's triggers is the
 * blind spot that let a habit streak be paid twice. */
export function rulesPayingCrossing(
  crossing: ProducerCrossing,
  rules: readonly RewardRuleDefault[] = PLATFORM_DEFAULT_REWARD_RULES,
): RewardRuleDefault[] {
  const triggers = crossingTriggers(crossing);
  return rules.filter((rule) =>
    triggers.some((trigger) => ruleMatchesTrigger(rule, crossing.engine, trigger)),
  );
}

/**
 * THE INVARIANT, AS A FUNCTION RATHER THAN A SENTENCE.
 *
 * Returns every way the seeded catalogue can pay one crossing twice. Empty is
 * the only acceptable answer, and `test/rewards/reward-rule-collision.spec.ts`
 * asserts exactly that — against the CODE copy, and again in
 * `reward-rule-connection.e2e.spec.ts` against the rows PostgreSQL actually
 * holds, because a migration can seed a row this file never mentions.
 *
 * TWO KINDS OF DOUBLE PAYMENT, and they are different facts:
 *
 *   CURRENCY  two or more XP rules, or two or more COINS rules, matching one
 *             crossing. This is the defect that was measured: 15 + 15 XP for
 *             one glass of water. An XP rule and a COINS rule together are NOT
 *             a collision — they are two different currencies for one act, and
 *             `default:habit:completed` (XP) beside a future coin rule is a
 *             product decision, not an accident.
 *   BADGE     two rules pointing at the SAME `badgeKey`. A crossing that can
 *             award `first_habit` twice is a duplicate even though
 *             `child_badge_awards (child_id, badge_id)` would refuse the second
 *             insert — the refusal is the database catching a catalogue that
 *             should not have asked. Two DIFFERENT badges on one crossing are
 *             fine and deliberate: an XP rule and a once-ever badge rule are
 *             how every first completion in this product already works.
 */
export interface CrossingCollision {
  readonly crossing: string;
  /** EVERY file that fires this crossing, in table order. A report naming only
   *  the direct producer sends the next reader to the wrong file half the time,
   *  which is exactly how the outbox half of a double payment stays unfound. */
  readonly producers: readonly string[];
  /** `'XP'`, `'COINS'`, or `badge:<key>`. */
  readonly paidTwiceAs: string;
  readonly ruleKeys: readonly string[];
}

export function crossingCollisions(
  rules: readonly RewardRuleDefault[] = PLATFORM_DEFAULT_REWARD_RULES,
  crossings: readonly ProducerCrossing[] = PRODUCER_CROSSINGS,
): CrossingCollision[] {
  const collisions: CrossingCollision[] = [];

  for (const crossing of crossings) {
    const paying = rulesPayingCrossing(crossing, rules);
    const buckets = new Map<string, string[]>();

    for (const rule of paying) {
      const bucket = rule.rewardType === 'BADGE' ? `badge:${rule.badgeKey}` : rule.rewardType;
      const keys = buckets.get(bucket) ?? [];
      keys.push(rule.key);
      buckets.set(bucket, keys);
    }

    for (const [paidTwiceAs, ruleKeys] of buckets) {
      if (ruleKeys.length > 1) {
        collisions.push({
          crossing: crossing.crossing,
          producers: crossing.producers.map((p) => p.file),
          paidTwiceAs,
          ruleKeys: [...ruleKeys].sort(),
        });
      }
    }
  }

  return collisions;
}

/**
 * Deterministic UUIDs for the seeded platform rows, so the migration is
 * re-runnable (`ON CONFLICT DO NOTHING`) and a test can assert a specific row
 * exists. `00000000-0000-4b40-8000-0000000000NN` — version nibble 4, variant
 * nibble 8, index in the last two hex digits. Not random, by design.
 *
 * THE INDEX IS NOT THE ARRAY POSITION, and that is not sloppiness: the seeded
 * ids are literals in migration `0007`, assigned in insertion order at the time
 * each row was ADDED (`default:habit:daily-goal` is `…000f`, seeded after
 * `…000e`, even though it reads third in the list). Renumbering by array
 * position would rewrite the `source` of every ledger row ever paid, which is
 * the same reason `RETIRED_PLATFORM_RULES` keeps its ids rather than closing
 * the gap they leave.
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
