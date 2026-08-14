/* eslint-disable @typescript-eslint/no-var-requires, @typescript-eslint/no-explicit-any */
/**
 * Builds a REAL Prisma client for the tenancy proof suites.
 *
 * Two modes, chosen by environment, because this repository has to work in two
 * very different ones:
 *
 *  - Normal (CI, any developer machine): plain `new PrismaClient()` on the
 *    native library engine. Nothing special.
 *  - Offline (`PRISMA_DRIVER_ADAPTER=pg`): the native engine binary cannot be
 *    downloaded here (binaries.prisma.sh answers 403 — the same blocker F1
 *    documented), so the client runs on the WASM query engine that ships inside
 *    @prisma/client, driven by @prisma/adapter-pg over node-postgres. Requires
 *    `scripts/regen-prisma-client-offline.sh` to have been run once.
 *
 * Both modes produce the same client surface, so the proofs below are the same
 * proofs either way — this file only changes HOW the connection is opened, not
 * what is asserted.
 */
import { createTenantExtension } from '../../src/common/tenancy/tenant.extension';

export interface TestPrismaHandle {
  /** Extension-wrapped: this is what the application uses. */
  scoped: any;
  /** Raw, un-extended: used to seed fixtures and to prove leakage WITHOUT the guard. */
  raw: any;
  disconnect: () => Promise<void>;
}

export function integrationDatabaseUrl(): string | undefined {
  return process.env.INTEGRATION_DATABASE_URL;
}

export function createTestPrisma(): TestPrismaHandle {
  // INTEGRATION_DATABASE_URL is the deliberate opt-in for the tenancy proofs;
  // DATABASE_URL is the fallback for the pre-existing schema suite, which has
  // always run against whatever database the developer configured.
  const url = process.env.INTEGRATION_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!url) throw new Error('INTEGRATION_DATABASE_URL or DATABASE_URL is required for this suite.');

  if (process.env.PRISMA_DRIVER_ADAPTER === 'pg') {
    const { PrismaClient } = require('@prisma/client/wasm');
    const { PrismaPg } = require('@prisma/adapter-pg');
    const { Pool } = require('pg');
    const pool = new Pool({ connectionString: url });
    const raw = new PrismaClient({ adapter: new PrismaPg(pool) });
    return {
      raw,
      scoped: raw.$extends(createTenantExtension()),
      disconnect: async () => {
        await raw.$disconnect();
        await pool.end();
      },
    };
  }

  const { PrismaClient } = require('@prisma/client');
  const raw = new PrismaClient({ datasources: { db: { url } } });
  return {
    raw,
    scoped: raw.$extends(createTenantExtension()),
    disconnect: () => raw.$disconnect(),
  };
}
