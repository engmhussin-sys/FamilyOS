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
 * statement that is wrong the first time it is copied. The FIVE ANALYTICS
 * statements — two for the roll-up, three for the operator breakdown — are
 * CROSS-TENANT by design, because a platform suppression rate is a
 * platform-level number. They run under `runAsSystemAsync` behind
 * `InternalAdminGuard` + `@SystemRoute`, exactly as `SQL_DELIVERY_BACKLOG` does,
 * and they return COUNTS ONLY. No title, no body, no child id, no family id
 * leaves any of them.
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
 * $18 aiRewritten · $19 aiFailed · $20 copyKey · $21 businessDate ·
 * $22 aiAllowed · $23 aiInvoked · $24 aiSafetyRejection
 *
 * SPRINT F1 — THE THREE AI COLUMNS ARE APPENDED AT THE END OF THE PARAMETER
 * LIST rather than inserted beside `ai_rewritten`, so every existing positional
 * index in this statement keeps its meaning and a reviewer diffing it can see
 * that nothing was renumbered.
 */
export const SQL_RECORD_DECISION = `
INSERT INTO "notification_decisions" (
  "family_id", "child_id", "source_event_id", "trigger", "event_type",
  "notification_type", "category", "target_audience", "decision", "priority_band",
  "score", "reason", "explanation", "provider_id", "age_band", "locale",
  "country_code", "ai_rewritten", "ai_failed", "copy_key", "business_date",
  "ai_allowed", "ai_invoked", "ai_safety_rejection"
) VALUES (
  $1::uuid, $2::uuid, $3::text, $4::text, $5::text,
  $6::text, $7::text, $8::text, $9::text, $10::text,
  $11::smallint, $12::text, $13::jsonb, $14::text, $15::text, $16::text,
  $17::text, $18::boolean, $19::boolean, $20::text, $21::date,
  $22::boolean, $23::boolean, $24::text
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
       "ai_allowed", "ai_invoked", "ai_safety_rejection",
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

/* ==========================================================================
 * THE OPERATOR BREAKDOWN (`GET /system/notifications/decision-breakdown`).
 *
 * WHY IT IS NOT `SQL_DECISION_ANALYTICS`. That statement answers «what is the
 * platform's suppression rate»: ONE row, nine numerators, rates included. The
 * question an operator has at 02:00 is a different one — «WHICH audience /
 * type / source / provenance / day is the suppression in» — and a single row
 * of grand totals cannot answer it. The two surfaces stay separate statements
 * rather than one growing statement, because a rate and a breakdown have
 * different natural shapes and merging them would give the grand total a
 * `GROUP BY` it does not want.
 *
 * THE FOUR WORDS, PINNED TO COLUMNS ONCE, HERE, so the API, the SQL and the
 * dashboard cannot drift into three vocabularies:
 *
 *   AUDIENCE    `target_audience`   PARENT | CHILD — who the decision was for.
 *   SOURCE      `trigger`           what SET IT OFF (`NOTIFICATION_TRIGGERS`:
 *                                   DOMAIN_EVENT, PERIODIC_SIGNAL, …). The
 *                                   producer-side origin.
 *   PROVENANCE  `provider_id`       WHICH DECISION PROVIDER produced the
 *                                   verdict (`rule-based-v1` today, an AI
 *                                   provider tomorrow). The provider
 *                                   abstraction exists precisely so that
 *                                   «which one decided this» is askable.
 *   DATE        `business_date`     the HOUSEHOLD's day, not a UTC one.
 *   CAUSE       `event_type`        the producer's own event — what actually
 *                                   happened (`REWARD_GRANTED`,
 *                                   `GOAL_COMPLETED`, …). «Top causes» is a
 *                                   GROUP BY this column, and it is a
 *                                   different question from «top TYPES»: one
 *                                   type carries several causes (see
 *                                   `INotificationRepository`'s docstring on
 *                                   `REWARD_GRANTED_CHILD` and its three).
 *
 * STILL NOTHING IDENTIFYING. No `family_id`, no `child_id`, no
 * `source_event_id`, no `explanation`, and the table holds no title or body at
 * all. Every column grouped on above is a closed-ish enum written by this
 * codebase, never by a user.
 * ========================================================================== */

/**
 * THE DELIVERY-ERROR REASON SET, WRITTEN ONCE.
 *
 * `SQL_DECISION_ANALYTICS` counts `delivery_failures` over exactly these two
 * reasons. The breakdown must count the SAME ones or an operator comparing the
 * two panels sees two different "delivery errors" numbers on one screen and
 * trusts neither. Interpolated rather than duplicated, and
 * `decision-analytics-sql.spec.ts` asserts the older statement still
 * contains this literal — so widening the set here cannot silently leave that
 * one behind.
 */
export const SQL_DELIVERY_ERROR_REASONS = `('DELIVERY_ERROR', 'DEFER_ENQUEUE_FAILED')`;

/** The six counts every breakdown row carries, so a bucket read on the
 * AUDIENCE table and the same bucket read on the DATE table cannot be computed
 * two different ways. `decided_*` is what the ENGINE concluded; `delivered` and
 * `delivery_errors` are what the PIPELINE then did — the two disagreeing is the
 * most useful row in this table, and it stays legible only while both are on
 * every row. */
const BREAKDOWN_COUNTS = `
  COUNT(*)::int                                                            AS total,
  COUNT(*) FILTER (WHERE d."decision" = 'SEND')::int                       AS decided_send,
  COUNT(*) FILTER (WHERE d."decision" = 'DEFER')::int                      AS decided_defer,
  COUNT(*) FILTER (WHERE d."decision" = 'SUPPRESS')::int                   AS decided_suppress,
  COUNT(*) FILTER (WHERE d."outcome" = 'SEND')::int                        AS delivered,
  COUNT(*) FILTER (WHERE d."outcome_reason" IN ${SQL_DELIVERY_ERROR_REASONS})::int
                                                                           AS delivery_errors`;

/** The filter, identical in text to the one `SQL_DECISION_ANALYTICS` carries,
 * so the breakdown and the roll-up are always over the SAME population. */
const BREAKDOWN_WHERE = `
 WHERE d."business_date" >= $1::date
   AND d."business_date" <= $2::date
   AND ($3::text IS NULL OR d."country_code" = $3::text)
   AND ($4::text IS NULL OR d."age_band" = $4::text)
   AND ($5::text IS NULL OR d."target_audience" = $5::text)
   AND ($6::text IS NULL OR d."category" = $6::text)`;

/**
 * THE FOUR CLOSED DIMENSIONS PLUS THE GRAND TOTAL, IN ONE SCAN.
 *
 * `GROUPING SETS` rather than four queries UNION ALLed, for the reason
 * `SQL_DECISION_ANALYTICS` gives for its nine `FILTER`s: every bucket must be
 * computed over ONE filtered population. Four separate statements would each
 * re-run the `WHERE`, and the first time someone edits one of them and not the
 * others the audience column and the date column stop adding up to the same
 * total — a discrepancy nobody notices until an incident.
 *
 * The grand-total grouping set `()` is in the SAME query for the same reason:
 * the denominator every percentage on the page is taken against must come from
 * the same scan as its numerators, not from a second round trip that might have
 * seen a different row.
 *
 * NO `LIMIT` HERE, AND IT NEEDS NONE. Every grouping set is bounded by a closed
 * vocabulary this codebase writes: audience is 2 (CHECK-constrained), source is
 * the 8 members of `NOTIFICATION_TRIGGERS`, provenance is the registered
 * decision providers, and date is bounded by the route's own 92-day cap. The
 * output cannot exceed roughly 105 rows however large the table gets. The two
 * OPEN vocabularies — notification type and cause — are deliberately NOT in
 * this statement; they get their own bounded top-N queries below.
 *
 * $1 fromDate · $2 toDate · $3 countryCode|NULL · $4 ageBand|NULL ·
 * $5 audience|NULL · $6 category|NULL
 */
export const SQL_DECISION_BREAKDOWN_DIMENSIONS = `
SELECT
  CASE
    WHEN GROUPING(d."target_audience") = 0 THEN 'AUDIENCE'
    WHEN GROUPING(d."trigger") = 0         THEN 'SOURCE'
    WHEN GROUPING(d."provider_id") = 0     THEN 'PROVENANCE'
    WHEN GROUPING(d."business_date") = 0   THEN 'DATE'
    ELSE 'TOTAL'
  END AS dimension,
  CASE
    WHEN GROUPING(d."target_audience") = 0 THEN d."target_audience"
    WHEN GROUPING(d."trigger") = 0         THEN d."trigger"
    WHEN GROUPING(d."provider_id") = 0     THEN d."provider_id"
    WHEN GROUPING(d."business_date") = 0   THEN to_char(d."business_date", 'YYYY-MM-DD')
    ELSE 'ALL'
  END AS bucket,
${BREAKDOWN_COUNTS}
  FROM "notification_decisions" d
${BREAKDOWN_WHERE}
 GROUP BY GROUPING SETS (
   (d."target_audience"),
   (d."trigger"),
   (d."provider_id"),
   (d."business_date"),
   ()
 )
 ORDER BY 1, 2`;

/**
 * TOP NOTIFICATION TYPES, with the full six counts.
 *
 * Separate from `SQL_DECISION_TOP_TYPES` rather than replacing it: that
 * statement is executed verbatim by the existing analytics suite and feeds the
 * existing growth panel, and widening its result set to serve a second caller
 * is how a shared query ends up with columns nobody reads. This one is the
 * operator's, and it carries what the operator's table shows.
 *
 * BOUNDED, and the bound is the caller's `$7`. `notification_type` is written
 * by producers rather than by a CHECK constraint, so its cardinality is not
 * closed the way `target_audience` is — an unbounded `GROUP BY` on it is a
 * response whose size is a function of how many producers exist.
 *
 * $1..$6 as `SQL_DECISION_BREAKDOWN_DIMENSIONS` · $7 limit
 */
export const SQL_DECISION_BREAKDOWN_TOP_TYPES = `
SELECT d."notification_type" AS bucket,
${BREAKDOWN_COUNTS}
  FROM "notification_decisions" d
${BREAKDOWN_WHERE}
 GROUP BY d."notification_type"
 ORDER BY COUNT(*) DESC, d."notification_type" ASC
 LIMIT $7::int`;

/**
 * TOP CAUSES — `event_type`, the thing that actually happened.
 *
 * The tie-break on the name is not cosmetic: without it two causes with equal
 * counts swap places between two loads of the same page, and an operator
 * reading a list that reorders itself concludes the data is moving when only
 * the sort is.
 *
 * $1..$6 as `SQL_DECISION_BREAKDOWN_DIMENSIONS` · $7 limit
 */
export const SQL_DECISION_TOP_CAUSES = `
SELECT d."event_type" AS bucket,
${BREAKDOWN_COUNTS}
  FROM "notification_decisions" d
${BREAKDOWN_WHERE}
 GROUP BY d."event_type"
 ORDER BY COUNT(*) DESC, d."event_type" ASC
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
