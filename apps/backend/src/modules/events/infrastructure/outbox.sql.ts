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

/**
 * PHASE C (`PC-B-002`) — THE DEAD LETTERS, BY NAME.
 *
 * `SQL_MARK_OUTBOX_FAILED` has been able to write `'DEAD'` since F3, and
 * NOTHING has ever read it back. A grant whose announcement dead-lettered was
 * therefore invisible: no metric, no query, no route — the operator could not
 * learn that a parent was owed a notification that would never arrive. This is
 * the gauge that makes that state observable, and it is deliberately the same
 * shape as `SQL_OLDEST_PENDING_AGE_SECONDS` above: an aggregate an alert can
 * page on, cross-tenant because a dead letter is a platform-level condition.
 *
 * GROUPED BY `event_type` because that is the axis an operator acts on — «12
 * REWARD_GRANTED dead» is a different incident from «12 SCREEN_TIME_THRESHOLD
 * dead», and one aggregate row hides which one happened.
 */
export const SQL_DEAD_LETTER_SUMMARY = `
SELECT "event_type"::text AS event_type,
       COUNT(*)::int AS count,
       COALESCE(EXTRACT(EPOCH FROM (now() - MIN("created_at"))), 0)::int AS oldest_age_seconds,
       COUNT(DISTINCT "family_id")::int AS family_count
  FROM "outbox_messages"
 WHERE "status" = 'DEAD'
   AND "family_id" IS NOT NULL
 GROUP BY "event_type"
 ORDER BY COUNT(*) DESC`;

/**
 * The individual dead letters, newest failure first, bounded. `family_id` is
 * SELECTED rather than filtered on: an operator triaging a dead letter needs to
 * know whose family is affected, and the relay is cross-tenant by definition
 * (the same `runAsSystem('OUTBOX_RELAY', ...)` justification the claim uses).
 *
 * $1 limit
 */
export const SQL_LIST_DEAD_LETTERS = `
SELECT "id"              AS id,
       "family_id"       AS family_id,
       "domain_event_id" AS domain_event_id,
       "event_type"::text AS event_type,
       "attempt_count"   AS attempt_count,
       "last_error"      AS last_error,
       "created_at"      AS created_at
  FROM "outbox_messages"
 WHERE "status" = 'DEAD'
   AND "family_id" IS NOT NULL
 ORDER BY "created_at" ASC
 LIMIT $1::int`;

/**
 * PHASE C (`PC-B-002`) — THE PATH BACK, AND WHY IT IS AN UPDATE AND NOT A
 * SECOND QUEUE.
 *
 * A dead-lettered grant had no route to delivery: `SQL_CLAIM_OUTBOX_BATCH`
 * claims `('PENDING', 'FAILED')` and DEAD is neither, by design — a message
 * that has killed eight workers must not loop. What was missing is a
 * DELIBERATE, OPERATOR-INITIATED return, and the correct shape for it is to
 * put the existing row back at the head of the existing queue rather than to
 * build a rival one (ADR-007: the outbox table IS the durable queue).
 *
 * `attempt_count` RESETS TO 0. Leaving it at 8 would mean the very first
 * failure after recovery dead-letters it again, which makes recovery a
 * one-attempt gesture rather than a real second chance.
 *
 * IDEMPOTENT BY CONSTRUCTION: `WHERE status = 'DEAD'` means a second run
 * matches zero rows and returns 0. There is no "already recovered" flag to get
 * out of step with the status column, and two operators pressing the button
 * simultaneously requeue the message once.
 *
 * DETERMINISTIC: the filter is (event type, family) — both explicit — so the
 * same call on the same table always moves the same rows. There is no
 * "recover everything" default; `$2` NULL means "any family" only when the
 * caller passes it, and `$1` NULL means "any event type" only when the caller
 * passes that.
 *
 * $1 event type (nullable) · $2 familyId (nullable) · $3 limit
 */
export const SQL_RECOVER_DEAD_LETTERS = `
UPDATE "outbox_messages"
   SET "status" = 'PENDING',
       "attempt_count" = 0,
       "locked_by" = NULL,
       "locked_at" = NULL,
       "published_at" = NULL,
       "next_attempt_at" = now(),
       "last_error" = LEFT(COALESCE('recovered from DEAD; previous error: ' || "last_error", 'recovered from DEAD'), 500)
 WHERE "id" IN (
   SELECT "id"
     FROM "outbox_messages"
    WHERE "status" = 'DEAD'
      AND "family_id" IS NOT NULL
      AND ($1::text IS NULL OR "event_type"::text = $1::text)
      AND ($2::uuid IS NULL OR "family_id" = $2::uuid)
    ORDER BY "created_at" ASC
    LIMIT $3::int
    FOR UPDATE SKIP LOCKED
 )`;
