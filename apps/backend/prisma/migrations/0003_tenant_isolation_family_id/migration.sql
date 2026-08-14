-- =============================================================================
-- 0003_tenant_isolation_family_id
-- R8 / DA-004 / SA-010 — make multi-tenant isolation STRUCTURAL, not manual.
--
-- Adds `family_id` to every tenant-scoped and child-scoped table so a Prisma
-- Client Extension has a column to inject into, and so Postgres RLS has a
-- column to write a policy on. Before this migration only 10 of 60 tables
-- carried the tenant key; 34 carried `child_id` only.
--
-- WHY THE STEP ORDER MATTERS (add nullable -> backfill -> NOT NULL -> FK+index)
-- ---------------------------------------------------------------------------
-- 1. `ADD COLUMN ... NOT NULL` without a DEFAULT fails outright on a table that
--    already holds rows. Adding it WITH a default would be worse: it would
--    stamp every historical row with a fabricated tenant, which is exactly the
--    class of silent data corruption this migration exists to prevent.
-- 2. So the column is added NULLABLE first. At that instant the table is in a
--    legal, readable state and the running application (which does not know
--    about the column yet) is unaffected — this is the "expand" half of an
--    expand/contract deployment.
-- 3. The backfill then derives the true tenant from the EXISTING relation
--    graph (children.family_id / devices.family_id / subscriptions.family_id).
--    It is written as `UPDATE ... WHERE family_id IS NULL`, so re-running the
--    migration is a no-op rather than a rewrite — idempotency is a property of
--    the statement, not of a wrapper script.
-- 4. Only AFTER the backfill is `SET NOT NULL` applied. Postgres validates the
--    whole table at that point; if even one row failed to resolve a tenant the
--    migration ABORTS instead of shipping a half-isolated table. A guard block
--    raises a descriptive exception before that, so the failure is diagnosable
--    (which table, how many orphans) rather than a bare constraint violation.
-- 5. The FK and the index come last: creating them before the data is clean
--    would either fail or hold a lock over the whole backfill window.
--
-- This repository has NO production data yet. The migration is nevertheless
-- written as if it did, because the ordering above is the only version of it
-- that is safe to run twice, and the only version that would still be correct
-- the day after the first customer signs up.
--
-- Idempotency: every statement is guarded (IF NOT EXISTS / catalogue lookup),
-- so the whole file can be replayed against an already-migrated database.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- STEP 1 — add the column, NULLABLE. No default: a fabricated tenant is worse
-- than a missing one.
-- -----------------------------------------------------------------------------
ALTER TABLE "parental_consents" ADD COLUMN IF NOT EXISTS "family_id" UUID;
ALTER TABLE "device_pairing_events" ADD COLUMN IF NOT EXISTS "family_id" UUID;
ALTER TABLE "screen_time_policies" ADD COLUMN IF NOT EXISTS "family_id" UUID;
ALTER TABLE "daily_behavioral_snapshots" ADD COLUMN IF NOT EXISTS "family_id" UUID;
ALTER TABLE "app_usage_logs" ADD COLUMN IF NOT EXISTS "family_id" UUID;
ALTER TABLE "app_block_rules" ADD COLUMN IF NOT EXISTS "family_id" UUID;
ALTER TABLE "location_safe_zones" ADD COLUMN IF NOT EXISTS "family_id" UUID;
ALTER TABLE "location_events" ADD COLUMN IF NOT EXISTS "family_id" UUID;
ALTER TABLE "ai_risk_scores" ADD COLUMN IF NOT EXISTS "family_id" UUID;
ALTER TABLE "ai_alerts" ADD COLUMN IF NOT EXISTS "family_id" UUID;
ALTER TABLE "ai_memory_entries" ADD COLUMN IF NOT EXISTS "family_id" UUID;
ALTER TABLE "habits" ADD COLUMN IF NOT EXISTS "family_id" UUID;
ALTER TABLE "habit_completions" ADD COLUMN IF NOT EXISTS "family_id" UUID;
ALTER TABLE "rewards_accounts" ADD COLUMN IF NOT EXISTS "family_id" UUID;
ALTER TABLE "rewards_ledger_entries" ADD COLUMN IF NOT EXISTS "family_id" UUID;
ALTER TABLE "child_badge_awards" ADD COLUMN IF NOT EXISTS "family_id" UUID;
ALTER TABLE "reward_redemptions" ADD COLUMN IF NOT EXISTS "family_id" UUID;
ALTER TABLE "child_messages" ADD COLUMN IF NOT EXISTS "family_id" UUID;
ALTER TABLE "life_timeline_events" ADD COLUMN IF NOT EXISTS "family_id" UUID;
ALTER TABLE "child_digital_twin_projections" ADD COLUMN IF NOT EXISTS "family_id" UUID;
ALTER TABLE "nutrition_logs" ADD COLUMN IF NOT EXISTS "family_id" UUID;
ALTER TABLE "hydration_logs" ADD COLUMN IF NOT EXISTS "family_id" UUID;
ALTER TABLE "sleep_logs" ADD COLUMN IF NOT EXISTS "family_id" UUID;
ALTER TABLE "activity_logs" ADD COLUMN IF NOT EXISTS "family_id" UUID;
ALTER TABLE "physical_measurement_logs" ADD COLUMN IF NOT EXISTS "family_id" UUID;
ALTER TABLE "health_score_daily" ADD COLUMN IF NOT EXISTS "family_id" UUID;
ALTER TABLE "faith_practices" ADD COLUMN IF NOT EXISTS "family_id" UUID;
ALTER TABLE "faith_practice_logs" ADD COLUMN IF NOT EXISTS "family_id" UUID;
ALTER TABLE "learning_goals" ADD COLUMN IF NOT EXISTS "family_id" UUID;
ALTER TABLE "learning_sessions" ADD COLUMN IF NOT EXISTS "family_id" UUID;
ALTER TABLE "learning_assessments" ADD COLUMN IF NOT EXISTS "family_id" UUID;
ALTER TABLE "smart_tasks" ADD COLUMN IF NOT EXISTS "family_id" UUID;
ALTER TABLE "family_challenge_participations" ADD COLUMN IF NOT EXISTS "family_id" UUID;
ALTER TABLE "notifications" ADD COLUMN IF NOT EXISTS "family_id" UUID;
ALTER TABLE "device_risk_assessments" ADD COLUMN IF NOT EXISTS "family_id" UUID;
ALTER TABLE "app_catalog_entries" ADD COLUMN IF NOT EXISTS "family_id" UUID;
ALTER TABLE "invoices" ADD COLUMN IF NOT EXISTS "family_id" UUID;
ALTER TABLE "audit_logs" ADD COLUMN IF NOT EXISTS "family_id" UUID;
ALTER TABLE "ai_usage_logs" ADD COLUMN IF NOT EXISTS "family_id" UUID;

-- -----------------------------------------------------------------------------
-- STEP 2 — backfill from the existing relation graph.
--   * 33 tables resolve through children.family_id
--   * notifications resolves through child_id when present, otherwise through
--     the recipient's family membership (user_id -> family_members)
--   * 2 tables resolve through devices.family_id
--   * invoices resolves through subscriptions.family_id
-- Every statement is `WHERE family_id IS NULL` => replay-safe.
-- -----------------------------------------------------------------------------
UPDATE "parental_consents" t SET "family_id" = c."family_id" FROM "children" c WHERE c."id" = t."child_id" AND t."family_id" IS NULL;
UPDATE "device_pairing_events" t SET "family_id" = c."family_id" FROM "children" c WHERE c."id" = t."child_id" AND t."family_id" IS NULL;
UPDATE "screen_time_policies" t SET "family_id" = c."family_id" FROM "children" c WHERE c."id" = t."child_id" AND t."family_id" IS NULL;
UPDATE "daily_behavioral_snapshots" t SET "family_id" = c."family_id" FROM "children" c WHERE c."id" = t."child_id" AND t."family_id" IS NULL;
UPDATE "app_usage_logs" t SET "family_id" = c."family_id" FROM "children" c WHERE c."id" = t."child_id" AND t."family_id" IS NULL;
UPDATE "app_block_rules" t SET "family_id" = c."family_id" FROM "children" c WHERE c."id" = t."child_id" AND t."family_id" IS NULL;
UPDATE "location_safe_zones" t SET "family_id" = c."family_id" FROM "children" c WHERE c."id" = t."child_id" AND t."family_id" IS NULL;
UPDATE "location_events" t SET "family_id" = c."family_id" FROM "children" c WHERE c."id" = t."child_id" AND t."family_id" IS NULL;
UPDATE "ai_risk_scores" t SET "family_id" = c."family_id" FROM "children" c WHERE c."id" = t."child_id" AND t."family_id" IS NULL;
UPDATE "ai_alerts" t SET "family_id" = c."family_id" FROM "children" c WHERE c."id" = t."child_id" AND t."family_id" IS NULL;
UPDATE "ai_memory_entries" t SET "family_id" = c."family_id" FROM "children" c WHERE c."id" = t."child_id" AND t."family_id" IS NULL;
UPDATE "habits" t SET "family_id" = c."family_id" FROM "children" c WHERE c."id" = t."child_id" AND t."family_id" IS NULL;
UPDATE "habit_completions" t SET "family_id" = c."family_id" FROM "children" c WHERE c."id" = t."child_id" AND t."family_id" IS NULL;
UPDATE "rewards_accounts" t SET "family_id" = c."family_id" FROM "children" c WHERE c."id" = t."child_id" AND t."family_id" IS NULL;
UPDATE "rewards_ledger_entries" t SET "family_id" = c."family_id" FROM "children" c WHERE c."id" = t."child_id" AND t."family_id" IS NULL;
UPDATE "child_badge_awards" t SET "family_id" = c."family_id" FROM "children" c WHERE c."id" = t."child_id" AND t."family_id" IS NULL;
UPDATE "reward_redemptions" t SET "family_id" = c."family_id" FROM "children" c WHERE c."id" = t."child_id" AND t."family_id" IS NULL;
UPDATE "child_messages" t SET "family_id" = c."family_id" FROM "children" c WHERE c."id" = t."child_id" AND t."family_id" IS NULL;
UPDATE "life_timeline_events" t SET "family_id" = c."family_id" FROM "children" c WHERE c."id" = t."child_id" AND t."family_id" IS NULL;
UPDATE "child_digital_twin_projections" t SET "family_id" = c."family_id" FROM "children" c WHERE c."id" = t."child_id" AND t."family_id" IS NULL;
UPDATE "nutrition_logs" t SET "family_id" = c."family_id" FROM "children" c WHERE c."id" = t."child_id" AND t."family_id" IS NULL;
UPDATE "hydration_logs" t SET "family_id" = c."family_id" FROM "children" c WHERE c."id" = t."child_id" AND t."family_id" IS NULL;
UPDATE "sleep_logs" t SET "family_id" = c."family_id" FROM "children" c WHERE c."id" = t."child_id" AND t."family_id" IS NULL;
UPDATE "activity_logs" t SET "family_id" = c."family_id" FROM "children" c WHERE c."id" = t."child_id" AND t."family_id" IS NULL;
UPDATE "physical_measurement_logs" t SET "family_id" = c."family_id" FROM "children" c WHERE c."id" = t."child_id" AND t."family_id" IS NULL;
UPDATE "health_score_daily" t SET "family_id" = c."family_id" FROM "children" c WHERE c."id" = t."child_id" AND t."family_id" IS NULL;
UPDATE "faith_practices" t SET "family_id" = c."family_id" FROM "children" c WHERE c."id" = t."child_id" AND t."family_id" IS NULL;
UPDATE "faith_practice_logs" t SET "family_id" = c."family_id" FROM "children" c WHERE c."id" = t."child_id" AND t."family_id" IS NULL;
UPDATE "learning_goals" t SET "family_id" = c."family_id" FROM "children" c WHERE c."id" = t."child_id" AND t."family_id" IS NULL;
UPDATE "learning_sessions" t SET "family_id" = c."family_id" FROM "children" c WHERE c."id" = t."child_id" AND t."family_id" IS NULL;
UPDATE "learning_assessments" t SET "family_id" = c."family_id" FROM "children" c WHERE c."id" = t."child_id" AND t."family_id" IS NULL;
UPDATE "smart_tasks" t SET "family_id" = c."family_id" FROM "children" c WHERE c."id" = t."child_id" AND t."family_id" IS NULL;
UPDATE "family_challenge_participations" t SET "family_id" = c."family_id" FROM "children" c WHERE c."id" = t."child_id" AND t."family_id" IS NULL;

-- notifications: child_id is nullable (parent-only notifications exist), so the
-- fallback is the recipient's family membership. DISTINCT ON keeps the choice
-- deterministic if a user ever belongs to more than one family; today the
-- product allows exactly one, and the NOT NULL check in STEP 3 is what proves
-- the assumption held rather than assuming it silently.
UPDATE "notifications" n SET "family_id" = c."family_id"
  FROM "children" c WHERE c."id" = n."child_id" AND n."family_id" IS NULL;
UPDATE "notifications" n SET "family_id" = fm."family_id"
  FROM (
    SELECT DISTINCT ON ("user_id") "user_id", "family_id"
    FROM "family_members" ORDER BY "user_id", "joined_at" ASC, "id" ASC
  ) fm
  WHERE fm."user_id" = n."user_id" AND n."family_id" IS NULL;

UPDATE "device_risk_assessments" t SET "family_id" = d."family_id" FROM "devices" d WHERE d."id" = t."device_id" AND t."family_id" IS NULL;
UPDATE "app_catalog_entries" t SET "family_id" = d."family_id" FROM "devices" d WHERE d."id" = t."device_id" AND t."family_id" IS NULL;
UPDATE "invoices" i SET "family_id" = s."family_id" FROM "subscriptions" s WHERE s."id" = i."subscription_id" AND i."family_id" IS NULL;

-- audit_logs / ai_usage_logs are DELIBERATELY left NULL-able and are NOT
-- backfilled here. Neither table has any relation from which a tenant could be
-- derived (audit_logs records platform-level events such as a failed login
-- before any family is known; ai_usage_logs has no FK at all). Inventing a
-- family_id for them would be a fabrication. New rows are written WITH the
-- tenant by the application from this sprint onward; historical rows honestly
-- carry NULL. See F2 report, "افتراضات ومخاطر مفتوحة".

-- -----------------------------------------------------------------------------
-- STEP 3 — prove the backfill was total BEFORE tightening the column.
-- A bare SET NOT NULL failure says only "column contains null values". This
-- block says which table and how many rows, which is the difference between a
-- five-minute fix and a rolled-back deploy.
-- -----------------------------------------------------------------------------
DO $$
DECLARE
  t    TEXT;
  n    BIGINT;
  bad  TEXT := '';
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'parental_consents',
    'device_pairing_events',
    'screen_time_policies',
    'daily_behavioral_snapshots',
    'app_usage_logs',
    'app_block_rules',
    'location_safe_zones',
    'location_events',
    'ai_risk_scores',
    'ai_alerts',
    'ai_memory_entries',
    'habits',
    'habit_completions',
    'rewards_accounts',
    'rewards_ledger_entries',
    'child_badge_awards',
    'reward_redemptions',
    'child_messages',
    'life_timeline_events',
    'child_digital_twin_projections',
    'nutrition_logs',
    'hydration_logs',
    'sleep_logs',
    'activity_logs',
    'physical_measurement_logs',
    'health_score_daily',
    'faith_practices',
    'faith_practice_logs',
    'learning_goals',
    'learning_sessions',
    'learning_assessments',
    'smart_tasks',
    'family_challenge_participations',
    'notifications',
    'device_risk_assessments',
    'app_catalog_entries',
    'invoices'
  ] LOOP
    EXECUTE format('SELECT count(*) FROM %I WHERE family_id IS NULL', t) INTO n;
    IF n > 0 THEN
      bad := bad || format('%s: %s orphan row(s); ', t, n);
    END IF;
  END LOOP;
  IF bad <> '' THEN
    RAISE EXCEPTION 'Tenant backfill incomplete -- % These rows have no resolvable family. Fix the data (or delete the orphans) and re-run; do NOT relax the constraint.', bad;
  END IF;
END $$;

-- -----------------------------------------------------------------------------
-- STEP 4 — tighten to NOT NULL. Safe now, and only now.
-- -----------------------------------------------------------------------------
ALTER TABLE "parental_consents" ALTER COLUMN "family_id" SET NOT NULL;
ALTER TABLE "device_pairing_events" ALTER COLUMN "family_id" SET NOT NULL;
ALTER TABLE "screen_time_policies" ALTER COLUMN "family_id" SET NOT NULL;
ALTER TABLE "daily_behavioral_snapshots" ALTER COLUMN "family_id" SET NOT NULL;
ALTER TABLE "app_usage_logs" ALTER COLUMN "family_id" SET NOT NULL;
ALTER TABLE "app_block_rules" ALTER COLUMN "family_id" SET NOT NULL;
ALTER TABLE "location_safe_zones" ALTER COLUMN "family_id" SET NOT NULL;
ALTER TABLE "location_events" ALTER COLUMN "family_id" SET NOT NULL;
ALTER TABLE "ai_risk_scores" ALTER COLUMN "family_id" SET NOT NULL;
ALTER TABLE "ai_alerts" ALTER COLUMN "family_id" SET NOT NULL;
ALTER TABLE "ai_memory_entries" ALTER COLUMN "family_id" SET NOT NULL;
ALTER TABLE "habits" ALTER COLUMN "family_id" SET NOT NULL;
ALTER TABLE "habit_completions" ALTER COLUMN "family_id" SET NOT NULL;
ALTER TABLE "rewards_accounts" ALTER COLUMN "family_id" SET NOT NULL;
ALTER TABLE "rewards_ledger_entries" ALTER COLUMN "family_id" SET NOT NULL;
ALTER TABLE "child_badge_awards" ALTER COLUMN "family_id" SET NOT NULL;
ALTER TABLE "reward_redemptions" ALTER COLUMN "family_id" SET NOT NULL;
ALTER TABLE "child_messages" ALTER COLUMN "family_id" SET NOT NULL;
ALTER TABLE "life_timeline_events" ALTER COLUMN "family_id" SET NOT NULL;
ALTER TABLE "child_digital_twin_projections" ALTER COLUMN "family_id" SET NOT NULL;
ALTER TABLE "nutrition_logs" ALTER COLUMN "family_id" SET NOT NULL;
ALTER TABLE "hydration_logs" ALTER COLUMN "family_id" SET NOT NULL;
ALTER TABLE "sleep_logs" ALTER COLUMN "family_id" SET NOT NULL;
ALTER TABLE "activity_logs" ALTER COLUMN "family_id" SET NOT NULL;
ALTER TABLE "physical_measurement_logs" ALTER COLUMN "family_id" SET NOT NULL;
ALTER TABLE "health_score_daily" ALTER COLUMN "family_id" SET NOT NULL;
ALTER TABLE "faith_practices" ALTER COLUMN "family_id" SET NOT NULL;
ALTER TABLE "faith_practice_logs" ALTER COLUMN "family_id" SET NOT NULL;
ALTER TABLE "learning_goals" ALTER COLUMN "family_id" SET NOT NULL;
ALTER TABLE "learning_sessions" ALTER COLUMN "family_id" SET NOT NULL;
ALTER TABLE "learning_assessments" ALTER COLUMN "family_id" SET NOT NULL;
ALTER TABLE "smart_tasks" ALTER COLUMN "family_id" SET NOT NULL;
ALTER TABLE "family_challenge_participations" ALTER COLUMN "family_id" SET NOT NULL;
ALTER TABLE "notifications" ALTER COLUMN "family_id" SET NOT NULL;
ALTER TABLE "device_risk_assessments" ALTER COLUMN "family_id" SET NOT NULL;
ALTER TABLE "app_catalog_entries" ALTER COLUMN "family_id" SET NOT NULL;
ALTER TABLE "invoices" ALTER COLUMN "family_id" SET NOT NULL;

-- -----------------------------------------------------------------------------
-- STEP 5 — foreign keys and indexes last.
-- ON DELETE CASCADE for tenant data (a deleted family takes its rows with it,
-- matching the existing children/devices cascade), ON DELETE SET NULL for the
-- two nullable/platform tables so the compliance trail survives account
-- deletion, as required by the 7-year audit retention rule.
-- -----------------------------------------------------------------------------
DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'parental_consents',
    'device_pairing_events',
    'screen_time_policies',
    'daily_behavioral_snapshots',
    'app_usage_logs',
    'app_block_rules',
    'location_safe_zones',
    'location_events',
    'ai_risk_scores',
    'ai_alerts',
    'ai_memory_entries',
    'habits',
    'habit_completions',
    'rewards_accounts',
    'rewards_ledger_entries',
    'child_badge_awards',
    'reward_redemptions',
    'child_messages',
    'life_timeline_events',
    'child_digital_twin_projections',
    'nutrition_logs',
    'hydration_logs',
    'sleep_logs',
    'activity_logs',
    'physical_measurement_logs',
    'health_score_daily',
    'faith_practices',
    'faith_practice_logs',
    'learning_goals',
    'learning_sessions',
    'learning_assessments',
    'smart_tasks',
    'family_challenge_participations',
    'notifications',
    'device_risk_assessments',
    'app_catalog_entries',
    'invoices'
  ] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = t || '_family_id_fkey') THEN
      EXECUTE format(
        'ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY ("family_id") REFERENCES "families"("id") ON DELETE CASCADE ON UPDATE CASCADE',
        t, t || '_family_id_fkey');
    END IF;
  END LOOP;

  FOREACH t IN ARRAY ARRAY[
    'audit_logs',
    'ai_usage_logs'
  ] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = t || '_family_id_fkey') THEN
      EXECUTE format(
        'ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY ("family_id") REFERENCES "families"("id") ON DELETE SET NULL ON UPDATE CASCADE',
        t, t || '_family_id_fkey');
    END IF;
  END LOOP;
END $$;

CREATE INDEX IF NOT EXISTS "parental_consents_family_id_idx" ON "parental_consents"("family_id");
CREATE INDEX IF NOT EXISTS "device_pairing_events_family_id_idx" ON "device_pairing_events"("family_id");
CREATE INDEX IF NOT EXISTS "screen_time_policies_family_id_idx" ON "screen_time_policies"("family_id");
CREATE INDEX IF NOT EXISTS "daily_behavioral_snapshots_family_id_idx" ON "daily_behavioral_snapshots"("family_id");
CREATE INDEX IF NOT EXISTS "app_usage_logs_family_id_idx" ON "app_usage_logs"("family_id");
CREATE INDEX IF NOT EXISTS "app_block_rules_family_id_idx" ON "app_block_rules"("family_id");
CREATE INDEX IF NOT EXISTS "location_safe_zones_family_id_idx" ON "location_safe_zones"("family_id");
CREATE INDEX IF NOT EXISTS "location_events_family_id_idx" ON "location_events"("family_id");
CREATE INDEX IF NOT EXISTS "ai_risk_scores_family_id_idx" ON "ai_risk_scores"("family_id");
CREATE INDEX IF NOT EXISTS "ai_alerts_family_id_idx" ON "ai_alerts"("family_id");
CREATE INDEX IF NOT EXISTS "ai_memory_entries_family_id_idx" ON "ai_memory_entries"("family_id");
CREATE INDEX IF NOT EXISTS "habits_family_id_idx" ON "habits"("family_id");
CREATE INDEX IF NOT EXISTS "habit_completions_family_id_idx" ON "habit_completions"("family_id");
CREATE INDEX IF NOT EXISTS "rewards_accounts_family_id_idx" ON "rewards_accounts"("family_id");
CREATE INDEX IF NOT EXISTS "rewards_ledger_entries_family_id_idx" ON "rewards_ledger_entries"("family_id");
CREATE INDEX IF NOT EXISTS "child_badge_awards_family_id_idx" ON "child_badge_awards"("family_id");
CREATE INDEX IF NOT EXISTS "reward_redemptions_family_id_idx" ON "reward_redemptions"("family_id");
CREATE INDEX IF NOT EXISTS "child_messages_family_id_idx" ON "child_messages"("family_id");
CREATE INDEX IF NOT EXISTS "life_timeline_events_family_id_idx" ON "life_timeline_events"("family_id");
CREATE INDEX IF NOT EXISTS "child_digital_twin_projections_family_id_idx" ON "child_digital_twin_projections"("family_id");
CREATE INDEX IF NOT EXISTS "nutrition_logs_family_id_idx" ON "nutrition_logs"("family_id");
CREATE INDEX IF NOT EXISTS "hydration_logs_family_id_idx" ON "hydration_logs"("family_id");
CREATE INDEX IF NOT EXISTS "sleep_logs_family_id_idx" ON "sleep_logs"("family_id");
CREATE INDEX IF NOT EXISTS "activity_logs_family_id_idx" ON "activity_logs"("family_id");
CREATE INDEX IF NOT EXISTS "physical_measurement_logs_family_id_idx" ON "physical_measurement_logs"("family_id");
CREATE INDEX IF NOT EXISTS "health_score_daily_family_id_idx" ON "health_score_daily"("family_id");
CREATE INDEX IF NOT EXISTS "faith_practices_family_id_idx" ON "faith_practices"("family_id");
CREATE INDEX IF NOT EXISTS "faith_practice_logs_family_id_idx" ON "faith_practice_logs"("family_id");
CREATE INDEX IF NOT EXISTS "learning_goals_family_id_idx" ON "learning_goals"("family_id");
CREATE INDEX IF NOT EXISTS "learning_sessions_family_id_idx" ON "learning_sessions"("family_id");
CREATE INDEX IF NOT EXISTS "learning_assessments_family_id_idx" ON "learning_assessments"("family_id");
CREATE INDEX IF NOT EXISTS "smart_tasks_family_id_idx" ON "smart_tasks"("family_id");
CREATE INDEX IF NOT EXISTS "family_challenge_participations_family_id_idx" ON "family_challenge_participations"("family_id");
CREATE INDEX IF NOT EXISTS "notifications_family_id_idx" ON "notifications"("family_id");
CREATE INDEX IF NOT EXISTS "device_risk_assessments_family_id_idx" ON "device_risk_assessments"("family_id");
CREATE INDEX IF NOT EXISTS "app_catalog_entries_family_id_idx" ON "app_catalog_entries"("family_id");
CREATE INDEX IF NOT EXISTS "invoices_family_id_idx" ON "invoices"("family_id");
CREATE INDEX IF NOT EXISTS "audit_logs_family_id_idx" ON "audit_logs"("family_id");
CREATE INDEX IF NOT EXISTS "ai_usage_logs_family_id_idx" ON "ai_usage_logs"("family_id");

-- DA-008: audit_logs was not filterable by tenant NOR by time range. The tenant
-- column above closes the first half; this composite index closes the second
-- and makes "show me everything that happened to family X last week" a single
-- index scan instead of a cross-tenant sequential scan.
CREATE INDEX IF NOT EXISTS "audit_logs_family_id_created_at_idx" ON "audit_logs"("family_id", "created_at");
-- DA-013: the CONTEXT §6 ceiling of <= $0.06 per active family per month is not
-- measurable without this index.
CREATE INDEX IF NOT EXISTS "ai_usage_logs_family_id_created_at_idx" ON "ai_usage_logs"("family_id", "created_at");

-- DP-1 gap found while classifying the 60 models: family_broadcast_messages has
-- carried family_id since Sprint 13 but never had an index on it.
CREATE INDEX IF NOT EXISTS "family_broadcast_messages_family_id_created_at_idx" ON "family_broadcast_messages"("family_id", "created_at");
