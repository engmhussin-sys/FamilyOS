/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * ============================================================================
 * THE TEST-ACCOUNT SEEDER, RUN AGAINST A REALLY-LISTENING APPLICATION.
 * ============================================================================
 *
 * `scripts/seed-test-accounts.sh` is what a person runs when they want to try
 * the product on a deployed host. It talks to nothing but the public API — the
 * same four calls a first-time family makes — so this suite runs the REAL
 * script against the REAL AppModule on a real port and checks the household it
 * leaves behind.
 *
 * WHY THAT IS WORTH A SUITE. A seeder that half-works is uniquely expensive:
 * it leaves an account somebody then tries to sign in with, and the failure
 * surfaces as "the login page is broken" hours later, on a host, with no clue
 * pointing back at the script. And it is the only place in this repository
 * that chains register -> login -> create child -> pairing invite, which is
 * exactly the chain a deploy is supposed to have made possible.
 *
 * RULE S1  The whole chain completes and the script says so. If registration,
 *          the login that follows it, child creation or the pairing invite
 *          breaks, this goes red — and it is the same chain, in the same
 *          order, that a real client performs. The SECOND child is the
 *          paywall boundary: created or refused with PLAN_UPGRADE_REQUIRED are
 *          both correct, and silence about it is not.
 * RULE S2  The credentials it prints WORK. The email and password are read
 *          back out of its own output and used to log in again, independently.
 *          A seeder is only as good as the credentials it hands over, and
 *          printing a password it never proved is the failure this rules out.
 * RULE S3  The pairing code it prints is real: the child app's first call
 *          redeems it, and it is single-use — a second redemption is refused.
 * RULE S4  A generated password satisfies the backend's own policy (10+ chars,
 *          at least one letter and one digit) — asserted on the generated
 *          value, because a generator that CAN produce an invalid password
 *          will, on some run, at the worst time.
 * RULE S5  It invents no operator account. `Role.SUPER_ADMIN` is a header key,
 *          not a user row, and a seeder that quietly created some "admin" user
 *          would be manufacturing a second authorization system beside the
 *          real one. The output must say so instead.
 */
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request = require('supertest');

import { AppModule } from '../../src/app.module';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { applyGlobalHttpPipeline } from '../../src/common/http/global-pipeline';
import { createTestPrismaService, integrationDatabaseUrl } from '../tenancy/prisma-test-client';

const execFileAsync = promisify(execFile);

const SCRIPT = join(__dirname, '..', '..', '..', '..', 'scripts', 'seed-test-accounts.sh');

function hasBinary(name: string): boolean {
  for (const dir of ['/usr/bin', '/bin', '/usr/local/bin']) {
    if (existsSync(join(dir, name))) return true;
  }
  return false;
}

const canRun =
  Boolean(integrationDatabaseUrl()) &&
  process.platform !== 'win32' &&
  existsSync(SCRIPT) &&
  hasBinary('curl') &&
  hasBinary('jq');

const describeIfRunnable = canRun ? describe : describe.skip;

/** One line out of the script's own printed credential block. */
function field(stdout: string, label: string): string {
  const line = stdout.split('\n').find((l) => l.trim().startsWith(`${label} `));
  if (!line) return '';
  return line.slice(line.indexOf(':') + 1).trim();
}

describeIfRunnable('seed-test-accounts.sh, against a really-listening application', () => {
  let app: INestApplication;
  let http: any;
  let baseUrl: string;
  let stdout = '';
  let exitCode = 0;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue(createTestPrismaService())
      .compile();

    app = moduleRef.createNestApplication();
    applyGlobalHttpPipeline(app);
    await app.init();
    await app.listen(0, '127.0.0.1');
    const address = app.getHttpServer().address();
    baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
    http = app.getHttpServer();

    // The credentials file is written into a throwaway directory: this suite
    // must not drop a TEST-ACCOUNTS.txt into the working tree of whoever runs
    // the test.
    const outDir = mkdtempSync(join(tmpdir(), 'abny-seed-'));
    try {
      const res = await execFileAsync('bash', [SCRIPT, baseUrl], {
        encoding: 'utf8',
        timeout: 180_000,
        env: { ...process.env, ABNY_TEST_OUT: join(outDir, 'TEST-ACCOUNTS.txt') },
      });
      stdout = res.stdout + (res.stderr ?? '');
    } catch (err: any) {
      stdout = String(err.stdout ?? '') + String(err.stderr ?? '');
      exitCode = err.code ?? -1;
    }
  }, 240_000);

  afterAll(async () => {
    if (app) await app.close();
  });

  it('S1 — the whole chain completes: family, session, two children, a pairing code', () => {
    // Printed first so a failure below shows what the script actually said,
    // rather than only which assertion tripped.
    if (exitCode !== 0) console.log(stdout);

    expect(exitCode).toBe(0);
    expect(stdout).toContain('created  parent account');
    expect(stdout).toContain('created  session');
    expect(stdout).toContain('created  child Omar');
    expect(stdout).toContain('TEST ACCOUNTS READY');

    /**
     * The second child is the PAYWALL BOUNDARY, and both outcomes are correct:
     * a plan that allows a sibling creates Salma, and a plan that does not
     * answers 403 PLAN_UPGRADE_REQUIRED. What must never happen is silence —
     * a seeder that swallowed the refusal would leave a family with one child
     * and no explanation, and the person testing would blame the app.
     */
    const created = stdout.includes('created  child Salma');
    const refused = stdout.includes('skipped  child Salma');
    expect({ created, refused, either: created || refused }).toEqual({
      created,
      refused,
      either: true,
    });
    if (refused) {
      expect(stdout).toContain('PLAN_UPGRADE_REQUIRED');
      expect(stdout).toContain('not a seeding failure');
    }
  }, 60_000);

  it('S2 — the credentials it printed actually log in', async () => {
    const email = field(stdout, 'email   ');
    const password = field(stdout, 'password');

    expect(email).toMatch(/@example\.com$/);
    expect(password).not.toBe('');

    const res = await request(http).post('/api/v1/auth/login').send({ email, password });
    expect(res.status).toBe(200);
    expect(res.body.tokens?.accessToken ?? res.body.accessToken).toEqual(expect.any(String));
  }, 60_000);

  it('S3 — the pairing code is real, and it is single-use', async () => {
    const code = field(stdout, 'code    ');
    expect(code).not.toBe('');
    expect(code).not.toBe('<none returned>');

    const first = await request(http).post('/api/v1/pairing/accept').send({ code });
    expect(first.status).toBe(200);

    // A pairing code that could be redeemed twice would let a second device
    // onto a child's account with a code the parent believes was spent.
    const second = await request(http).post('/api/v1/pairing/accept').send({ code });
    expect(second.status).toBeGreaterThanOrEqual(400);
  }, 60_000);

  it('S4 — the generated password satisfies the backend’s own policy', () => {
    const password = field(stdout, 'password');
    expect(password.length).toBeGreaterThanOrEqual(10);
    expect(password).toMatch(/[A-Za-z]/);
    expect(password).toMatch(/\d/);
  });

  it('S5 — it invents no operator account, and says why', () => {
    expect(stdout).toContain('There is no account');
    expect(stdout).toContain('INTERNAL_ADMIN_API_KEY');
    // The words that would mean it had manufactured one.
    expect(stdout).not.toMatch(/super[- ]?admin\s*(email|password)/i);
  });
});
