-- =============================================================================
-- 0011_scheduler_and_retention — Phase C, step P4 (PA-B-031).
--
-- THE DEFECT. Phase B's own final report named it blocker #5 and classified it
-- as a COMPLIANCE CONDITION rather than an improvement: there is no scheduler
-- anywhere in this repository, therefore data retention is dead code. A2 §9.1
-- measured the consequence — retention covers 5 tables of 60, and nothing runs
-- any of them. `DataRetentionEnforcementService.enforceAll()` had ZERO
-- production callers; its own docstring admits «Not scheduled anywhere
-- itself.» So did `HabitEngineService.markMissedHabits()`, which is why
-- `habit_completions.status` has a `MISSED` value that no code path in
-- production has ever written.
--
-- This migration adds the two tables that make a scheduled job a fact with a
-- history rather than a timer with a log line, plus the RETENTION INDEXES
-- A2 DA-011 measured as missing (a 300K-row `notifications` sweep was a Seq
-- Scan over 226,517 rows / 230,517 buffers / 208ms, because every index on
-- that table leads with a column the sweep does not filter on).
--
-- SAFE TO RE-RUN. Every statement is IF NOT EXISTS / ON CONFLICT DO NOTHING,
-- the same property migrations 0007-0010 established, so applying it twice to
-- the same database is a no-op rather than an error.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. THE JOB REGISTRY. One row per named job; the row is also the LEASE.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "scheduled_jobs" (
  "name"                  VARCHAR(60)  PRIMARY KEY,
  "scope"                 VARCHAR(20)  NOT NULL,
  "cadence_seconds"       INTEGER      NOT NULL,
  "local_hour"            SMALLINT,
  "enabled"               BOOLEAN      NOT NULL DEFAULT true,
  "next_run_at"           TIMESTAMP(3) NOT NULL DEFAULT now(),
  "last_started_at"       TIMESTAMP(3),
  "last_finished_at"      TIMESTAMP(3),
  "last_status"           VARCHAR(20),
  "last_error"            VARCHAR(500),
  "last_duration_ms"      INTEGER,
  "last_affected_rows"    INTEGER,
  "consecutive_failures"  INTEGER      NOT NULL DEFAULT 0,
  "locked_by"             VARCHAR(60),
  "locked_at"             TIMESTAMP(3),
  "created_at"            TIMESTAMP(3) NOT NULL DEFAULT now(),
  "updated_at"            TIMESTAMP(3) NOT NULL DEFAULT now()
);

-- The scope vocabulary is closed AT THE DATABASE, not by a TypeScript union
-- that a raw INSERT can walk around. Same discipline as migration 0002's
-- CHECK constraints on the rewards ledger.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'scheduled_jobs_scope_check') THEN
    ALTER TABLE "scheduled_jobs"
      ADD CONSTRAINT "scheduled_jobs_scope_check" CHECK ("scope" IN ('PLATFORM', 'FAMILY'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'scheduled_jobs_cadence_check') THEN
    ALTER TABLE "scheduled_jobs"
      ADD CONSTRAINT "scheduled_jobs_cadence_check" CHECK ("cadence_seconds" > 0);
  END IF;
  -- A FAMILY job without a local hour has no definition of when its day ends;
  -- a PLATFORM job with one implies a calendar it does not have. Both are
  -- refused here rather than half-honoured in code.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'scheduled_jobs_local_hour_check') THEN
    ALTER TABLE "scheduled_jobs"
      ADD CONSTRAINT "scheduled_jobs_local_hour_check" CHECK (
        ("scope" = 'FAMILY'   AND "local_hour" IS NOT NULL AND "local_hour" BETWEEN 0 AND 23)
        OR
        ("scope" = 'PLATFORM' AND "local_hour" IS NULL)
      );
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "scheduled_jobs_enabled_next_run_at_idx"
  ON "scheduled_jobs" ("enabled", "next_run_at");

-- -----------------------------------------------------------------------------
-- 2. THE RUN HISTORY. started / finished / failed, duration, affected rows —
--    and the UNIQUE KEY that is the whole idempotency guarantee.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "job_runs" (
  "id"            UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  "family_id"     UUID,
  "job_name"      VARCHAR(60)  NOT NULL,
  "business_date" DATE,
  "status"        VARCHAR(20)  NOT NULL,
  "attempt"       INTEGER      NOT NULL DEFAULT 1,
  "worker_id"     VARCHAR(60)  NOT NULL,
  "trigger"       VARCHAR(20)  NOT NULL DEFAULT 'SCHEDULE',
  "started_at"    TIMESTAMP(3) NOT NULL DEFAULT now(),
  "finished_at"   TIMESTAMP(3),
  "duration_ms"   INTEGER,
  "affected_rows" INTEGER      NOT NULL DEFAULT 0,
  "details"       JSONB,
  "error"         VARCHAR(1000)
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'job_runs_family_id_fkey') THEN
    ALTER TABLE "job_runs"
      ADD CONSTRAINT "job_runs_family_id_fkey"
      FOREIGN KEY ("family_id") REFERENCES "families"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'job_runs_job_name_fkey') THEN
    ALTER TABLE "job_runs"
      ADD CONSTRAINT "job_runs_job_name_fkey"
      FOREIGN KEY ("job_name") REFERENCES "scheduled_jobs"("name") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'job_runs_status_check') THEN
    ALTER TABLE "job_runs"
      ADD CONSTRAINT "job_runs_status_check" CHECK ("status" IN ('RUNNING', 'SUCCEEDED', 'FAILED'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'job_runs_trigger_check') THEN
    ALTER TABLE "job_runs"
      ADD CONSTRAINT "job_runs_trigger_check" CHECK ("trigger" IN ('SCHEDULE', 'MANUAL'));
  END IF;
END $$;

-- THE IDEMPOTENCY CONSTRAINT. One run per (job, family, business date).
-- NULLs are distinct in a PostgreSQL unique index, so PLATFORM runs
-- (family_id NULL, business_date NULL) accumulate one row per execution while
-- FAMILY runs are pinned to exactly one row per calendar day per household.
CREATE UNIQUE INDEX IF NOT EXISTS "job_runs_job_name_family_id_business_date_key"
  ON "job_runs" ("job_name", "family_id", "business_date");

CREATE INDEX IF NOT EXISTS "job_runs_job_name_started_at_idx" ON "job_runs" ("job_name", "started_at");
CREATE INDEX IF NOT EXISTS "job_runs_family_id_job_name_idx"   ON "job_runs" ("family_id", "job_name");
CREATE INDEX IF NOT EXISTS "job_runs_status_started_at_idx"    ON "job_runs" ("status", "started_at");

-- -----------------------------------------------------------------------------
-- 3. THE RETENTION INDEXES (A2 DA-011).
--
--    Every retention sweep filters on a TIME column alone and on nothing else,
--    because retention is a property of age, not of ownership. Every index that
--    existed on these tables leads with `family_id`, `child_id` or `user_id`,
--    so PostgreSQL could not use any of them and every sweep was a Seq Scan
--    over the whole table — measured by A2 at 226,517 rows / 208ms on a 300K
--    `notifications` table, i.e. a sweep that gets slower exactly as the reason
--    to run it gets more urgent.
--
--    These are plain B-tree indexes on the single sweep column. BRIN was
--    considered and rejected for now: BRIN wins on append-only physical
--    ordering and these tables are all subject to interleaved DELETEs, which
--    degrade BRIN's block ranges. Partitioning (A2 §10's real answer above
--    ~100K families) is the follow-up, and it is recorded as such rather than
--    pretended at here.
-- -----------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS "notifications_created_at_idx"              ON "notifications" ("created_at");
CREATE INDEX IF NOT EXISTS "daily_behavioral_snapshots_usage_date_idx" ON "daily_behavioral_snapshots" ("usage_date");
CREATE INDEX IF NOT EXISTS "app_usage_logs_usage_date_idx"             ON "app_usage_logs" ("usage_date");
CREATE INDEX IF NOT EXISTS "child_messages_created_at_idx"             ON "child_messages" ("created_at");
CREATE INDEX IF NOT EXISTS "ai_memory_entries_updated_at_idx"          ON "ai_memory_entries" ("updated_at");
CREATE INDEX IF NOT EXISTS "audit_logs_created_at_idx"                 ON "audit_logs" ("created_at");
CREATE INDEX IF NOT EXISTS "ai_usage_logs_created_at_idx"              ON "ai_usage_logs" ("created_at");
CREATE INDEX IF NOT EXISTS "analytics_events_occurred_at_idx"          ON "analytics_events" ("occurred_at");
CREATE INDEX IF NOT EXISTS "consumed_messages_consumed_at_idx"         ON "consumed_messages" ("consumed_at");
CREATE INDEX IF NOT EXISTS "domain_events_received_at_idx"             ON "domain_events" ("received_at");
CREATE INDEX IF NOT EXISTS "refresh_tokens_expires_at_idx"             ON "refresh_tokens" ("expires_at");
-- Partial: the sweep only ever looks at messages that are already delivered,
-- and a partial index keeps the hot PENDING/FAILED rows out of it entirely.
CREATE INDEX IF NOT EXISTS "outbox_messages_published_at_idx"
  ON "outbox_messages" ("published_at") WHERE "status" = 'PUBLISHED';

-- -----------------------------------------------------------------------------
-- 4. SEED THE REGISTRY.
--
--    The rows are seeded HERE rather than upserted at boot for one reason: a
--    job's `enabled` flag and `local_hour` are OPERATIONAL STATE an operator is
--    allowed to change, and a boot-time upsert would silently revert their
--    decision on every deploy. `ON CONFLICT DO NOTHING` means the code owns the
--    job's existence and the operator owns its configuration.
--
--    Cadences, and why each one is that number:
--      data-retention-sweep      86400s  — daily. Deleting aged data one day
--                                          late is acceptable; hammering the
--                                          table hourly is not.
--      expired-token-sweep       86400s  — daily. A refresh token is already
--                                          rejected the instant it expires
--                                          (`token.service.ts:157`); this only
--                                          removes the corpse.
--      outbox-dead-letter-alert    300s  — every 5 min. This is an alert; a
--                                          5-minute detection window on a
--                                          permanently-undeliverable reward
--                                          announcement is the point.
--      family-daily-rollover       900s  — every 15 min. NOT the per-family
--                                          cadence: this is how often each
--                                          family's own local clock is
--                                          re-checked against its 02:00
--                                          boundary. A family is rolled over
--                                          exactly once per ITS OWN business
--                                          day, enforced by job_runs' unique
--                                          key, and 15 minutes is the worst-case
--                                          lateness of that boundary.
-- -----------------------------------------------------------------------------
INSERT INTO "scheduled_jobs" ("name", "scope", "cadence_seconds", "local_hour", "enabled")
VALUES
  ('data-retention-sweep',     'PLATFORM', 86400, NULL, true),
  ('expired-token-sweep',      'PLATFORM', 86400, NULL, true),
  ('outbox-dead-letter-alert', 'PLATFORM',   300, NULL, true),
  ('family-daily-rollover',    'FAMILY',     900,    2, true)
ON CONFLICT ("name") DO NOTHING;
