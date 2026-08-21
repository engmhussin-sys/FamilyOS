#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-var-requires */
/**
 * ===========================================================================
 * DID THIS DATABASE EVER RUN THE MIGRATION SQL? — one question, four numbers.
 * ===========================================================================
 *
 * WHY IT EXISTS. `prisma migrate diff --to-schema-datamodel` compares TABLES
 * AND COLUMNS. It is blind to everything this repository's migrations do in
 * raw SQL — and the most important of those is ROW LEVEL SECURITY. Migration
 * 0004 (`tenant_rls_defence_in_depth`) and five of its successors enable RLS
 * and create the `tenant_isolation` policy on every tenant-scoped table.
 *
 * A database created by `prisma db push` has every table and every column and
 * NOT ONE POLICY: db push applies the datamodel, never the migration SQL. So
 * `migrate diff` would report "no drift" on such a database, and baselining it
 * would mark 0004 as applied — permanently. The policies would then never be
 * created, and the defence-in-depth layer under this product's tenant
 * isolation would be silently, invisibly absent on a live host.
 *
 * That is the exact failure this file exists to make impossible. `tenant_isolation`
 * policy count is a BINARY signal and does not depend on counting anything
 * correctly: zero means the migration SQL has never run here.
 *
 * ============================ WHY PLAIN JAVASCRIPT =========================
 *
 * It runs inside the production image, from `scripts/predeploy.sh`, where
 * there is no TypeScript, no ts-node and no devDependencies — `--omit=dev`
 * is what makes that sentence true. `@prisma/client` and its generated client
 * ARE there, and are the only database client that is.
 *
 * The two-mode connection below mirrors `test/tenancy/prisma-test-client.ts`
 * rather than importing it: that file is TypeScript, lives under `test/`, and
 * is not in the image. The duplication is nine lines and is the price of a
 * probe that runs where it is needed; the alternative is a probe that only
 * works in the one environment that does not need it.
 *
 * OUTPUT: one line of JSON on stdout, nothing else, so `sh` can read it with
 * a single `grep`. Any failure exits non-zero with the reason on stderr — it
 * never prints a plausible-looking zero, because a zero here is the value that
 * means "refuse to baseline" and must only ever be a measurement.
 */
async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    process.stderr.write('predeploy-schema-probe: DATABASE_URL is not set\n');
    process.exit(2);
  }

  let prisma;
  let pool;
  if (process.env.PRISMA_DRIVER_ADAPTER === 'pg') {
    // The offline/sandbox path, identical in shape to the test helper: the
    // native query engine cannot be downloaded there, so the WASM engine runs
    // over node-postgres. This is how the suite exercises this file for real.
    const { PrismaClient } = require('@prisma/client/wasm');
    const { PrismaPg } = require('@prisma/adapter-pg');
    const { Pool } = require('pg');
    pool = new Pool({ connectionString: url });
    prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
  } else {
    const { PrismaClient } = require('@prisma/client');
    prisma = new PrismaClient({ datasources: { db: { url } } });
  }

  try {
    const one = async (sql) => {
      const rows = await prisma.$queryRawUnsafe(sql);
      const value = Object.values(rows[0])[0];
      // `count(*)` arrives as BigInt on the native engine and as a string on
      // some adapters. Normalised here so the consumer never has to care, and
      // never compares a string to a number and quietly gets `false`.
      return typeof value === 'boolean' ? value : Number(value);
    };

    /**
     * The table name is checked against `to_regclass` and then interpolated —
     * so it is never taken from input of any kind. The three names below are
     * literals in this file. Nothing here reads a name from the environment,
     * the database or an argument, and nothing should start.
     */
    const countOrNull = async (table) => {
      const exists = await one(`SELECT to_regclass('public.${table}') IS NOT NULL`);
      if (!exists) return null;
      return one(`SELECT count(*) FROM "${table}"`);
    };

    const result = {
      /**
       * THE DECIDING NUMBER. Zero means no migration SQL has ever run against
       * this database, whatever its tables look like.
       */
      tenantIsolationPolicies: await one(
        `SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND policyname = 'tenant_isolation'`,
      ),
      tablesWithRowLevelSecurity: await one(
        `SELECT count(*) FROM pg_class c
           JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public' AND c.relrowsecurity`,
      ),
      baseTables: await one(
        `SELECT count(*) FROM information_schema.tables
          WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`,
      ),
      migrationLedgerPresent: await one(
        `SELECT to_regclass('public._prisma_migrations') IS NOT NULL`,
      ),
      /**
       * IS THERE ANYTHING HERE WORTH KEEPING? — the question every refusal
       * above forces a human to answer, and the one the log could not answer
       * for them.
       *
       * On 2026-08-21 the release step correctly refused to baseline a
       * production database, and the only way to decide what to do next was to
       * open a SQL console and count rows by hand. That is a step nobody
       * should have to take on a phone at midnight, and it is one query.
       *
       * `null` means the table does not exist in this schema — which is itself
       * an answer, and a different one from zero. A 57-table schema does not
       * have every table this build expects, so asking for a count of a table
       * that was never created must not take the whole probe down.
       */
      rows: {
        families: await countOrNull('families'),
        users: await countOrNull('users'),
        children: await countOrNull('children'),
      },
    };

    process.stdout.write(JSON.stringify(result) + '\n');
  } finally {
    await prisma.$disconnect().catch(() => undefined);
    if (pool) await pool.end().catch(() => undefined);
  }
}

main().catch((err) => {
  process.stderr.write(`predeploy-schema-probe: ${err && err.message ? err.message : String(err)}\n`);
  process.exit(2);
});
