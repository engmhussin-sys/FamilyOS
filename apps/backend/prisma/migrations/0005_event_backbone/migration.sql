-- =============================================================================
-- 0005_event_backbone — Sprint F3 (R3).
--
-- Adds the three tables the whole event backbone stands on:
--   domain_events    — append-only record of everything published
--   outbox_messages  — the transactional outbox (Postgres IS the queue)
--   consumed_messages— consumer-side idempotency markers
--
-- Written to be RE-RUNNABLE. Every statement is IF NOT EXISTS or wrapped in a
-- DO block that checks first, for the same reason migration 0003 was: the only
-- version of a migration that is safe on the day after the first customer is
-- one that can be run twice.
--
-- TENANCY (F2 / R8): all three tables carry `family_id uuid NOT NULL` with an
-- ON DELETE CASCADE FK to families, matching the 44 STRICT tables migration
-- 0003 produced. They are registered as STRICT in
-- src/common/tenancy/tenant-model-registry.ts, so the Prisma extension scopes
-- every read and stamps every write, and the CI static guard requires the
-- relay's raw SQL to name family_id explicitly.
-- =============================================================================

-- --- enums ------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'EventType') THEN
    CREATE TYPE "EventType" AS ENUM (
      'HABIT_COMPLETED',
      'TASK_COMPLETED',
      'STREAK_ACHIEVED',
      'DAILY_GOAL_COMPLETED',
      'HYDRATION_GOAL_COMPLETED',
      'ACTIVITY_GOAL_COMPLETED',
      'EDUCATION_PROGRESS',
      'MEMORIZATION_COMPLETED',
      'REWARD_GRANTED',
      'DEVICE_PAIRED',
      'SCREEN_TIME_THRESHOLD',
      'IMPORTANT_SAFETY_EVENT'
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'OutboxStatus') THEN
    CREATE TYPE "OutboxStatus" AS ENUM ('PENDING', 'PUBLISHING', 'PUBLISHED', 'FAILED', 'DEAD');
  END IF;
END
$$;

-- --- domain_events ----------------------------------------------------------
CREATE TABLE IF NOT EXISTS "domain_events" (
  "id"              UUID         NOT NULL,
  "family_id"       UUID         NOT NULL,
  "child_id"        UUID,
  "device_id"       UUID,
  "aggregate_type"  VARCHAR(40)  NOT NULL,
  "aggregate_id"    UUID         NOT NULL,
  "event_type"      "EventType"  NOT NULL,
  "idempotency_key" VARCHAR(80)  NOT NULL,
  "client_event_id" VARCHAR(120),
  "schema_version"  SMALLINT     NOT NULL DEFAULT 1,
  "payload"         JSONB        NOT NULL,
  "correlation_id"  TEXT,
  "occurred_at"     TIMESTAMP(3) NOT NULL,
  "received_at"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "domain_events_pkey" PRIMARY KEY ("id")
);

-- Layer 1 of replay protection (docs/06 §6.6): the FINAL guarantee that one
-- real-world occurrence produces one event row, however many times it is sent.
CREATE UNIQUE INDEX IF NOT EXISTS "domain_events_family_id_idempotency_key_key"
  ON "domain_events" ("family_id", "idempotency_key");

-- Transport-level de-duplication. Only meaningful where device_id IS NOT NULL
-- (PostgreSQL treats NULLs as distinct) — which is exactly the ingestion path
-- it exists for.
CREATE UNIQUE INDEX IF NOT EXISTS "domain_events_family_id_device_id_client_event_id_key"
  ON "domain_events" ("family_id", "device_id", "client_event_id");

CREATE INDEX IF NOT EXISTS "domain_events_family_id_event_type_occurred_at_idx"
  ON "domain_events" ("family_id", "event_type", "occurred_at");
CREATE INDEX IF NOT EXISTS "domain_events_family_id_child_id_occurred_at_idx"
  ON "domain_events" ("family_id", "child_id", "occurred_at");
CREATE INDEX IF NOT EXISTS "domain_events_aggregate_type_aggregate_id_idx"
  ON "domain_events" ("aggregate_type", "aggregate_id");

-- --- outbox_messages --------------------------------------------------------
CREATE TABLE IF NOT EXISTS "outbox_messages" (
  "id"              UUID           NOT NULL,
  "family_id"       UUID           NOT NULL,
  "domain_event_id" UUID           NOT NULL,
  "event_type"      "EventType"    NOT NULL,
  "destination"     VARCHAR(40)    NOT NULL DEFAULT 'INTERNAL_BUS',
  "payload"         JSONB          NOT NULL,
  "status"          "OutboxStatus" NOT NULL DEFAULT 'PENDING',
  "attempt_count"   SMALLINT       NOT NULL DEFAULT 0,
  "next_attempt_at" TIMESTAMP(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "last_error"      VARCHAR(500),
  "locked_by"       VARCHAR(60),
  "locked_at"       TIMESTAMP(3),
  "published_at"    TIMESTAMP(3),
  "created_at"      TIMESTAMP(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "outbox_messages_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "outbox_messages_domain_event_id_destination_key"
  ON "outbox_messages" ("domain_event_id", "destination");

-- The relay's claim query orders by created_at over this index. PARTIAL on the
-- two states that can still be delivered, so the index stays small once the
-- table is mostly PUBLISHED rows (docs/04 §4).
CREATE INDEX IF NOT EXISTS "outbox_messages_pending_idx"
  ON "outbox_messages" ("next_attempt_at", "created_at")
  WHERE "status" IN ('PENDING', 'FAILED');

CREATE INDEX IF NOT EXISTS "outbox_messages_status_next_attempt_at_idx"
  ON "outbox_messages" ("status", "next_attempt_at");
CREATE INDEX IF NOT EXISTS "outbox_messages_family_id_status_idx"
  ON "outbox_messages" ("family_id", "status");

-- --- consumed_messages ------------------------------------------------------
CREATE TABLE IF NOT EXISTS "consumed_messages" (
  "id"              UUID         NOT NULL,
  "family_id"       UUID         NOT NULL,
  "consumer_name"   VARCHAR(80)  NOT NULL,
  "domain_event_id" UUID         NOT NULL,
  "outcome"         VARCHAR(40)  NOT NULL DEFAULT 'HANDLED',
  "consumed_at"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "consumed_messages_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "consumed_messages_consumer_name_domain_event_id_key"
  ON "consumed_messages" ("consumer_name", "domain_event_id");
CREATE INDEX IF NOT EXISTS "consumed_messages_family_id_consumer_name_idx"
  ON "consumed_messages" ("family_id", "consumer_name");

-- --- foreign keys (last, per migration 0003's ordering rationale) ------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'domain_events_family_id_fkey') THEN
    ALTER TABLE "domain_events"
      ADD CONSTRAINT "domain_events_family_id_fkey"
      FOREIGN KEY ("family_id") REFERENCES "families"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'outbox_messages_family_id_fkey') THEN
    ALTER TABLE "outbox_messages"
      ADD CONSTRAINT "outbox_messages_family_id_fkey"
      FOREIGN KEY ("family_id") REFERENCES "families"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'outbox_messages_domain_event_id_fkey') THEN
    ALTER TABLE "outbox_messages"
      ADD CONSTRAINT "outbox_messages_domain_event_id_fkey"
      FOREIGN KEY ("domain_event_id") REFERENCES "domain_events"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'consumed_messages_family_id_fkey') THEN
    ALTER TABLE "consumed_messages"
      ADD CONSTRAINT "consumed_messages_family_id_fkey"
      FOREIGN KEY ("family_id") REFERENCES "families"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END
$$;

-- --- RLS, matching migration 0004's defence-in-depth layer -------------------
-- 0004 generated its policies from the catalogue ("a table added later with a
-- NOT NULL family_id is covered the moment this migration is replayed"). Rather
-- than restate the policy shape here and risk it drifting from 0004's, this
-- replays exactly that block, scoped to the three new tables. Policy names,
-- the setting name (`app.current_family_id`) and the owner-bypass policy are
-- byte-identical to 0004 — including the bypass, without which the application
-- (which still connects as the table owner, see F2 §6) would read zero rows.
DO $$
DECLARE
  t TEXT;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'abny_app') THEN
    FOREACH t IN ARRAY ARRAY['domain_events', 'outbox_messages', 'consumed_messages'] LOOP
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO abny_app', t);
      EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
      EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
      EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
      EXECUTE format(
        'CREATE POLICY tenant_isolation ON %I '
        'USING (family_id = NULLIF(current_setting(''app.current_family_id'', true), '''')::uuid) '
        'WITH CHECK (family_id = NULLIF(current_setting(''app.current_family_id'', true), '''')::uuid)',
        t);
      EXECUTE format('DROP POLICY IF EXISTS tenant_bypass_owner ON %I', t);
      EXECUTE format(
        'CREATE POLICY tenant_bypass_owner ON %I TO %I USING (true) WITH CHECK (true)',
        t, current_user);
    END LOOP;
  END IF;
END
$$;
