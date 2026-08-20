-- =============================================================================
-- 0004_tenant_rls_defence_in_depth
-- Layer 3 of the tenant-isolation stack (docs/05-Database-Architecture §6.4).
--
-- The Prisma Client Extension (layer 1) covers every model operation. It does
-- NOT cover `$queryRaw`, nested writes, or a future service that opens its own
-- connection. RLS is the net under those cases: with it on, a cross-family row
-- is not "unlikely to be returned", it is impossible to return.
--
-- ---------------------------------------------------------------------------
-- POOLING — read this before enabling the role.
-- ---------------------------------------------------------------------------
-- The policies below key on `current_setting('app.current_family_id', true)`.
-- The variable MUST be set with `set_config(..., is_local => true)` INSIDE a
-- transaction, never with a session-level `SET`:
--
--   * This application pools connections (Prisma's own pool today; PgBouncer in
--     transaction mode is the documented production target). A session-level
--     `SET` survives the request and leaks the previous caller's tenant onto
--     whoever borrows that connection next. That failure mode is silent and
--     reads as a data-leak bug, not a config bug.
--   * `set_config(..., true)` is reverted at COMMIT/ROLLBACK, so it cannot
--     outlive the transaction that set it. A2 said exactly this; it is verified
--     by execution in
--     `test/database/tenant-rls.integration.spec.ts`.
--
-- The consequence, stated plainly: a query issued OUTSIDE a transaction has no
-- setting, `current_setting(..., true)` returns NULL, the predicate is NULL,
-- and the row is denied. That is fail-closed and correct — but it also means
-- the application role cannot be switched to `abny_app` until every read path
-- runs inside `withRls()` (see src/common/tenancy/rls.ts). This migration
-- therefore CREATES and PROVES the policies; it does not, on its own, move the
-- running application onto the restricted role. See F2 report §RLS.
--
-- ---------------------------------------------------------------------------
-- WHY `NULLIF(current_setting(...), '')` AND NOT `current_setting(...)::uuid`
-- ---------------------------------------------------------------------------
-- Found by execution, not by reading. `set_config(name, value, is_local=>true)`
-- does NOT restore a previously-UNSET custom GUC to NULL at COMMIT — it
-- restores it to the EMPTY STRING. The obvious policy text from the
-- architecture doc therefore evaluates `''::uuid` on the very next query on
-- that pooled connection, which raises
--   ERROR: invalid input syntax for type uuid: ""
-- instead of denying the row. That is fail-loud rather than fail-open, so it is
-- not a leak — but it breaks every query issued outside a transaction, which
-- would have been discovered in production rather than here. NULLIF turns the
-- empty string back into NULL, the predicate becomes NULL, and the row is
-- denied. Proven both ways in test/database/tenant-rls.integration.spec.ts.
--
-- Idempotent: safe to replay.
-- =============================================================================

-- 1. The restricted application role. No BYPASSRLS, no superuser, NOLOGIN here
--    (deployment grants LOGIN + a password out of band, never in a migration).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'abny_app') THEN
    CREATE ROLE abny_app NOLOGIN;
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO abny_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO abny_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO abny_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO abny_app;

-- 2. Append-only tables: enforce immutability with privileges, not with hope.
REVOKE UPDATE, DELETE ON rewards_ledger_entries, audit_logs, device_pairing_events FROM abny_app;

-- 3. Policies on every table whose family_id is NOT NULL (the 44 strictly
--    tenant-scoped tables). Generated from the catalogue rather than listed by
--    hand, so a table added later with a NOT NULL family_id is covered the
--    moment this migration is replayed — and `test/tenancy` fails the build if
--    it is not.
DO $$
DECLARE
  t TEXT;
BEGIN
  FOR t IN
    SELECT c.relname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'family_id'
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND a.attnotnull
    ORDER BY c.relname
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    -- FORCE so the policy also applies to the table owner. Without it, the
    -- migration user (who owns every table) silently bypasses everything and
    -- the whole layer becomes decorative.
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I '
      'USING (family_id = NULLIF(current_setting(''app.current_family_id'', true), '''')::uuid) '
      'WITH CHECK (family_id = NULLIF(current_setting(''app.current_family_id'', true), '''')::uuid)',
      t);
    -- The migration/DDL role must still be able to run maintenance and the
    -- retention jobs across tenants. It gets an explicit, named bypass policy
    -- rather than an implicit one.
    EXECUTE format('DROP POLICY IF EXISTS tenant_bypass_owner ON %I', t);
    EXECUTE format(
      'CREATE POLICY tenant_bypass_owner ON %I TO %I USING (true) WITH CHECK (true)',
      t, current_user);
  END LOOP;
END $$;

-- 4. The tenant root itself: a family may read only its own row.
ALTER TABLE families ENABLE ROW LEVEL SECURITY;
ALTER TABLE families FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON families;
CREATE POLICY tenant_isolation ON families
  USING (id = NULLIF(current_setting('app.current_family_id', true), '')::uuid)
  WITH CHECK (id = NULLIF(current_setting('app.current_family_id', true), '')::uuid);
DO $$
BEGIN
  EXECUTE format(
    'DROP POLICY IF EXISTS tenant_bypass_owner ON families');
  EXECUTE format(
    'CREATE POLICY tenant_bypass_owner ON families TO %I USING (true) WITH CHECK (true)',
    current_user);
END $$;
