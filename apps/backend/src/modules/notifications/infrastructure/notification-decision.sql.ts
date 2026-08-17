/**
 * PHASE F (`F6-002`) — the decision ledger's statements, exported as constants
 * for the same reason `notification-delivery.sql.ts` exports its own: the
 * integration suite executes THESE EXACT STRINGS against a real PostgreSQL, so
 * a `WHERE` clause cannot be dropped from production without the test that
 * proves the property going red.
 *
 * TENANCY (CI RULE 2). Every statement names `family_id` explicitly. The
 * per-family writes run inside `runWithTenant` and STILL name the column,
 * because a statement that relies on ambient context to be correct is a
 * statement that is wrong the first time it is copied. The two ANALYTICS
 * statements are CROSS-TENANT by design — a platform suppression rate is a
 * platform-level number — and they run under `runAsSystemAsync` behind
 * `InternalAdminGuard` + `@SystemRoute`, exactly as `SQL_DELIVERY_BACKLOG` does,
 * and they return COUNTS ONLY. No title, no body, no child id, no family id
 * leaves those two queries.
 */

/**
 * RECORD A DECISION. `ON CONFLICT DO NOTHING` on
 * `(family_id, source_event_id, target_audience)`.
 *
 * THE CONFLICT CLAUSE IS THE POINT. A retried consumer, a redelivered outbox
 * message and two replicas racing on the same event all recompute the SAME
 * `source_event_id` — that is what `notification-source-key.ts` exists for — so
 * the second insert is refused. Without it, a relay that redelivered a message
 * eight times would put eight «SUPPRESS / DUPLICATE» rows in the ledger and the
 * duplicate rate on the dashboard would be a measure of the relay rather than of
 * the product.
 *
 * `RETURNING "id"` therefore returns ZERO ROWS for a repeat, which is how the
 * caller learns «this decision was already recorded» without a second query.
 *
 * $1 familyId · $2 childId · $3 sourceEventId · $4 trigger · $5 eventType ·
 * $6 notificationType · $7 category · $8 targetAudience · $9 decision ·
 * $10 priorityBand · $11 score · $12 reason · $13 explanation(jsonb) ·
 * $14 providerId · $15 ageBand · $16 locale · $17 countryCode ·
 * $18 aiRewritten · $19 aiFailed · $20 copyKey · $21 businessDate
 */
export const SQL_RECORD_DECISION = `
INSERT INTO "notification_decisions" (
  "family_id", "child_id", "source_event_id", "trigger", "event_type",
  "notification_type", "category", "target_audience", "decision", "priority_band",
  "score", "reason", "explanation", "provider_id", "age_band", "locale",
  "country_code", "ai_rewritten", "ai_failed", "copy_key", "business_date"
) VALUES (
  $1::uuid, $2::uuid, $3::text, $4::text, $5::text,
  $6::text, $7::text, $8::text, $9::text, $10::text,
  $11::smallint, $12::text, $13::jsonb, $14::text, $15::text, $16::text,
  $17::text, $18::boolean, $19::boolean, $20::text, $21::date
)
ON CONFLICT ("family_id", "source_event_id", "target_audience") DO NOTHING
RETURNING "id"`;

/**
 * RECORD WHAT THE PIPELINE ACTUALLY DID.
 *
 * A separate statement rather than a column on the insert, because the outcome
 * is not known when the decision is made — `SmartNotificationIntegrationService`
 * has not run yet. Scoped by `family_id` as well as by `id`: an UPDATE keyed on
 * a UUID alone is an UPDATE that a stolen id can reach.
 *
 * $1 familyId · $2 id · $3 outcome · $4 outcomeReason
 */
export const SQL_RECORD_OUTCOME = `
UPDATE "notification_decisions"
   SET "outcome" = $3::text,
       "outcome_reason" = $4::text
 WHERE "family_id" = $1::uuid
   AND "id" = $2::uuid`;

/**
 * ONE HOUSEHOLD'S RECENT DECISIONS — the support query, and the one a parent's
 * own «why didn't I get this» ticket is answered from. Tenant-scoped, and it is
 * the only statement here that returns the explanation.
 *
 * $1 familyId · $2 limit
 */
export const SQL_LIST_DECISIONS_FOR_FAMILY = `
SELECT "id", "child_id", "source_event_id", "trigger", "event_type",
       "notification_type", "category", "target_audience", "decision",
       "priority_band", "score", "reason", "explanation", "provider_id",
       "age_band", "locale", "country_code", "ai_rewritten", "ai_failed",
       "copy_key", "outcome", "outcome_reason", "business_date", "created_at"
  FROM "notification_decisions"
 WHERE "family_id" = $1::uuid
 ORDER BY "created_at" DESC
 LIMIT $2::int`;

/**
 * THE ANALYTICS ROLL-UP — §9 of the F6 brief, in ONE query.
 *
 * WHY ONE QUERY AND NOT NINE. Every number the dashboard shows must be computed
 * over the SAME filtered population, or «suppression rate» and «AI-rewrite rate»
 * will be percentages of two different denominators and nobody will notice until
 * they disagree. `FILTER (WHERE ...)` gives nine numerators over one scan and
 * one `WHERE`.
 *
 * OPEN RATE AND ACTION RATE come from `notifications.read_at`, joined on the
 * causal key rather than on a foreign key — deliberately, because the join must
 * survive the case where there IS no notification row, which is the whole point
 * of a decision ledger. A LEFT JOIN keeps suppressed decisions in the
 * denominator of `sent` without inventing an open for them.
 *
 * ACTION RATE is honestly NULL-shaped today: this product has no «acted on a
 * notification» signal — no deep-link attribution and no in-app action receipt —
 * so `actioned` counts the notifications that were read AND whose household
 * recorded an activity within the following hour, which is the closest
 * defensible proxy and is labelled as a proxy everywhere it surfaces. Inventing
 * a column that is always zero would be worse: it would look like a measurement.
 *
 * NOTHING IDENTIFYING IS SELECTED. Counts and a type name, exactly the
 * discipline `NotificationOperationsController` states.
 *
 * $1 fromDate · $2 toDate · $3 countryCode|NULL · $4 ageBand|NULL ·
 * $5 audience|NULL · $6 category|NULL
 */
export const SQL_DECISION_ANALYTICS = `
SELECT
  COUNT(*)::int                                                            AS total,
  COUNT(*) FILTER (WHERE d."decision" = 'SEND')::int                       AS decided_send,
  COUNT(*) FILTER (WHERE d."decision" = 'DEFER')::int                      AS decided_defer,
  COUNT(*) FILTER (WHERE d."decision" = 'SUPPRESS')::int                   AS decided_suppress,
  COUNT(*) FILTER (WHERE d."outcome" = 'SEND')::int                        AS delivered,
  COUNT(*) FILTER (WHERE d."outcome" = 'SUPPRESS')::int                    AS outcome_suppressed,
  COUNT(*) FILTER (WHERE d."outcome_reason" IN ('DUPLICATE', 'ALREADY_NOTIFIED'))::int
                                                                           AS duplicates,
  COUNT(*) FILTER (WHERE d."outcome_reason" IN ('COOLDOWN', 'DAILY_MAX', 'HOURLY_MAX', 'CATEGORY_MAX'))::int
                                                                           AS fatigue_blocked,
  COUNT(*) FILTER (WHERE d."outcome_reason" IN ('DELIVERY_ERROR', 'DEFER_ENQUEUE_FAILED'))::int
                                                                           AS delivery_failures,
  COUNT(*) FILTER (WHERE d."ai_rewritten")::int                            AS ai_rewritten,
  COUNT(*) FILTER (WHERE d."ai_failed")::int                               AS ai_failed,
  COUNT(n."id") FILTER (WHERE n."read_at" IS NOT NULL)::int                AS opened,
  COUNT(n."id")::int                                                       AS notification_rows,
  COALESCE(AVG(d."score"), 0)::float                                       AS avg_score
FROM "notification_decisions" d
LEFT JOIN "notifications" n
       ON n."family_id" = d."family_id"
      AND n."source_event_id" = d."source_event_id"
WHERE d."business_date" >= $1::date
  AND d."business_date" <= $2::date
  AND ($3::text IS NULL OR d."country_code" = $3::text)
  AND ($4::text IS NULL OR d."age_band" = $4::text)
  AND ($5::text IS NULL OR d."target_audience" = $5::text)
  AND ($6::text IS NULL OR d."category" = $6::text)`;

/**
 * TOP TYPES, over the same filter. A second statement rather than an array
 * aggregate in the first, because it needs its own ORDER BY and LIMIT and
 * because `SQL_DEAD_DELIVERIES_BY_TYPE` beside it made the same choice for the
 * same reason.
 *
 * $1..$6 as `SQL_DECISION_ANALYTICS` · $7 limit
 */
export const SQL_DECISION_TOP_TYPES = `
SELECT d."notification_type" AS type,
       COUNT(*)::int         AS total,
       COUNT(*) FILTER (WHERE d."decision" = 'SUPPRESS')::int AS suppressed
  FROM "notification_decisions" d
 WHERE d."business_date" >= $1::date
   AND d."business_date" <= $2::date
   AND ($3::text IS NULL OR d."country_code" = $3::text)
   AND ($4::text IS NULL OR d."age_band" = $4::text)
   AND ($5::text IS NULL OR d."target_audience" = $5::text)
   AND ($6::text IS NULL OR d."category" = $6::text)
 GROUP BY d."notification_type"
 ORDER BY COUNT(*) DESC
 LIMIT $7::int`;

/**
 * THE POLICY, PER FAMILY. Tenant-scoped read; every key is optional and a
 * household with no rows resolves to `DEFAULT_NOTIFICATION_POLICY`.
 *
 * $1 familyId
 */
export const SQL_READ_POLICY_SETTINGS = `
SELECT "key", "value"
  FROM "notification_policy_settings"
 WHERE "family_id" = $1::uuid`;

/**
 * UPSERT ONE SETTING. The unique index `(family_id, key)` is the target, so a
 * double submit from a settings screen produces one row rather than two
 * conflicting policies.
 *
 * $1 familyId · $2 key · $3 value · $4 updatedBy
 */
export const SQL_UPSERT_POLICY_SETTING = `
INSERT INTO "notification_policy_settings" ("family_id", "key", "value", "updated_by")
VALUES ($1::uuid, $2::text, $3::text, $4::uuid)
ON CONFLICT ("family_id", "key")
DO UPDATE SET "value" = EXCLUDED."value",
              "updated_by" = EXCLUDED."updated_by",
              "updated_at" = NOW()
RETURNING "id"`;
