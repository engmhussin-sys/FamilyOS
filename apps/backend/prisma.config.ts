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
 * THE ADAPTER IS THE ENGINE NOW. Prisma 7 dropped the native query engine
 * binary. This repository has been paying for that binary twice: once in a real
 * deploy-time failure (an engine built for openssl-1.1.x refusing to load in
 * node:20-alpine, which is why `binaryTargets` existed) and once in a
 * checked-in workaround script, because `binaries.prisma.sh` answers 403 in our
 * build environments. Neither cost exists any more — `pg` is plain JavaScript.
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
