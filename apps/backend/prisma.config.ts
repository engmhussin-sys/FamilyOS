import 'dotenv/config';
import path from 'node:path';

import { defineConfig } from 'prisma/config';

/**
 * ===========================================================================
 * PRISMA 7 — WHERE THE CONNECTION LIVES NOW.
 * ===========================================================================
 *
 * Prisma 7 removed `datasource.url` from `schema.prisma`. The CLI gets its
 * connection from here; the RUNTIME gets its own from `PrismaService`. They are
 * deliberately separate: a migration is run by a deploy step with credentials
 * that may create tables, and the application runs as a role that may not.
 * Collapsing them into one string in the schema is what made that distinction
 * impossible to express.
 *
 * THE ADAPTER IS THE ENGINE AT RUNTIME. Prisma 7 dropped the native QUERY
 * engine binary. This repository had been paying for that binary twice: once in
 * a real deploy-time failure (an engine built for openssl-1.1.x refusing to
 * load in node:20-alpine, which is why `binaryTargets` existed) and once in a
 * checked-in workaround script, because `binaries.prisma.sh` answers 403 in our
 * build environments. Neither cost exists for the APPLICATION any more — `pg`
 * is plain JavaScript.
 *
 * ── THE CLI STILL DOWNLOADS A BINARY, AND THIS FILE IS THE CLI'S ───────
 *
 * Corrected after an earlier version of this comment overstated the win: the
 * SCHEMA ENGINE is still native, and every command this config serves —
 * `migrate dev`, `migrate deploy`, `migrate diff`, `db push` — fetches it.
 * Reproduced 2026-08-22 in this repository's own container:
 *
 *   Failed to fetch the engine file at https://binaries.prisma.sh/
 *     all_commits/<hash>/debian-openssl-3.0.x/schema-engine.gz — 403 Forbidden
 *
 * PRISMA_ENGINES_CHECKSUM_IGNORE_MISSING=1 gets past the checksum and then
 * fails on the engine itself, so it is not a way through.
 *
 * WHAT THIS MEANS OPERATIONALLY. A deploy environment that can reach
 * binaries.prisma.sh runs `predeploy.sh` unchanged. One that cannot must apply
 * the committed `prisma/migrations/*​/migration.sql` files directly — they are
 * the same statements, in the same order, and they are in version control
 * precisely so that the CLI is a convenience rather than a dependency.
 */
export default defineConfig({
  schema: path.join('prisma', 'schema.prisma'),
  migrations: {
    path: path.join('prisma', 'migrations'),
  },
  // The CLI's connection. `datasource.url` moved OUT of `schema.prisma` and to
  // here in Prisma 7 — read from the environment rather than written down, so a
  // production URL never lands in a file that gets committed.
  datasource: {
    url: process.env.DATABASE_URL,
  },
});
