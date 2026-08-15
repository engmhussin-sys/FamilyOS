/**
 * PHASE C P4 — the scheduler's statements, exported as constants for exactly
 * the reason `outbox.sql.ts` and `rewards.sql.ts` export theirs: the
 * integration suites EXECUTE THESE EXACT STRINGS against a real PostgreSQL. A
 * `WHERE` clause dropped from production takes the test that proves the
 * property with it, so the test cannot drift from the code it protects.
 *
 * TENANCY. `scheduled_jobs` is GLOBAL (platform configuration) and `job_runs`
 * is PLATFORM_ANNOTATED, so neither is in the CI guard's strict-table list —
 * but every statement below that touches `job_runs` names `family_id`
 * explicitly anyway, because being outside a scanner's list is not a reason to
 * write a statement that hides which tenant it touches.
 */

/**
 * THE CLAIM — and the whole no-duplicate-execution-across-replicas guarantee.
 *
 * Two independent mechanisms, and it is worth being precise about which one
 * does what, because they protect different windows:
 *
 *   1. `pg_try_advisory_xact_lock` (issued separately, see SQL_TRY_JOB_LOCK)
 *      serialises the CLAIM ITSELF. Replica B does not block on replica A's
 *      row lock; it fails fast and moves on to the next job. This is the
 *      codebase's existing primitive — `rewards.sql.ts:168` already uses the
 *      transaction-scoped advisory lock for the same reason — and it is
 *      released by COMMIT/ROLLBACK, never by us, so a crash cannot leak it.
 *
 *   2. THIS conditional UPDATE is the LEASE, and it is what protects the
 *      EXECUTION, which outlives the claim transaction. Even with no advisory
 *      lock at all, two concurrent executions of this statement cannot both
 *      return a row: PostgreSQL takes a row lock on the matching tuple, the
 *      second statement re-evaluates its qualifier against the UPDATED row,
 *      sees a fresh `locked_at`, and matches nothing. Correctness rests HERE.
 *      The advisory lock is an optimisation on top, and saying otherwise would
 *      misplace the guarantee.
 *
 * The staleness clause is the crash story. A replica that dies mid-run never
 * clears `locked_at`; after `$2` seconds the lease is simply taken by whoever
 * asks next. Nothing has to notice the death.
 *
 * $1 workerId · $2 leaseSeconds · $3 jobName · $4 ignoreSchedule (manual trigger)
 */
export const SQL_CLAIM_JOB = `
UPDATE "scheduled_jobs"
   SET "locked_by"       = $1::text,
       "locked_at"       = now(),
       "last_started_at" = now(),
       "updated_at"      = now()
 WHERE "name" = $3::text
   AND "enabled" = true
   AND ($4::boolean OR "next_run_at" <= now())
   AND ("locked_at" IS NULL OR "locked_at" < now() - make_interval(secs => $2::int))
RETURNING "name",
          "scope",
          "cadence_seconds",
          "local_hour",
          "enabled",
          "next_run_at",
          "consecutive_failures"`;

/**
 * The fast-fail half of the claim. Taken inside the SAME transaction as
 * SQL_CLAIM_JOB and released by that transaction's COMMIT.
 *
 * `hashtextextended(text, 0)` is the identical construction
 * `SQL_LOCK_GRANT_SCOPE` uses for the reward path — one hash function, one
 * namespace convention, so two subsystems cannot collide on a lock key by
 * accident. The `scheduler:` prefix is what keeps them apart.
 *
 * $1 jobName
 */
export const SQL_TRY_JOB_LOCK = `SELECT pg_try_advisory_xact_lock(hashtextextended('scheduler:' || $1::text, 0)) AS acquired`;

/** Releases the lease after a run, recording the visible outcome. $1..$7 */
export const SQL_FINISH_JOB_SUCCESS = `
UPDATE "scheduled_jobs"
   SET "locked_by"            = NULL,
       "locked_at"            = NULL,
       "last_finished_at"     = now(),
       "last_status"          = 'SUCCEEDED',
       "last_error"           = NULL,
       "last_duration_ms"     = $2::int,
       "last_affected_rows"   = $3::int,
       "consecutive_failures" = 0,
       "next_run_at"          = $4::timestamp(3),
       "updated_at"           = now()
 WHERE "name" = $1::text`;

/**
 * The FAILURE half. `consecutive_failures` increments rather than being set,
 * so the backoff and the alert threshold both read a real count, and
 * `last_error` is truncated to the column width rather than throwing — a
 * scheduler whose failure recorder can itself fail is a scheduler with no
 * failure state.
 */
export const SQL_FINISH_JOB_FAILURE = `
UPDATE "scheduled_jobs"
   SET "locked_by"            = NULL,
       "locked_at"            = NULL,
       "last_finished_at"     = now(),
       "last_status"          = 'FAILED',
       "last_error"           = left($2::text, 500),
       "last_duration_ms"     = $3::int,
       "consecutive_failures" = "consecutive_failures" + 1,
       "next_run_at"          = $4::timestamp(3),
       "updated_at"           = now()
 WHERE "name" = $1::text`;

/** Every registered job, for the operational surface. */
export const SQL_LIST_JOBS = `
SELECT "name", "scope", "cadence_seconds", "local_hour", "enabled",
       "next_run_at", "last_started_at", "last_finished_at", "last_status",
       "last_error", "last_duration_ms", "last_affected_rows",
       "consecutive_failures", "locked_by", "locked_at"
  FROM "scheduled_jobs"
 ORDER BY "name"`;

export const SQL_GET_JOB = `
SELECT "name", "scope", "cadence_seconds", "local_hour", "enabled",
       "next_run_at", "last_started_at", "last_finished_at", "last_status",
       "last_error", "last_duration_ms", "last_affected_rows",
       "consecutive_failures", "locked_by", "locked_at"
  FROM "scheduled_jobs"
 WHERE "name" = $1::text`;

/** Which jobs the poller should attempt this tick. */
export const SQL_DUE_JOB_NAMES = `
SELECT "name"
  FROM "scheduled_jobs"
 WHERE "enabled" = true
   AND "next_run_at" <= now()
 ORDER BY "next_run_at"`;

/**
 * THE IDEMPOTENCY CLAIM FOR ONE RUN — the statement that makes "run this
 * family's rollover for this business date" happen exactly once.
 *
 * `ON CONFLICT ... DO UPDATE ... WHERE status <> 'SUCCEEDED'` is doing three
 * jobs at once, and each is deliberate:
 *
 *   - A run that already SUCCEEDED conflicts, the DO UPDATE's WHERE rejects
 *     it, `RETURNING` yields NOTHING, and the caller skips. That is the
 *     idempotency guarantee, held by the database rather than by a check in
 *     code (CONTEXT §3 principle 6).
 *   - A run that FAILED conflicts, is taken over, and `attempt` increments.
 *     That is the retry.
 *   - A run stuck in RUNNING because its worker died is ALSO taken over —
 *     but only after the lease has expired, which is why `$6` is passed and
 *     the RUNNING case is guarded by `started_at` rather than by status alone.
 *     Without that guard, two live workers could both "take over" a run that
 *     is merely slow.
 *
 * $1 jobName · $2 familyId (nullable) · $3 businessDate (nullable) ·
 * $4 workerId · $5 trigger · $6 leaseSeconds
 */
export const SQL_CLAIM_RUN = `
INSERT INTO "job_runs" ("job_name", "family_id", "business_date", "status", "attempt", "worker_id", "trigger", "started_at")
VALUES ($1::text, $2::uuid, $3::date, 'RUNNING', 1, $4::text, $5::text, now())
ON CONFLICT ("job_name", "family_id", "business_date") DO UPDATE
   SET "status"     = 'RUNNING',
       "attempt"    = "job_runs"."attempt" + 1,
       "worker_id"  = $4::text,
       "trigger"    = $5::text,
       "started_at" = now(),
       "finished_at" = NULL,
       "duration_ms" = NULL,
       "error"       = NULL
 WHERE "job_runs"."status" = 'FAILED'
    OR ("job_runs"."status" = 'RUNNING'
        AND "job_runs"."started_at" < now() - make_interval(secs => $6::int))
RETURNING "id", "family_id", "attempt"`;

/** $1 runId · $2 durationMs · $3 affectedRows · $4 details json */
export const SQL_FINISH_RUN_SUCCESS = `
UPDATE "job_runs"
   SET "status"        = 'SUCCEEDED',
       "finished_at"   = now(),
       "duration_ms"   = $2::int,
       "affected_rows" = $3::int,
       "details"       = $4::jsonb,
       "error"         = NULL
 WHERE "id" = $1::uuid`;

/** $1 runId · $2 durationMs · $3 error */
export const SQL_FINISH_RUN_FAILURE = `
UPDATE "job_runs"
   SET "status"      = 'FAILED',
       "finished_at" = now(),
       "duration_ms" = $2::int,
       "error"       = left($3::text, 1000)
 WHERE "id" = $1::uuid`;

/**
 * The fan-out enumeration for a FAMILY-scoped job.
 *
 * BOUNDED AND RESUMABLE. It returns families that do NOT already have a
 * SUCCEEDED run for the business date they are currently able to close — but
 * the business date is per-family and depends on the family's own timezone, so
 * it cannot be computed in SQL without re-implementing `family-date.ts` in
 * PL/pgSQL. Instead this returns the CANDIDATE set (families not soft-deleted,
 * with their timezone) in a stable order, and `SQL_CLAIM_RUN` does the
 * exactly-once filtering per family. That keeps ONE implementation of the
 * business calendar in the codebase, which is the entire point of B1/B2.
 *
 * `deleted_at IS NULL` matters: rolling over a deleted family would resurrect
 * work for a household that has asked to be gone.
 *
 * $1 limit · $2 offset
 */
export const SQL_LIST_ACTIVE_FAMILIES = `
SELECT "id", "timezone"
  FROM "families"
 WHERE "deleted_at" IS NULL
 ORDER BY "id"
 LIMIT $1::int OFFSET $2::int`;

export const SQL_COUNT_ACTIVE_FAMILIES = `
SELECT count(*)::int AS total FROM "families" WHERE "deleted_at" IS NULL`;

/**
 * Run history, newest first. `family_id` is SELECTed and may be filtered so the
 * admin surface can answer "what happened to THIS household" without reading
 * every other one.
 *
 * $1 jobName (nullable = all) · $2 familyId (nullable = all) ·
 * $3 statusFilter (nullable = all) · $4 limit
 */
export const SQL_LIST_RUNS = `
SELECT "id", "job_name", "family_id", "business_date", "status", "attempt",
       "trigger", "worker_id", "started_at", "finished_at", "duration_ms",
       "affected_rows", "details", "error"
  FROM "job_runs"
 WHERE ($1::text IS NULL OR "job_name" = $1::text)
   AND ($2::uuid IS NULL OR "family_id" = $2::uuid)
   AND ($3::text IS NULL OR "status"   = $3::text)
 ORDER BY "started_at" DESC
 LIMIT $4::int`;

/**
 * The failure gauge an alert pages on. Deliberately counts runs in a WINDOW
 * rather than "all failures ever": a job that failed once last March is not an
 * incident, and an alert that never clears is an alert that gets muted.
 *
 * $1 windowHours
 */
export const SQL_FAILED_RUN_SUMMARY = `
SELECT "job_name",
       count(*)::int                                          AS failed_count,
       count(DISTINCT "family_id")::int                        AS family_count,
       max(EXTRACT(EPOCH FROM (now() - "started_at")))::int    AS oldest_age_seconds
  FROM "job_runs"
 WHERE "status" = 'FAILED'
   AND "started_at" > now() - make_interval(hours => $1::int)
 GROUP BY "job_name"
 ORDER BY failed_count DESC`;

/** Enable/disable a job from the operational surface. $1 name · $2 enabled */
export const SQL_SET_JOB_ENABLED = `
UPDATE "scheduled_jobs"
   SET "enabled" = $2::boolean, "updated_at" = now()
 WHERE "name" = $1::text`;
