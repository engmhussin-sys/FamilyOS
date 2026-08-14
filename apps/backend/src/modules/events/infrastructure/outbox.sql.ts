/**
 * The Outbox relay's claim/complete statements, exported as constants for the
 * same reason `rewards.sql.ts` exports its own: the integration tests execute
 * THESE EXACT STRINGS against a real PostgreSQL. If `FOR UPDATE SKIP LOCKED`
 * or a `WHERE` clause is ever dropped from production, the test that proves the
 * property goes red — the test cannot drift from the code it protects.
 *
 * TENANCY: every statement names `family_id` explicitly. These run under
 * `runAsSystem('OUTBOX_RELAY', ...)` because a relay is cross-tenant by
 * definition, and the CI static guard (RULE 2) requires raw SQL touching a
 * strict table to mention the column. Both facts are deliberate: the SELECT
 * RETURNS `family_id` so the relay can immediately re-enter a real tenant
 * context before any consumer runs.
 */

/**
 * Claims a batch of deliverable messages ATOMICALLY.
 *
 * `FOR UPDATE SKIP LOCKED` is what makes the relay horizontally scalable: N
 * instances polling the same table never hand the same row to two of them and
 * never block each other. Without SKIP LOCKED, instance 2 waits on instance 1's
 * lock and the relay's throughput becomes single-threaded.
 *
 * The UPDATE and the SELECT are one statement so there is no window in which a
 * row is selected but not yet marked PUBLISHING.
 *
 * `attempt_count` increments HERE, at claim time, not at failure time. A worker
 * that crashes mid-delivery therefore still burns an attempt, so a message that
 * reliably kills its worker reaches DEAD instead of looping forever.
 *
 * $1 workerId · $2 batch size
 */
export const SQL_CLAIM_OUTBOX_BATCH = `
UPDATE "outbox_messages" AS o
   SET "status"        = 'PUBLISHING',
       "locked_by"     = $1::text,
       "locked_at"     = now(),
       "attempt_count" = o."attempt_count" + 1
  FROM (
    SELECT "id"
      FROM "outbox_messages"
     WHERE "status" IN ('PENDING', 'FAILED')
       AND "next_attempt_at" <= now()
     ORDER BY "created_at"
     LIMIT $2::int
     FOR UPDATE SKIP LOCKED
  ) AS claimed
 WHERE o."id" = claimed."id"
RETURNING o."id"              AS id,
          o."family_id"       AS family_id,
          o."domain_event_id" AS domain_event_id,
          o."event_type"      AS event_type,
          o."destination"     AS destination,
          o."payload"         AS payload,
          o."attempt_count"   AS attempt_count`;

/**
 * Marks a message delivered. `WHERE status = 'PUBLISHING'` is not decoration:
 * it means a message whose lock was already stolen by a stale-lock sweep cannot
 * be marked PUBLISHED twice by two workers.
 *
 * $1 messageId
 */
export const SQL_MARK_OUTBOX_PUBLISHED = `
UPDATE "outbox_messages"
   SET "status" = 'PUBLISHED',
       "published_at" = now(),
       "locked_by" = NULL,
       "locked_at" = NULL,
       "last_error" = NULL
 WHERE "id" = $1::uuid
   AND "status" = 'PUBLISHING'
   AND "family_id" IS NOT NULL`;

/**
 * Schedules a retry with exponential backoff, or dead-letters the message once
 * it has burned its attempts.
 *
 * The backoff is computed in SQL rather than in TypeScript so that it is
 * applied identically no matter which process writes it, and so a DBA reading
 * the table can reproduce `next_attempt_at` from `attempt_count` alone:
 *   delay = LEAST(2 ^ attempt_count, 300) seconds  -> 2s, 4s, 8s ... capped 5m.
 *
 * $1 messageId · $2 error text (truncated to the column width by the caller)
 * $3 max attempts
 */
export const SQL_MARK_OUTBOX_FAILED = `
UPDATE "outbox_messages"
   SET "status" = CASE WHEN "attempt_count" >= $3::int THEN 'DEAD'::"OutboxStatus"
                       ELSE 'FAILED'::"OutboxStatus" END,
       "last_error" = LEFT($2::text, 500),
       "locked_by" = NULL,
       "locked_at" = NULL,
       "next_attempt_at" = now() + (LEAST(POWER(2, "attempt_count"), 300) * INTERVAL '1 second')
 WHERE "id" = $1::uuid
   AND "status" = 'PUBLISHING'
   AND "family_id" IS NOT NULL`;

/**
 * Releases messages whose worker died holding the lock. Without this a crashed
 * relay strands its in-flight batch in PUBLISHING forever, and the events it was
 * carrying are simply never delivered — the outbox's worst failure mode,
 * because it is silent.
 *
 * $1 stale-lock age in seconds
 */
export const SQL_RECLAIM_STALE_OUTBOX_LOCKS = `
UPDATE "outbox_messages"
   SET "status" = 'FAILED',
       "locked_by" = NULL,
       "locked_at" = NULL,
       "last_error" = 'reclaimed: worker lock expired',
       "next_attempt_at" = now()
 WHERE "status" = 'PUBLISHING'
   AND "locked_at" < now() - ($1::int * INTERVAL '1 second')
   AND "family_id" IS NOT NULL`;

/** Operational read: the age of the oldest undelivered message, in seconds.
 *  docs/04 §7 alerts when this passes 60s. Cross-tenant on purpose. */
export const SQL_OLDEST_PENDING_AGE_SECONDS = `
SELECT COALESCE(EXTRACT(EPOCH FROM (now() - MIN("created_at"))), 0)::int AS age_seconds,
       COUNT(*)::int AS pending_count,
       COUNT(DISTINCT "family_id")::int AS family_count
  FROM "outbox_messages"
 WHERE "status" IN ('PENDING', 'FAILED')`;
