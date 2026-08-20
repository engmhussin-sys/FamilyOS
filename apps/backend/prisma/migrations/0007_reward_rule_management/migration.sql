-- =============================================================================
-- 0007_reward_rule_management — Phase B, step B4 (PA-B-015).
--
-- THE DEFECT. `reward_rules` had ONE writer in the entire backend
-- (`prisma-reward-program.repository.ts:111`, F4 companion rows), zero
-- controllers, zero seeds and zero INSERTs in migrations 0001..0006. Every
-- production completion from Habits, Health, Hydration, Activity, Faith,
-- Education and Learning reached `evaluateRewardRules([], event)` and returned
-- zero grants — and since `REWARD_GRANTED` is emitted only inside
-- `if (granted > 0)`, the ledger, the timeline and the notification after it
-- were unreachable too.
--
-- ADDITIVE ONLY, and RE-RUNNABLE, for the same reason 0003/0005/0006 were:
-- the only version of a migration that is safe the day after the first
-- customer is one that can be run twice.
--
-- WHAT IT ADDS
--   columns   reward_rules += event_type, category, label_ar, max_per_day,
--                             max_per_week, min_verified_by,
--                             created_by_user_id, updated_at
--             (ALL NULLABLE except updated_at, which defaults — so every
--              existing rule row, including every F4 companion row, stays
--              valid and keeps its current wildcard behaviour)
--   rows      reward_program_categories += 4 (RELIGION, FITNESS,
--                             FAMILY_CONTRIBUTION, CUSTOM) — the client's list,
--                             as ROWS, because the table exists so a new
--                             category is an INSERT and not an ALTER TYPE
--   rows      reward_rules += 16 PLATFORM DEFAULTS (family_id IS NULL)
--   index     one active managed rule per (family, engine, event type, reward
--             type, condition) — the constraint that stops a parent
--             accidentally holding two rules that both pay for one completion
--
-- TENANCY. `reward_rules` is registered SHARED_NULL in
-- `src/common/tenancy/tenant-model-registry.ts:117`: `family_id IS NULL` means
-- "platform rule, visible to every family", and the tenant extension already
-- honours that. RLS policies on this table were created by 0004
-- with the same OR-NULL shape; nothing here changes them. The 16 seeded rows
-- use that existing, tested mechanism — they do not introduce a new one.
-- =============================================================================

-- --- 1. reward_rules: the management columns --------------------------------
--
-- `event_type` IS THE ONE THAT MATTERS (PA-B-013). Until now a rule matched on
-- `trigger_engine` alone, so a single habit-builder rule matched BOTH the keyed
-- `HABIT_COMPLETED` trigger and the legacy keyless `habit_completed` trigger
-- the same engine still fires — two ledger rows for one completion, one of them
-- with a `nokey:<uuid>` idempotency key that no unique index can ever catch.
-- A rule that names its event type matches exactly one of them, and the engine
-- refuses to pay a type-scoped rule that arrives without an idempotency key.
--
-- NULL keeps the old wildcard behaviour, which is what makes this safe for the
-- F4 companion rows (matched by `{programId, multiplierBps}`) and for any rule
-- already seeded by a test fixture.
ALTER TABLE "reward_rules" ADD COLUMN IF NOT EXISTS "event_type" VARCHAR(60);
ALTER TABLE "reward_rules" ADD COLUMN IF NOT EXISTS "category" VARCHAR(40);
ALTER TABLE "reward_rules" ADD COLUMN IF NOT EXISTS "label_ar" TEXT;
ALTER TABLE "reward_rules" ADD COLUMN IF NOT EXISTS "max_per_day" INTEGER;
ALTER TABLE "reward_rules" ADD COLUMN IF NOT EXISTS "max_per_week" INTEGER;
ALTER TABLE "reward_rules" ADD COLUMN IF NOT EXISTS "min_verified_by" VARCHAR(10);
ALTER TABLE "reward_rules" ADD COLUMN IF NOT EXISTS "created_by_user_id" UUID;
ALTER TABLE "reward_rules" ADD COLUMN IF NOT EXISTS "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- --- 1b. rewards_ledger_entries: the BUSINESS DATE a grant belongs to -------
--
-- WHY A COLUMN AND NOT A `created_at` RANGE. `maxPerDay` has to answer "how
-- many times has this rule paid this child TODAY?", and "today" is a property
-- of the family (B1+B2), not of the server. Answering it with
-- `created_at >= $start AND created_at < $end` requires reconstructing the
-- family's day boundaries as instants on every check, and it is wrong in three
-- ways that a stored date is not:
--
--   1. `created_at` is written by PostgreSQL's `now()`, while the day boundary
--      is computed from the APPLICATION's clock. Any skew between them
--      mis-buckets grants near midnight — the exact hours PA-B-001 was about.
--   2. A family that changes its timezone re-buckets its ENTIRE history,
--      because the boundaries move under rows that never moved.
--   3. It cannot be indexed usefully per (child, rule, day).
--
-- The column stores what `FamilyDateService.getBusinessDate(familyId)` returned
-- at grant time — the same value the idempotency key is built from — so the cap
-- and the key agree by construction rather than by coincidence.
--
-- NULLABLE: every row written before this migration has no business date and
-- must not be invented one. Those rows simply do not count against a cap, which
-- is correct — no cap existed when they were written.
ALTER TABLE "rewards_ledger_entries" ADD COLUMN IF NOT EXISTS "business_date" DATE;

CREATE INDEX IF NOT EXISTS "rewards_ledger_entries_cap_idx"
  ON "rewards_ledger_entries" ("child_id", "source", "business_date");

-- --- 2. new reward categories (ROWS, not enum values) -----------------------
-- The client's category list, mapped onto what 0006 already seeded:
--   Religion            -> RELIGION            (new)
--   Quran/Hadith/Fiqh   -> QURAN/HADITH/FIQH   (0006)
--   Manners             -> MANNERS             (0006)
--   Education           -> STUDY               (0006)
--   Science/Programming -> SCIENCE/PROGRAMMING (0006)
--   Mathematics         -> MATH                (0006)
--   Reading             -> READING             (0006)
--   Sports              -> SPORT               (0006)
--   Fitness             -> FITNESS             (new)
--   Health              -> HEALTH              (0006)
--   Habits              -> HABITS              (0006)
--   Family contribution -> FAMILY_CONTRIBUTION (new)
--   Custom              -> CUSTOM              (new)
INSERT INTO "reward_program_categories" ("code", "label_ar", "streak_kind", "sort_order") VALUES
  ('RELIGION', 'دين', 'quran', 200),
  ('FITNESS', 'لياقة بدنية', 'exercise', 210),
  ('FAMILY_CONTRIBUTION', 'مساهمة أسرية', 'behaviour', 220),
  ('CUSTOM', 'مخصص من الوالد', 'learning', 230)
ON CONFLICT ("code") DO UPDATE
  SET "label_ar" = EXCLUDED."label_ar",
      "streak_kind" = EXCLUDED."streak_kind",
      "sort_order" = EXCLUDED."sort_order";

-- --- 3. FK: a rule's category must be a real, catalogued category -----------
-- ON DELETE RESTRICT, exactly like `reward_programs.category` in 0006: a
-- catalogue row a family is actively using cannot be deleted out from under it.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'reward_rules_category_fkey'
  ) THEN
    ALTER TABLE "reward_rules"
      ADD CONSTRAINT "reward_rules_category_fkey"
      FOREIGN KEY ("category") REFERENCES "reward_program_categories"("code")
      ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END
$$;

-- --- 4. sanity CHECKs -------------------------------------------------------
-- Same class as 0002's six reward-integrity CHECKs, and the same caveat: these
-- live in SQL and not in schema.prisma, so a future `prisma migrate dev` would
-- offer to drop them. `test/database/reward-rule-constraints.integration.spec.ts`
-- queries `pg_constraint` and fails if any of them is missing.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'reward_rules_max_per_day_positive') THEN
    ALTER TABLE "reward_rules" ADD CONSTRAINT "reward_rules_max_per_day_positive"
      CHECK ("max_per_day" IS NULL OR "max_per_day" > 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'reward_rules_max_per_week_positive') THEN
    ALTER TABLE "reward_rules" ADD CONSTRAINT "reward_rules_max_per_week_positive"
      CHECK ("max_per_week" IS NULL OR "max_per_week" > 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'reward_rules_min_verified_by_known') THEN
    ALTER TABLE "reward_rules" ADD CONSTRAINT "reward_rules_min_verified_by_known"
      CHECK ("min_verified_by" IS NULL OR "min_verified_by" IN ('SELF', 'SENSOR', 'SYSTEM', 'PARENT'));
  END IF;
END
$$;

-- --- 5. one active managed rule per scope -----------------------------------
--
-- WHY AN EXPRESSION INDEX. Two rules that differ only in their
-- `trigger_condition` are legitimate and necessary (the two health defaults
-- differ only by `{metric: hydration}` vs `{metric: activity}`), so the
-- condition has to be part of the key. `md5(trigger_condition::text)` is
-- deterministic for `jsonb` because PostgreSQL stores jsonb with its keys
-- sorted and its whitespace normalised — `{"a":1,"b":2}` and `{ "b":2, "a":1 }`
-- produce the same text and therefore the same hash.
--
-- WHY `COALESCE(family_id, ...)`. In a plain unique index every NULL is
-- distinct, so a NULL `family_id` (the platform tier) would be unconstrained —
-- the same vacuous-index trap A2 §7.3 measured on `idempotency_key`. The
-- COALESCE to the nil UUID gives the platform tier a real, shared key.
--
-- `WHERE program_id IS NULL AND is_active` scopes it to MANAGED rules: F4
-- companion rows deliberately carry several multiplier tiers for one program
-- and must not be constrained by this, and a deactivated rule is history.
CREATE UNIQUE INDEX IF NOT EXISTS "reward_rules_active_scope_uniq"
  ON "reward_rules" (
    COALESCE("family_id", '00000000-0000-0000-0000-000000000000'::uuid),
    "trigger_engine",
    COALESCE("event_type", '*'),
    "reward_type",
    md5("trigger_condition"::text)
  )
  WHERE "program_id" IS NULL AND "is_active";

-- Hot path: `listActiveRewardRules(familyId, triggerEngine)` runs on EVERY
-- completion, for both tiers at once.
CREATE INDEX IF NOT EXISTS "reward_rules_engine_active_idx"
  ON "reward_rules" ("trigger_engine", "is_active");

-- --- 6. THE PLATFORM DEFAULTS ----------------------------------------------
--
-- Generated FROM `src/shared/rewards/reward-rule-catalogue.ts`, and asserted
-- equal to it row for row by `test/rewards/reward-rule-catalogue.spec.ts`. Two
-- copies of a constant only stay in agreement if something FAILS when they
-- diverge — the same argument migration 0006 makes for the Quran catalogue.
--
-- `family_id IS NULL` = the platform tier. `listActiveRewardRules` has always
-- selected `OR: [{familyId}, {familyId: null}]`, so these rows reach EVERY
-- family — including every family created before this migration ran — with zero
-- code change on the read path. That retroactivity is the whole reason the
-- defaults are resolved lazily instead of copied per family at family creation.
--
-- Ids are deterministic (`00000000-0000-4b40-8000-...`), which is what makes
-- `ON CONFLICT DO UPDATE` re-runnable and lets a test assert a specific row.
INSERT INTO "reward_rules"
  ("id", "family_id", "trigger_engine", "event_type", "trigger_condition",
   "reward_type", "reward_amount_or_badge_id", "is_active",
   "max_per_day", "max_per_week", "category", "label_ar", "created_at", "updated_at")
VALUES
  ('00000000-0000-4b40-8000-000000000000', NULL, 'habit-builder', 'HABIT_COMPLETED', '{}'::jsonb, 'XP', '10', true, 10, 60, 'HABITS', 'إتمام عادة', now(), now()),
  ('00000000-0000-4b40-8000-000000000001', NULL, 'habit-builder', 'STREAK_ACHIEVED', '{}'::jsonb, 'COINS', '15', true, 3, 10, 'HABITS', 'سلسلة عادات متصلة', now(), now()),
  ('00000000-0000-4b40-8000-00000000000f', NULL, 'habit-builder', 'DAILY_GOAL_COMPLETED', '{}'::jsonb, 'XP', '20', true, 2, 14, 'HABITS', 'هدف يومي مكتمل', now(), now()),
  ('00000000-0000-4b40-8000-000000000002', NULL, 'smart-tasks', 'TASK_COMPLETED', '{}'::jsonb, 'XP', '10', true, 10, 60, 'FAMILY_CONTRIBUTION', 'إتمام مهمة', now(), now()),
  ('00000000-0000-4b40-8000-000000000003', NULL, 'health', 'HYDRATION_GOAL_COMPLETED', '{}'::jsonb, 'XP', '15', true, 1, 7, 'HEALTH', 'هدف شرب الماء اليومي', now(), now()),
  ('00000000-0000-4b40-8000-000000000004', NULL, 'health', 'ACTIVITY_GOAL_COMPLETED', '{}'::jsonb, 'XP', '20', true, 1, 7, 'FITNESS', 'هدف النشاط البدني اليومي', now(), now()),
  ('00000000-0000-4b40-8000-000000000005', NULL, 'health', 'DAILY_GOAL_COMPLETED', '{"metric": "hydration"}'::jsonb, 'XP', '15', true, 1, 7, 'HEALTH', 'هدف شرب الماء اليومي', now(), now()),
  ('00000000-0000-4b40-8000-000000000006', NULL, 'health', 'DAILY_GOAL_COMPLETED', '{"metric": "activity"}'::jsonb, 'XP', '20', true, 1, 7, 'FITNESS', 'هدف النشاط البدني اليومي', now(), now()),
  ('00000000-0000-4b40-8000-000000000007', NULL, 'health', 'STREAK_ACHIEVED', '{}'::jsonb, 'COINS', '20', true, 2, 8, 'HEALTH', 'سلسلة صحية متصلة', now(), now()),
  ('00000000-0000-4b40-8000-000000000008', NULL, 'learning', 'EDUCATION_PROGRESS', '{}'::jsonb, 'XP', '20', true, 5, 30, 'STUDY', 'تقدّم دراسي', now(), now()),
  ('00000000-0000-4b40-8000-000000000009', NULL, 'learning', 'EDUCATION_TASK_COMPLETED', '{}'::jsonb, 'XP', '20', true, 5, 30, 'STUDY', 'جلسة تعلّم', now(), now()),
  ('00000000-0000-4b40-8000-00000000000a', NULL, 'learning', 'LEARNING_GOAL_ACHIEVED', '{}'::jsonb, 'COINS', '50', true, 3, 10, 'STUDY', 'تحقيق هدف تعليمي', now(), now()),
  ('00000000-0000-4b40-8000-00000000000b', NULL, 'learning', 'STREAK_ACHIEVED', '{}'::jsonb, 'COINS', '20', true, 2, 8, 'STUDY', 'سلسلة تعلّم متصلة', now(), now()),
  ('00000000-0000-4b40-8000-00000000000c', NULL, 'faith', 'MEMORIZATION_COMPLETED', '{}'::jsonb, 'XP', '25', true, 5, 30, 'QURAN', 'إتمام حفظ', now(), now()),
  ('00000000-0000-4b40-8000-00000000000d', NULL, 'faith', 'FAITH_PRACTICE_COMPLETED', '{}'::jsonb, 'XP', '15', true, 6, 42, 'RELIGION', 'أداء عبادة', now(), now()),
  ('00000000-0000-4b40-8000-00000000000e', NULL, 'faith', 'STREAK_ACHIEVED', '{}'::jsonb, 'COINS', '20', true, 2, 8, 'RELIGION', 'سلسلة عبادة متصلة', now(), now())
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

-- --- 7. RLS grants (only when 0004's role exists) ---------------------------
-- 0004 created `abny_app` and its policies conditionally; this block follows
-- the same shape so the migration runs identically on a database where the role
-- was never created (CI, local dev).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'abny_app') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE ON "reward_rules" TO abny_app';
  END IF;
END
$$;
