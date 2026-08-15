/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-var-requires */
/**
 * PHASE C P4 (PA-B-031) — THE SCHEDULER, PROVEN AGAINST A REAL POSTGRESQL.
 *
 * Everything asserted here is EXECUTED. The lock is a real `pg_try_advisory_xact_lock`
 * contended by two real runners with two real worker ids; the idempotency is a
 * real unique-index conflict; the retention deletes are real rows counted
 * before and after; the timezone proof is two real families with two real
 * `Family.timezone` values reaching two DIFFERENT `job_runs.business_date`
 * values from ONE instant.
 *
 * WHY THAT MATTERS FOR THIS PARTICULAR STEP. The thing being replaced is a
 * subsystem that was, in this project's own words, «a policy document with an
 * unexecuted implementation underneath it». Replacing it with a second set of
 * claims backed by mocks would have changed nothing that matters. So the four
 * required properties — deterministic, idempotent, singly-executed across
 * replicas, timezone-correct — each have a test below that would go red if the
 * property were removed, and none of them assert on a log line.
 */
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request = require('supertest');

import { AppModule } from '../../src/app.module';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { createTenantExtension } from '../../src/common/tenancy/tenant.extension';
import { runAsSystemAsync } from '../../src/common/tenancy/system-context';
import { JobObservability } from '../../src/modules/scheduler/application/job-observability.service';
import { JobRegistry } from '../../src/modules/scheduler/application/job-registry.service';
import { JobRunner } from '../../src/modules/scheduler/application/job-runner.service';
import { SchedulerService } from '../../src/modules/scheduler/application/scheduler.service';
import { RETENTION_SWEEP_JOB } from '../../src/modules/scheduler/application/jobs/retention-sweep.job';
import { FAMILY_DAILY_ROLLOVER_JOB } from '../../src/modules/scheduler/application/jobs/family-daily-rollover.job';
import { integrationDatabaseUrl } from '../tenancy/prisma-test-client';

const describeIfDb = integrationDatabaseUrl() ? describe : describe.skip;

const ADMIN_KEY = process.env.INTERNAL_ADMIN_API_KEY as string;

/**
 * THE INSTANT THE TIMEZONE PROOF IS TAKEN AT, and it is a January one on
 * purpose. Egypt reintroduced DST in 2023, so in August Africa/Cairo and
 * Asia/Riyadh are BOTH UTC+3 and roll over together — asserting a difference in
 * August would be asserting something false. In January Cairo is UTC+2 and
 * Riyadh is UTC+3, so at 23:30Z the Riyadh clock reads 02:30 on the 16th (past
 * the 02:00 boundary) and the Cairo clock reads 01:30 on the 16th (not past
 * it). Read from tzdata by `family-date.ts`, never from a remembered offset.
 */
const WINTER_INSTANT = new Date('2026-01-15T23:30:00.000Z');
const WINTER_INSTANT_PLUS_1H = new Date('2026-01-16T00:30:00.000Z');

function offlinePrismaService(): any {
  const url = process.env.INTEGRATION_DATABASE_URL as string;
  if (process.env.PRISMA_DRIVER_ADAPTER === 'pg') {
    const { PrismaClient } = require('@prisma/client/wasm');
    const { PrismaPg } = require('@prisma/adapter-pg');
    const { Pool } = require('pg');
    const pool = new Pool({ connectionString: url });
    const base = new PrismaClient({ adapter: new PrismaPg(pool) });
    const extended = base.$extends(createTenantExtension());
    extended.onModuleInit = async () => undefined;
    extended.onModuleDestroy = async () => {
      await base.$disconnect();
      await pool.end();
    };
    return extended;
  }
  const { PrismaClient } = require('@prisma/client');
  const base = new PrismaClient({ datasources: { db: { url } } });
  const extended = base.$extends(createTenantExtension());
  extended.onModuleInit = async () => base.$connect();
  extended.onModuleDestroy = async () => base.$disconnect();
  return extended;
}

describeIfDb('PHASE C P4 — the scheduler (real PostgreSQL)', () => {
  let app: INestApplication;
  let http: any;
  let prisma: any;
  let runner: JobRunner;
  let observability: JobObservability;
  let registry: JobRegistry;

  const stamp = Date.now();
  const createdFamilies: string[] = [];
  const createdUsers: string[] = [];

  const sys = (what: string, fn: () => Promise<any>): Promise<any> =>
    runAsSystemAsync('TEST_FIXTURE', `Phase C P4 scheduler suite: ${what}`, async () => await fn());

  const raw = <T>(sql: string, ...params: unknown[]): Promise<T> =>
    sys('raw sql', () => prisma.$queryRawUnsafe(sql, ...params)) as Promise<T>;

  const exec = (sql: string, ...params: unknown[]): Promise<number> =>
    sys('raw exec', () => prisma.$executeRawUnsafe(sql, ...params)) as Promise<number>;

  /** Clears any lease and failure state left by a previous test in this file. */
  const resetJob = (job: string): Promise<number> =>
    exec(
      `UPDATE "scheduled_jobs"
          SET "locked_by" = NULL, "locked_at" = NULL, "consecutive_failures" = 0,
              "last_status" = NULL, "last_error" = NULL, "enabled" = true,
              "next_run_at" = now() - INTERVAL '1 hour'
        WHERE "name" = $1`,
      job,
    );

  const jobRow = async (job: string): Promise<any> =>
    (await raw<any[]>(`SELECT * FROM "scheduled_jobs" WHERE "name" = $1`, job))[0];

  async function createFamily(label: string, timezone: string): Promise<{ familyId: string; childId: string }> {
    const family = await sys('create family', () =>
      prisma.family.create({ data: { name: `P4 ${label} ${stamp}`, timezone }, select: { id: true } }),
    );
    createdFamilies.push(family.id);

    const user = await sys('create user', () =>
      prisma.user.create({
        data: {
          email: `p4.${label}.${stamp}@example.test`,
          passwordHash: 'x',
          fullName: 'P4 Parent',
        },
        select: { id: true },
      }),
    );
    createdUsers.push(user.id);
    await sys('create membership', () =>
      prisma.familyMember.create({ data: { familyId: family.id, userId: user.id, role: 'OWNER' } }),
    );

    const child = await sys('create child', () =>
      prisma.child.create({
        data: {
          familyId: family.id,
          firstName: `P4 Kid ${label}`,
          dateOfBirth: new Date('2015-04-01T00:00:00.000Z'),
        },
        select: { id: true },
      }),
    );
    await sys('create habit', () =>
      prisma.habit.create({
        data: {
          familyId: family.id,
          childId: child.id,
          title: `P4 Habit ${label}`,
          category: 'LEARNING',
          isActive: true,
        },
      }),
    );
    return { familyId: family.id, childId: child.id };
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue(offlinePrismaService())
      .compile();

    app = moduleRef.createNestApplication();
    const { ValidationPipe } = require('@nestjs/common');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();

    http = app.getHttpServer();
    prisma = app.get(PrismaService);
    runner = app.get(JobRunner);
    observability = app.get(JobObservability);
    registry = app.get(JobRegistry);
  }, 120_000);

  afterAll(async () => {
    if (prisma) {
      await sys('cleanup runs', () =>
        prisma.$executeRawUnsafe(`DELETE FROM "job_runs" WHERE "worker_id" LIKE 'sched-%' AND "family_id" = ANY($1::uuid[])`, createdFamilies),
      ).catch(() => undefined);
      for (const id of createdFamilies) {
        await sys('cleanup family', () => prisma.family.deleteMany({ where: { id } })).catch(() => undefined);
      }
      for (const id of createdUsers) {
        await sys('cleanup user', () => prisma.user.deleteMany({ where: { id } })).catch(() => undefined);
      }
    }
    await app?.close();
  }, 120_000);

  // ==========================================================================
  describe('1. the registry is real and reaches the database', () => {
    it('every registered job has a scheduled_jobs row, and vice versa', async () => {
      const rows = await raw<Array<{ name: string }>>(`SELECT "name" FROM "scheduled_jobs" ORDER BY "name"`);
      expect(rows.map((r) => r.name)).toEqual([...registry.names()].sort());
    });

    it('the FAMILY/PLATFORM CHECK constraint is real, not a TypeScript union', async () => {
      // A closed vocabulary that only exists in the type system is a vocabulary
      // a raw INSERT walks around. Migration 0011 puts it in the database.
      await expect(
        exec(
          `INSERT INTO "scheduled_jobs" ("name","scope","cadence_seconds") VALUES ('p4-bogus','WHENEVER',60)`,
        ),
      ).rejects.toThrow();
    });

    it('refuses a FAMILY job with no local rollover hour', async () => {
      await expect(
        exec(
          `INSERT INTO "scheduled_jobs" ("name","scope","cadence_seconds","local_hour") VALUES ('p4-bogus2','FAMILY',60,NULL)`,
        ),
      ).rejects.toThrow();
    });
  });

  // ==========================================================================
  describe('2. NO DUPLICATE EXECUTION ACROSS REPLICAS — the lock, contended', () => {
    it('two runners racing for the same job: exactly one claims it', async () => {
      await resetJob(RETENTION_SWEEP_JOB);

      // Two INDEPENDENT runners with two independent worker ids — the closest
      // this process can get to two replicas, and the thing the lease actually
      // has to survive.
      const runnerB = new JobRunner(prisma, registry);
      expect(runnerB.workerId).not.toBe(runner.workerId);

      const [a, b] = await Promise.all([
        runner.runJob(RETENTION_SWEEP_JOB),
        runnerB.runJob(RETENTION_SWEEP_JOB),
      ]);

      const claimed = [a, b].filter((r) => r.claimed);
      expect(claimed).toHaveLength(1);
    }, 60_000);

    it('a second claim is refused while the lease is held, and granted once it goes stale', async () => {
      await resetJob(RETENTION_SWEEP_JOB);

      // Simulate a replica that took the lease and then died: the row still
      // says locked, and nothing is going to clear it.
      await exec(
        `UPDATE "scheduled_jobs" SET "locked_by" = 'dead-replica', "locked_at" = now() WHERE "name" = $1`,
        RETENTION_SWEEP_JOB,
      );
      const refused = await runner.runJob(RETENTION_SWEEP_JOB);
      expect(refused.claimed).toBe(false);

      // Age the lease past `leaseSeconds` (600). Nothing "notices" the death —
      // the staleness IS the recovery.
      await exec(
        `UPDATE "scheduled_jobs" SET "locked_at" = now() - INTERVAL '20 minutes' WHERE "name" = $1`,
        RETENTION_SWEEP_JOB,
      );
      const taken = await runner.runJob(RETENTION_SWEEP_JOB);
      expect(taken.claimed).toBe(true);
    }, 60_000);

    it('releases the lease after the run, so the next tick is not blocked', async () => {
      await resetJob(RETENTION_SWEEP_JOB);
      await runner.runJob(RETENTION_SWEEP_JOB);
      const row = await jobRow(RETENTION_SWEEP_JOB);
      expect(row.locked_by).toBeNull();
      expect(row.locked_at).toBeNull();
    }, 60_000);

    it('a disabled job is never claimed, however overdue it is', async () => {
      await resetJob(RETENTION_SWEEP_JOB);
      await observability.setEnabled(RETENTION_SWEEP_JOB, false);
      try {
        const report = await runner.runJob(RETENTION_SWEEP_JOB);
        expect(report.claimed).toBe(false);
        // Not even a MANUAL trigger overrides `enabled` — the kill switch has
        // to actually stop the job, or it is not a kill switch.
        const manual = await runner.runJob(RETENTION_SWEEP_JOB, { trigger: 'MANUAL' });
        expect(manual.claimed).toBe(false);
      } finally {
        await observability.setEnabled(RETENTION_SWEEP_JOB, true);
      }
    }, 60_000);
  });

  // ==========================================================================
  describe('3. OBSERVABLE — the run history is a queryable table', () => {
    it('records started/finished, duration and affected rows for a platform run', async () => {
      await resetJob(RETENTION_SWEEP_JOB);
      const before = new Date();
      const report = await runner.runJob(RETENTION_SWEEP_JOB, { trigger: 'MANUAL' });
      expect(report.claimed).toBe(true);

      const runs = await observability.listRuns({ jobName: RETENTION_SWEEP_JOB, limit: 1 });
      expect(runs).toHaveLength(1);
      const run = runs[0];
      expect(run.status).toBe('SUCCEEDED');
      expect(run.trigger).toBe('MANUAL');
      expect(new Date(run.startedAt).getTime()).toBeGreaterThanOrEqual(before.getTime() - 2000);
      expect(run.finishedAt).not.toBeNull();
      expect(run.durationMs).not.toBeNull();
      expect(run.details).not.toBeNull();
      // PLATFORM runs are attributable to no household, and that is stored as
      // NULL rather than as a pretend tenant.
      expect(run.familyId).toBeNull();
      expect(run.businessDate).toBeNull();
    }, 60_000);

    it('the details object carries COUNTS ONLY — never a row, an id or a body', async () => {
      await resetJob(RETENTION_SWEEP_JOB);
      await runner.runJob(RETENTION_SWEEP_JOB, { trigger: 'MANUAL' });
      const [run] = await observability.listRuns({ jobName: RETENTION_SWEEP_JOB, limit: 1 });

      // THE PRIVACY PROPERTY OF A RETENTION LOG, asserted rather than promised:
      // a sweep that recorded what it deleted would have copied the data it was
      // told to destroy into a table with a longer retention period.
      for (const [key, value] of Object.entries(run.details ?? {})) {
        expect(typeof value).toBe('number');
        expect(key).toMatch(/^[a-z0-9_]+$/);
      }
    }, 60_000);

    it('the registry view shows last run, next run and the lease state', async () => {
      await resetJob(RETENTION_SWEEP_JOB);
      await runner.runJob(RETENTION_SWEEP_JOB, { trigger: 'MANUAL' });

      const jobs = await observability.listJobs();
      const job = jobs.find((j) => j.name === RETENTION_SWEEP_JOB)!;
      expect(job.registered).toBe(true);
      expect(job.lastStatus).toBe('SUCCEEDED');
      expect(job.lastFinishedAt).not.toBeNull();
      expect(job.running).toBe(false);
      expect(job.alerting).toBe(false);
      // The cadence is a DAY, so the next run must be roughly a day out — not
      // "immediately", which is what a scheduler with no state does.
      expect(job.nextRunAt.getTime()).toBeGreaterThan(Date.now() + 20 * 60 * 60 * 1000);
    }, 60_000);
  });

  // ==========================================================================
  describe('4. RETRY WITH BACKOFF AND A VISIBLE FAILURE STATE', () => {
    it('a throwing job is recorded FAILED, counted, and backed off — twice, doubling', async () => {
      await resetJob(RETENTION_SWEEP_JOB);
      const definition = registry.get(RETENTION_SWEEP_JOB)!;
      const spy = jest
        .spyOn(definition, 'handler' as never)
        .mockRejectedValue(new Error('P4 injected failure') as never);

      try {
        await runner.runJob(RETENTION_SWEEP_JOB, { trigger: 'MANUAL' });
        let row = await jobRow(RETENTION_SWEEP_JOB);
        expect(row.last_status).toBe('FAILED');
        expect(Number(row.consecutive_failures)).toBe(1);
        expect(row.last_error).toContain('P4 injected failure');
        const firstDelay = new Date(row.next_run_at).getTime() - Date.now();
        // 60s base, with slack for the round trips.
        expect(firstDelay).toBeGreaterThan(30_000);
        expect(firstDelay).toBeLessThan(120_000);

        // The run row is FAILED too, with the error text on it.
        const [run] = await observability.listRuns({ jobName: RETENTION_SWEEP_JOB, limit: 1 });
        expect(run.status).toBe('FAILED');
        expect(run.error).toContain('P4 injected failure');

        await exec(
          `UPDATE "scheduled_jobs" SET "next_run_at" = now() - INTERVAL '1 minute' WHERE "name" = $1`,
          RETENTION_SWEEP_JOB,
        );
        await runner.runJob(RETENTION_SWEEP_JOB, { trigger: 'MANUAL' });
        row = await jobRow(RETENTION_SWEEP_JOB);
        expect(Number(row.consecutive_failures)).toBe(2);
        const secondDelay = new Date(row.next_run_at).getTime() - Date.now();
        expect(secondDelay).toBeGreaterThan(firstDelay);

        // THE ALERT. The failure is visible in the gauge, not only in a log.
        const failures = await observability.failures(24);
        expect(failures.find((f) => f.jobName === RETENTION_SWEEP_JOB)?.failedCount).toBeGreaterThanOrEqual(1);
      } finally {
        spy.mockRestore();
      }
    }, 90_000);

    it('a success clears the failure counter and the error text', async () => {
      await exec(
        `UPDATE "scheduled_jobs" SET "consecutive_failures" = 4, "last_status" = 'FAILED',
             "last_error" = 'stale', "locked_by" = NULL, "locked_at" = NULL,
             "next_run_at" = now() - INTERVAL '1 hour' WHERE "name" = $1`,
        RETENTION_SWEEP_JOB,
      );
      await runner.runJob(RETENTION_SWEEP_JOB, { trigger: 'MANUAL' });
      const row = await jobRow(RETENTION_SWEEP_JOB);
      expect(Number(row.consecutive_failures)).toBe(0);
      expect(row.last_status).toBe('SUCCEEDED');
      expect(row.last_error).toBeNull();
    }, 60_000);
  });

  // ==========================================================================
  describe('5. RETENTION IS REAL — rows deleted, and deleting twice deletes once', () => {
    let retentionFamily: string;

    beforeAll(async () => {
      const created = await createFamily('retention', 'UTC');
      retentionFamily = created.familyId;
    }, 60_000);

    /** Seeds `count` notifications aged `ageDays` days, for this suite's family. */
    async function seedOldNotifications(count: number, ageDays: number): Promise<void> {
      const owner = await raw<Array<{ user_id: string }>>(
        `SELECT "user_id" FROM "family_members" WHERE "family_id" = $1::uuid LIMIT 1`,
        retentionFamily,
      );
      await exec(
        `INSERT INTO "notifications"
           ("id","family_id","user_id","type","title","body","priority","created_at","source_event_id")
         SELECT gen_random_uuid(), $1::uuid, $2::uuid, 'P4_TEST', 'x', 'y', 'NORMAL',
                now() - make_interval(days => $3::int), 'p4-' || gen_random_uuid()::text
           FROM generate_series(1, $4::int)`,
        retentionFamily,
        owner[0].user_id,
        ageDays,
        count,
      );
    }

    const countNotifications = async (): Promise<number> =>
      Number(
        (
          await raw<Array<{ c: string }>>(
            `SELECT count(*)::int AS c FROM "notifications" WHERE "family_id" = $1::uuid`,
            retentionFamily,
          )
        )[0].c,
      );

    it('deletes rows past their retention period and reports the count', async () => {
      await seedOldNotifications(25, 200); // well past the 90-day period
      await seedOldNotifications(5, 1); // inside it, must survive
      expect(await countNotifications()).toBe(30);

      await resetJob(RETENTION_SWEEP_JOB);
      const report = await runner.runJob(RETENTION_SWEEP_JOB, { trigger: 'MANUAL' });
      expect(report.claimed).toBe(true);

      expect(await countNotifications()).toBe(5);

      const [run] = await observability.listRuns({ jobName: RETENTION_SWEEP_JOB, limit: 1 });
      expect(run.status).toBe('SUCCEEDED');
      expect(run.affectedRows).toBeGreaterThanOrEqual(25);
      expect(run.details?.notifications).toBeGreaterThanOrEqual(25);
    }, 90_000);

    it('IS IDEMPOTENT — a second sweep deletes nothing and does not fail', async () => {
      const before = await countNotifications();

      await resetJob(RETENTION_SWEEP_JOB);
      const second = await runner.runJob(RETENTION_SWEEP_JOB, { trigger: 'MANUAL' });
      expect(second.claimed).toBe(true);

      const [run] = await observability.listRuns({ jobName: RETENTION_SWEEP_JOB, limit: 1 });
      expect(run.status).toBe('SUCCEEDED');
      expect(run.details?.notifications ?? 0).toBe(0);
      expect(await countNotifications()).toBe(before);
    }, 90_000);

    it('IS DETERMINISTIC — the same instant and the same rows produce the same decision', async () => {
      await seedOldNotifications(7, 200);
      const service = app.get(
        require('../../src/modules/data-retention/application/data-retention-enforcement.service')
          .DataRetentionEnforcementService,
      );

      // Fixed `now`, run twice: the first deletes 7, the second deletes 0 —
      // because the predicate is an ABSOLUTE cutoff, not "since the last run".
      const at = new Date('2026-08-15T00:00:00.000Z');
      const first: any[] = await sys('sweep 1', () => service.sweepAll({ now: at }));
      const second: any[] = await sys('sweep 2', () => service.sweepAll({ now: at }));

      const deleted = (r: any[]): number => r.find((x) => x.key === 'notifications').deletedRows;
      expect(deleted(first)).toBeGreaterThanOrEqual(7);
      expect(deleted(second)).toBe(0);
    }, 90_000);

    it('IS BOUNDED — a small batch size produces many small statements, not one big lock', async () => {
      await seedOldNotifications(12, 200);
      const service = app.get(
        require('../../src/modules/data-retention/application/data-retention-enforcement.service')
          .DataRetentionEnforcementService,
      );

      const results: any[] = await sys('bounded sweep', () =>
        service.sweepAll({ now: new Date(), batchSize: 5, maxBatchesPerTarget: 2 }),
      );
      const notifications = results.find((r: any) => r.key === 'notifications');
      // 2 batches x 5 = at most 10 deleted, and the shortfall is REPORTED
      // rather than hidden.
      expect(notifications.deletedRows).toBeLessThanOrEqual(10);
      expect(notifications.batches).toBeLessThanOrEqual(2);
      expect(notifications.truncated).toBe(true);
    }, 90_000);

    it('scopes to one family when asked, which is what account deletion needs', async () => {
      const other = await createFamily('retention-other', 'UTC');
      const otherOwner = await raw<Array<{ user_id: string }>>(
        `SELECT "user_id" FROM "family_members" WHERE "family_id" = $1::uuid LIMIT 1`,
        other.familyId,
      );
      await exec(
        `INSERT INTO "notifications"
           ("id","family_id","user_id","type","title","body","priority","created_at","source_event_id")
         SELECT gen_random_uuid(), $1::uuid, $2::uuid, 'P4_TEST', 'x', 'y', 'NORMAL',
                now() - INTERVAL '200 days', 'p4o-' || gen_random_uuid()::text
           FROM generate_series(1, 4)`,
        other.familyId,
        otherOwner[0].user_id,
      );
      await seedOldNotifications(4, 200);

      const service = app.get(
        require('../../src/modules/data-retention/application/data-retention-enforcement.service')
          .DataRetentionEnforcementService,
      );
      await sys('family-scoped sweep', () => service.sweepAll({ familyId: retentionFamily }));

      // Ours gone, THEIRS UNTOUCHED — the family scope narrows, it does not widen.
      expect(await countNotifications()).toBe(5);
      const theirs = await raw<Array<{ c: string }>>(
        `SELECT count(*)::int AS c FROM "notifications" WHERE "family_id" = $1::uuid`,
        other.familyId,
      );
      expect(Number(theirs[0].c)).toBe(4);
    }, 90_000);
  });

  // ==========================================================================
  describe('6. TIMEZONE-CORRECT — two families, ONE instant, two different days', () => {
    let cairo: { familyId: string; childId: string };
    let riyadh: { familyId: string; childId: string };

    beforeAll(async () => {
      cairo = await createFamily('cairo', 'Africa/Cairo');
      riyadh = await createFamily('riyadh', 'Asia/Riyadh');
    }, 60_000);

    const businessDateFor = async (familyId: string): Promise<string | null> => {
      const runs = await observability.listRuns({
        jobName: FAMILY_DAILY_ROLLOVER_JOB,
        familyId,
        limit: 1,
      });
      return runs[0]?.businessDate ?? null;
    };

    it('THE PROOF: at 2026-01-15T23:30Z Riyadh closes 2026-01-15 and Cairo closes 2026-01-14', async () => {
      await resetJob(FAMILY_DAILY_ROLLOVER_JOB);
      const report = await runner.runJob(FAMILY_DAILY_ROLLOVER_JOB, {
        now: WINTER_INSTANT,
        trigger: 'MANUAL',
      });
      expect(report.claimed).toBe(true);

      const riyadhDate = await businessDateFor(riyadh.familyId);
      const cairoDate = await businessDateFor(cairo.familyId);

      // The two households are at 02:30 and 01:30 local respectively. One has
      // crossed its rollover boundary and one has not, from the SAME instant.
      expect(riyadhDate).toBe('2026-01-15');
      expect(cairoDate).toBe('2026-01-14');
      expect(riyadhDate).not.toBe(cairoDate);
    }, 120_000);

    it('one hour later Cairo crosses its own boundary and closes the same day Riyadh already did', async () => {
      await resetJob(FAMILY_DAILY_ROLLOVER_JOB);
      await runner.runJob(FAMILY_DAILY_ROLLOVER_JOB, {
        now: WINTER_INSTANT_PLUS_1H,
        trigger: 'MANUAL',
      });
      expect(await businessDateFor(cairo.familyId)).toBe('2026-01-15');
    }, 120_000);

    it('each family got its OWN run row, stamped with its OWN tenant', async () => {
      const cairoRuns = await observability.listRuns({
        jobName: FAMILY_DAILY_ROLLOVER_JOB,
        familyId: cairo.familyId,
      });
      expect(cairoRuns.length).toBeGreaterThan(0);
      for (const run of cairoRuns) expect(run.familyId).toBe(cairo.familyId);
      // The fan-out re-entered a real tenant context per family; a run row with
      // a NULL family here would mean the job body ran cross-tenant.
      expect(cairoRuns.every((r) => r.familyId !== null)).toBe(true);
    }, 60_000);

    it('IS IDEMPOTENT — re-running the same instant skips every family the database says is done', async () => {
      await resetJob(FAMILY_DAILY_ROLLOVER_JOB);
      const again = await runner.runJob(FAMILY_DAILY_ROLLOVER_JOB, {
        now: WINTER_INSTANT_PLUS_1H,
        trigger: 'MANUAL',
      });
      expect(again.claimed).toBe(true);
      expect(again.executed).toBe(0);
      expect(again.skipped).toBeGreaterThan(0);

      // And exactly one row per (family, business date) — the unique index, not
      // a check in code.
      const rows = await raw<Array<{ c: string }>>(
        `SELECT count(*)::int AS c FROM "job_runs"
          WHERE "job_name" = $1 AND "family_id" = $2::uuid AND "business_date" = DATE '2026-01-15'`,
        FAMILY_DAILY_ROLLOVER_JOB,
        cairo.familyId,
      );
      expect(Number(rows[0].c)).toBe(1);
    }, 120_000);

    it('actually writes the MISSED rows that nothing in production has ever written', async () => {
      // The rollover marked the family's one active habit MISSED for the day it
      // closed. Before this job existed, `markMissedHabits` had exactly one
      // caller — a manual HTTP route — so this row could not exist.
      const rows = await raw<Array<{ c: string }>>(
        `SELECT count(*)::int AS c FROM "habit_completions"
          WHERE "family_id" = $1::uuid AND "status" = 'MISSED'`,
        cairo.familyId,
      );
      expect(Number(rows[0].c)).toBeGreaterThan(0);
    }, 60_000);
  });

  // ==========================================================================
  describe('7. THE OPERATIONAL SURFACE', () => {
    const admin = (req: any): any => req.set({ 'x-internal-admin-key': ADMIN_KEY });

    it('lists jobs behind the internal-admin guard', async () => {
      const res = await admin(request(http).get('/system/jobs')).expect(200);
      expect(res.body.jobs.length).toBe(registry.names().length);
      expect(res.body.jobs.every((j: any) => j.registered)).toBe(true);
      expect(typeof res.body.alerting).toBe('number');
    });

    it('refuses every route without the admin key', async () => {
      await request(http).get('/system/jobs').expect(401);
      await request(http).get('/system/jobs/runs').expect(401);
      await request(http).get('/system/jobs/failures').expect(401);
      await request(http).post(`/system/jobs/${RETENTION_SWEEP_JOB}/run`).expect(401);
      await request(http)
        .post(`/system/jobs/${RETENTION_SWEEP_JOB}/enabled`)
        .send({ enabled: false })
        .expect(401);
    });

    it('refuses a wrong admin key', async () => {
      await request(http)
        .get('/system/jobs')
        .set({ 'x-internal-admin-key': 'not-the-key' })
        .expect(401);
    });

    it('returns run history, newest first, and narrows by job', async () => {
      const res = await admin(
        request(http).get('/system/jobs/runs').query({ jobName: RETENTION_SWEEP_JOB, limit: 5 }),
      ).expect(200);
      expect(res.body.runs.every((r: any) => r.jobName === RETENTION_SWEEP_JOB)).toBe(true);
      const times = res.body.runs.map((r: any) => new Date(r.startedAt).getTime());
      expect([...times].sort((a, b) => b - a)).toEqual(times);
    });

    it('returns the failure gauge over a bounded window', async () => {
      const res = await admin(request(http).get('/system/jobs/failures').query({ windowHours: 24 })).expect(200);
      expect(res.body.windowHours).toBe(24);
      expect(Array.isArray(res.body.failures)).toBe(true);
    });

    it('triggers a run by hand and AUDITS it', async () => {
      await resetJob(RETENTION_SWEEP_JOB);
      const before = await raw<Array<{ c: string }>>(
        `SELECT count(*)::int AS c FROM "audit_logs" WHERE "action" = 'scheduler.job.manual_run'`,
      );

      const res = await admin(request(http).post(`/system/jobs/${RETENTION_SWEEP_JOB}/run`)).expect(201);
      expect(res.body.claimed).toBe(true);

      const after = await raw<Array<{ c: string }>>(
        `SELECT count(*)::int AS c FROM "audit_logs" WHERE "action" = 'scheduler.job.manual_run'`,
      );
      expect(Number(after[0].c)).toBe(Number(before[0].c) + 1);
    }, 90_000);

    it('answers 404 for a job that does not exist', async () => {
      await admin(request(http).post('/system/jobs/no-such-job/run')).expect(404);
      await admin(request(http).post('/system/jobs/no-such-job/enabled').send({ enabled: true })).expect(404);
    });

    it('disables and re-enables a job, auditing both', async () => {
      try {
        await admin(
          request(http).post(`/system/jobs/${RETENTION_SWEEP_JOB}/enabled`).send({ enabled: false }),
        ).expect(201);
        expect((await jobRow(RETENTION_SWEEP_JOB)).enabled).toBe(false);

        const audits = await raw<Array<{ c: string }>>(
          `SELECT count(*)::int AS c FROM "audit_logs" WHERE "action" = 'scheduler.job.enabled_changed'`,
        );
        expect(Number(audits[0].c)).toBeGreaterThan(0);
      } finally {
        await admin(
          request(http).post(`/system/jobs/${RETENTION_SWEEP_JOB}/enabled`).send({ enabled: true }),
        );
      }
    });

    it('rejects a malformed body rather than coercing it', async () => {
      await admin(
        request(http).post(`/system/jobs/${RETENTION_SWEEP_JOB}/enabled`).send({ enabled: 'yes' }),
      ).expect(400);
    });
  });

  // ==========================================================================
  describe('8. the poller itself', () => {
    it('does not start on module init — an AppModule in a test opens no timer', () => {
      // The property that keeps 119 other suites from acquiring a scheduler.
      const scheduler = app.get(SchedulerService);
      expect((scheduler as any).timer).toBeNull();
    });

    it('a tick runs every due job and returns real numbers', async () => {
      for (const name of registry.names()) await resetJob(name);
      const scheduler = app.get(SchedulerService);
      const reports = await scheduler.tick(WINTER_INSTANT);
      expect(reports.map((r) => r.job).sort()).toEqual([...registry.names()].sort());
      // The dead-letter alert may legitimately fail if the shared test database
      // has dead letters in it from another suite; every other job must claim.
      expect(reports.filter((r) => r.claimed).length).toBeGreaterThanOrEqual(3);
    }, 180_000);

    it('a re-entrant tick is a no-op rather than a second concurrent pass', async () => {
      const scheduler = app.get(SchedulerService);
      (scheduler as any).ticking = true;
      try {
        expect(await scheduler.tick()).toEqual([]);
      } finally {
        (scheduler as any).ticking = false;
      }
    });
  });
});
