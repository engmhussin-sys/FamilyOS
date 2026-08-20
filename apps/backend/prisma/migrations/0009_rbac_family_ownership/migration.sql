-- =============================================================================
-- 0009_rbac_family_ownership — Phase C, step P3 (A4 §SA-005).
--
-- THE DEFECT. `family_members.role` has carried `OWNER | PARENT` since 0001,
-- but nothing in the database or the application ever enforced how many OWNERs
-- a family may have, and nothing enforced that it has one at all. The role was
-- a label. Phase C makes it a permission — ownership transfer demotes one row
-- and promotes another — and a permission that can silently duplicate is worse
-- than no permission, because the "only the owner may delete the family" check
-- then passes for two people.
--
-- CONTEXT §3 principle 6 in a different domain: the primary defence is a
-- DATABASE CONSTRAINT, not a check in code. `FamilyMembershipService` already
-- performs the transfer inside one transaction; this index is what makes a
-- FUTURE bug in that method fail loudly instead of quietly creating a second
-- owner in a household that is, by A4's own scenario, sometimes in a custody
-- dispute.
--
-- ADDITIVE ONLY, and RE-RUNNABLE, for the same reason 0003/0005/0006/0007
-- were: the only version of a migration that is safe the day after the first
-- customer is one that can be run twice.
--
-- WHAT IT ADDS
--   index   one live OWNER per family (partial unique index).
--   index   (family_id, role) filtered to live rows — the roster read and the
--           owner lookup performed by every destructive operation.
--
-- WHAT IT DOES NOT DO, deliberately:
--   - it does NOT add a NOT-NULL "must have an owner" constraint. Postgres
--     cannot express "at least one row in a set" as a table constraint without
--     a trigger, and a trigger on `family_members` would fire during account
--     deletion's own soft-delete sweep. The invariant is held instead by
--     `FamilyMembershipService.removeMember`, which refuses to remove the
--     acting owner (transfer first, then be removed).
--   - it does NOT add new enum values. `SUPER_ADMIN`, `SUPPORT` and `CHILD`
--     are principal roles derived at authentication time; none of them is a
--     row in `family_members`, so widening the enum would create three values
--     that no INSERT may ever use.
-- =============================================================================

-- Exactly one live OWNER per family.
CREATE UNIQUE INDEX IF NOT EXISTS "family_members_one_live_owner_per_family"
  ON "family_members" ("family_id")
  WHERE "role" = 'OWNER' AND "deleted_at" IS NULL;

-- The lookup every OWNER-only operation performs before it mutates anything.
CREATE INDEX IF NOT EXISTS "family_members_family_id_role_live_idx"
  ON "family_members" ("family_id", "role")
  WHERE "deleted_at" IS NULL;
