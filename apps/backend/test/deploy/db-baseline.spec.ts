/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * ============================================================================
 * THE SCRIPT THAT DECIDES WHETHER TO LIE TO PRISMA.
 * ============================================================================
 *
 * `scripts/db-baseline.sh` writes rows into `_prisma_migrations` saying "this
 * migration is already applied" without running its SQL. That is a CLAIM ABOUT
 * A LIVE DATABASE, and a false one is the most expensive mistake in this whole
 * deploy: baseline a database that is missing migration 0030's columns and
 * `migrate deploy` skips 0030 forever, leaving new code on an old schema. It
 * answers 200 on every route that happens not to touch the new column, and
 * 500 on the first one that does — in production, later, with no clue pointing
 * back to the day someone ran a script.
 *
 * So the branch that matters is not the happy one. It is REFUSAL. This suite
 * drives the decision with a STUBBED Prisma, because the four states that have
 * to be refused cannot be produced on demand against a real database:
 *
 * RULE B1  Drift present → REFUSED, nothing written, and the missing SQL is
 *          printed in full. The operator decides with the statements in front
 *          of them, not from a summary of them.
 * RULE B2  No drift → the baseline is a true statement, and it proceeds —
 *          one `migrate resolve --applied` per migration directory in the
 *          repository, derived at run time and never a hard-coded 29.
 * RULE B3  Without `--apply` NOTHING is written even when there is no drift.
 *          A diagnosis that quietly mutates is not a diagnosis.
 * RULE B4  The two signals — `--exit-code` and the emitted script — are read
 *          independently, and DISAGREEMENT is refused rather than resolved by
 *          preferring one. Prisma changing either channel in a future release
 *          must fail loudly here, not silently baseline a drifted database.
 * RULE B5  A `migrate diff` that fails to run at all (bad URL, missing engine)
 *          is refused with its own output. This is the branch that would
 *          otherwise read as "no statements found, therefore no drift" — the
 *          canonical false pass, and the one this repository has already
 *          shipped once in a different doctor.
 * RULE B6  The connection string is never printed. It carries a password.
 */
import { execFile } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const REPO_ROOT = join(__dirname, '..', '..', '..', '..');
const SCRIPT = join(REPO_ROOT, 'scripts', 'db-baseline.sh');
const BACKEND_DIR = join(REPO_ROOT, 'apps', 'backend');

const SECRET_URL = 'postgresql://baseline_user:sup3r-s3cret-pw@db.example.invalid:5432/railway';

const describeIfRunnable = process.platform !== 'win32' && existsSync(SCRIPT) ? describe : describe.skip;

interface IRun {
  stdout: string;
  exitCode: number;
  /** Every argv the stub was invoked with, one per line, in order. */
  calls: string[];
}

/**
 * A stub standing in for `npx prisma`. It records every invocation, answers
 * `migrate diff` with the given script and exit code, and answers
 * `migrate resolve` successfully. Written per-test into a temp directory so
 * the cases cannot contaminate each other through a shared file.
 */
function makeStub(opts: { diffScript: string; diffExit: number; resolveExit?: number }): {
  bin: string;
  callLog: string;
} {
  const dir = mkdtempSync(join(tmpdir(), 'abny-baseline-'));
  const callLog = join(dir, 'calls.txt');
  const diffOut = join(dir, 'diff.sql');
  writeFileSync(diffOut, opts.diffScript);

  const bin = join(dir, 'prisma-stub.sh');
  writeFileSync(
    bin,
    [
      '#!/usr/bin/env bash',
      `echo "$@" >> ${JSON.stringify(callLog)}`,
      'if [ "$1" = "migrate" ] && [ "$2" = "diff" ]; then',
      `  cat ${JSON.stringify(diffOut)}`,
      `  exit ${opts.diffExit}`,
      'fi',
      'if [ "$1" = "migrate" ] && [ "$2" = "resolve" ]; then',
      `  exit ${opts.resolveExit ?? 0}`,
      'fi',
      'exit 99',
      '',
    ].join('\n'),
  );
  chmodSync(bin, 0o755);
  return { bin, callLog };
}

async function run(
  stub: { bin: string; callLog: string },
  args: string[] = [],
  env: Record<string, string> = {},
): Promise<IRun> {
  const options = {
    encoding: 'utf8' as const,
    timeout: 60_000,
    env: {
      ...process.env,
      DATABASE_URL: SECRET_URL,
      PRISMA_BIN: stub.bin,
      DB_BASELINE_BACKEND_DIR: BACKEND_DIR,
      ...env,
    },
  };
  let stdout = '';
  let exitCode = 0;
  try {
    const result = await execFileAsync('bash', [SCRIPT, ...args], options);
    stdout = result.stdout + (result.stderr ?? '');
  } catch (err: any) {
    // Refusal is the designed outcome for most cases here, so a non-zero exit
    // is a result to read rather than an error to rethrow.
    stdout = String(err.stdout ?? '') + String(err.stderr ?? '');
    exitCode = err.code ?? -1;
  }
  const calls = existsSync(stub.callLog)
    ? readFileSync(stub.callLog, 'utf8').split('\n').filter(Boolean)
    : [];
  return { stdout, exitCode, calls };
}

const EMPTY_DIFF = '-- This is an empty migration.\n';
const REAL_DRIFT = [
  '-- AlterTable',
  'ALTER TABLE "notification_decisions" ADD COLUMN "ai_model" TEXT;',
  '',
  '-- CreateIndex',
  'CREATE INDEX "notification_decisions_business_date_idx" ON "notification_decisions"("business_date");',
  '',
].join('\n');

/** The repository's own migration list — the expectation, read from disk. */
function migrationsOnDisk(): string[] {
  const { readdirSync, statSync } = require('node:fs');
  const root = join(BACKEND_DIR, 'prisma', 'migrations');
  return readdirSync(root)
    .filter((n: string) => statSync(join(root, n)).isDirectory())
    .sort();
}

describeIfRunnable('db-baseline.sh — the decision to record migrations as applied', () => {
  it('B1 — drift present: REFUSED, nothing written, and the missing SQL is shown in full', async () => {
    const stub = makeStub({ diffScript: REAL_DRIFT, diffExit: 2 });
    const result = await run(stub, ['--apply']);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('BLOCKED');
    expect(result.stdout).toContain('DOES NOT MATCH');
    // In full — both statements, not a count of them.
    expect(result.stdout).toContain('ADD COLUMN "ai_model"');
    expect(result.stdout).toContain('CREATE INDEX "notification_decisions_business_date_idx"');
    // NOTHING written: `resolve` must never have been reached, even though
    // --apply was passed.
    expect(result.calls.filter((c) => c.startsWith('migrate resolve'))).toEqual([]);
  }, 90_000);

  it('B2 — no drift with --apply: one resolve per migration directory, derived from the repo', async () => {
    const stub = makeStub({ diffScript: EMPTY_DIFF, diffExit: 0 });
    const result = await run(stub, ['--apply']);

    const resolved = result.calls
      .filter((c) => c.startsWith('migrate resolve'))
      .map((c) => c.replace('migrate resolve --applied ', '').trim());

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('BASELINE COMPLETE');
    // Compared against the directories on disk, so migration 0031 tomorrow
    // moves both sides and this cannot rot into a hard-coded 29.
    expect(resolved).toEqual(migrationsOnDisk());
  }, 90_000);

  it('B3 — no drift WITHOUT --apply: writes nothing, and says what it would have run', async () => {
    const stub = makeStub({ diffScript: EMPTY_DIFF, diffExit: 0 });
    const result = await run(stub);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('SAFE TO BASELINE');
    expect(result.stdout).toContain('nothing was written');
    expect(result.calls.filter((c) => c.startsWith('migrate resolve'))).toEqual([]);
    // The commands are printed so the operator can run them by hand instead.
    expect(result.stdout).toContain(`npx prisma migrate resolve --applied ${migrationsOnDisk()[0]}`);
  }, 90_000);

  it('B4 — signals disagree: refused rather than resolved in favour of either one', async () => {
    // Exit code says clean; the emitted script plainly is not. A script that
    // trusted the exit code would baseline a drifted database here.
    const stub = makeStub({ diffScript: REAL_DRIFT, diffExit: 0 });
    const result = await run(stub, ['--apply']);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('disagree');
    expect(result.calls.filter((c) => c.startsWith('migrate resolve'))).toEqual([]);
  }, 90_000);

  it('B4b — and disagreement the other way round is refused too', async () => {
    const stub = makeStub({ diffScript: EMPTY_DIFF, diffExit: 2 });
    const result = await run(stub, ['--apply']);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('disagree');
    expect(result.calls.filter((c) => c.startsWith('migrate resolve'))).toEqual([]);
  }, 90_000);

  it('B5 — a diff that could not run at all is refused, never read as "no drift"', async () => {
    const stub = makeStub({
      diffScript: 'Error: P1001: Cannot reach database server at `db.example.invalid`:`5432`\n',
      diffExit: 1,
    });
    const result = await run(stub, ['--apply']);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('failed to run');
    expect(result.stdout).toContain('P1001');
    expect(result.calls.filter((c) => c.startsWith('migrate resolve'))).toEqual([]);
  }, 90_000);

  it('B5b — an unset DATABASE_URL is refused before anything is measured', async () => {
    const stub = makeStub({ diffScript: EMPTY_DIFF, diffExit: 0 });
    const result = await run(stub, ['--apply'], { DATABASE_URL: '' });

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('DATABASE_URL is not set');
    expect(result.calls).toEqual([]);
  }, 90_000);

  it('B6 — the connection string is never printed, in any branch', async () => {
    const cases = [
      makeStub({ diffScript: EMPTY_DIFF, diffExit: 0 }),
      makeStub({ diffScript: REAL_DRIFT, diffExit: 2 }),
      makeStub({ diffScript: 'Error: P1001\n', diffExit: 1 }),
    ];
    for (const stub of cases) {
      const result = await run(stub, ['--apply']);
      expect(result.stdout).not.toContain('sup3r-s3cret-pw');
      expect(result.stdout).not.toContain(SECRET_URL);
      // ...while still telling the operator WHICH database it was pointed at,
      // because "it refused" is useless if you cannot tell what it looked at.
      expect(result.stdout).toContain('db.example.invalid');
    }
  }, 120_000);
});
