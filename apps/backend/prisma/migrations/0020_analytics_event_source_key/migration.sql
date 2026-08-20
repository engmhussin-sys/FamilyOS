-- ============================================================================
-- PHASE F (`F6-004`, closing `PF-E-004`) — MAKE THE ANALYTICS COUNTER AS
-- IDEMPOTENT AS THE LEDGER ALREADY IS.
--
-- WHAT WAS MEASURED. `e2e-01 › THE REPLAY` re-delivered every outbox message
-- twice with the consumer markers deleted. The ledger stayed at 1, the timeline
-- stayed at 1, the notification stayed at 1, `family_activations` stayed at 1 —
-- and `analytics_events(REWARD_GRANTED)` went to 3. `GrowthDomainEventBridge`
-- states in its own docstring that it does not use `ConsumerIdempotency`
-- because «double-counting an analytics event is a rounding error». The
-- rounding error is measured: it is the redelivery rate, and it inflates the
-- FIRST_REWARD funnel step and every conversion rate computed from it.
--
-- WHY A CONSTRAINT AND NOT `ConsumerIdempotency`. F3's own docstring calls
-- `consumed_messages` an OPTIMISATION: delete the marker and the handler runs
-- again. The scenario that measured this defect DELETES THAT MARKER — it is
-- how it forces a replay — so a marker-based fix would pass a test nobody
-- wrote and fail the one that exists. The same argument B9 made about
-- notifications applies here unchanged: the refusal must be a constraint, not
-- a window and not a row that can be dropped while the cause survives.
--
-- WHY THE KEY IS `(event_name, source_event_id)` AND NOT `(family_id, …)`.
-- `family_id` is NULLABLE on this table — pre-registration events legitimately
-- have none — and PostgreSQL treats NULLs as distinct in a unique index, so
-- including it would produce a constraint that silently stops constraining for
-- exactly the rows nobody checks. `source_event_id` is a `domain_events.id`:
-- a server-assigned UUID that is already globally unique and already
-- family-scoped by its own row, so the family adds no discrimination and one
-- real risk.
--
-- PARTIAL, so the open `POST /analytics/track` surface is untouched: ad-hoc
-- product telemetry carries no source event, writes NULL, and is not
-- deduplicated by this index at all.
--
-- TENANCY (F2). No new table and no change of classification:
-- `analytics_events` keeps `family_id` and its existing `shared-null`
-- classification, which `npm run ci:tenant-guard` re-verifies.
--
-- RE-RUNNABLE: `IF NOT EXISTS` on both statements.
-- ============================================================================

ALTER TABLE "analytics_events"
  ADD COLUMN IF NOT EXISTS "source_event_id" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "analytics_events_source_event_uq"
  ON "analytics_events" ("event_name", "source_event_id")
  WHERE "source_event_id" IS NOT NULL;
