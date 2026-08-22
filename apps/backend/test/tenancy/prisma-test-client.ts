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

/**
 * `overrideUrl` exists for ONE case: a suite that must observe a database
 * OTHER than the configured integration one — `migration-status.service.spec`
 * points a second client at a deliberately empty database to prove the
 * "`_prisma_migrations` is missing" branch is reported and not thrown. It is
 * an override and not a new function so that both callers keep sharing the
 * native/WASM mode selection below; a private copy of these thirty lines in
 * one spec is exactly the duplication this helper was extracted to end.
 */
export function createTestPrisma(overrideUrl?: string): TestPrismaHandle {
  // INTEGRATION_DATABASE_URL is the deliberate opt-in for the tenancy proofs;
  // DATABASE_URL is the fallback for the pre-existing schema suite, which has
  // always run against whatever database the developer configured.
  const url = overrideUrl ?? process.env.INTEGRATION_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!url) throw new Error('INTEGRATION_DATABASE_URL or DATABASE_URL is required for this suite.');

  if (process.env.PRISMA_DRIVER_ADAPTER === 'pg') {
    const { PrismaClient } = require('@prisma/client');
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
  const raw = new PrismaClient({
    // PRISMA 7: `datasources` was removed from the constructor — driver
    // adapters are the only mode, so the adapter IS the connection. This
    // branch used to exist to AVOID the adapter; it now builds the same
    // client the branch above does, which is the honest end state: a test
    // must not reach the database through a different engine than
    // production does.
    adapter: new (require('@prisma/adapter-pg').PrismaPg)(
      new (require('pg').Pool)({ connectionString: url }),
    ),
  });
  return {
    raw,
    scoped: raw.$extends(createTenantExtension()),
    disconnect: () => raw.$disconnect(),
  };
}

/**
 * PHASE F (`F6-009`) — THE SAME CLIENT, SHAPED AS A `PrismaService` SUBSTITUTE.
 *
 * WHY THIS LIVES HERE AND NOT IN THE GOLDEN SUITE. Five e2e specs already
 * carry a private, byte-identical `offlinePrismaService()` copy
 * (`reward-engine`, `intra-family-authorization`, `smart-notification-engine`,
 * `event-pipeline`, `cross-tenant-probe`). Adding a sixth copy for the golden
 * suite would have been the exact duplication CONTEXT §3 principle 1 forbids,
 * so the golden suite calls THIS function — the one that already knows how to
 * open the connection in both modes — and adds only the two Nest lifecycle
 * hooks a DI substitute needs.
 *
 * The existing copies are deliberately NOT rewritten to call it: that would be
 * an unrelated edit to five green suites inside a phase whose subject is the
 * golden scenarios, and a diff nobody could attribute.
 */
export function createTestPrismaService(): TestPrismaHandle['scoped'] {
  const handle = createTestPrisma();
  const scoped = handle.scoped;
  // `onModuleInit` is a no-op in adapter mode: `PrismaPg` connects lazily and
  // an explicit `$connect()` on the WASM client is not required.
  scoped.onModuleInit = async (): Promise<void> => {
    if (process.env.PRISMA_DRIVER_ADAPTER !== 'pg') await handle.raw.$connect();
  };
  scoped.onModuleDestroy = async (): Promise<void> => {
    await handle.disconnect();
  };
  return scoped;
}
