/**
 * Layer 3 proof: PostgreSQL Row Level Security, migration 0004.
 *
 * Everything here runs against a real PostgreSQL 16 through node-postgres, as a
 * NON-SUPERUSER role — because a superuser (and, without FORCE, a table owner)
 * bypasses RLS entirely, and a "passing" RLS test run as superuser proves
 * nothing at all. That distinction is the single most common way an RLS
 * deployment turns out to be decorative, so it is asserted explicitly below.
 *
 * The suite answers the four questions the F2 brief asks:
 *   1. Do the policies actually block a cross-tenant read on a raw connection?
 *   2. Does `set_config(..., is_local => true)` scope correctly inside a
 *      transaction?
 *   3. Does it CLEAN UP afterwards on the same pooled connection — i.e. is it
 *      safe under connection pooling?
 *   4. What would a session-level `SET` have done instead? (Measured, not
 *      assumed.)
 *
 * Runs only when INTEGRATION_DATABASE_URL is set. Skipped, never silently
 * passed, otherwise.
 */
import { randomUUID } from 'crypto';

import { Client, Pool } from 'pg';

const CONNECTION_STRING = process.env.INTEGRATION_DATABASE_URL;
const describeIfDb = CONNECTION_STRING ? describe : describe.skip;

const RLS_ROLE = 'abny_rls_probe';
const RLS_PASSWORD = 'abny_rls_probe_password';

describeIfDb('R8 layer 3 — PostgreSQL RLS (real PostgreSQL, non-superuser role)', () => {
  let admin: Pool;
  let appUrl: string;
  const familyA = randomUUID();
  const familyB = randomUUID();
  const childA = randomUUID();
  const childB = randomUUID();
  const habitA = randomUUID();
  const habitB = randomUUID();

  beforeAll(async () => {
    admin = new Pool({ connectionString: CONNECTION_STRING });

    // A real, restricted login role that inherits abny_app's grants. Created
    // here rather than in the migration: a migration must never put a password
    // in version control.
    await admin.query(`DROP OWNED BY ${RLS_ROLE}`).catch(() => undefined);
    await admin.query(`DROP ROLE IF EXISTS ${RLS_ROLE}`).catch(() => undefined);
    await admin.query(`CREATE ROLE ${RLS_ROLE} LOGIN PASSWORD '${RLS_PASSWORD}'`);
    await admin.query(`GRANT abny_app TO ${RLS_ROLE}`);

    const url = new URL(CONNECTION_STRING as string);
    url.username = RLS_ROLE;
    url.password = RLS_PASSWORD;
    appUrl = url.toString();

    for (const [fid, cid, hid, label] of [
      [familyA, childA, habitA, 'A'],
      [familyB, childB, habitB, 'B'],
    ] as const) {
      await admin.query('INSERT INTO families (id, name, updated_at) VALUES ($1, $2, now())', [
        fid,
        `RLS Family ${label}`,
      ]);
      await admin.query(
        'INSERT INTO children (id, family_id, first_name, date_of_birth, updated_at) VALUES ($1,$2,$3,$4,now())',
        [cid, fid, `Child ${label}`, '2015-01-01'],
      );
      await admin.query(
        'INSERT INTO habits (id, family_id, child_id, title, category) VALUES ($1,$2,$3,$4,$5)',
        [hid, fid, cid, `RLS Habit ${label}`, 'LEARNING'],
      );
    }
  });

  afterAll(async () => {
    await admin.query('DELETE FROM families WHERE id = ANY($1)', [[familyA, familyB]]);
    await admin.query(`DROP OWNED BY ${RLS_ROLE}`).catch(() => undefined);
    await admin.query(`DROP ROLE IF EXISTS ${RLS_ROLE}`).catch(() => undefined);
    await admin.end();
  });

  it('the probe role is NOT a superuser and does NOT bypass RLS — otherwise everything below is vacuous', async () => {
    const { rows } = await admin.query(
      'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = $1',
      [RLS_ROLE],
    );
    expect(rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
  });

  it('RLS is ENABLED and FORCED on every tenant table plus families', async () => {
    const { rows } = await admin.query(`
      SELECT count(*)::int AS n
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'family_id' AND a.attnotnull
      WHERE n.nspname = 'public' AND c.relkind = 'r'
        AND c.relrowsecurity AND c.relforcerowsecurity
    `);
    // F3: 44 -> 47. Migration 0005 replays 0004's policy block verbatim over
    // `domain_events`, `outbox_messages` and `consumed_messages`, so the count
    // moving is the evidence that the event backbone did NOT get a weaker
    // tenancy layer than the tables that came before it.
    expect(rows[0].n).toBe(47);

    const families = await admin.query(
      `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'families'`,
    );
    expect(families.rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });

    const policies = await admin.query(
      `SELECT count(*)::int AS n FROM pg_policies WHERE schemaname='public' AND policyname='tenant_isolation'`,
    );
    // F3: 45 -> 48. The 44 strict tables + `families` itself, plus the three
    // event-backbone tables migration 0005 adds. Same policy shape, same
    // setting name, same owner-bypass — 0005 replays 0004's block verbatim.
    expect(policies.rows[0].n).toBe(48);
  });

  it('with NO tenant setting, the restricted role sees NOTHING — fail-closed, not fail-open', async () => {
    const client = new Client({ connectionString: appUrl });
    await client.connect();
    try {
      const { rows } = await client.query('SELECT id FROM habits WHERE id = ANY($1)', [
        [habitA, habitB],
      ]);
      expect(rows).toEqual([]);
    } finally {
      await client.end();
    }
  });

  it('with set_config(..., true) inside a transaction, it sees exactly one tenant', async () => {
    const client = new Client({ connectionString: appUrl });
    await client.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.current_family_id', $1, true)", [familyA]);
      const { rows } = await client.query('SELECT id, family_id FROM habits WHERE id = ANY($1)', [
        [habitA, habitB],
      ]);
      expect(rows.map((r) => r.id)).toEqual([habitA]);
      await client.query('COMMIT');
    } finally {
      await client.end();
    }
  });

  it('the transaction-local setting does NOT survive the transaction on the same connection', async () => {
    // This is THE pooling question. One physical connection, two consecutive
    // "requests" for two different tenants — exactly what a pool does.
    const client = new Client({ connectionString: appUrl });
    await client.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.current_family_id', $1, true)", [familyA]);
      await client.query('COMMIT');

      // NOTE: Postgres restores a previously-unset custom GUC to the EMPTY
      // STRING, not to NULL. This is exactly why the policy wraps it in NULLIF
      // — see the header of migration 0004.
      const leaked = await client.query(
        "SELECT current_setting('app.current_family_id', true) AS v",
      );
      expect(leaked.rows[0].v).toBe('');

      const after = await client.query('SELECT id FROM habits WHERE id = ANY($1)', [
        [habitA, habitB],
      ]);
      expect(after.rows).toEqual([]);

      // ...and the next tenant on the same connection sees only its own rows.
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.current_family_id', $1, true)", [familyB]);
      const second = await client.query('SELECT id FROM habits WHERE id = ANY($1)', [
        [habitA, habitB],
      ]);
      expect(second.rows.map((r) => r.id)).toEqual([habitB]);
      await client.query('COMMIT');
    } finally {
      await client.end();
    }
  });

  it('a SESSION-level SET, by contrast, leaks the tenant to the next borrower — measured, not assumed', async () => {
    const client = new Client({ connectionString: appUrl });
    await client.connect();
    try {
      // `SET` takes no bind parameters — that alone is a hint that it is not
      // meant for per-request values. The literal is a UUID we generated.
      await client.query(`SET app.current_family_id = '${familyA}'`);
      // "Next request" on the same pooled connection, doing nothing wrong:
      const { rows } = await client.query('SELECT id FROM habits WHERE id = ANY($1)', [
        [habitA, habitB],
      ]);
      // It still sees family A. THIS is why rls.ts uses set_config(..., true).
      expect(rows.map((r) => r.id)).toEqual([habitA]);
    } finally {
      await client.end();
    }
  });

  it('WITH CHECK blocks planting a row in another tenant, even by raw SQL', async () => {
    const client = new Client({ connectionString: appUrl });
    await client.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.current_family_id', $1, true)", [familyA]);
      await expect(
        client.query(
          'INSERT INTO habits (id, family_id, child_id, title, category) VALUES ($1,$2,$3,$4,$5)',
          [randomUUID(), familyB, childB, 'Planted by raw SQL', 'LEARNING'],
        ),
      ).rejects.toThrow(/row-level security/i);
      await client.query('ROLLBACK');
    } finally {
      await client.end();
    }
  });

  it('an UPDATE aimed at another tenant matches zero rows instead of succeeding', async () => {
    const client = new Client({ connectionString: appUrl });
    await client.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.current_family_id', $1, true)", [familyA]);
      const res = await client.query('UPDATE habits SET title = $1 WHERE id = $2', [
        'HIJACKED',
        habitB,
      ]);
      expect(res.rowCount).toBe(0);
      await client.query('COMMIT');
    } finally {
      await client.end();
    }

    const check = await admin.query('SELECT title FROM habits WHERE id = $1', [habitB]);
    expect(check.rows[0].title).toBe('RLS Habit B');
  });

  it('append-only tables are UPDATE/DELETE-proof at the privilege level, not by convention', async () => {
    const client = new Client({ connectionString: appUrl });
    await client.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.current_family_id', $1, true)", [familyA]);
      await expect(client.query('DELETE FROM audit_logs')).rejects.toThrow(/permission denied/i);
      await client.query('ROLLBACK');
    } finally {
      await client.end();
    }
  });
});
