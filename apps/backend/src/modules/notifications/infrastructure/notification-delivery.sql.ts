/**
 * PHASE D (`PC-D-005`) — the deferral queue's statements, exported as constants
 * for the same reason `outbox.sql.ts` and `scheduler.sql.ts` export theirs: the
 * integration suite executes THESE EXACT STRINGS against a real PostgreSQL, so
 * a `WHERE` clause cannot be dropped from production without the test that
 * proves the property going red.
 *
 * TENANCY: every statement names `family_id` explicitly. The claim and the
 * cross-tenant enumeration run under `runAsSystem('NOTIFICATION_RELEASE', ...)`;
 * the per-family statements run inside `runWithTenant` and STILL name the
 * column, because CI RULE 2 requires raw SQL touching a strict table to say so
 * itself and because a statement that relies on ambient context to be correct
 * is a statement that is wrong the first time it is copied.
 */

/**
 * ENQUEUE. `ON CONFLICT DO NOTHING` on `(family_id, source_event_id)`, which is
 * B9's idempotency one link earlier in the chain: an outbox message redelivered
 * twice inside the quiet window writes ONE deferred row, not two that the
 * downstream unique index would deduplicate only after the digest had counted
 * both.
 *
 * $1 familyId · $2 childId · $3 type · $4 category · $5 priority ·
 * $6 targetAudience · $7 title · $8 body · $9 sourceEventId · $10 deferReason ·
 * $11 scheduledFor · $12 businessDate · $13 data (PHASE E, `PD-N-004`)
 */
export const SQL_ENQUEUE_DEFERRED = `
INSERT INTO "notification_deliveries" (
  "family_id", "child_id", "type", "category", "priority", "target_audience",
  "title", "body", "source_event_id", "defer_reason", "scheduled_for", "business_date", "data"
) VALUES (
  $1::uuid, $2::uuid, $3::text, $4::text, $5::text, $6::text,
  left($7::text, 200), left($8::text, 500), $9::text, $10::text, $11::timestamp, $12::date,
  $13::jsonb
)
ON CONFLICT ("family_id", "source_event_id") DO NOTHING
RETURNING "id"`;

/**
 * The families with work to do. Cross-tenant BY DESIGN — this is the sweep's
 * enumeration, and it returns ONLY the tenant id, never a row's content, so
 * the system-context bypass reads the minimum that makes the fan-out possible.
 *
 * $1 now · $2 limit
 */
export const SQL_LIST_FAMILIES_WITH_DUE_DELIVERIES = `
SELECT DISTINCT "family_id"
  FROM "notification_deliveries"
 WHERE "state" = 'PENDING'
   AND "scheduled_for" <= $1::timestamp
   AND ("next_attempt_at" IS NULL OR "next_attempt_at" <= $1::timestamp)
   AND ("locked_at" IS NULL OR "locked_at" < $1::timestamp - make_interval(secs => 120))
 ORDER BY "family_id"
 LIMIT $2::int`;

/**
 * CLAIM one family's due rows, atomically.
 *
 * `FOR UPDATE SKIP LOCKED` and the `DELIVERING` transition together are the
 * cross-replica guarantee, and they are the SAME construct `SQL_CLAIM_OUTBOX_BATCH`
 * uses — deliberately, because two delivery paths with two different concurrency
 * stories is how one of them ends up being the wrong one.
 *
 * `attempt_count` increments HERE, at claim time, not at failure time. A worker
 * that dies mid-delivery therefore still burns an attempt, so a row that
 * reliably kills its worker reaches DEAD instead of looping forever. Same
 * reasoning, same sentence, as the outbox.
 *
 * $1 familyId · $2 workerId · $3 now · $4 limit
 */
export const SQL_CLAIM_DUE_DELIVERIES = `
UPDATE "notification_deliveries" AS d
   SET "state"         = 'DELIVERING',
       "locked_by"     = $2::text,
       "locked_at"     = $3::timestamp,
       "attempt_count" = d."attempt_count" + 1,
       "updated_at"    = now()
  FROM (
    SELECT "id"
      FROM "notification_deliveries"
     WHERE "family_id" = $1::uuid
       AND "state" = 'PENDING'
       AND "scheduled_for" <= $3::timestamp
       AND ("next_attempt_at" IS NULL OR "next_attempt_at" <= $3::timestamp)
     ORDER BY "created_at"
     LIMIT $4::int
     FOR UPDATE SKIP LOCKED
  ) AS claimed
 WHERE d."id" = claimed."id"
RETURNING d."id"              AS id,
          d."family_id"       AS family_id,
          d."child_id"        AS child_id,
          d."type"            AS type,
          d."category"        AS category,
          d."priority"        AS priority,
          d."target_audience" AS target_audience,
          d."title"           AS title,
          d."body"            AS body,
          d."source_event_id" AS source_event_id,
          d."data"            AS data,
          d."scheduled_for"   AS scheduled_for,
          d."business_date"   AS business_date,
          d."attempt_count"   AS attempt_count,
          d."created_at"      AS created_at`;

/**
 * DELIVERED. `WHERE state = 'DELIVERING'` is not decoration: it means a row
 * whose lease was stolen by a stale-lock sweep cannot be marked delivered twice
 * by two workers.
 *
 * $1 id
 */
export const SQL_MARK_DELIVERED = `
UPDATE "notification_deliveries"
   SET "state"        = 'DELIVERED',
       "delivered_at" = now(),
       "updated_at"   = now(),
       "locked_by"    = NULL,
       "locked_at"    = NULL,
       "last_error"   = NULL
 WHERE "id" = $1::uuid
   AND "state" = 'DELIVERING'
   AND "family_id" IS NOT NULL`;

/**
 * SUPPRESSED — deliberately not delivered, WITH THE REASON. The CHECK
 * constraint in migration 0014 refuses this row without `resolution_reason`,
 * which is the schema-level version of the sentence this whole phase is about:
 * a dropped notification that does not say why is the defect, not the fix.
 *
 * $1 id · $2 reason
 */
export const SQL_MARK_SUPPRESSED = `
UPDATE "notification_deliveries"
   SET "state"             = 'SUPPRESSED',
       "resolution_reason" = $2::text,
       "updated_at"        = now(),
       "locked_by"         = NULL,
       "locked_at"         = NULL
 WHERE "id" = $1::uuid
   AND "state" IN ('DELIVERING', 'PENDING')
   AND "family_id" IS NOT NULL`;

/**
 * A TRANSIENT FAILURE: back to PENDING with exponential backoff — or, once the
 * attempts are burned, to DEAD.
 *
 * The backoff is computed IN SQL, exactly as `SQL_MARK_OUTBOX_FAILED` computes
 * its own, so that it is applied identically no matter which replica writes it
 * and so a DBA reading the table can see the policy without reading TypeScript.
 *
 * THE `DEAD` BRANCH IS THE POINT OF THIS STATEMENT. Phase C's finding was that
 * a permanently failed delivery must be a queryable state and not a log line
 * nobody greps. `resolution_reason = 'MAX_ATTEMPTS'` and the preserved
 * `last_error` are what an operator reads at 09:00 to learn that a reward
 * announcement from last night will never arrive.
 *
 * $1 id · $2 error · $3 maxAttempts · $4 baseSeconds · $5 maxSeconds
 */
export const SQL_MARK_ATTEMPT_FAILED = `
UPDATE "notification_deliveries"
   SET "state" = CASE
                   WHEN "attempt_count" >= $3::int THEN 'DEAD'
                   ELSE 'PENDING'
                 END,
       "resolution_reason" = CASE
                   WHEN "attempt_count" >= $3::int THEN 'MAX_ATTEMPTS'
                   ELSE NULL
                 END,
       "next_attempt_at" = CASE
                   WHEN "attempt_count" >= $3::int THEN NULL
                   ELSE now() + make_interval(secs =>
                          least($5::int, $4::int * power(2, greatest("attempt_count" - 1, 0))::int))
                 END,
       "last_error" = left($2::text, 500),
       "locked_by"  = NULL,
       "locked_at"  = NULL,
       "updated_at" = now()
 WHERE "id" = $1::uuid
   AND "state" = 'DELIVERING'
   AND "family_id" IS NOT NULL`;

/**
 * RE-DEFER. The window was still quiet when the row was released — a timezone
 * change, a policy edit, clock skew between a replica and the database. The row
 * goes back to PENDING with a NEW `scheduled_for`, and the attempt it just
 * burned is what bounds the loop: `RELEASE_DEFAULTS.maxDeferrals` is checked by
 * the caller before this is reached.
 *
 * $1 id · $2 newScheduledFor
 */
export const SQL_REDEFER = `
UPDATE "notification_deliveries"
   SET "state"         = 'PENDING',
       "scheduled_for" = $2::timestamp,
       "next_attempt_at" = NULL,
       "locked_by"     = NULL,
       "locked_at"     = NULL,
       "updated_at"    = now()
 WHERE "id" = $1::uuid
   AND "state" = 'DELIVERING'
   AND "family_id" IS NOT NULL`;

/**
 * THE OPERATOR GAUGE. Deliberately counts DEAD SEPARATELY from PENDING rather
 * than folding both into one «backlog» number — Phase C measured the exact
 * failure of not doing that: `OutboxRelay.backlog()` counted `PENDING/FAILED`
 * only, so a message reaching DEAD made the gauge go DOWN and the alert got
 * quieter as the incident got worse. This statement cannot do that.
 *
 * Cross-tenant by design; it returns counts and type names, never a title, a
 * body, a child id or a family id.
 */
export const SQL_DELIVERY_BACKLOG = `
SELECT
  count(*) FILTER (WHERE "state" = 'PENDING')::int AS pending,
  count(*) FILTER (WHERE "state" = 'DEAD')::int    AS dead,
  coalesce(
    extract(epoch FROM (now() - min("scheduled_for") FILTER (WHERE "state" = 'PENDING')))::int,
    0
  ) AS oldest_pending_age_seconds
  FROM "notification_deliveries"
 WHERE "family_id" IS NOT NULL`;

/** The DEAD breakdown an alert pages on. Types, counts, nothing else. */
export const SQL_DEAD_DELIVERIES_BY_TYPE = `
SELECT "type" AS type, count(*)::int AS count
  FROM "notification_deliveries"
 WHERE "state" = 'DEAD'
   AND "family_id" IS NOT NULL
 GROUP BY "type"
 ORDER BY count DESC, "type" ASC`;

/**
 * RELEASE STALE LEASES. A replica that died holding `DELIVERING` rows would
 * otherwise wedge them forever — `SQL_CLAIM_DUE_DELIVERIES` only looks at
 * PENDING. Nothing «notices» the death; the staleness IS the recovery, exactly
 * as it is for the scheduler's own lease.
 *
 * $1 leaseSeconds
 */
export const SQL_RECLAIM_STALE_DELIVERY_LOCKS = `
UPDATE "notification_deliveries"
   SET "state"     = 'PENDING',
       "locked_by" = NULL,
       "locked_at" = NULL,
       "updated_at" = now()
 WHERE "state" = 'DELIVERING'
   AND "locked_at" < now() - make_interval(secs => $1::int)
   AND "family_id" IS NOT NULL`;
