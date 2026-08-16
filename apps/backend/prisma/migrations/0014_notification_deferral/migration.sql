-- =============================================================================
-- 0014_notification_deferral — Phase D (PC-D-005).
--
-- THE DEFECT. `smart-notification-integration.service.ts:175` read
--
--     decision: isDeferrable ? 'DEFER' : 'SUPPRESS'
--
-- and returned. `grep "'DEFER'" src/` returned two lines: the type definition
-- and that expression. There was no table, no queue and no redelivery — a
-- notification classified «still valid, just not now» was DROPPED. With the
-- default policy of 21:00–07:00 that is ten hours of every day (41.6%) in which
-- a reward a child genuinely earned, or a safety event, disappeared for good.
--
-- THE FIX IS A TABLE, because the thing that was missing is durability. This
-- migration adds it, plus the `scheduled_jobs` row that releases from it. It
-- adds NO second scheduler and NO second queue: the release is a PLATFORM job
-- executed by the Phase C runner, under the same lease, the same advisory lock
-- and the same `job_runs` history as the other four.
--
-- WHY IT IS NOT `outbox_messages`. The outbox carries DOMAIN EVENTS to
-- consumers and its retry policy is about TRANSPORT. This table carries a
-- notification whose delivery was refused by a PRODUCT RULE, and its schedule
-- is a family-local wall-clock time. Sharing one table would mean one
-- `next_attempt_at` column meaning two different things and one relay applying
-- exponential backoff to a decision that is not failing. What IS shared is the
-- SHAPE — status vocabulary, attempt_count, next_attempt_at, last_error, a
-- terminal DEAD, and an operator-visible surface — deliberately, so that the
-- two behave alike under an incident.
--
-- TENANCY (F2). `family_id uuid NOT NULL` with a FK and ON DELETE CASCADE, and
-- the model is registered STRICT_TENANT in `tenant-model-registry.ts` — the
-- same class as `notifications` itself. A deferred notification is one
-- household's business and nothing about it is platform-level.
--
-- SAFE TO RE-RUN. Every statement is IF NOT EXISTS / DO NOTHING, the property
-- migrations 0007–0011 established.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. THE DEFERRED NOTIFICATION.
--
--    One row per notification that has been ACCEPTED but not yet DELIVERED.
--    The row is the visibility: before this table a deferred notification was
--    not «pending», it was absent, and the difference between those two words
--    is this entire migration.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "notification_deliveries" (
  "id"               UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  "family_id"        UUID         NOT NULL,
  "child_id"         UUID,

  -- The candidate, stored verbatim so the release path re-runs the SAME
  -- decision pipeline over the SAME inputs rather than reconstructing them.
  "type"             VARCHAR(60)  NOT NULL,
  "category"         VARCHAR(30)  NOT NULL,
  "priority"         VARCHAR(20)  NOT NULL DEFAULT 'NORMAL',
  "target_audience"  VARCHAR(10)  NOT NULL,
  "title"            VARCHAR(200) NOT NULL,
  "body"             VARCHAR(500) NOT NULL,

  -- THE CAUSAL KEY, carried UNCHANGED from the producer through the deferral
  -- and into `notifications.source_event_id` at release. This is what makes
  -- B9's idempotency survive defer -> deliver: the key a producer composed at
  -- 22:00 is the key inserted at 07:00, so a redelivery of the same cause
  -- collides with the unique index exactly as it would have without deferral.
  "source_event_id"  VARCHAR(200) NOT NULL,

  "state"            VARCHAR(20)  NOT NULL DEFAULT 'PENDING',
  "defer_reason"     VARCHAR(40)  NOT NULL,
  -- Why it will never be delivered. NULL while the row is still owed.
  "resolution_reason" VARCHAR(40),

  -- THE SCHEDULED DELIVERY TIME, computed by `FamilyDateService.nextLocalTimeAfter`
  -- from `Family.timezone` — the end of THIS family's quiet hours, read from
  -- tzdata at the target instant. Two families in two zones deferring in the
  -- same second get two different values here, and that is the requirement.
  "scheduled_for"    TIMESTAMP(3) NOT NULL,
  -- The family's business date at the moment of deferral. The digest groups on
  -- it, and it is what makes «one digest per household per day» a key rather
  -- than a count.
  "business_date"    DATE         NOT NULL,

  -- The outbox's retry shape, reused rather than reinvented.
  "attempt_count"    INTEGER      NOT NULL DEFAULT 0,
  "next_attempt_at"  TIMESTAMP(3),
  "last_error"       VARCHAR(500),

  "created_at"       TIMESTAMP(3) NOT NULL DEFAULT now(),
  "updated_at"       TIMESTAMP(3) NOT NULL DEFAULT now(),
  "delivered_at"     TIMESTAMP(3),
  "locked_by"        VARCHAR(60),
  "locked_at"        TIMESTAMP(3)
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'notification_deliveries_family_id_fkey') THEN
    ALTER TABLE "notification_deliveries"
      ADD CONSTRAINT "notification_deliveries_family_id_fkey"
      FOREIGN KEY ("family_id") REFERENCES "families"("id") ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'notification_deliveries_child_id_fkey') THEN
    ALTER TABLE "notification_deliveries"
      ADD CONSTRAINT "notification_deliveries_child_id_fkey"
      FOREIGN KEY ("child_id") REFERENCES "children"("id") ON DELETE CASCADE;
  END IF;

  -- The state vocabulary is closed AT THE DATABASE. A TypeScript union is a
  -- vocabulary a raw UPDATE walks around, and the one state that must never be
  -- reachable by accident is DEAD.
  --
  --   PENDING     owed, and scheduled.
  --   DELIVERING  claimed by one worker under a lease.
  --   DELIVERED   a `notifications` (or `child_messages`) row exists.
  --   SUPPRESSED  deliberately not delivered — coalesced, digested, or refused
  --               by a cap AT DELIVERY TIME. `resolution_reason` says which.
  --   DEAD        permanently failed after exhausting attempts. TERMINAL AND
  --               VISIBLE — the whole lesson of Phase C's outbox finding.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'notification_deliveries_state_check') THEN
    ALTER TABLE "notification_deliveries"
      ADD CONSTRAINT "notification_deliveries_state_check"
      CHECK ("state" IN ('PENDING', 'DELIVERING', 'DELIVERED', 'SUPPRESSED', 'DEAD'));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'notification_deliveries_audience_check') THEN
    ALTER TABLE "notification_deliveries"
      ADD CONSTRAINT "notification_deliveries_audience_check"
      CHECK ("target_audience" IN ('PARENT', 'CHILD'));
  END IF;

  -- A resolved row must say why. A row in DEAD or SUPPRESSED with a NULL reason
  -- is the silent drop this phase exists to remove, so it is refused rather
  -- than merely discouraged.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'notification_deliveries_reason_check') THEN
    ALTER TABLE "notification_deliveries"
      ADD CONSTRAINT "notification_deliveries_reason_check"
      CHECK (
        ("state" IN ('SUPPRESSED', 'DEAD') AND "resolution_reason" IS NOT NULL)
        OR "state" NOT IN ('SUPPRESSED', 'DEAD')
      );
  END IF;
END $$;

-- -----------------------------------------------------------------------------
-- 2. THE UNIQUE KEY — B9's constraint, extended one link earlier in the chain.
--
--    `notifications (family_id, source_event_id, user_id)` protects the
--    DELIVERED row. It does NOT protect the DEFERRED one: without the index
--    below, an outbox message redelivered twice inside the quiet window would
--    write two deferred rows, and at 07:00 the second would be refused by
--    `notifications` — correctly, but only after the digest had already counted
--    it. The count a parent sees would have been inflated by a redelivery.
--
--    `user_id` is deliberately NOT in this key, unlike in `notifications`.
--    Recipient resolution happens AT DELIVERY (owner lookup, fanout), so at
--    deferral time there is no user to key on; `(family_id, source_event_id)`
--    is the strongest key that is knowable here, and the per-recipient half is
--    enforced downstream where the recipient exists.
-- -----------------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS "notification_deliveries_family_source_key"
  ON "notification_deliveries" ("family_id", "source_event_id");

-- The release sweep's own access path: due rows, oldest first.
CREATE INDEX IF NOT EXISTS "notification_deliveries_state_scheduled_idx"
  ON "notification_deliveries" ("state", "scheduled_for");
-- The per-family read, for the release transaction and the parent-facing count.
CREATE INDEX IF NOT EXISTS "notification_deliveries_family_state_idx"
  ON "notification_deliveries" ("family_id", "state", "scheduled_for");
-- The retention sweep filters on age alone (A2 DA-011's lesson, applied up
-- front this time instead of after a Seq Scan is measured).
CREATE INDEX IF NOT EXISTS "notification_deliveries_created_at_idx"
  ON "notification_deliveries" ("created_at");

-- -----------------------------------------------------------------------------
-- 3. THE JOB. Cadence 300s, and the number is an argument.
--
--    This is the WORST-CASE LATENESS of a release, not a per-family frequency.
--    A family whose quiet hours end at 07:00 gets its overnight queue between
--    07:00:00 and 07:05:00. Faster buys nothing a human would notice; slower
--    turns «released at the end of quiet hours» into a claim with an asterisk.
--    It matches `outbox-dead-letter-alert` on purpose — the two jobs that must
--    react to a condition rather than close a day run at the same rate.
--
--    PLATFORM, not FAMILY. A FAMILY-scoped job claims `job_runs (job_name,
--    family_id, business_date)` and therefore runs ONCE PER FAMILY PER DAY,
--    which is exactly right for a rollover and exactly wrong for a sweep that
--    must also retry a failed push twenty minutes later. The fan-out over
--    families happens INSIDE the handler, each family inside its own
--    `runWithTenant`, which is the same shape `OutboxRelay.dispatch` uses.
-- -----------------------------------------------------------------------------
INSERT INTO "scheduled_jobs" ("name", "scope", "cadence_seconds", "local_hour", "enabled")
VALUES ('notification-delivery-sweep', 'PLATFORM', 300, NULL, true)
ON CONFLICT ("name") DO NOTHING;
