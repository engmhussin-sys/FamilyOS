-- =============================================================================
-- 0027 — THE AI SAFETY ALERT GETS A CAUSE, AND THEREFORE AN IDENTITY
-- =============================================================================
--
-- THE DEFECT THIS UNBLOCKS. `ai_alerts` — documented in `schema.prisma` as the
-- AI layer's output contract, «parents see alerts, never raw monitored
-- content» — had READERS AND NO WRITER.
-- `GrowthAlertsService.aiSafetyIncident` (`growth-alerts.service.ts:360`) scans
-- it for un-reviewed CRITICAL rows under a comment that says «one is one too
-- many», and it scanned an empty table on every tick since 0001. The offline
-- child-safety classifier in `ai-core/domain/distress.ts` could fire and no
-- alert row was ever created, so the durable record a parent reads and the
-- page an operator receives both depended on a table nothing could fill.
-- `test/architecture/dormant-schema.guard.spec.ts` names it for exactly that.
--
-- WHAT THIS MIGRATION ADDS, AND WHY IT IS A CONSTRAINT RATHER THAN CODE.
-- A safety detection is REPLAYABLE: a child app retrying a request, a second
-- check-in inside the same conversation, two replicas handling one submission.
-- «The same detection must not alert a parent twice» is an IDENTITY statement,
-- and this project's rule (CONTEXT principle: idempotency comes from database
-- unique constraints) is that identity is held by PostgreSQL and not by a
-- check-then-insert, which cannot see a concurrent writer and forgets.
--
--   source_event_id   the producer's written answer to «what makes this alert
--                     the same alert». Composed at the call site, never here:
--                     this table does not know what caused the row and must
--                     not guess. The first producer —
--                     `DistressEscalationService` — composes
--                     `distress:<childId>:<familyBusinessDate>`, i.e. ONE
--                     distress alert per child per family day. It carries no
--                     classification code and no fragment of what the child
--                     wrote; see `ai-alert.types.ts` for the argument.
--
--   ai_alerts (family_id, source_event_id) UNIQUE
--                     family first, exactly as
--                     `notifications (family_id, source_event_id, user_id)`
--                     and `child_messages (family_id, source_event_id)` are
--                     ordered — the tenant is the leading column everywhere in
--                     this schema, so the index is usable for a per-family
--                     scan as well as for the conflict.
--
-- NOT NULL WITH NO DEFAULT, DELIBERATELY. `ai_alerts` is empty in every
-- environment (that is the defect), so there is no backfill to write and no
-- legacy prefix to invent. Making the column required is the point: a future
-- producer cannot opt out of the constraint by omitting the field, which is
-- precisely how `ICreateRuntimeAlertInput.sourceEventId` is required in B9.
--
-- VARCHAR(200) matches `notifications.source_event_id` so the two keys cannot
-- drift into different truncation rules.
--
-- RLS: `ai_alerts` already carries `family_id`, its FORCE ROW LEVEL SECURITY
-- policies from 0004, and its `family_id` index. Nothing here changes any of
-- that; a new column inherits the row's policy.
--
-- Idempotent: safe to replay.
-- =============================================================================

ALTER TABLE "ai_alerts"
  ADD COLUMN IF NOT EXISTS "source_event_id" VARCHAR(200);

-- The table has no rows in any environment (the whole reason this migration
-- exists), so this is a formality rather than a backfill — and it is written
-- anyway so that replaying this file against a database somebody has since
-- written rows into cannot fail on the NOT NULL below.
UPDATE "ai_alerts"
   SET "source_event_id" = 'legacy:' || "id"::text
 WHERE "source_event_id" IS NULL;

ALTER TABLE "ai_alerts"
  ALTER COLUMN "source_event_id" SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "ai_alerts_family_id_source_event_id_key"
  ON "ai_alerts" ("family_id", "source_event_id");
