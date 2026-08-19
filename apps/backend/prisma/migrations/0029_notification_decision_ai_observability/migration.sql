-- ============================================================================
-- «WAS THE MODEL EVEN ALLOWED TO SPEAK?» — THE THREE FACTS THE DECISION LOG
-- COMPUTED AND THREW AWAY.
-- ============================================================================
--
-- WHAT WAS MEASURED, not inferred. `engine-quality.e2e.spec.ts §6.14` ran the
-- real consumer against a real PostgreSQL twice: once with
-- `NOTIFICATION_AI_REPHRASE_ENABLED` unset (the stub provider recorded ZERO
-- calls) and once with it set to `true` and the stub returning a rewrite the
-- safety gate then refused (the stub recorded a call). The two persisted rows
-- were IDENTICAL on every column this table had:
--
--     ai_rewritten = false, ai_failed = false      (feature off)
--     ai_rewritten = false, ai_failed = false      (model called, refused)
--
-- So `ai_rewritten = false AND ai_failed = false` — which is the state of the
-- overwhelming majority of rows in this table — carried FOUR mutually exclusive
-- histories and could not tell them apart:
--
--   1. the feature was OFF, or no `AI_PROVIDER` was bound: no model was called;
--   2. it was ON, the model WAS called, and its answer was REFUSED by safety;
--   3. it was ON, the model WAS called, and it returned the same sentence;
--   4. it was ON but the DETERMINISTIC TEMPLATE itself failed safety, so the
--      composer shipped GENERIC and never reached the model at all.
--
-- «Is our AI rephrasing actually running in production?» was therefore not
-- answerable from this database, and neither was «how often does the safety
-- gate refuse the model», which is a child-safety number.
--
-- ---------------------------------------------------------------------------
-- WHERE EACH VALUE COMES FROM. Every one of the three has a real producer that
-- already existed; nothing here is a column waiting for a future writer.
--
--   ai_allowed           `NotificationComposerService.compose` —
--                        `rephraseEnabled() && Boolean(this.ai)`, evaluated ONCE
--                        at the top of the call so that all seven of its return
--                        paths report the same answer, including the ones that
--                        return before the flag would otherwise be consulted.
--                        Carried on `ComposedNotification.aiAllowed`, written by
--                        `SmartNotificationEngineService.recordDecision`.
--
--   ai_invoked           the same method: set to `true` immediately BEFORE
--                        `await this.ai.complete(...)`, so a throw or a timeout
--                        still records «the model was called». Carried on
--                        `ComposedNotification.aiInvoked`.
--
--   ai_safety_rejection  `ComposedNotification.safetyRejection`, which has
--                        existed since `F6-004` and was discarded by the engine.
--                        A closed reason string from the composer's own
--                        `validate()` — `ENUM_OR_PLACEHOLDER_LEAK`, whatever
--                        `ChildSafetyFilterService` returned for a CHILD
--                        (`TOO_LONG`, a banned-content reason), or
--                        `PARENT_COPY_UNSAFE`. NULL MEANS «the gate had no
--                        objection», which is a fact and not an absence: the
--                        non-null case is produced on two live branches (an
--                        unsafe TEMPLATE and an unsafe MODEL ANSWER) and is
--                        exercised by `test/notifications/decision-log-completeness.e2e.spec.ts`.
--
-- WHAT IS DELIBERATELY NOT ADDED HERE: a `channel` column. The only honest
-- producer of «which channel did this actually go out on» is
-- `PushFanoutOutcome` (SENT / SKIPPED / NONE / RETRYABLE / PERMANENT /
-- NO_RECIPIENT), computed inside `PrismaRuntimeAlertRepository.createForFamilyOwner`
-- and discarded there — `IRuntimeAlertRepository.createForFamilyOwner` returns
-- `Promise<boolean>`, so the value cannot reach this table without changing that
-- contract and `SmartNotificationIntegrationService.deliverNow` with it. Anything
-- else that could be put in such a column today is a restatement of
-- `target_audience` plus `outcome` — a second source of truth for a fact this
-- row already carries — and this table's own history (the decision NOT to add a
-- `GOAL_ALMOST_DONE` progress column) is the precedent for not doing that.
--
-- ---------------------------------------------------------------------------
-- IDEMPOTENT. `IF NOT EXISTS` on all three, so applying this file twice is a
-- no-op the second time.
--
-- BACKFILL: none, and none is possible. The three facts were never recorded, so
-- a historical row cannot be told which of the four histories it had. The
-- defaults say «not allowed, not invoked, nothing refused», which is the
-- CORRECT reading for every row this product has written to date: the feature
-- flag is off by default and no shipped deployment has set it.
-- ============================================================================

ALTER TABLE "notification_decisions"
  ADD COLUMN IF NOT EXISTS "ai_allowed" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "notification_decisions"
  ADD COLUMN IF NOT EXISTS "ai_invoked" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "notification_decisions"
  ADD COLUMN IF NOT EXISTS "ai_safety_rejection" VARCHAR(40);

COMMENT ON COLUMN "notification_decisions"."ai_allowed" IS
  'Was AI rephrasing permitted for this composition (feature flag AND a bound AI_PROVIDER)? Written by NotificationComposerService.compose.';
COMMENT ON COLUMN "notification_decisions"."ai_invoked" IS
  'Was IAIProvider.complete actually entered? Set before the await, so a timeout still counts as a call. Written by NotificationComposerService.compose.';
COMMENT ON COLUMN "notification_decisions"."ai_safety_rejection" IS
  'The safety gate''s closed refusal reason for the template or the model answer, or NULL when it had no objection. ComposedNotification.safetyRejection.';

-- ---------------------------------------------------------------------------
-- NO INDEX, AND THAT IS A DECISION. Both booleans are LOW-CARDINALITY and,
-- until a deployment turns the flag on, overwhelmingly single-valued — a btree
-- on either would be an index PostgreSQL declines to use and a write cost on
-- every notification this product ever decides. The operator surfaces that
-- would read them (`GET /system/notifications/analytics` and
-- `/decision-breakdown`) are already bounded by
-- `notification_decisions_business_date_idx` from migration 0028, which is the
-- scan bound that actually matters for those queries.
-- ---------------------------------------------------------------------------
