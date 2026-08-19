-- =============================================================================
-- 0026 — THE BADGE CATALOGUE, AND THE RULES THAT ASK FOR IT
-- =============================================================================
--
-- THE DEFECT. `badge_definitions` had NO WRITER anywhere in this repository:
-- no seed, no INSERT in migrations 0001..0025, no admin route.
-- `findBadgeByKey` (`prisma-rewards.repository.ts:327`) therefore returned
-- NULL for every key, and the live `awardBadgeIfNotAlready` two lines below it
-- — correct, and protected by the real `child_badge_awards (child_id,
-- badge_id)` UNIQUE constraint — could never be reached with a real badge id.
-- No child in this product could earn a badge.
--
-- AND IT WAS WORSE THAN THAT, which is why this migration writes two tables.
-- The only code path that awards a badge is `RewardsEngineService
-- .processTriggerEvent` handling a grant with `rewardType = 'BADGE'`, and such
-- a grant can only come from a `RewardRule` with `reward_type = 'BADGE'`.
-- There were ZERO of those, and no way to create one:
--   * `CreateRewardRuleDto.rewardType` is `@IsIn(['XP','COINS'])` — BADGE is
--     withheld there with a comment saying no badge catalogue exists, so the
--     two gaps were each other's stated justification;
--   * the F4 companion-rule writer derives its type from `RewardSpec`, and
--     `PROGRAM_REWARD_TYPES` has no BADGE member;
--   * migration 0007's 16 platform defaults are all XP or COINS.
-- Seeding definitions alone would have produced a catalogue nobody looks up —
-- the same dormancy pointing the other way. THE DEFINITIONS AND THEIR DEMAND
-- LAND TOGETHER, in this one file, from one TypeScript list.
--
-- SOURCE OF TRUTH. `src/shared/rewards/badge-catalogue.ts` (`PLATFORM_BADGES`)
-- and the `PLATFORM_DEFAULT_BADGE_RULES` derived from it in
-- `src/shared/rewards/reward-rule-catalogue.ts`. The rows below are that list.
-- `test/rewards/badge-catalogue.e2e.spec.ts` asserts the database copy and the
-- code copy are identical row for row, in BOTH directions, so neither can grow
-- an entry the other does not have. Same discipline as 0006 (`quran_surahs`
-- from `shared/rewards/quran.ts`), 0007 (`reward_rules` from
-- `shared/rewards/reward-rule-catalogue.ts`) and 0014 (`countries`).
--
-- WHY A MIGRATION AND NOT A RUNTIME SERVICE. `badge_definitions` has no
-- `family_id`, no RLS policy and no tenant: one row is shared by every family
-- in every country, and `child_badge_awards (child_id, badge_id)` is UNIQUE, so
-- the identity of a badge has to be stable across the whole fleet and across
-- every future deploy. That is deployment-level reference data, exactly like
-- `countries`, `currencies`, `quran_surahs`, `reward_program_categories` and
-- the platform reward rules — all of them seeded this way.
--
-- ADDITIVE ONLY, AND RE-RUNNABLE. No column is added, no constraint is
-- changed, no existing row is deleted. Both INSERTs are
-- `ON CONFLICT ... DO UPDATE` rather than DO NOTHING, for the reason 0006 and
-- 0007 give: a copy correction in a later deploy must actually land, and
-- DO NOTHING would silently keep the old sentence. The conflict target for a
-- definition is `key`, NOT `id`, because `key` is the join a `RewardRule`
-- stores and the value awards are anchored to — so re-running this file
-- corrects the words while every `child_badge_awards` row keeps pointing at the
-- badge it always pointed at.
-- =============================================================================

-- --- 1. badge_definitions ----------------------------------------------------
--
-- `title` and `description` ARE THE ARABIC ONES, deliberately. Both columns are
-- rendered verbatim to a child: `GET /self/achievements/badges` returns
-- `row.badge.title` and the child app prints it with no catalogue of its own,
-- and `rewards-engine.service.ts` feeds the same string into `BADGE_EARNED` /
-- `BADGE_EARNED_PARENT` as `{badgeTitle}` — inside an Arabic sentence. The
-- English copy lives beside the Arabic in `badge-catalogue.ts`, in the shape
-- `notification-copy.ts` uses, ready for the day one of those two readers takes
-- a locale; it is not a second pair of columns, because a column no reader can
-- reach is the dormant-schema defect this migration exists to close.
--
-- `criteria` IS NOT DECORATION. It records, in machine-readable form, exactly
-- which trigger awards the badge, and the spec asserts that trigger matches a
-- real `reward_rules` row below. `occurrence: FIRST` is a statement about the
-- database, not an intention: `(child_id, badge_id)` is UNIQUE, so the rule
-- fires on every completion and only the first one can ever insert.
--
-- `is_group_achievement` IS FALSE ON EVERY ROW, chosen rather than defaulted.
-- Its one reader (`prisma-digital-twin.repository.ts:23`) counts group-badge
-- awards into the family collaboration signal, and the only thing that could
-- earn one is `FamilyChallenge`, which no module can create. A group badge
-- seeded today would be a badge no child could be awarded.
INSERT INTO "badge_definitions" ("id", "key", "title", "description", "criteria", "is_group_achievement")
VALUES
  ('00000000-0000-4b41-8000-000000000000', 'first_habit', 'أول عادة',
   'أتممت أول عادة لك. البداية أصعب خطوة، وقد قطعتها.',
   '{"occurrence":"FIRST","triggerEngine":"habit-builder","eventType":"HABIT_COMPLETED","triggerCondition":{},"awardedBy":"platform_reward_rule"}'::jsonb, false),
  ('00000000-0000-4b41-8000-000000000001', 'first_streak', 'سلسلة لا تنقطع',
   'واصلت عادتك أيامًا متتالية. الاستمرار هو ما يصنع الفرق.',
   '{"occurrence":"FIRST","triggerEngine":"habit-builder","eventType":"STREAK_ACHIEVED","triggerCondition":{},"awardedBy":"platform_reward_rule"}'::jsonb, false),
  ('00000000-0000-4b41-8000-000000000002', 'first_task', 'يد تساعد',
   'أنجزت أول مهمة في البيت. مساعدتك ملحوظة ومقدَّرة.',
   '{"occurrence":"FIRST","triggerEngine":"smart-tasks","eventType":"TASK_COMPLETED","triggerCondition":{},"awardedBy":"platform_reward_rule"}'::jsonb, false),
  ('00000000-0000-4b41-8000-000000000003', 'first_hydration_goal', 'كأس بعد كأس',
   'أكملت هدف الماء ليوم كامل. جسمك يشكرك على ذلك.',
   '{"occurrence":"FIRST","triggerEngine":"health","eventType":"HYDRATION_GOAL_COMPLETED","triggerCondition":{},"awardedBy":"platform_reward_rule"}'::jsonb, false),
  ('00000000-0000-4b41-8000-000000000004', 'first_activity_goal', 'جسم يتحرك',
   'بلغت هدف نشاطك اليومي لأول مرة. حركتك اليوم كانت كافية.',
   '{"occurrence":"FIRST","triggerEngine":"health","eventType":"ACTIVITY_GOAL_COMPLETED","triggerCondition":{},"awardedBy":"platform_reward_rule"}'::jsonb, false),
  ('00000000-0000-4b41-8000-000000000005', 'first_study_session', 'أول جلسة مذاكرة',
   'أنهيت أول جلسة تعلّم كاملة. التركيز مهارة، وقد بدأت تتقنها.',
   '{"occurrence":"FIRST","triggerEngine":"learning","eventType":"EDUCATION_TASK_COMPLETED","triggerCondition":{},"awardedBy":"platform_reward_rule"}'::jsonb, false),
  ('00000000-0000-4b41-8000-000000000006', 'first_learning_goal', 'هدف محقَّق',
   'وصلت إلى أول هدف تعليمي وضعته لنفسك. خطّطت ثم أتممت.',
   '{"occurrence":"FIRST","triggerEngine":"learning","eventType":"LEARNING_GOAL_ACHIEVED","triggerCondition":{},"awardedBy":"platform_reward_rule"}'::jsonb, false),
  ('00000000-0000-4b41-8000-000000000007', 'first_memorization', 'أول ما حفظت',
   'أتممت أول مقطع حفظ. ما تحفظه يبقى معك.',
   '{"occurrence":"FIRST","triggerEngine":"faith","eventType":"MEMORIZATION_COMPLETED","triggerCondition":{},"awardedBy":"platform_reward_rule"}'::jsonb, false),
  ('00000000-0000-4b41-8000-000000000008', 'first_faith_practice', 'أول خطوة',
   'سجّلت أول عبادة لك. القليل الدائم خير من الكثير المنقطع.',
   '{"occurrence":"FIRST","triggerEngine":"faith","eventType":"FAITH_PRACTICE_COMPLETED","triggerCondition":{},"awardedBy":"platform_reward_rule"}'::jsonb, false)
ON CONFLICT ("key") DO UPDATE
  SET "title" = EXCLUDED."title",
      "description" = EXCLUDED."description",
      "criteria" = EXCLUDED."criteria",
      "is_group_achievement" = EXCLUDED."is_group_achievement";

-- --- 2. reward_rules: the badge half of the platform defaults ----------------
--
-- `family_id IS NULL` — a platform rule, visible to every family through the
-- `OR: [{familyId}, {familyId: null}]` read path `listActiveRewardRules` has
-- always had, and the SHARED_NULL registration in `tenant-model-registry.ts`.
-- Nothing new is introduced here; these rows use 0007's mechanism exactly.
--
-- `reward_amount_or_badge_id` HOLDS A `badge_definitions.key`, not a number.
-- That is the one column in this schema that means two different things
-- depending on `reward_type`, and the engine already branches on it: the BADGE
-- path calls `findBadgeByKey(grant.amountOrBadgeId)` and never `Number(...)`.
--
-- `max_per_day` / `max_per_week` ARE NULL, and that is not laziness. The cap
-- counts ledger rows per rule per business day, and on a badge the award is
-- refused by `child_badge_awards (child_id, badge_id)` before `applyEarn` is
-- ever called — so a cap on a once-ever grant is a number nothing can read.
--
-- The ids continue 0007's deterministic block (`...4b40-8000-...`) at 0x10, so
-- they cannot collide with the sixteen rows already there. The partial unique
-- index `reward_rules_active_scope_uniq` includes `reward_type`, so a badge
-- rule sits beside the XP rule for the same engine and event type rather than
-- competing with it.
INSERT INTO "reward_rules"
  ("id", "family_id", "trigger_engine", "event_type", "trigger_condition",
   "reward_type", "reward_amount_or_badge_id", "is_active",
   "max_per_day", "max_per_week", "category", "label_ar", "created_at", "updated_at")
VALUES
  ('00000000-0000-4b40-8000-000000000010', NULL, 'habit-builder', 'HABIT_COMPLETED',           '{}'::jsonb, 'BADGE', 'first_habit',           true, NULL, NULL, 'HABITS',              'وسام أول عادة',        now(), now()),
  ('00000000-0000-4b40-8000-000000000011', NULL, 'habit-builder', 'STREAK_ACHIEVED',           '{}'::jsonb, 'BADGE', 'first_streak',          true, NULL, NULL, 'HABITS',              'وسام أول سلسلة متصلة', now(), now()),
  ('00000000-0000-4b40-8000-000000000012', NULL, 'smart-tasks',   'TASK_COMPLETED',            '{}'::jsonb, 'BADGE', 'first_task',            true, NULL, NULL, 'FAMILY_CONTRIBUTION', 'وسام أول مهمة',        now(), now()),
  ('00000000-0000-4b40-8000-000000000013', NULL, 'health',        'HYDRATION_GOAL_COMPLETED',  '{}'::jsonb, 'BADGE', 'first_hydration_goal',  true, NULL, NULL, 'HEALTH',              'وسام أول هدف ماء',     now(), now()),
  ('00000000-0000-4b40-8000-000000000014', NULL, 'health',        'ACTIVITY_GOAL_COMPLETED',   '{}'::jsonb, 'BADGE', 'first_activity_goal',   true, NULL, NULL, 'FITNESS',             'وسام أول هدف نشاط',    now(), now()),
  ('00000000-0000-4b40-8000-000000000015', NULL, 'learning',      'EDUCATION_TASK_COMPLETED',  '{}'::jsonb, 'BADGE', 'first_study_session',   true, NULL, NULL, 'STUDY',               'وسام أول جلسة تعلّم',  now(), now()),
  ('00000000-0000-4b40-8000-000000000016', NULL, 'learning',      'LEARNING_GOAL_ACHIEVED',    '{}'::jsonb, 'BADGE', 'first_learning_goal',   true, NULL, NULL, 'STUDY',               'وسام أول هدف تعليمي',  now(), now()),
  ('00000000-0000-4b40-8000-000000000017', NULL, 'faith',         'MEMORIZATION_COMPLETED',    '{}'::jsonb, 'BADGE', 'first_memorization',    true, NULL, NULL, 'QURAN',               'وسام أول حفظ',         now(), now()),
  ('00000000-0000-4b40-8000-000000000018', NULL, 'faith',         'FAITH_PRACTICE_COMPLETED',  '{}'::jsonb, 'BADGE', 'first_faith_practice',  true, NULL, NULL, 'RELIGION',            'وسام أول عبادة',       now(), now())
ON CONFLICT ("id") DO UPDATE
  SET "trigger_engine" = EXCLUDED."trigger_engine",
      "event_type" = EXCLUDED."event_type",
      "trigger_condition" = EXCLUDED."trigger_condition",
      "reward_type" = EXCLUDED."reward_type",
      "reward_amount_or_badge_id" = EXCLUDED."reward_amount_or_badge_id",
      "is_active" = EXCLUDED."is_active",
      "max_per_day" = EXCLUDED."max_per_day",
      "max_per_week" = EXCLUDED."max_per_week",
      "category" = EXCLUDED."category",
      "label_ar" = EXCLUDED."label_ar",
      "updated_at" = now();

-- --- 3. RLS grants (only when 0004's role exists) -----------------------------
-- Same conditional shape as 0007 §7. `badge_definitions` is a shared reference
-- table with no RLS policy, and the app only ever SELECTs it; the INSERT/UPDATE
-- grants belong to migrations, which run as the owner.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'abny_app') THEN
    EXECUTE 'GRANT SELECT ON "badge_definitions" TO abny_app';
  END IF;
END
$$;
