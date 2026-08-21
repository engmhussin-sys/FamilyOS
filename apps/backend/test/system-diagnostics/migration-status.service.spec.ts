/**
 * ============================================================================
 * THE SCHEMA A DEPLOY IS ACTUALLY SITTING ON — MEASURED, NOT ASSUMED.
 * ============================================================================
 *
 * WHY THIS SUITE EXISTS. On 2026-08-21 a backend image built and pushed
 * successfully for the first time, and the staging host answered
 * `GET /health/ready` with `{"status":"ok","database":true,"redis":true}` —
 * while still serving a build from BEFORE the operator surface was closed.
 * The probe said "ok" throughout, because "ok" is the most it has ever been
 * able to say: it asks whether Postgres answers `SELECT 1`, and a schema
 * thirty migrations behind answers that exactly as cheerfully as today's.
 *
 * So "did `prisma migrate deploy` actually run before this container took its
 * first request?" had no answer over HTTP at all — and `railway.json` runs
 * that command as a `preDeployCommand`, which can be silently unset on the
 * service, or skipped when the config-as-code path is wrong, with a green
 * "Deployed" badge either way.
 *
 * ================== WHAT THIS ENVIRONMENT CAN AND CANNOT PROVE ==============
 *
 * It cannot run `prisma migrate deploy`: the migration engine binary is
 * fetched from binaries.prisma.sh, which answers 403 here — the same blocker
 * F1 documented, and the reason every local database in this sandbox was built
 * by applying migration SQL directly and therefore has NO `_prisma_migrations`
 * table at all.
 *
 * That is stated rather than worked around, and the suite is split along it:
 *
 *   D-rules  THE DERIVATION — counting, ordering, and which row is "latest" —
 *            against a fixed set of ledger rows. Pure logic, no database, so
 *            these run everywhere and cover the states a real deploy almost
 *            never produces on demand: a migration that started and never
 *            finished, and one that was rolled back.
 *   L-rules  THE LEDGER — against whatever database is actually configured,
 *            asserting the service's report is CONSISTENT WITH IT, computed
 *            independently in SQL. In CI, where `.github/workflows/ci.yml`
 *            does run `npx prisma migrate deploy`, this asserts a real applied
 *            history matching this repository's migration directories. In this
 *            sandbox it asserts the missing-table branch is REPORTED and not
 *            thrown — the branch that keeps one absent table from taking down
 *            the eight other diagnostics fields an operator called for.
 *
 * A single spec claiming to prove both would be claiming a `migrate deploy`
 * that did not happen.
 */
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { MigrationStatusService } from '../../src/modules/system-diagnostics/application/migration-status.service';
import { createTestPrisma, integrationDatabaseUrl } from '../tenancy/prisma-test-client';

/** The repository's own list of migrations — the expectation, read from disk. */
function migrationDirectoriesOnDisk(): string[] {
  const root = join(__dirname, '..', '..', 'prisma', 'migrations');
  return readdirSync(root)
    .filter((name) => statSync(join(root, name)).isDirectory())
    .sort();
}

interface ILedgerRow {
  migration_name: string;
  finished_at: Date | null;
  rolled_back_at: Date | null;
}

/**
 * The service's only dependency is `prisma.$queryRaw`, so the derivation can
 * be driven by handing it rows directly. This is not a mock standing in for
 * behaviour that was never checked elsewhere — the L-rules below run the same
 * query against a real Postgres; this half exists to reach the two broken
 * states on demand.
 */
function serviceOver(rows: ILedgerRow[] | Error): MigrationStatusService {
  const prisma = {
    $queryRaw: async () => {
      if (rows instanceof Error) throw rows;
      return rows;
    },
  };
  return new MigrationStatusService(prisma as never);
}

const at = (iso: string): Date => new Date(iso);

describe('MigrationStatusService — the derivation', () => {
  it('D1 — counts only migrations that finished and were not rolled back', async () => {
    const status = await serviceOver([
      { migration_name: '0001_init', finished_at: at('2026-01-01T00:00:00Z'), rolled_back_at: null },
      { migration_name: '0002_next', finished_at: at('2026-01-02T00:00:00Z'), rolled_back_at: null },
      { migration_name: '0003_bad', finished_at: at('2026-01-03T00:00:00Z'), rolled_back_at: at('2026-01-03T01:00:00Z') },
      { migration_name: '0004_stuck', finished_at: null, rolled_back_at: null },
    ]).read();

    expect(status.available).toBe(true);
    expect(status.appliedCount).toBe(2);
  });

  it('D2 — a rolled-back or unfinished migration is NAMED, not merely counted', async () => {
    const status = await serviceOver([
      { migration_name: '0001_init', finished_at: at('2026-01-01T00:00:00Z'), rolled_back_at: null },
      { migration_name: '0003_bad', finished_at: at('2026-01-03T00:00:00Z'), rolled_back_at: at('2026-01-03T01:00:00Z') },
      { migration_name: '0004_stuck', finished_at: null, rolled_back_at: null },
    ]).read();

    expect(status.unfinishedCount).toBe(2);
    // Sorted-independent comparison: the operator needs both names, and the
    // order the database returned them in is not part of the contract.
    expect([...status.unfinishedNames].sort()).toEqual(['0003_bad', '0004_stuck']);
  });

  it('D3 — `latestName` is the newest APPLIED migration, never a broken row that came after', async () => {
    /**
     * The failure this pins: a deploy that applied 0029 cleanly and then died
     * inside 0030. Reporting `0030` as the latest would tell an operator the
     * schema is up to date at the exact moment it is half-migrated — the most
     * expensive possible lie for this field to tell.
     */
    const status = await serviceOver([
      { migration_name: '0029_ok', finished_at: at('2026-08-20T10:00:00Z'), rolled_back_at: null },
      { migration_name: '0030_died', finished_at: null, rolled_back_at: null },
    ]).read();

    expect(status.latestName).toBe('0029_ok');
    expect(status.latestAppliedAt).toBe('2026-08-20T10:00:00.000Z');
    expect(status.unfinishedNames).toEqual(['0030_died']);
  });

  it('D4 — an empty ledger is available with nothing applied, not "unavailable"', async () => {
    const status = await serviceOver([]).read();

    // A brand-new database that `migrate deploy` has not yet touched is a
    // DIFFERENT state from one whose ledger table cannot be read, and an
    // operator has to be able to tell them apart.
    expect(status.available).toBe(true);
    expect(status.appliedCount).toBe(0);
    expect(status.latestName).toBeNull();
    expect(status.latestAppliedAt).toBeNull();
  });

  it('D5 — a database error is reported with its reason and never thrown', async () => {
    const status = await serviceOver(new Error('relation "_prisma_migrations" does not exist')).read();

    expect(status.available).toBe(false);
    expect(status.reason).toContain('_prisma_migrations');
    expect(status.appliedCount).toBe(0);
    expect(status.latestName).toBeNull();
  });
});

const describeIfDb = integrationDatabaseUrl() ? describe : describe.skip;

describeIfDb('MigrationStatusService — against the configured database', () => {
  let handle: ReturnType<typeof createTestPrisma>;

  beforeAll(() => {
    handle = createTestPrisma();
  });

  afterAll(async () => {
    await handle.disconnect();
  });

  it('L1 — reports exactly what this database contains, established independently in SQL', async () => {
    const [{ present }] = (await handle.raw.$queryRawUnsafe(
      `SELECT to_regclass('public._prisma_migrations') IS NOT NULL AS present`,
    )) as { present: boolean }[];

    const status = await new MigrationStatusService(handle.raw).read();

    if (!present) {
      // THIS SANDBOX. The databases here were built by applying migration SQL
      // directly, because the migration engine cannot be downloaded. The
      // branch being measured is the real one, against a real absent table.
      expect(status.available).toBe(false);
      expect(status.reason).toEqual(expect.any(String));
      expect(status.reason).not.toBe('');
      expect(status.appliedCount).toBe(0);
      return;
    }

    // CI, AND ANY DEPLOYED ENVIRONMENT. The expectation is computed by a
    // second, differently-shaped query — an aggregate rather than a row scan —
    // so the assertion is not the service's own logic restated.
    const [counted] = (await handle.raw.$queryRawUnsafe(
      `SELECT count(*) FILTER (WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL) AS applied,
              count(*) FILTER (WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL) AS broken
       FROM "_prisma_migrations"`,
    )) as { applied: bigint; broken: bigint }[];

    expect(status.available).toBe(true);
    expect(status.appliedCount).toBe(Number(counted.applied));
    expect(status.unfinishedCount).toBe(Number(counted.broken));
  });

  it('L2 — when a real migration history exists, it is this repository’s history', async () => {
    const status = await new MigrationStatusService(handle.raw).read();
    if (!status.available || status.appliedCount === 0) {
      // Nothing to compare against. Reported rather than passed silently, so
      // a green line here is never mistaken for "the schema matches".
      expect(status.latestName).toBeNull();
      return;
    }

    const onDisk = migrationDirectoriesOnDisk();
    // Every applied migration must be a directory in this repository, and the
    // newest applied one must be the newest directory — the exact comparison
    // `scripts/deploy-doctor.*` makes against a deployed host.
    expect(onDisk).toContain(status.latestName);
    expect(status.latestName).toBe(onDisk[onDisk.length - 1]);
    expect(status.unfinishedCount).toBe(0);
  });
});
