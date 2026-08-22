-- ============================================================================
-- THE PLATFORM'S STAFF GET NAMES.
--
-- WHAT WAS BROKEN. One shared `INTERNAL_ADMIN_API_KEY` was simultaneously the
-- authentication, the authorization AND the identity of all forty-five operator
-- routes. Three consequences, each of which this migration exists to end:
--
--   NOBODY COULD BE NAMED. Every operator action was written with
--   `actor_type = 'SYSTEM'`, the same value a scheduled sweep uses. «Which of my
--   staff suspended this household» had no answer in this database, and the
--   directive that produced this work asks for exactly that answer.
--   NOBODY COULD BE REMOVED. Revoking one person meant rotating one secret and
--   re-issuing it to everyone else.
--   EVERYBODY COULD DO EVERYTHING. `@PlatformAdminSurface()` resolves to a
--   single role, so a support agent reading a ticket held the same key that
--   edits prices.
--
-- THE SHARED KEY IS NOT REMOVED BY THIS MIGRATION and must not be: it becomes
-- the OUTER gate — «did this request reach the console at all» — and the rows
-- created here are the inner one, the one with a name. Two gates in series, and
-- the existing forty-five routes keep working through the outer one unchanged
-- while the inner one is adopted route by route. A migration that flipped all
-- forty-five at once would be a migration that logs every operator out of a
-- console during the same deploy that gives them a new way in.
--
-- WHY `operators` IS NOT `users`. An operator is staff: no family, no children,
-- no subscription, and they must never be resolvable by the family-facing
-- login. One row that two entirely different authentication paths both accept
-- is the shape of every privilege-escalation bug ever written.
--
-- WHY REVOCATION IS A TOMBSTONE AND NOT A DELETE. The audit rows an operator
-- wrote name them by id. Deleting the row would leave those rows pointing at
-- nothing, which is the one direction an audit trail may never move.
--
-- FOUR ROLES, NOT SEVEN. `OPERATIONS`, `BILLING` and `ANALYST` were specified
-- and are deliberately absent: a role with no holder is a permission matrix
-- nobody exercises and no test defends. `permissions.ts` is written so that
-- adding one later is a single map entry plus the test that fails until the
-- matrix is complete.
--
-- WHAT THE AUDIT TABLE GAINS, AND WHAT IT DELIBERATELY DOES NOT. It gains
-- `operator_id`, `operator_email`, `operator_role`, `reason` and `request_id`.
-- The email and the role are DENORMALISED ON PURPOSE: an operator can be
-- renamed, re-roled or revoked, and an audit row must record who they WERE and
-- what they HELD at the instant they acted — joining `operators` for that
-- answer would silently rewrite history on every role change.
--
-- `before`, `after`, `user_agent` and `result` were specified and are NOT added
-- here, because in this slice each would have had NO WRITER, and a nullable
-- column whose only writer is «nothing yet» is precisely what this repository's
-- dormancy ledger exists to refuse. They land with the mutations that record
-- them.
-- ============================================================================

-- A staff member acting on a household is neither a family USER nor a
-- background SYSTEM sweep, and putting them in either bucket is what made the
-- question unanswerable.
ALTER TYPE "ActorType" ADD VALUE IF NOT EXISTS 'OPERATOR';

CREATE TYPE "OperatorRole" AS ENUM ('SUPER_ADMIN', 'SUPPORT', 'SAFETY', 'READ_ONLY');
CREATE TYPE "OperatorStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'REVOKED');

CREATE TABLE "operators" (
    "id"            UUID           NOT NULL DEFAULT gen_random_uuid(),
    -- Lowercased at the service boundary so a login cannot be case-shadowed.
    "email"         TEXT           NOT NULL,
    "full_name"     TEXT           NOT NULL,
    "role"          "OperatorRole" NOT NULL,
    -- Argon2id, the same PasswordService the family surface uses.
    "password_hash" TEXT           NOT NULL,
    "status"        "OperatorStatus" NOT NULL DEFAULT 'ACTIVE',
    "last_login_at" TIMESTAMP(3),
    "created_at"    TIMESTAMP(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"    TIMESTAMP(3)   NOT NULL,
    "revoked_at"    TIMESTAMP(3),

    CONSTRAINT "operators_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "operators_email_key" ON "operators"("email");
CREATE INDEX "operators_status_idx" ON "operators"("status");

ALTER TABLE "audit_logs" ADD COLUMN "operator_id"    UUID;
ALTER TABLE "audit_logs" ADD COLUMN "operator_email" TEXT;
ALTER TABLE "audit_logs" ADD COLUMN "operator_role"  "OperatorRole";
ALTER TABLE "audit_logs" ADD COLUMN "reason"         TEXT;
ALTER TABLE "audit_logs" ADD COLUMN "request_id"     TEXT;

-- «Everything this member of staff has ever done» is the query a compliance
-- review opens with, and a JSON scan could not answer it.
CREATE INDEX "audit_logs_operator_id_created_at_idx" ON "audit_logs"("operator_id", "created_at");

-- DELIBERATELY NO FOREIGN KEY from audit_logs.operator_id to operators.id.
-- The audit row must survive independently of the operator row's lifetime and
-- must never be the reason a deletion is refused or, worse, cascades. The
-- denormalised email and role above are what make the row readable on its own;
-- the id is a correlation key, not a dependency.
