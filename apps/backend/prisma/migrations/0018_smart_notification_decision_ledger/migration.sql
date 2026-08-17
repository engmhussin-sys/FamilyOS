-- =============================================================================
-- 0018_smart_notification_decision_ledger — PHASE F (`F6-002`).
--
-- THE GAP. Every decision this product has ever made about a notification was
-- unrecoverable the instant it was made. `evaluateFatigue` returned
-- `{ allowed: false, blockedReason: 'DAILY_MAX' }` into a local variable;
-- `evaluateAndDeliver` turned it into an `INotificationOutcome` and returned it
-- to a consumer that wrote ONE `logger.debug` line and discarded it. Ask «why
-- did this household not get the reward notification on Tuesday?» and the
-- honest answer, for the whole life of the product, was: nobody can know.
--
-- That is not only a support problem. §9 of the F6 brief asks for sent /
-- suppressed / open rate / action rate / duplicate rate / AI-rewrite rate /
-- delivery failure / top types / fatigue, filterable by country, age, audience,
-- category and date. NOT ONE of those numbers is derivable from `notifications`
-- alone, because `notifications` holds only the rows that were SENT. The
-- interesting half of the notification system — everything it decided not to do
-- — had no storage at all.
--
-- WHAT THIS MIGRATION ADDS. Two tables.
--
--   1. `notification_decisions` — one row per decision, INCLUDING the ones that
--      produced no notification. It carries the score, the band, the trigger,
--      the reason, the full component-by-component arithmetic as JSONB, and the
--      analytics axes (country, age band, locale, audience, category). It is
--      the answer to «why», and it is also the only table from which a
--      suppression rate can be computed.
--
--   2. `notification_policy_settings` — the caps, cooldowns, quiet hours and
--      score thresholds, PER FAMILY, so that
--      `DEFAULT_FATIGUE_POLICY`'s five constants stop being a deploy away from
--      being changed. Same shape as `growth_settings`: a closed key vocabulary,
--      validated on write against `NOTIFICATION_POLICY_SCHEMAS`.
--
-- WHY A DECISION LEDGER AND NOT COLUMNS ON `notifications`. Three reasons, and
-- the first one is decisive:
--
--   a. A SUPPRESSED decision has no `notifications` row to hang a column on.
--      Columns would record only the decisions that agreed with themselves.
--   b. A CHILD-audience notification lands in `child_messages`, not
--      `notifications` (`PE-N-001` is the whole story of that split). Columns
--      would have to be added to both tables and kept in step forever.
--   c. `notifications` is read on the parent's hot path (`listForUser`). Adding
--      a JSONB explanation to it would put a debugging artefact in the payload
--      of every notification list request.
--
-- WHY IT IS NOT AN `analytics_events` ROW. Because retention differs and the
-- purpose differs: this is operational evidence about a household's own
-- notifications, read back BY that household's support case, and it inherits
-- `notifications`' own tenancy. An analytics event is aggregate, pseudonymous
-- and platform-scoped. Merging them would make the analytics store the largest
-- collection of per-child behavioural data in the system, which CONTEXT §3
-- principle 8 forbids in as many words.
--
-- PRIVACY (CONTEXT §3 principle 8). NO TITLE, NO BODY, NO CHILD NAME, NO GOAL
-- TITLE is stored here, and that is deliberate rather than incidental: the
-- rendered sentence already exists in `notifications.body` / `child_messages.
-- body` under this family's own tenancy, and copying it into a table an
-- operator queries cross-tenant would make an admin dashboard the place a
-- child's messages are readable. What is stored is the DECISION — numbers,
-- enums and a reason — which is exactly what is needed to explain an outcome
-- and nothing that identifies what was said.
--
-- TENANCY (F2 / R8). Both tables carry `family_id uuid NOT NULL` with a FK and
-- ON DELETE CASCADE, and both are registered STRICT_TENANT in
-- `tenant-model-registry.ts` — the same class as `notifications` and
-- `notification_deliveries`. There is no nullable-tenant case: a decision that
-- belongs to no household is not something this system can produce, because the
-- tenant is already established before the engine is called.
--
-- SAFE TO RE-RUN. Every statement is IF NOT EXISTS / DO NOTHING, the property
-- migrations 0007–0017 established.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. THE DECISION LEDGER.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "notification_decisions" (
  "id"                UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  "family_id"         UUID         NOT NULL,
  "child_id"          UUID,

  -- THE CAUSAL KEY, the same string the notification itself carries. It is what
  -- joins a decision to its `notifications` row (for open rate and action rate)
  -- and to its `notification_deliveries` row (for delivery failure), without
  -- this table needing a foreign key to either — which matters because the
  -- notification row may not exist at all, and that is the interesting case.
  "source_event_id"   VARCHAR(200) NOT NULL,

  -- WHAT SET IT OFF. `NOTIFICATION_TRIGGERS` — a closed union in TypeScript and
  -- a plain VARCHAR here, matching this schema's established treatment of
  -- open-ended classification fields (`notifications.type`,
  -- `notification_deliveries.category`). A CHECK would freeze the vocabulary in
  -- the database and require a migration for the ninth producer.
  "trigger"           VARCHAR(40)  NOT NULL,
  "event_type"        VARCHAR(60)  NOT NULL,
  "notification_type" VARCHAR(60)  NOT NULL,
  "category"          VARCHAR(30)  NOT NULL,
  "target_audience"   VARCHAR(10)  NOT NULL,

  -- THE FOUR EXPLAINABILITY COLUMNS the brief names by name.
  "decision"          VARCHAR(10)  NOT NULL,
  "priority_band"     VARCHAR(10)  NOT NULL,
  "score"             SMALLINT     NOT NULL,
  "reason"            VARCHAR(60)  NOT NULL,

  -- THE ARITHMETIC. One object per score component: name, raw, weight,
  -- contribution and an English note naming the fact that produced it. Stored
  -- rather than recomputed so a decision read back in six months still adds up
  -- even after the weights have been retuned — the difference between an audit
  -- trail and a re-simulation.
  "explanation"       JSONB        NOT NULL DEFAULT '[]'::jsonb,

  -- WHICH PROVIDER DECIDED. `'rule-based'` today. It exists because the entire
  -- point of `NotificationDecisionProvider` is that a different implementation
  -- can produce these rows later, and the first question anyone will ask of a
  -- surprising decision is which one did.
  "provider_id"       VARCHAR(40)  NOT NULL,

  -- THE ANALYTICS AXES, denormalised ON PURPOSE — the same argument
  -- `notification_deliveries.category` makes. A dashboard filtering «suppression
  -- rate for 11-13 year olds in Egypt last month» must not have to re-derive the
  -- child's age AS IT WAS AT THE TIME from a date of birth, nor the household's
  -- country from a subscription that has since changed. These are facts about
  -- the decision, not about the entity, and they are frozen with it.
  --
  -- `age_band` IS A BAND, NEVER AN AGE and never a date of birth: it is
  -- `notification-tone.ts`'s band string, which is the coarsest form that still
  -- answers the question the dashboard asks.
  "age_band"          VARCHAR(10),
  "locale"            VARCHAR(5)   NOT NULL DEFAULT 'ar',
  "country_code"      VARCHAR(2),

  -- THE AI COLUMNS. §7 of the brief: AI is optional personalisation and never
  -- authority, so the two facts worth recording are whether a rewrite was USED
  -- and whether one FAILED. Both false is the normal, AI-disabled path.
  "ai_rewritten"      BOOLEAN      NOT NULL DEFAULT FALSE,
  "ai_failed"         BOOLEAN      NOT NULL DEFAULT FALSE,
  -- Which copy entry actually produced the text, after the nearest-band walk and
  -- the GENERIC fallback. A dashboard showing a spike in `GENERIC` is showing a
  -- producer that shipped a type nobody wrote copy for.
  "copy_key"          VARCHAR(60)  NOT NULL DEFAULT 'GENERIC',

  -- WHAT THE PIPELINE ACTUALLY DID, as opposed to what the engine decided.
  -- These two disagreeing is not a bug, it is the most useful row in the table:
  -- «engine said SEND, pipeline said SUPPRESS/DAILY_MAX» is a complete
  -- explanation of a missing notification. NULL until the pipeline has answered,
  -- which is the honest value for a decision that suppressed before delivery was
  -- ever attempted.
  "outcome"           VARCHAR(10),
  "outcome_reason"    VARCHAR(40),

  -- The family's own business date, so «last month» means the household's month.
  "business_date"     DATE         NOT NULL,
  "created_at"        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

  CONSTRAINT "notification_decisions_family_fk"
    FOREIGN KEY ("family_id") REFERENCES "families"("id") ON DELETE CASCADE,
  CONSTRAINT "notification_decisions_child_fk"
    FOREIGN KEY ("child_id") REFERENCES "children"("id") ON DELETE CASCADE,

  -- The three closed vocabularies that are worth closing IN THE DATABASE,
  -- because a typo in one of them silently breaks a dashboard rather than
  -- raising anything. Same discipline as `notification_deliveries.state`.
  CONSTRAINT "notification_decisions_decision_check"
    CHECK ("decision" IN ('SEND', 'DEFER', 'SUPPRESS')),
  CONSTRAINT "notification_decisions_band_check"
    CHECK ("priority_band" IN ('HIGH', 'MEDIUM', 'LOW', 'SUPPRESS')),
  CONSTRAINT "notification_decisions_audience_check"
    CHECK ("target_audience" IN ('PARENT', 'CHILD')),
  CONSTRAINT "notification_decisions_outcome_check"
    CHECK ("outcome" IS NULL OR "outcome" IN ('SEND', 'DEFER', 'SUPPRESS')),
  -- The score is a 0..100 integer. Bounded here as well as in the scorer,
  -- because a clamp in application code is a promise and a CHECK is a fact.
  CONSTRAINT "notification_decisions_score_check"
    CHECK ("score" >= 0 AND "score" <= 100)
);

-- ONE DECISION PER (family, cause, audience).
--
-- The audience is IN the key and that is deliberate: one event legitimately
-- notifies both a child and a parent (`ACHIEVEMENT_VERIFIED` is classified
-- `BOTH`), and those are two decisions with two scores. Without the audience
-- the second would be silently dropped and the ledger would under-count exactly
-- the case that is hardest to reason about.
--
-- WHAT IT BUYS. A retried consumer, a redelivered outbox message and a
-- concurrent double-fire all recompute the SAME `source_event_id` — that is
-- what `notification-source-key.ts` is for — so the second insert collides and
-- is refused. The decision ledger inherits B9's idempotency instead of
-- inventing its own, which is also why a retry cannot inflate the suppression
-- rate on a dashboard.
CREATE UNIQUE INDEX IF NOT EXISTS "notification_decisions_cause_uniq"
  ON "notification_decisions" ("family_id", "source_event_id", "target_audience");

-- The tenant's own read path: «show me this household's recent decisions».
CREATE INDEX IF NOT EXISTS "notification_decisions_family_created_idx"
  ON "notification_decisions" ("family_id", "created_at" DESC);

-- The four analytics axes. Separate indexes rather than one wide composite,
-- because the dashboard filters are independent — country without category,
-- category without age band — and a composite would serve only the leading
-- prefix.
CREATE INDEX IF NOT EXISTS "notification_decisions_decision_date_idx"
  ON "notification_decisions" ("decision", "business_date");
CREATE INDEX IF NOT EXISTS "notification_decisions_category_date_idx"
  ON "notification_decisions" ("category", "business_date");
CREATE INDEX IF NOT EXISTS "notification_decisions_country_date_idx"
  ON "notification_decisions" ("country_code", "business_date");
CREATE INDEX IF NOT EXISTS "notification_decisions_type_date_idx"
  ON "notification_decisions" ("notification_type", "business_date");

-- -----------------------------------------------------------------------------
-- 2. THE POLICY, PER FAMILY.
--
--    Key/value rather than a wide table, and the reason is the one
--    `growth_settings` gives: the set of knobs will grow, every growth of it
--    would otherwise be a migration, and a migration per knob is how a product
--    ends up with knobs that live in code because adding one was too expensive.
--
--    EVERY KEY IS OPTIONAL. A household with no rows here gets
--    `DEFAULT_NOTIFICATION_POLICY`, whose numbers are byte-for-byte
--    `DEFAULT_FATIGUE_POLICY`'s. That is what lets this table ship with no
--    backfill and no behaviour change on the day it is created.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "notification_policy_settings" (
  "id"          UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  "family_id"   UUID         NOT NULL,
  "key"         VARCHAR(80)  NOT NULL,
  "value"       VARCHAR(200) NOT NULL,
  "updated_by"  UUID,
  "created_at"  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  "updated_at"  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

  CONSTRAINT "notification_policy_settings_family_fk"
    FOREIGN KEY ("family_id") REFERENCES "families"("id") ON DELETE CASCADE
);

-- One value per key per household. The UPSERT target, and the reason a double
-- submit from a settings screen cannot produce two conflicting policies.
CREATE UNIQUE INDEX IF NOT EXISTS "notification_policy_settings_family_key_uniq"
  ON "notification_policy_settings" ("family_id", "key");

CREATE INDEX IF NOT EXISTS "notification_policy_settings_family_idx"
  ON "notification_policy_settings" ("family_id");
