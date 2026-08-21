-- ============================================================================
-- EVERY DISTRESS ALERT THIS PRODUCT HAS EVER RAISED IS UNREVIEWED.
--
-- Not a figure of speech. `ai_alerts.reviewed_at` and `reviewed_by_user_id`
-- have had NO WRITER anywhere in `src/` for the entire life of the product, and
-- `PrismaAiAlertRepository` pins the fact in its own type system:
--
--     const _statusIsExhaustive: AlertStatus = 'NEW' satisfies AiAlertStatus;
--
-- Three of the four `AlertStatus` values — REVIEWED, DISMISSED, ESCALATED — were
-- unreachable, and no operator route read the table at all. The alert's own
-- controller says, in its header, that this data belongs on «an OPERATOR page
-- behind InternalAdminGuard». That page did not exist.
--
-- AND IT WAS WORSE THAN INERT. `growth-alerts.service.ts` counts alerts matching
-- `{ severity: 'CRITICAL', reviewedAt: null }` and raises a growth alert on the
-- number. Since nothing could ever set `reviewed_at`, that counter could only
-- ever go UP: a platform alarm wired to a value with no writer, which no action
-- anywhere could clear.
--
-- ── `reviewed_by_user_id` IS REMOVED, NOT KEPT ─────────────────────────
--
-- It pointed at `users`, i.e. at a PARENT, for a review flow that was never
-- built. Measured before dropping: zero writers, zero readers in `src/`, one
-- test asserting it null. Nothing is lost because nothing was ever stored.
--
-- Reviewing a child-distress signal is the safety desk's job and the safety
-- desk is STAFF, so the replacement points at `operators`. Deliberately with NO
-- FOREIGN KEY, for the same reason `audit_logs.operator_id` has none: a safety
-- record must survive its reviewer's departure, and must never be the reason a
-- deletion is refused or, worse, cascades.
--
-- ── WHY NOTES ARE A TABLE ──────────────────────────────────────────────
--
-- An escalation with no words is unactionable: «escalated» tells the next
-- person that somebody was worried and nothing about why, and that somebody has
-- usually gone home. Notes accumulate, are written by different people at
-- different times, and each must carry its own author and instant — a single
-- column is a field the second writer overwrites the first in.
--
-- APPEND-ONLY BY CONSTRUCTION: nothing in `src/` updates or deletes a note, and
-- an architecture test refuses a writer that would. The directive is explicit
-- that an operator may not delete safety history, and a note explaining why an
-- alert was dismissed is exactly the history somebody would later want gone.
--
-- ── THE QUEUE INDEX IS NOT PREFIXED BY family_id ───────────────────────
--
-- Every other index on this table starts with a tenant, because every other
-- reader is a household. The safety desk works ONE QUEUE across the platform —
-- worst first, oldest first — and prefixing by family would make the queue's
-- own ordering unindexable.
-- ============================================================================

ALTER TABLE "ai_alerts" DROP CONSTRAINT IF EXISTS "ai_alerts_reviewed_by_user_id_fkey";
ALTER TABLE "ai_alerts" DROP COLUMN IF EXISTS "reviewed_by_user_id";
ALTER TABLE "ai_alerts" ADD COLUMN "reviewed_by_operator_id" UUID;

CREATE INDEX "ai_alerts_status_severity_created_at_idx"
  ON "ai_alerts"("status", "severity", "created_at");

CREATE TABLE "ai_alert_notes" (
    "family_id"      UUID         NOT NULL,
    "id"             UUID         NOT NULL DEFAULT gen_random_uuid(),
    "alert_id"       UUID         NOT NULL,
    -- Denormalised, like every operator reference in this schema: the note must
    -- still name its author after that author is revoked.
    "operator_id"    UUID         NOT NULL,
    "operator_email" TEXT         NOT NULL,
    "transition_to"  "AlertStatus",
    "body"           TEXT         NOT NULL,
    "created_at"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_alert_notes_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ai_alert_notes_alert_id_created_at_idx" ON "ai_alert_notes"("alert_id", "created_at");
CREATE INDEX "ai_alert_notes_family_id_idx" ON "ai_alert_notes"("family_id");

ALTER TABLE "ai_alert_notes"
  ADD CONSTRAINT "ai_alert_notes_alert_id_fkey"
  FOREIGN KEY ("alert_id") REFERENCES "ai_alerts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ai_alert_notes"
  ADD CONSTRAINT "ai_alert_notes_family_id_fkey"
  FOREIGN KEY ("family_id") REFERENCES "families"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Row-level security on the same terms — and with the same shape — as every
-- other family-owned table in this schema (0004, 0006). Copied structurally
-- rather than paraphrased: `NULLIF(..., '')` matters, because an unset
-- `app.current_family_id` is an EMPTY STRING and `''::uuid` raises rather than
-- returning NULL, which would turn a missing tenant into a 500 instead of an
-- empty result. `WITH CHECK` matters because a policy that filters reads and
-- not writes lets a caller INSERT into another household.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'abny_app') THEN
    EXECUTE 'GRANT SELECT, INSERT ON "ai_alert_notes" TO abny_app';
    EXECUTE 'ALTER TABLE "ai_alert_notes" ENABLE ROW LEVEL SECURITY';
    EXECUTE 'ALTER TABLE "ai_alert_notes" FORCE ROW LEVEL SECURITY';
    EXECUTE 'DROP POLICY IF EXISTS tenant_isolation ON "ai_alert_notes"';
    EXECUTE
      'CREATE POLICY tenant_isolation ON "ai_alert_notes" '
      'USING (family_id = NULLIF(current_setting(''app.current_family_id'', true), '''')::uuid) '
      'WITH CHECK (family_id = NULLIF(current_setting(''app.current_family_id'', true), '''')::uuid)';
    EXECUTE 'DROP POLICY IF EXISTS tenant_bypass_owner ON "ai_alert_notes"';
    EXECUTE format(
      'CREATE POLICY tenant_bypass_owner ON "ai_alert_notes" TO %I USING (true) WITH CHECK (true)',
      current_user);

    -- APPEND-ONLY BY PRIVILEGE, not by convention — the treatment 0004 gave
    -- `audit_logs` and 0006 gave `verification_attempts`. The GRANT above never
    -- included UPDATE or DELETE, and this revoke makes that explicit and
    -- survives a later blanket grant. The directive is categorical that an
    -- operator may not delete safety history, and a note explaining why an
    -- alert was dismissed is precisely the history somebody would later want
    -- gone. A rule enforced by the database cannot be forgotten by a service.
    EXECUTE 'REVOKE UPDATE, DELETE ON "ai_alert_notes" FROM abny_app';
  END IF;
END $$;
