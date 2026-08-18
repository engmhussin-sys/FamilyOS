/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-var-requires */
/**
 * THE 201st FAMILY — a regression proof against a real PostgreSQL.
 *
 * WHAT WAS BROKEN. `SQL_LIST_ACTIVE_FAMILIES` was `ORDER BY id LIMIT 200
 * OFFSET 0` and `JobRunner.executeFamilies` called it ONCE. A family-scoped
 * job — including the daily rollover, which is what writes MISSED habits and
 * decides a day is over — therefore processed the first 200 households in uuid
 * order and silently never reached the rest. No error, no log, no metric: past
 * a couple of hundred households an arbitrary and unpredictable subset of
 * families simply stopped having their day rolled over. The registry comment
 * claimed the remainder was «picked up by the next tick», which was false — the
 * next tick re-read the SAME first 200, found them done, and skipped them.
 *
 * WHY THIS SUITE INSERTS REAL ROWS. A mocked paginator proves that a mock
 * paginates. The only thing that proves households past the page boundary are
 * reached is households past the page boundary, in a table, counted afterwards
 * from that table rather than from the runner's own return value — a runner
 * that lies about how many families it processed is precisely the failure being
 * tested for. So this creates {@link COHORT_SIZE} synthetic families (more than
 * `SCHEDULER_DEFAULTS.familyBatchSize`, so at least
 * `COHORT_SIZE - familyBatchSize` of them are guaranteed to sit past the old
 * cut-off), sweeps, and then asks the DATABASE who was processed.
 *
 * IT FAILS AGAINST THE OLD BEHAVIOUR, deterministically rather than
 * probabilistically: the old code could execute at most 200 families in total,
 * and this cohort alone is larger than that, so §1's count could not have
 * passed however the uuids fell.
 *
 * SHARED DATABASE. This database has families from a dozen other suites in it.
 * Every assertion below is keyed on THIS suite's cohort ids, never on a global
 * count — and §1 asserts that other families really are present, so the suite
 * cannot pass by accident in an empty database either.
 */
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';

import { AppModule } from '../../src/app.module';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { createTenantExtension } from '../../src/common/tenancy/tenant.extension';
import { runAsSystemAsync } from '../../src/common/tenancy/system-context';
import { JobRunner } from '../../src/modules/scheduler/application/job-runner.service';
import { FAMILY_DAILY_ROLLOVER_JOB } from '../../src/modules/scheduler/application/jobs/family-daily-rollover.job';
import { SCHEDULER_DEFAULTS } from '../../src/modules/scheduler/domain/job.types';
import { SQL_LIST_ACTIVE_FAMILIES_PAGE } from '../../src/modules/scheduler/infrastructure/scheduler.sql';
import { integrationDatabaseUrl } from '../tenancy/prisma-test-client';

const describeIfDb = integrationDatabaseUrl() ? describe : describe.skip;

/**
 * 220 — deliberately between 201 and 250, and deliberately MORE than
 * `familyBatchSize` (200). One page cannot hold this cohort, so «every family
 * was processed» is a statement about at least two pages.
 */
const COHORT_SIZE = 220;

/** Every synthetic family is UTC, so one expected business date covers them all. */
const COHORT_TZ = 'UTC';

/** How many of the cohort carry a seeded notification and reward row. See beforeAll. */
const SEEDED_SUBSET = 5;

/**
 * Fixed instants, chosen well away from the dates `scheduler.e2e.spec.ts` uses
 * (January 2026) so the two suites cannot see each other's `job_runs` rows.
 * `local_hour` for the rollover is 2, so at 05:00 UTC the newest closable day
 * is YESTERDAY.
 */
const INSTANT_A = new Date('2026-03-10T05:00:00.000Z');
const BUSINESS_DATE_A = '2026-03-09';
const INSTANT_B = new Date('2026-03-11T05:00:00.000Z');
const BUSINESS_DATE_B = '2026-03-10';
const INSTANT_C = new Date('2026-03-12T05:00:00.000Z');
const BUSINESS_DATE_C = '2026-03-11';
const ALL_BUSINESS_DATES = [BUSINESS_DATE_A, BUSINESS_DATE_B, BUSINESS_DATE_C];

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

describeIfDb('THE 201st FAMILY — a FAMILY sweep reaches every household (real PostgreSQL)', () => {
  let app: INestApplication;
  let prisma: any;
  let runner: JobRunner;

  const stamp = Date.now();
  const cohortName = `PAGINATION-COHORT-${stamp}`;
  /** The ids of the families THIS suite created. Every assertion is keyed on them. */
  let cohort: string[] = [];
  /** The subset that carries a seeded notification and reward row. */
  let seeded: string[] = [];
  let seedUserId: string | null = null;
  /**
   * FAMILIES THIS SUITE CREATES BUT DOES NOT OWN — the "other households" the
   * isolation assertion needs.
   *
   * They used to be borrowed: the assertion simply counted every non-cohort
   * family in the database and required the number to be greater than zero.
   * That passed only because other suites had already run and left rows behind,
   * so on a database migrated from empty — which is exactly how CI and every
   * honest verification run starts — `--runInBand` reached this suite first,
   * found zero foreign families, and failed. A test whose validity depends on
   * another suite's leftovers is not measuring isolation; it is measuring
   * execution order. These rows make the same property true deterministically.
   */
  let outsiders: string[] = [];

  const sys = (what: string, fn: () => Promise<any>): Promise<any> =>
    runAsSystemAsync('TEST_FIXTURE', `Family-sweep pagination suite: ${what}`, async () => await fn());

  const raw = <T>(sql: string, ...params: unknown[]): Promise<T> =>
    sys('raw sql', () => prisma.$queryRawUnsafe(sql, ...params)) as Promise<T>;

  const exec = (sql: string, ...params: unknown[]): Promise<number> =>
    sys('raw exec', () => prisma.$executeRawUnsafe(sql, ...params)) as Promise<number>;

  const count = async (sql: string, ...params: unknown[]): Promise<number> =>
    Number((await raw<Array<{ c: number | string }>>(sql, ...params))[0].c);

  /** Clears the lease and failure state so each test starts from a claimable job. */
  const resetJob = (): Promise<number> =>
    exec(
      `UPDATE "scheduled_jobs"
          SET "locked_by" = NULL, "locked_at" = NULL, "consecutive_failures" = 0,
              "last_status" = NULL, "last_error" = NULL, "enabled" = true,
              "next_run_at" = now() - INTERVAL '1 hour'
        WHERE "name" = $1`,
      FAMILY_DAILY_ROLLOVER_JOB,
    );

  const jobRow = async (): Promise<any> =>
    (
      await raw<any[]>(`SELECT * FROM "scheduled_jobs" WHERE "name" = $1`, FAMILY_DAILY_ROLLOVER_JOB)
    )[0];

  /** SUCCEEDED cohort runs for one business date, counted from the database. */
  const succeededCohortRuns = (businessDate: string): Promise<number> =>
    count(
      `SELECT count(*)::int AS c FROM "job_runs"
        WHERE "job_name" = $1 AND "family_id" = ANY($2::uuid[])
          AND "business_date" = $3::date AND "status" = 'SUCCEEDED'`,
      FAMILY_DAILY_ROLLOVER_JOB,
      cohort,
      businessDate,
    );

  /**
   * Pages the PRODUCTION statement, exactly as `executeFamilies` does, and
   * returns the full id sequence. Used to prove the order is total and stable
   * without asking the runner to tell us about itself.
   */
  async function pageAllFamilyIds(pageSize: number): Promise<string[]> {
    const ids: string[] = [];
    let lastId: string | null = null;
    for (;;) {
      const page: Array<{ id: string }> = await raw<Array<{ id: string }>>(
        SQL_LIST_ACTIVE_FAMILIES_PAGE,
        pageSize,
        lastId,
      );
      if (page.length === 0) break;
      for (const row of page) ids.push(row.id);
      if (page.length < pageSize) break;
      lastId = page[page.length - 1].id;
    }
    return ids;
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue(offlinePrismaService())
      .compile();

    app = moduleRef.createNestApplication();
    await app.init();

    prisma = app.get(PrismaService);
    runner = app.get(JobRunner);

    // THE COHORT. Inserted in bulk because 220 households built one Prisma call
    // at a time is a minute of round trips for no extra proof; the rows are the
    // same rows. `gen_random_uuid()` gives them the same unpredictable uuid
    // ordering real households have, which is the whole reason the old bug
    // skipped an ARBITRARY subset rather than a nameable one.
    const families = await raw<Array<{ id: string }>>(
      `INSERT INTO "families" ("id","name","timezone","updated_at")
       SELECT gen_random_uuid(), $1 || ' #' || i::text, $2::text, now()
         FROM generate_series(1, $3::int) AS i
       RETURNING "id"`,
      cohortName,
      COHORT_TZ,
      COHORT_SIZE,
    );
    cohort = families.map((f) => f.id);

    // The foreign households, in a DIFFERENT timezone so they are not merely
    // other rows but genuinely other tenants on a different calendar. Created
    // here rather than assumed, so this suite proves isolation on an empty
    // database as well as a busy one.
    const foreign = await raw<Array<{ id: string }>>(
      `INSERT INTO "families" ("id","name","timezone","updated_at")
       SELECT gen_random_uuid(), $1 || ' #' || i::text, 'Asia/Riyadh', now()
         FROM generate_series(1, 5) AS i
       RETURNING "id"`,
      `${cohortName}-OUTSIDER`,
    );
    outsiders = foreign.map((f) => f.id);

    await exec(
      `INSERT INTO "children" ("id","family_id","first_name","date_of_birth","updated_at")
       SELECT gen_random_uuid(), f."id", 'Pagination Kid', DATE '2015-04-01', now()
         FROM "families" f WHERE f."id" = ANY($1::uuid[])`,
      cohort,
    );

    // ONE ACTIVE HABIT PER FAMILY. This is what turns «a run row exists» into
    // «the job body actually did this household's work»: the rollover marks it
    // MISSED for the day it closed, so the MISSED row is per-family evidence
    // that is impossible to produce without executing that family's handler.
    await exec(
      `INSERT INTO "habits" ("id","child_id","family_id","title","category","is_active")
       SELECT gen_random_uuid(), c."id", c."family_id", 'Pagination Habit', 'LEARNING', true
         FROM "children" c WHERE c."family_id" = ANY($1::uuid[])`,
      cohort,
    );

    // A PRE-EXISTING NOTIFICATION AND REWARD PER SEEDED FAMILY. Without these,
    // «the re-run created no duplicate notifications» would be 0 === 0 — true
    // of a database with no notifications in it, and therefore worth nothing.
    // With them the assertion is «these 5 rows are still 5 rows», which a sweep
    // that re-executed a household's handler would break the moment the
    // rollover starts emitting either of them.
    seeded = cohort.slice(0, SEEDED_SUBSET);
    const users = await raw<Array<{ id: string }>>(
      `INSERT INTO "users" ("id","email","password_hash","full_name","updated_at")
       VALUES (gen_random_uuid(), $1::text, 'x', 'Pagination Parent', now())
       RETURNING "id"`,
      `pagination.${stamp}@example.test`,
    );
    seedUserId = users[0].id;
    await exec(
      `INSERT INTO "family_members" ("id","family_id","user_id","role","joined_at")
       SELECT gen_random_uuid(), f."id", $2::uuid, 'OWNER', now()
         FROM "families" f WHERE f."id" = ANY($1::uuid[])`,
      seeded,
      seedUserId,
    );
    await exec(
      `INSERT INTO "notifications"
         ("id","family_id","user_id","type","title","body","priority","source_event_id")
       SELECT gen_random_uuid(), f."id", $2::uuid, 'PAGINATION_TEST', 'x', 'y', 'NORMAL',
              'pagination-' || f."id"::text
         FROM "families" f WHERE f."id" = ANY($1::uuid[])`,
      seeded,
      seedUserId,
    );
    await exec(
      `INSERT INTO "rewards_ledger_entries"
         ("id","child_id","family_id","type","reward_type","amount","delta","source","idempotency_key")
       SELECT gen_random_uuid(), c."id", c."family_id", 'EARN', 'XP', 10, 10, 'PAGINATION_TEST',
              'pagination-' || c."id"::text
         FROM "children" c WHERE c."family_id" = ANY($1::uuid[])`,
      seeded,
    );
  }, 300_000);

  afterAll(async () => {
    if (prisma) {
      // Non-cohort side effects first: this sweep also rolled over the families
      // other suites left behind, and those rows are keyed on business dates
      // only this file uses, so removing them removes exactly what this file
      // added and nothing else.
      await exec(
        `DELETE FROM "job_runs" WHERE "job_name" = $1 AND "business_date" = ANY($2::date[])`,
        FAMILY_DAILY_ROLLOVER_JOB,
        ALL_BUSINESS_DATES,
      ).catch(() => undefined);
      await exec(
        `DELETE FROM "habit_completions" WHERE "status" = 'MISSED' AND "date" = ANY($1::date[])`,
        ALL_BUSINESS_DATES,
      ).catch(() => undefined);
      // The cohort itself cascades: children, habits, completions, notifications,
      // reward entries, memberships, job_runs.
      await exec(`DELETE FROM "families" WHERE "id" = ANY($1::uuid[])`, cohort).catch(() => undefined);
      // The outsiders leave with the cohort. They exist to make one assertion
      // deterministic, not to become the next suite's inherited state — which
      // is the very habit that made this test order-dependent.
      if (outsiders.length > 0) {
        await exec(`DELETE FROM "job_runs" WHERE "family_id" = ANY($1::uuid[])`, outsiders).catch(() => undefined);
        await exec(`DELETE FROM "families" WHERE "id" = ANY($1::uuid[])`, outsiders).catch(() => undefined);
      }
      if (seedUserId) {
        await exec(`DELETE FROM "users" WHERE "id" = $1::uuid`, seedUserId).catch(() => undefined);
      }
      await resetJob().catch(() => undefined);
    }
    await app?.close();
  }, 300_000);

  // ==========================================================================
  describe('1. ZERO FAMILIES SKIPPED — counted from the database, not from a return value', () => {
    let report: any;

    beforeAll(async () => {
      await resetJob();
      report = await runner.runJob(FAMILY_DAILY_ROLLOVER_JOB, { now: INSTANT_A, trigger: 'MANUAL' });
    }, 300_000);

    it('the cohort is genuinely bigger than one page, and shares the database with other suites', async () => {
      // Without this, everything below could be true of a 3-family database.
      expect(COHORT_SIZE).toBeGreaterThan(SCHEDULER_DEFAULTS.familyBatchSize);
      expect(cohort).toHaveLength(COHORT_SIZE);
      expect(new Set(cohort).size).toBe(COHORT_SIZE);

      // The database holds households this suite does not own. Counted against
      // the outsiders THIS suite created, not against whatever another suite
      // happened to leave behind — see `outsiders` for why that distinction is
      // the difference between passing on a clean database and passing only
      // when something ran first.
      const others = await count(
        `SELECT count(*)::int AS c FROM "families"
          WHERE "deleted_at" IS NULL AND NOT ("id" = ANY($1::uuid[]))`,
        cohort,
      );
      expect(outsiders).toHaveLength(5);
      expect(others).toBeGreaterThanOrEqual(outsiders.length);
    });

    it('the foreign households are swept too — isolation is scoping, not exclusion', async () => {
      // The cohort assertions below are all keyed on cohort ids, which would
      // stay true even if the sweep silently skipped everyone else. It does
      // not: a family this suite does not own still gets its day closed.
      const foreignRuns = await count(
        `SELECT count(*)::int AS c FROM "job_runs"
          WHERE "family_id" = ANY($1::uuid[]) AND "status" = 'SUCCEEDED'`,
        outsiders,
      );
      expect(foreignRuns).toBe(outsiders.length);
    });

    it('EVERY created family has exactly one SUCCEEDED run for the day it closed', async () => {
      expect(report.claimed).toBe(true);

      // Counted from `job_runs`, which is where the truth is. 220 of 220.
      expect(await succeededCohortRuns(BUSINESS_DATE_A)).toBe(COHORT_SIZE);

      // EXACTLY ONCE: one row per family, and none of them re-attempted.
      const rows = await raw<Array<{ family_id: string; attempt: number; status: string }>>(
        `SELECT "family_id", "attempt", "status" FROM "job_runs"
          WHERE "job_name" = $1 AND "family_id" = ANY($2::uuid[]) AND "business_date" = $3::date`,
        FAMILY_DAILY_ROLLOVER_JOB,
        cohort,
        BUSINESS_DATE_A,
      );
      expect(rows).toHaveLength(COHORT_SIZE);
      expect(new Set(rows.map((r) => r.family_id)).size).toBe(COHORT_SIZE);
      expect(rows.every((r) => Number(r.attempt) === 1)).toBe(true);
      expect(rows.every((r) => r.status === 'SUCCEEDED')).toBe(true);

      // NOT ONE MISSING — asked the other way round, from the cohort towards
      // the runs, so a family with no row at all cannot hide in a total.
      const unprocessed = await count(
        `SELECT count(*)::int AS c
           FROM unnest($1::uuid[]) AS f(id)
          WHERE NOT EXISTS (
            SELECT 1 FROM "job_runs" r
             WHERE r."job_name" = $2 AND r."family_id" = f.id
               AND r."business_date" = $3::date AND r."status" = 'SUCCEEDED')`,
        cohort,
        FAMILY_DAILY_ROLLOVER_JOB,
        BUSINESS_DATE_A,
      );
      expect(unprocessed).toBe(0);
    }, 120_000);

    it('THE REGRESSION ITSELF: the families past the old 200-row cut-off were processed', async () => {
      // The households the previous implementation could not reach: those
      // ranked beyond `familyBatchSize` in the very order the enumeration uses.
      // At least COHORT_SIZE - 200 of ours are here by pigeonhole, whatever the
      // uuids did, so this assertion is deterministic rather than lucky.
      const pastCutoff = await raw<Array<{ id: string }>>(
        `WITH ordered AS (
           SELECT "id", row_number() OVER (ORDER BY "id") AS rn
             FROM "families" WHERE "deleted_at" IS NULL)
         SELECT "id" FROM ordered WHERE rn > $1::int AND "id" = ANY($2::uuid[])`,
        SCHEDULER_DEFAULTS.familyBatchSize,
        cohort,
      );
      expect(pastCutoff.length).toBeGreaterThanOrEqual(COHORT_SIZE - SCHEDULER_DEFAULTS.familyBatchSize);

      const processedPastCutoff = await count(
        `SELECT count(*)::int AS c FROM "job_runs"
          WHERE "job_name" = $1 AND "family_id" = ANY($2::uuid[])
            AND "business_date" = $3::date AND "status" = 'SUCCEEDED'`,
        FAMILY_DAILY_ROLLOVER_JOB,
        pastCutoff.map((r) => r.id),
        BUSINESS_DATE_A,
      );
      expect(processedPastCutoff).toBe(pastCutoff.length);
    }, 120_000);

    it('the job BODY ran for every family, not just the run row', async () => {
      // One active habit per family, marked MISSED for the closed day. A sweep
      // that wrote run rows without executing the handlers would leave this at
      // zero; a sweep that reached only page one would leave it short.
      const missed = await count(
        `SELECT count(*)::int AS c FROM "habit_completions"
          WHERE "family_id" = ANY($1::uuid[]) AND "date" = $2::date AND "status" = 'MISSED'`,
        cohort,
        BUSINESS_DATE_A,
      );
      expect(missed).toBe(COHORT_SIZE);
    }, 120_000);

    it('REPORTS WHAT IT DID: pages and families are counted and logged, not implied', () => {
      // The observability requirement. `familiesSeen` under the household count
      // is exactly what a future silent truncation looks like, which is why it
      // is a number on the report rather than a log line only.
      expect(report.pages).toBeGreaterThanOrEqual(2);
      expect(report.familiesSeen).toBeGreaterThanOrEqual(COHORT_SIZE);
      expect(report.familiesSeen).toBeGreaterThan(SCHEDULER_DEFAULTS.familyBatchSize);
      expect(report.truncated).toBe(false);
      expect(report.executed + report.skipped + report.failed).toBe(report.familiesSeen);
    });

    it('BOUNDED MEMORY: no page ever exceeds familyBatchSize rows', async () => {
      const pages: number[] = [];
      let lastId: string | null = null;
      for (;;) {
        const page: Array<{ id: string }> = await raw<Array<{ id: string }>>(
          SQL_LIST_ACTIVE_FAMILIES_PAGE,
          SCHEDULER_DEFAULTS.familyBatchSize,
          lastId,
        );
        if (page.length === 0) break;
        pages.push(page.length);
        if (page.length < SCHEDULER_DEFAULTS.familyBatchSize) break;
        lastId = page[page.length - 1].id;
      }
      expect(pages.length).toBeGreaterThanOrEqual(2);
      expect(Math.max(...pages)).toBeLessThanOrEqual(SCHEDULER_DEFAULTS.familyBatchSize);
    }, 120_000);
  });

  // ==========================================================================
  describe('2. DETERMINISTIC, TOTAL ORDER — the same sequence twice', () => {
    it('paging the production statement twice yields the identical sequence', async () => {
      // Executes the EXACT exported string, at a page size that forces many
      // boundaries, so a cursor that lost or repeated a row at a boundary shows
      // up as an inequality rather than as a difference of opinion.
      const first = await pageAllFamilyIds(37);
      const second = await pageAllFamilyIds(37);
      expect(second).toEqual(first);

      // TOTAL: strictly increasing, hence no duplicates and no ambiguity about
      // where a page boundary falls.
      const sorted = [...first].sort();
      expect(first).toEqual(sorted);
      expect(new Set(first).size).toBe(first.length);

      // And it really did cover the cohort — a stable order over the wrong rows
      // would satisfy everything above.
      const seen = new Set(first);
      expect(cohort.every((id) => seen.has(id))).toBe(true);
    }, 180_000);

    it('a different page size visits the same families in the same order', async () => {
      const small = await pageAllFamilyIds(11);
      const large = await pageAllFamilyIds(SCHEDULER_DEFAULTS.familyBatchSize);
      expect(small).toEqual(large);
    }, 180_000);

    it('the SWEEP visited the cohort in that same id order', async () => {
      // Read back from `job_runs.started_at`: the sequence the runner actually
      // executed in. Ties in the millisecond clock are broken by family id, so
      // this is an assertion about the order the runner chose, not about the
      // resolution of the clock.
      const rows = await raw<Array<{ by_time: string[]; by_id: string[] }>>(
        `SELECT array_agg("family_id"::text ORDER BY "started_at", "family_id") AS by_time,
                array_agg("family_id"::text ORDER BY "family_id")               AS by_id
           FROM "job_runs"
          WHERE "job_name" = $1 AND "family_id" = ANY($2::uuid[]) AND "business_date" = $3::date`,
        FAMILY_DAILY_ROLLOVER_JOB,
        cohort,
        BUSINESS_DATE_A,
      );
      expect(rows[0].by_time).toHaveLength(COHORT_SIZE);
      expect(rows[0].by_time).toEqual(rows[0].by_id);
    }, 120_000);

    it('a SECOND sweep of a new business date covers exactly the same cohort', async () => {
      await resetJob();
      const report = await runner.runJob(FAMILY_DAILY_ROLLOVER_JOB, { now: INSTANT_B, trigger: 'MANUAL' });
      expect(report.claimed).toBe(true);
      expect(report.truncated).toBe(false);

      // Same households, one day later: same total, no family gained or lost.
      expect(await succeededCohortRuns(BUSINESS_DATE_B)).toBe(COHORT_SIZE);
    }, 300_000);
  });

  // ==========================================================================
  describe('3. SAFE RETRY — a re-run double-processes nothing', () => {
    let before: { runs: number; missed: number; notifications: number; rewards: number };

    const snapshot = async (): Promise<typeof before> => ({
      runs: await count(
        `SELECT count(*)::int AS c FROM "job_runs"
          WHERE "job_name" = $1 AND "family_id" = ANY($2::uuid[])`,
        FAMILY_DAILY_ROLLOVER_JOB,
        cohort,
      ),
      missed: await count(
        `SELECT count(*)::int AS c FROM "habit_completions"
          WHERE "family_id" = ANY($1::uuid[]) AND "status" = 'MISSED'`,
        cohort,
      ),
      notifications: await count(
        `SELECT count(*)::int AS c FROM "notifications" WHERE "family_id" = ANY($1::uuid[])`,
        cohort,
      ),
      rewards: await count(
        `SELECT count(*)::int AS c FROM "rewards_ledger_entries" WHERE "family_id" = ANY($1::uuid[])`,
        cohort,
      ),
    });

    beforeAll(async () => {
      before = await snapshot();
      await resetJob();
      // The SAME instant §2 already swept. This is the half-way-death case:
      // the cursor restarts at the beginning and re-enumerates every family it
      // already finished. Nothing may run twice.
      const again = await runner.runJob(FAMILY_DAILY_ROLLOVER_JOB, { now: INSTANT_B, trigger: 'MANUAL' });
      expect(again.claimed).toBe(true);
      // The pagination reached them all AGAIN — and the claim refused them all.
      expect(again.familiesSeen).toBeGreaterThanOrEqual(COHORT_SIZE);
      expect(again.skipped).toBeGreaterThanOrEqual(COHORT_SIZE);
    }, 300_000);

    it('NO DUPLICATE JOB-RUN ROWS — still one per (family, business date)', async () => {
      const after = await snapshot();
      expect(after.runs).toBe(before.runs);

      const duplicated = await count(
        `SELECT count(*)::int AS c FROM (
           SELECT "family_id", "business_date"
             FROM "job_runs"
            WHERE "job_name" = $1 AND "family_id" = ANY($2::uuid[])
            GROUP BY "family_id", "business_date"
           HAVING count(*) > 1) d`,
        FAMILY_DAILY_ROLLOVER_JOB,
        cohort,
      );
      expect(duplicated).toBe(0);

      // The claim REFUSED the re-run rather than taking it over: a second
      // execution would have incremented `attempt`.
      const attempts = await count(
        `SELECT coalesce(max("attempt"), 0)::int AS c FROM "job_runs"
          WHERE "job_name" = $1 AND "family_id" = ANY($2::uuid[])`,
        FAMILY_DAILY_ROLLOVER_JOB,
        cohort,
      );
      expect(attempts).toBe(1);
    }, 120_000);

    it('NO DUPLICATE WORK — the MISSED rows are the same rows, not twice as many', async () => {
      const after = await snapshot();
      expect(after.missed).toBe(before.missed);
      // Two sweeps, two business dates, one habit each: 2 x COHORT_SIZE, and
      // the re-run added none.
      expect(after.missed).toBe(COHORT_SIZE * 2);

      const duplicatedCompletions = await count(
        `SELECT count(*)::int AS c FROM (
           SELECT "habit_id", "date" FROM "habit_completions"
            WHERE "family_id" = ANY($1::uuid[])
            GROUP BY "habit_id", "date" HAVING count(*) > 1) d`,
        cohort,
      );
      expect(duplicatedCompletions).toBe(0);
    }, 120_000);

    it('NO DUPLICATE REWARDS AND NO DUPLICATE NOTIFICATIONS', async () => {
      const after = await snapshot();
      // NOT VACUOUS: these counts are non-zero because `beforeAll` seeded one
      // notification and one reward per seeded family. «Unchanged» is therefore
      // a statement about real rows, not about an empty table.
      expect(before.notifications).toBe(SEEDED_SUBSET);
      expect(before.rewards).toBe(SEEDED_SUBSET);
      expect(after.notifications).toBe(before.notifications);
      expect(after.rewards).toBe(before.rewards);

      const dupNotifications = await count(
        `SELECT count(*)::int AS c FROM (
           SELECT "family_id", "source_event_id", "user_id" FROM "notifications"
            WHERE "family_id" = ANY($1::uuid[])
            GROUP BY "family_id", "source_event_id", "user_id" HAVING count(*) > 1) d`,
        cohort,
      );
      expect(dupNotifications).toBe(0);

      const dupRewards = await count(
        `SELECT count(*)::int AS c FROM (
           SELECT "child_id", "idempotency_key" FROM "rewards_ledger_entries"
            WHERE "family_id" = ANY($1::uuid[])
            GROUP BY "child_id", "idempotency_key" HAVING count(*) > 1) d`,
        cohort,
      );
      expect(dupRewards).toBe(0);
    }, 120_000);

    it('NO TENANT LEAKAGE — every run row carries its own household', async () => {
      // A page that carried one family's context into another's handler would
      // show up as a MISSED row on a habit belonging to a different family from
      // the completion's own `family_id`, or as a NULL-tenant run row.
      const mismatched = await count(
        `SELECT count(*)::int AS c
           FROM "habit_completions" hc
           JOIN "habits" h ON h."id" = hc."habit_id"
          WHERE hc."family_id" = ANY($1::uuid[]) AND h."family_id" <> hc."family_id"`,
        cohort,
      );
      expect(mismatched).toBe(0);

      const untenanted = await count(
        `SELECT count(*)::int AS c FROM "job_runs"
          WHERE "job_name" = $1 AND "business_date" = ANY($2::date[]) AND "family_id" IS NULL`,
        FAMILY_DAILY_ROLLOVER_JOB,
        ALL_BUSINESS_DATES,
      );
      expect(untenanted).toBe(0);
    }, 120_000);
  });

  // ==========================================================================
  describe('4. A BOUNDED RUN THAT STOPS EARLY SAYS SO LOUDLY', () => {
    it('hitting maxFamilyPagesPerRun is a FAILED job with a stated reason, never a quiet success', async () => {
      // The safety valve, exercised by lowering it rather than by inserting
      // 100,000 households. One page is smaller than this cohort, so the sweep
      // provably cannot finish — which is the situation the valve exists for.
      const defaults = SCHEDULER_DEFAULTS as unknown as { maxFamilyPagesPerRun: number };
      const original = defaults.maxFamilyPagesPerRun;
      defaults.maxFamilyPagesPerRun = 1;
      try {
        await resetJob();
        const report = await runner.runJob(FAMILY_DAILY_ROLLOVER_JOB, { now: INSTANT_C, trigger: 'MANUAL' });

        expect(report.claimed).toBe(true);
        expect(report.truncated).toBe(true);
        expect(report.pages).toBe(1);
        expect(report.familiesSeen).toBe(SCHEDULER_DEFAULTS.familyBatchSize);

        // AND IT IS NOT GREEN. The whole defect was a partial fan-out that
        // reported success, so a truncated sweep must be legible as a failure
        // in the registry row an operator reads.
        const row = await jobRow();
        expect(row.last_status).toBe('FAILED');
        expect(String(row.last_error)).toContain('TRUNCATED');
        expect(Number(row.consecutive_failures)).toBe(1);

        // And the families it did NOT reach genuinely have no run row — the
        // truncation is real, not cosmetic.
        const done = await succeededCohortRuns(BUSINESS_DATE_C);
        expect(done).toBeLessThan(COHORT_SIZE);
      } finally {
        defaults.maxFamilyPagesPerRun = original;
        await resetJob();
      }
    }, 300_000);

    it('and the next run, unbounded again, finishes the households that were left', async () => {
      await resetJob();
      const report = await runner.runJob(FAMILY_DAILY_ROLLOVER_JOB, { now: INSTANT_C, trigger: 'MANUAL' });
      expect(report.truncated).toBe(false);
      expect(await succeededCohortRuns(BUSINESS_DATE_C)).toBe(COHORT_SIZE);

      // Still exactly one row per family for that day: the resumed pass
      // re-enumerated the ones the truncated pass had already done and the
      // claim refused every one of them.
      const rows = await count(
        `SELECT count(*)::int AS c FROM "job_runs"
          WHERE "job_name" = $1 AND "family_id" = ANY($2::uuid[]) AND "business_date" = $3::date`,
        FAMILY_DAILY_ROLLOVER_JOB,
        cohort,
        BUSINESS_DATE_C,
      );
      expect(rows).toBe(COHORT_SIZE);
    }, 300_000);
  });
});
