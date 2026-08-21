/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * ============================================================================
 * THE RELEASE STEP — THE ONE SCRIPT THAT RUNS BEFORE ANY TRAFFIC.
 * ============================================================================
 *
 * `scripts/predeploy.sh` is Railway's `preDeployCommand`. It decides whether a
 * deploy is promoted at all, and it is the only place in this system allowed
 * to write rows into `_prisma_migrations` — rows that CLAIM a migration is
 * already applied. A wrong claim there is permanent and silent: `migrate
 * deploy` skips that migration forever, and the application runs new code on
 * an old schema.
 *
 * It replaced a bare `npx prisma migrate deploy` that answered P3005 nine
 * times over three days and could say nothing else. So the branches that
 * matter here are the ones that REFUSE, and none of them can be produced on
 * demand against a real database — a database that has tables but no ledger
 * AND no RLS policies is exactly the state nobody can conjure when they want
 * it. Both Prisma and the schema probe are therefore stubbed, and the shell
 * logic between them is what is under test.
 *
 * RUN UNDER `dash`, NOT bash. The image is Alpine and the shell is busybox
 * ash. A suite that proved this script works in bash would prove nothing
 * about the only machine that runs it, and `local`, `[[`, arrays and
 * `pipefail` all pass silently in bash. dash is the closest strict POSIX
 * shell available here and it rejects every one of those.
 *
 * RULE P1  A successful `migrate deploy` short-circuits everything. The
 *          normal path must be untouched by any of this.
 * RULE P2  An error that is NOT P3005 fails exactly as it did before, with
 *          its own output and its own exit code. This script is not allowed
 *          to reinterpret unrelated failures.
 * RULE P3  P3005 + ZERO `tenant_isolation` policies → REFUSED. This is the
 *          db-push database, where `migrate diff` says "no drift" and
 *          baselining would delete row-level security from a live host by
 *          marking migration 0004 applied. The refusal must not depend on the
 *          diff at all — the diff is never even consulted.
 * RULE P4  P3005 + policies present + drift → REFUSED, drift printed in full.
 * RULE P5  P3005 + policies present + no drift → baseline written, one
 *          `resolve --applied` per migration directory, and then `migrate
 *          deploy` RUN AGAIN so the completed ledger is proven rather than
 *          assumed.
 * RULE P6  The two diff signals are read independently and disagreement is
 *          refused.
 * RULE P7  A probe that cannot run is refused. It must never be read as
 *          "zero policies" — that value has its own meaning — nor as "fine".
 */
import { execFile } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const BACKEND_DIR = join(__dirname, '..', '..');
const SCRIPT = join(BACKEND_DIR, 'scripts', 'predeploy.sh');

/**
 * dash is the POSIX shell this repository can actually run. If it is absent
 * the suite SKIPS rather than silently falling back to bash — a green run
 * under bash would be a false pass about an Alpine image.
 */
function posixShell(): string | null {
  for (const candidate of ['/usr/bin/dash', '/bin/dash', '/bin/busybox']) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

const SHELL = posixShell();
const describeIfPosix = SHELL && existsSync(SCRIPT) ? describe : describe.skip;

interface IStubs {
  dir: string;
  prisma: string;
  probe: string;
  callLog: string;
}

interface IPrismaBehaviour {
  /** Output and exit code of the FIRST `migrate deploy`. */
  deploy: { out: string; exit: number };
  /** Output and exit code of a SECOND `migrate deploy`, after baselining. */
  redeploy?: { out: string; exit: number };
  diff?: { out: string; exit: number };
  resolveExit?: number;
}

function makeStubs(prismaBehaviour: IPrismaBehaviour, probe: { out: string; exit: number }): IStubs {
  const dir = mkdtempSync(join(tmpdir(), 'abny-predeploy-'));
  const callLog = join(dir, 'calls.txt');
  const deployCount = join(dir, 'deploys.txt');

  const write = (name: string, body: string[]): string => {
    const path = join(dir, name);
    writeFileSync(path, ['#!/bin/sh', ...body, ''].join('\n'));
    chmodSync(path, 0o755);
    return path;
  };

  const redeploy = prismaBehaviour.redeploy ?? { out: 'No pending migrations to apply.', exit: 0 };
  const diff = prismaBehaviour.diff ?? { out: '-- This is an empty migration.', exit: 0 };

  const prisma = write('prisma-stub.sh', [
    `echo "$@" >> ${JSON.stringify(callLog)}`,
    'if [ "$1" = "migrate" ] && [ "$2" = "deploy" ]; then',
    `  n=$(cat ${JSON.stringify(deployCount)} 2>/dev/null || echo 0)`,
    `  echo $((n + 1)) > ${JSON.stringify(deployCount)}`,
    '  if [ "$n" = "0" ]; then',
    `    printf '%s\\n' ${JSON.stringify(prismaBehaviour.deploy.out)}`,
    `    exit ${prismaBehaviour.deploy.exit}`,
    '  fi',
    `  printf '%s\\n' ${JSON.stringify(redeploy.out)}`,
    `  exit ${redeploy.exit}`,
    'fi',
    'if [ "$1" = "migrate" ] && [ "$2" = "diff" ]; then',
    `  printf '%s\\n' ${JSON.stringify(diff.out)}`,
    `  exit ${diff.exit}`,
    'fi',
    'if [ "$1" = "migrate" ] && [ "$2" = "resolve" ]; then',
    `  exit ${prismaBehaviour.resolveExit ?? 0}`,
    'fi',
    'exit 99',
  ]);

  const probeBin = write('probe-stub.sh', [
    `printf '%s\\n' ${JSON.stringify(probe.out)}`,
    `exit ${probe.exit}`,
  ]);

  return { dir, prisma, probe: probeBin, callLog };
}

interface IRun {
  stdout: string;
  exitCode: number;
  calls: string[];
}

async function run(stubs: IStubs, env: Record<string, string> = {}): Promise<IRun> {
  let stdout = '';
  let exitCode = 0;
  try {
    const res = await execFileAsync(SHELL as string, [SCRIPT], {
      cwd: BACKEND_DIR,
      encoding: 'utf8',
      timeout: 60_000,
      env: {
        ...process.env,
        DATABASE_URL: 'postgresql://u:p@db.example.invalid:5432/railway',
        PRISMA_BIN: stubs.prisma,
        PREDEPLOY_PROBE_BIN: stubs.probe,
        ...env,
      },
    });
    stdout = res.stdout + (res.stderr ?? '');
  } catch (err: any) {
    stdout = String(err.stdout ?? '') + String(err.stderr ?? '');
    exitCode = err.code ?? -1;
  }
  const calls = existsSync(stubs.callLog)
    ? readFileSync(stubs.callLog, 'utf8').split('\n').filter(Boolean)
    : [];
  return { stdout, exitCode, calls };
}

const P3005 = [
  '29 migrations found in prisma/migrations',
  'Error: P3005',
  'The database schema is not empty.',
].join('\n');

const HEALTHY_PROBE = JSON.stringify({
  tenantIsolationPolicies: 56,
  tablesWithRowLevelSecurity: 56,
  baseTables: 101,
  migrationLedgerPresent: false,
  rows: { families: 96, users: 92, children: 82 },
});
/** The shape production was actually measured in on 2026-08-21. */
const DB_PUSH_PROBE = JSON.stringify({
  tenantIsolationPolicies: 0,
  tablesWithRowLevelSecurity: 0,
  baseTables: 57,
  migrationLedgerPresent: false,
  rows: { families: 0, users: 0, children: 0 },
});
const DB_PUSH_PROBE_WITH_DATA = JSON.stringify({
  tenantIsolationPolicies: 0,
  tablesWithRowLevelSecurity: 0,
  baseTables: 57,
  migrationLedgerPresent: false,
  rows: { families: 12, users: 19, children: 24 },
});
const DB_PUSH_PROBE_NO_TABLES = JSON.stringify({
  tenantIsolationPolicies: 0,
  tablesWithRowLevelSecurity: 0,
  baseTables: 3,
  migrationLedgerPresent: false,
  rows: { families: null, users: null, children: null },
});
const DRIFT_SQL = 'ALTER TABLE "notification_decisions" ADD COLUMN "ai_model" TEXT;';

function migrationsOnDisk(): string[] {
  const { readdirSync, statSync } = require('node:fs');
  const root = join(BACKEND_DIR, 'prisma', 'migrations');
  return readdirSync(root)
    .filter((n: string) => statSync(join(root, n)).isDirectory())
    .sort();
}
const resolved = (r: IRun): string[] =>
  r.calls
    .filter((c) => c.startsWith('migrate resolve'))
    .map((c) => c.replace('migrate resolve --applied ', '').trim())
    .sort();

describeIfPosix('predeploy.sh — the release step, under a strict POSIX shell', () => {
  it('P1 — a successful migrate deploy short-circuits everything below it', async () => {
    const stubs = makeStubs({ deploy: { out: 'No pending migrations to apply.', exit: 0 } }, {
      out: HEALTHY_PROBE,
      exit: 0,
    });
    const result = await run(stubs);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('migrate deploy succeeded');
    // Neither the probe nor the diff is consulted on the normal path.
    expect(result.calls.filter((c) => c.startsWith('migrate diff'))).toEqual([]);
    expect(resolved(result)).toEqual([]);
  }, 90_000);

  it('P2 — an error that is NOT P3005 fails with its own output and its own exit code', async () => {
    const stubs = makeStubs(
      { deploy: { out: 'Error: P1001 Cannot reach database server', exit: 7 } },
      { out: HEALTHY_PROBE, exit: 0 },
    );
    const result = await run(stubs);

    expect(result.exitCode).toBe(7);
    expect(result.stdout).toContain('P1001');
    expect(result.stdout).toContain('NOT P3005');
    expect(result.calls.filter((c) => c.startsWith('migrate diff'))).toEqual([]);
    expect(resolved(result)).toEqual([]);
  }, 90_000);

  it('P3 — zero tenant_isolation policies is refused WITHOUT even consulting the diff', async () => {
    const stubs = makeStubs(
      // The diff would say "no drift" here — a db-push database has every
      // table and every column. That is precisely why it must not be the
      // deciding signal, and this asserts it is never even asked.
      { deploy: { out: P3005, exit: 1 }, diff: { out: '-- This is an empty migration.', exit: 0 } },
      { out: DB_PUSH_PROBE, exit: 0 },
    );
    const result = await run(stubs);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('NEVER BUILT BY THE MIGRATIONS');
    expect(result.stdout).toContain('row-level-security');
    expect(result.calls.filter((c) => c.startsWith('migrate diff'))).toEqual([]);
    expect(resolved(result)).toEqual([]);
  }, 90_000);

  /**
   * Every refusal ends in the same question — "is there anything in this
   * database worth keeping?" — and until this line existed the only way to
   * answer it was to open a SQL console by hand, which on 2026-08-21 meant
   * a person doing it from a phone. Three states, three different sentences,
   * and "the table does not exist" is deliberately not flattened into "zero".
   */
  it('P3b — the refusal reports what the database CONTAINS, in all three states', async () => {
    const empty = await run(
      makeStubs({ deploy: { out: P3005, exit: 1 } }, { out: DB_PUSH_PROBE, exit: 0 }),
    );
    expect(empty.stdout).toContain('0 families, 0 users');
    expect(empty.stdout).toContain('HOLDS NO HOUSEHOLDS');

    const populated = await run(
      makeStubs({ deploy: { out: P3005, exit: 1 } }, { out: DB_PUSH_PROBE_WITH_DATA, exit: 0 }),
    );
    expect(populated.stdout).toContain('12 families, 19 users');
    expect(populated.stdout).toContain('Do not reset it');
    expect(populated.stdout).not.toContain('HOLDS NO HOUSEHOLDS');

    const absent = await run(
      makeStubs({ deploy: { out: P3005, exit: 1 } }, { out: DB_PUSH_PROBE_NO_TABLES, exit: 0 }),
    );
    expect(absent.stdout).toContain('do not exist in this schema');
    // A missing table must never be reported as an empty one — that reads as
    // "safe to wipe" about a database nobody has measured.
    expect(absent.stdout).not.toContain('HOLDS NO HOUSEHOLDS');

    // None of the three writes anything: this is a refusal branch throughout.
    for (const r of [empty, populated, absent]) expect(resolved(r)).toEqual([]);
  }, 150_000);

  it('P4 — drift is refused and printed in full', async () => {
    const stubs = makeStubs(
      { deploy: { out: P3005, exit: 1 }, diff: { out: DRIFT_SQL, exit: 2 } },
      { out: HEALTHY_PROBE, exit: 0 },
    );
    const result = await run(stubs);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('DOES NOT MATCH');
    expect(result.stdout).toContain('ADD COLUMN "ai_model"');
    expect(resolved(result)).toEqual([]);
  }, 90_000);

  it('P5 — both measurements clean: every migration is marked, then deploy is RE-RUN to prove it', async () => {
    const stubs = makeStubs(
      { deploy: { out: P3005, exit: 1 }, diff: { out: '-- This is an empty migration.', exit: 0 } },
      { out: HEALTHY_PROBE, exit: 0 },
    );
    const result = await run(stubs);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('RELEASE STEP COMPLETE');
    expect(resolved(result)).toEqual(migrationsOnDisk());
    // Twice: the failing one that raised P3005, and the verification pass.
    // A script that stopped after writing the ledger would be assuming the
    // very thing it had just changed.
    expect(result.calls.filter((c) => c === 'migrate deploy').length).toBe(2);
  }, 90_000);

  it('P5b — a baseline that leaves migrate deploy still failing is NOT reported as success', async () => {
    const stubs = makeStubs(
      {
        deploy: { out: P3005, exit: 1 },
        redeploy: { out: 'Error: P3018 A migration failed to apply', exit: 4 },
        diff: { out: '-- This is an empty migration.', exit: 0 },
      },
      { out: HEALTHY_PROBE, exit: 0 },
    );
    const result = await run(stubs);

    expect(result.exitCode).toBe(4);
    expect(result.stdout).toContain('still fails after baselining');
    expect(result.stdout).not.toContain('RELEASE STEP COMPLETE');
  }, 90_000);

  it('P6 — the two diff signals disagreeing is refused, in both directions', async () => {
    const codeCleanScriptDirty = await run(
      makeStubs(
        { deploy: { out: P3005, exit: 1 }, diff: { out: DRIFT_SQL, exit: 0 } },
        { out: HEALTHY_PROBE, exit: 0 },
      ),
    );
    expect(codeCleanScriptDirty.exitCode).toBe(1);
    expect(codeCleanScriptDirty.stdout).toContain('disagree');
    expect(resolved(codeCleanScriptDirty)).toEqual([]);

    const codeDirtyScriptClean = await run(
      makeStubs(
        { deploy: { out: P3005, exit: 1 }, diff: { out: '-- nothing', exit: 2 } },
        { out: HEALTHY_PROBE, exit: 0 },
      ),
    );
    expect(codeDirtyScriptClean.exitCode).toBe(1);
    expect(codeDirtyScriptClean.stdout).toContain('disagree');
    expect(resolved(codeDirtyScriptClean)).toEqual([]);
  }, 120_000);

  it('P7 — a probe that cannot run is refused, never read as zero and never as fine', async () => {
    const stubs = makeStubs(
      { deploy: { out: P3005, exit: 1 } },
      { out: 'predeploy-schema-probe: connect ECONNREFUSED', exit: 2 },
    );
    const result = await run(stubs);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('could not measure the live schema');
    expect(result.stdout).toContain('ECONNREFUSED');
    // Not the zero-policies refusal — that message means something specific
    // and must not be printed for a failure to measure.
    expect(result.stdout).not.toContain('NEVER BUILT BY THE MIGRATIONS');
    expect(resolved(result)).toEqual([]);
  }, 90_000);

  /**
   * A release step that is not IN the image is a release step that does not
   * run — and the symptom would be the deploy failing again with a shell
   * error, one round trip later. Two things have to be true and neither is
   * visible from the script itself.
   */
  it('P9 — both release files are copied into the runtime image and not excluded from its context', () => {
    const dockerfile = readFileSync(join(BACKEND_DIR, 'Dockerfile'), 'utf8');
    const dockerignore = readFileSync(join(BACKEND_DIR, '.dockerignore'), 'utf8');

    expect(dockerfile).toContain('scripts/predeploy.sh');
    expect(dockerfile).toContain('scripts/predeploy-schema-probe.js');

    // The COPY must be in the RUNTIME stage: the builder's filesystem is
    // discarded, and the pre-deploy command runs from the runtime image.
    const runtimeStage = dockerfile.slice(dockerfile.indexOf('AS runtime'));
    expect(runtimeStage).toContain('COPY scripts/predeploy.sh scripts/predeploy-schema-probe.js ./scripts/');

    // `.dockerignore` used to exclude `scripts` wholesale, which would make
    // that COPY fail at build time. It must now exclude by name, and neither
    // name may be one of ours.
    const patterns = dockerignore
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'));
    expect(patterns).not.toContain('scripts');
    for (const ours of ['scripts/predeploy.sh', 'scripts/predeploy-schema-probe.js']) {
      expect(patterns.some((p) => ours === p || ours.startsWith(`${p}/`))).toBe(false);
    }
  });

  it('P8 — ABNY_PREDEPLOY_NO_BASELINE=1 reports instead of writing, even when clean', async () => {
    const stubs = makeStubs(
      { deploy: { out: P3005, exit: 1 }, diff: { out: '-- This is an empty migration.', exit: 0 } },
      { out: HEALTHY_PROBE, exit: 0 },
    );
    const result = await run(stubs, { ABNY_PREDEPLOY_NO_BASELINE: '1' });

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('reporting instead of writing');
    expect(resolved(result)).toEqual([]);
  }, 90_000);
});
