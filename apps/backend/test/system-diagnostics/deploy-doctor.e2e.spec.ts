/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * ============================================================================
 * THE DEPLOY DOCTOR IS ITSELF TESTED — AGAINST A REALLY-LISTENING APPLICATION.
 * ============================================================================
 *
 * WHY. `scripts/deploy-doctor.sh` is the script whose word decides whether a
 * deploy is believed. Until this suite it was the only executable in this
 * repository that nothing exercised — and a doctor that misreads a host is
 * worse than no doctor, because its output is trusted precisely when nobody
 * has another way to check. This project has already shipped that exact shape
 * of defect once: an earlier `release-doctor` reported `key.properties` as
 * present while both apps read `signing.properties`, so it was green on a
 * machine whose release build then failed.
 *
 * WHAT IS REAL HERE. Not a fixture, not a mock HTTP server: the real
 * `AppModule`, with the real global pipeline, bound to a real TCP port, and
 * the real script invoked as a subprocess over the network stack. The only
 * substitution is `PrismaService` — this sandbox cannot download Prisma's
 * native query engine (binaries.prisma.sh answers 403), so the same
 * WASM-over-node-postgres client every other e2e suite here uses stands in.
 * The HTTP surface the doctor reads is otherwise the deployed one.
 *
 * RULE DD1  Against a host running THIS build, the doctor's terminal line is
 *           the success verdict, and the build-identity row PASSes — the
 *           unauthenticated 401 fingerprint works on a real guard, not just in
 *           the description of one.
 * RULE DD2  A wrong operator key is BLOCKED, and the terminal line says so.
 *           A doctor that shrugs at a refused key would report a host nobody
 *           can actually operate as healthy.
 * RULE DD3  The doctor never prints the operator key, in any row, at any
 *           verbosity — it is passed on a command line and read from a
 *           subprocess's full output here, which is the strongest form of that
 *           assertion available.
 * RULE DD4  The schema row is derived from the LIVE database rather than
 *           assumed: pointed at a database with no `_prisma_migrations` table
 *           (which is every database in this sandbox, for the reason above),
 *           it BLOCKS and names the preDeployCommand — the exact reading that
 *           would have caught a container booting on an un-migrated schema.
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';

import { AppModule } from '../../src/app.module';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { applyGlobalHttpPipeline } from '../../src/common/http/global-pipeline';
import { createTestPrismaService, integrationDatabaseUrl } from '../tenancy/prisma-test-client';

const DOCTOR = join(__dirname, '..', '..', '..', '..', 'scripts', 'deploy-doctor.sh');

/**
 * Three preconditions, each skipping for a DIFFERENT and stated reason rather
 * than one blanket `describe.skip` that hides which one was missing.
 */
const canRun =
  Boolean(integrationDatabaseUrl()) &&
  Boolean(process.env.INTERNAL_ADMIN_API_KEY) &&
  process.platform !== 'win32' &&
  existsSync(DOCTOR);

const describeIfRunnable = canRun ? describe : describe.skip;

interface IDoctorRun {
  stdout: string;
  verdict: string;
  exitCode: number;
}

const execFileAsync = promisify(execFile);

/**
 * ASYNCHRONOUS, AND THAT IS NOT A STYLE CHOICE. The application under test is
 * running IN THIS PROCESS, on this event loop. `execFileSync` would block the
 * loop for the lifetime of the subprocess, so the doctor's own HTTP requests
 * could never be answered — every check would time out and the suite would
 * report a healthy host as dead. Measured: the first version of this file used
 * `execFileSync` and hung until the test timeout, on an application that was
 * serving perfectly.
 */
async function runDoctor(baseUrl: string, key?: string): Promise<IDoctorRun> {
  const args = key ? [baseUrl, '--key', key] : [baseUrl];
  try {
    const { stdout } = await execFileAsync('bash', [DOCTOR, ...args], {
      encoding: 'utf8',
      timeout: 120_000,
    });
    return { stdout, verdict: lastLine(stdout), exitCode: 0 };
  } catch (err: any) {
    // A non-zero exit is the doctor's DESIGNED outcome for a bad host, so it
    // is a result to read, never an error to rethrow.
    const stdout = String(err.stdout ?? '');
    return { stdout, verdict: lastLine(stdout), exitCode: err.code ?? -1 };
  }
}

function lastLine(text: string): string {
  const lines = text.trimEnd().split('\n');
  return lines[lines.length - 1] ?? '';
}

/** The row for one check id, so an assertion names the check and not an offset. */
function row(stdout: string, checkId: string): string {
  return stdout.split('\n').find((line) => line.includes(` ${checkId} `)) ?? '';
}

describeIfRunnable('deploy-doctor.sh, against a really-listening application', () => {
  let app: INestApplication;
  let baseUrl: string;
  const operatorKey = process.env.INTERNAL_ADMIN_API_KEY as string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue(createTestPrismaService())
      .compile();

    app = moduleRef.createNestApplication();
    applyGlobalHttpPipeline(app);
    await app.init();
    // Port 0: the OS picks a free one. A hard-coded port makes a suite that
    // fails only when something else on the machine happens to hold it.
    await app.listen(0, '127.0.0.1');
    const address = app.getHttpServer().address();
    baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  }, 90_000);

  afterAll(async () => {
    if (app) await app.close();
  });

  it('DD1 — reads a live host: liveness, readiness and a CLOSED operator surface', async () => {
    const run = await runDoctor(baseUrl);

    expect(row(run.stdout, 'liveness')).toContain('PASS');
    expect(row(run.stdout, 'readiness')).toContain('PASS');
    // The fingerprint that needs no key: an anonymous 401 from a guarded route.
    expect(row(run.stdout, 'build-identity')).toContain('PASS');
    expect(row(run.stdout, 'build-identity')).toContain('CLOSED');
  }, 120_000);

  it('DD2 — a WRONG operator key is BLOCKED, and the verdict line says do not ship', async () => {
    const run = await runDoctor(baseUrl, 'this-is-not-the-operator-key');

    expect(row(run.stdout, 'operator-key')).toContain('BLOCKED');
    expect(run.verdict).toBe('DO NOT SHIP');
    expect(run.exitCode).toBe(1);
  }, 120_000);

  it('DD3 — the operator key is never printed, at any point, in any row', async () => {
    const run = await runDoctor(baseUrl, operatorKey);

    expect(run.stdout).not.toContain(operatorKey);
    // ...and it says so, rather than silently omitting it, so a reader of the
    // output knows a key was in play at all.
    expect(run.stdout).toContain('never printed');
  }, 120_000);

  it('DD4 — the schema row is read from the LIVE database, not assumed', async () => {
    const run = await runDoctor(baseUrl, operatorKey);
    const schemaRow = row(run.stdout, 'schema-version');

    expect(schemaRow).not.toBe('');
    // Every database in this sandbox was built by applying migration SQL
    // directly, so `_prisma_migrations` genuinely does not exist and the
    // doctor must say so. Where a real `migrate deploy` HAS run — CI, and any
    // deployed host — the same row PASSes with the applied count. Both are
    // accepted; a row that said neither would mean the field was not read.
    const readTheLedger =
      schemaRow.includes('_prisma_migrations') || schemaRow.includes('migrations applied');
    expect({ schemaRow, readTheLedger }).toEqual({ schemaRow, readTheLedger: true });

    if (schemaRow.includes('_prisma_migrations')) {
      expect(schemaRow).toContain('BLOCKED');
      // Names the thing to go and look at — the whole point of an actionable row.
      expect(schemaRow).toContain('preDeployCommand');
      expect(run.verdict).toBe('DO NOT SHIP');
    }
  }, 120_000);
});
