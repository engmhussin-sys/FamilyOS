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
/** §6's own day, so the mid-sweep mutation cannot read §1–§4's run rows. */
const INSTANT_D = new Date('2026-03-13T05:00:00.000Z');
const BUSINESS_DATE_D = '2026-03-12';
const ALL_BUSINESS_DATES = [BUSINESS_DATE_A, BUSINESS_DATE_B, BUSINESS_DATE_C, BUSINESS_DATE_D];

/**
 * TWO UUIDs AT THE EXTREMES OF PostgreSQL'S `uuid` ORDER, used by §6 to place a
 * mid-sweep INSERT provably BEFORE and provably AFTER the keyset cursor without
 * having to guess where the cursor landed.
 *
 * `gen_random_uuid()` is v4: sixteen random bytes bar the version and variant
 * nibbles, so the chance a real cohort row sorts below the first or above the
 * second is ~2^-120. §6 does not rely on that anyway — it ASSERTS the two
 * relationships against the observed cursor before it draws any conclusion, so
 * an impossible collision fails the test loudly instead of quietly inverting
 * what it proves.
 */
const UUID_BELOW_ANY_CURSOR = '00000000-0000-4000-8000-000000000001';
const UUID_ABOVE_ANY_CURSOR = 'ffffffff-ffff-4fff-bfff-ffffffffffff';

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

  /**
   * The same walk, INSTRUMENTED — and the instrumentation is the point of §5.
   *
   * `pages` counts the non-empty pages the loop consumed; `queries` counts every
   * round trip including the terminating empty one. They differ by exactly one
   * when the row count is a whole multiple of the page size, which is the
   * boundary case a naive paginator gets wrong in the most expensive possible
   * way: it sees a full page, assumes there is more, and either loops forever or
   * — the historically likelier bug — sees a full page, assumes it is the ONLY
   * page, and stops. Counting both numbers is what lets §5 tell those apart
   * instead of inferring them from the ids alone.
   */
  async function pageAllFamilyIdsCounted(
    pageSize: number,
  ): Promise<{ ids: string[]; pages: number; queries: number }> {
    const ids: string[] = [];
    let lastId: string | null = null;
    let pages = 0;
    let queries = 0;
    for (;;) {
      const page: Array<{ id: string }> = await raw<Array<{ id: string }>>(
        SQL_LIST_ACTIVE_FAMILIES_PAGE,
        pageSize,
        lastId,
      );
      queries += 1;
      if (page.length === 0) break;
      pages += 1;
      for (const row of page) ids.push(row.id);
      if (page.length < pageSize) break;
      lastId = page[page.length - 1].id;
    }
    return { ids, pages, queries };
  }

  /**
   * THE COHORT'S OWN SUBSEQUENCE of a walk over the whole table.
   *
   * This database is shared, and another suite may insert or delete a family
   * while §5 is walking it. That makes the GLOBAL id sequence a moving target
   * and a global assertion a flake. The cohort's rows, however, are this
   * suite's own and nothing else touches them — so filtering each walk down to
   * the cohort turns "the same families in the same order at every page size"
   * into a statement that is exactly as strong and completely deterministic.
   */
  const cohortSubsequence = (ids: string[]): string[] => {
    const inCohort = new Set(cohort);
    return ids.filter((id) => inCohort.has(id));
  };

  /**
   * `pages` and `queries` are not free variables — they are a function of how
   * many rows came back and how big the page was. Asserting them against THAT
   * rather than against a number measured earlier is what keeps §5 immune to a
   * concurrent insert: whatever the table did, the loop's arithmetic must still
   * describe the walk it actually performed.
   */
  const expectedWalkShape = (rowCount: number, pageSize: number): { pages: number; queries: number } => {
    if (rowCount === 0) return { pages: 0, queries: 1 };
    const pages = Math.ceil(rowCount / pageSize);
    // A last page that is exactly full cannot be recognised as the end, so the
    // loop pays for one more round trip to learn the table is exhausted.
    return { pages, queries: rowCount % pageSize === 0 ? pages + 1 : pages };
  };

  /**
   * Walks with a page size chosen to equal the number of rows the walk returns,
   * retrying if the shared table changed underneath it. Gives §5 the "EXACTLY
   * one page" row of the matrix as a real observation rather than an assumption.
   */
  async function walkAtExactlyOnePage(): Promise<{
    ids: string[];
    pages: number;
    queries: number;
    pageSize: number;
  }> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const total = (await pageAllFamilyIds(100_000)).length;
      const walk = await pageAllFamilyIdsCounted(total);
      if (walk.ids.length === total) return { ...walk, pageSize: total };
    }
    throw new Error('the families table changed under five consecutive walks; cannot size an exact page');
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

  // ==========================================================================
  /**
   * 5. THE PAGE-DIVISION MATRIX — every way the cohort can fall across pages.
   *
   * §1 proves the sweep reaches everyone when the cohort spans two pages. That
   * is one row of a matrix, and it is the row a naive fix passes. The rows that
   * catch the remaining off-by-ones are the DEGENERATE ones: a table smaller
   * than a page (does the loop terminate without a second query?), a table that
   * is EXACTLY a page (the full-last-page trap — the loop must not mistake a
   * full page for the last page, which is precisely the shape of the original
   * `LIMIT 200` defect), and a table spanning many pages (does the cursor
   * advance correctly every time, or only the first?).
   *
   * WHAT EACH ROW ASSERTS, and why it is identity rather than counting: every
   * page size must yield the IDENTICAL cohort subsequence. A count can be right
   * while the membership is wrong — one family visited twice and another not at
   * all is the exact failure mode a count cannot see, and it is the one that
   * matters. Comparing the sequences elementwise makes "no family processed
   * twice" and "no family skipped" the same assertion, checked four ways.
   */
  describe('5. THE PAGE-DIVISION MATRIX — fewer than, exactly, and many times one page', () => {
    /** The reference every page size is compared against. */
    let reference: string[] = [];

    beforeAll(async () => {
      reference = cohortSubsequence(await pageAllFamilyIds(100_000));
    }, 300_000);

    it('the reference walk sees the whole cohort exactly once, in ascending id order', () => {
      expect(reference).toHaveLength(COHORT_SIZE);
      expect(new Set(reference).size).toBe(COHORT_SIZE);
      expect(reference).toEqual([...cohort].sort());
    });

    it('FEWER THAN ONE PAGE: a page bigger than the table is one page and one extra query is not paid', async () => {
      const total = (await pageAllFamilyIds(100_000)).length;
      const walk = await pageAllFamilyIdsCounted(total + 50);

      // The short page IS the end of the table; recognising that is what saves
      // the round trip, and paying it anyway would mean the loop cannot tell a
      // short page from a full one.
      expect(walk.ids.length).toBeLessThan(total + 50);
      expect(walk.pages).toBe(1);
      expect(walk.queries).toBe(1);
      expect(cohortSubsequence(walk.ids)).toEqual(reference);
    }, 300_000);

    it('EXACTLY ONE PAGE: a full last page is not mistaken for the last page', async () => {
      const walk = await walkAtExactlyOnePage();

      // THE TRAP. Every row fits in one page and that page comes back FULL. A
      // loop that breaks on a full page would stop here with the right answer
      // by luck; a loop that never re-seeks would stop here with the right
      // answer and the WRONG answer on every larger table. The only way to tell
      // the two apart from outside is that the correct loop issues a second,
      // empty query — so that is what is asserted.
      // The page was full to the last row — that is what makes this the exact
      // boundary rather than merely a large page.
      expect(walk.ids).toHaveLength(walk.pageSize);
      expect(walk.pages).toBe(1);
      expect(walk.queries).toBe(2);
      expect(cohortSubsequence(walk.ids)).toEqual(reference);
    }, 300_000);

    it('MORE THAN ONE PAGE: two pages visit the same families in the same order', async () => {
      const total = (await pageAllFamilyIds(100_000)).length;
      const walk = await pageAllFamilyIdsCounted(Math.ceil(total / 2));

      expect(walk.pages).toBeGreaterThanOrEqual(2);
      expect(cohortSubsequence(walk.ids)).toEqual(reference);
    }, 300_000);

    it('SEVERAL PAGES: a page size of one crosses every boundary there is', async () => {
      // The most hostile division available: EVERY page is exactly full, so the
      // full-page branch is taken once per family rather than once per walk, and
      // the cursor has to advance correctly N times instead of twice. If the
      // seek predicate were `>=` instead of `>` this walk would never terminate;
      // if the cursor were taken from the wrong row it would skip every other
      // family. Both are visible here and invisible at a page size of 200.
      const walk = await pageAllFamilyIdsCounted(1);

      expect(walk.pages).toBe(walk.ids.length);
      expect(walk.queries).toBe(walk.ids.length + 1);
      expect(cohortSubsequence(walk.ids)).toEqual(reference);
    }, 300_000);

    it('NO FAMILY TWICE AND NONE MISSING, at every page size, by identity', async () => {
      const wanted = new Set(reference);

      for (const pageSize of [1, 2, 7, 199, 200, 201, 219, 220, 221, 1000]) {
        const walk = await pageAllFamilyIdsCounted(pageSize);

        // (a) the walk is internally duplicate-free — no id appears on two pages
        expect(new Set(walk.ids).size).toBe(walk.ids.length);

        // (b) the page arithmetic describes the walk that actually happened,
        //     whatever else the shared table did meanwhile
        expect({ pages: walk.pages, queries: walk.queries }).toEqual(
          expectedWalkShape(walk.ids.length, pageSize),
        );

        // (c) SET EQUALITY on the cohort: nothing skipped, nothing repeated
        const seen = cohortSubsequence(walk.ids);
        expect(new Set(seen)).toEqual(wanted);
        expect(seen).toEqual(reference);
      }
    }, 300_000);
  });

  // ==========================================================================
  /**
   * 6. A FAMILY INSERTED OR DELETED WHILE THE SWEEP IS RUNNING.
   *
   * Keyset pagination is only correct if its sort key is STABLE and UNIQUE.
   * `SQL_LIST_ACTIVE_FAMILIES_PAGE` orders by `families.id` — a primary key, so
   * unique and never updated — which is the precondition. This section stops
   * asserting that from the schema and executes it: it mutates the table
   * BETWEEN two pages of a real sweep and then asks the database who was
   * processed.
   *
   * WHY THIS IS THE TEST THAT MATTERS. Under `OFFSET`, a row inserted before
   * the window shifts every later page by one and a family falls through the
   * crack unnoticed; a row deleted before the window shifts them the other way
   * and a family is returned twice. Both are silent. Under a keyset the claim
   * is that neither can happen, because the cursor names a POSITION rather than
   * a COUNT — and a claim of that shape is worth exactly as much as the test
   * that tries to break it.
   *
   * WHAT IS AND IS NOT A DEFECT. A family inserted BEFORE the cursor is not
   * enumerated by this pass. That is correct and is not a skip: the sweep is a
   * pass over the households that existed as it walked past them, `job_runs`
   * carries no cursor, and the next tick starts from the beginning and picks it
   * up — which §6 proves rather than assumes. The defect would be a family that
   * existed for the WHOLE sweep and was still missed, or one processed twice.
   */
  describe('6. MID-SWEEP INSERT AND DELETE — the keyset holds its position', () => {
    let cursorAfterFirstPage: string;
    /** Inserted mid-sweep, sorting BEFORE the cursor. */
    let insertedBehind: string;
    /** Inserted mid-sweep, sorting AFTER the cursor. */
    let insertedAhead: string;
    /** A cohort family soft-deleted mid-sweep, sorting AFTER the cursor. */
    let deletedAhead: string;
    /** The cohort minus the family that was deleted while the sweep ran. */
    let survivors: string[] = [];
    let report: any;

    beforeAll(async () => {
      await resetJob();

      // THE HOOK. `JobRunner.executeFamilies` reads each page through
      // `PrismaService.$queryRawUnsafe`, so wrapping that one method lets the
      // mutation land in the real gap between two real pages — no fake
      // paginator, no reimplementation of the loop, and the production
      // statement is still the thing being paged.
      const original = prisma.$queryRawUnsafe.bind(prisma);
      let pageReads = 0;

      prisma.$queryRawUnsafe = async (sql: string, ...params: unknown[]): Promise<any> => {
        const rows = await original(sql, ...params);
        if (sql !== SQL_LIST_ACTIVE_FAMILIES_PAGE || pageReads > 0) return rows;

        pageReads += 1;
        const page = rows as Array<{ id: string }>;
        // The cohort is larger than one page, so the first page must be full
        // and there must be a page after it for the mutation to affect.
        expect(page.length).toBe(SCHEDULER_DEFAULTS.familyBatchSize);
        cursorAfterFirstPage = page[page.length - 1].id;

        // Writes go through $executeRawUnsafe, which is NOT wrapped, so the
        // mutation cannot recurse into this hook.
        await exec(
          `INSERT INTO "families" ("id","name","timezone","updated_at")
           VALUES ($1::uuid, $2, 'UTC', now()), ($3::uuid, $4, 'UTC', now())`,
          UUID_BELOW_ANY_CURSOR,
          `${cohortName}-MIDSWEEP-BEHIND`,
          UUID_ABOVE_ANY_CURSOR,
          `${cohortName}-MIDSWEEP-AHEAD`,
        );
        insertedBehind = UUID_BELOW_ANY_CURSOR;
        insertedAhead = UUID_ABOVE_ANY_CURSOR;

        // And take one household AWAY, from the part of the table the sweep has
        // not reached yet. A soft delete, because that is how this product
        // removes a household and what `deleted_at IS NULL` filters on.
        const ahead = await raw<Array<{ id: string }>>(
          `SELECT "id" FROM "families"
            WHERE "id" = ANY($1::uuid[]) AND "id" > $2::uuid
            ORDER BY "id" DESC LIMIT 1`,
          cohort,
          cursorAfterFirstPage,
        );
        deletedAhead = ahead[0].id;
        await exec(`UPDATE "families" SET "deleted_at" = now() WHERE "id" = $1::uuid`, deletedAhead);

        return rows;
      };

      try {
        report = await runner.runJob(FAMILY_DAILY_ROLLOVER_JOB, { now: INSTANT_D, trigger: 'MANUAL' });
      } finally {
        prisma.$queryRawUnsafe = original;
      }

      survivors = cohort.filter((id) => id !== deletedAhead);
    }, 300_000);

    afterAll(async () => {
      // Undo the soft delete so the cohort cleanup in the outer afterAll still
      // removes every row this file created.
      if (deletedAhead) {
        await exec(
          `UPDATE "families" SET "deleted_at" = NULL WHERE "id" = $1::uuid`,
          deletedAhead,
        ).catch(() => undefined);
      }
      for (const id of [insertedBehind, insertedAhead]) {
        if (!id) continue;
        await exec(`DELETE FROM "job_runs" WHERE "family_id" = $1::uuid`, id).catch(() => undefined);
        await exec(`DELETE FROM "families" WHERE "id" = $1::uuid`, id).catch(() => undefined);
      }
      await resetJob().catch(() => undefined);
    }, 300_000);

    it('the mutation really did land between two pages, at the extremes of the cursor', () => {
      expect(report.claimed).toBe(true);
      expect(report.pages).toBeGreaterThanOrEqual(2);
      expect(cursorAfterFirstPage).toBeTruthy();
      // The whole section's reasoning depends on these two orderings; if a v4
      // uuid ever landed outside them, this fails instead of silently proving
      // the opposite of what it claims.
      expect(insertedBehind < cursorAfterFirstPage).toBe(true);
      expect(insertedAhead > cursorAfterFirstPage).toBe(true);
      expect(deletedAhead > cursorAfterFirstPage).toBe(true);
    });

    it('NO SURVIVOR WAS SKIPPED — every family that existed throughout has a run row', async () => {
      const rows = await raw<Array<{ family_id: string }>>(
        `SELECT "family_id" FROM "job_runs"
          WHERE "job_name" = $1 AND "family_id" = ANY($2::uuid[]) AND "business_date" = $3::date
            AND "status" = 'SUCCEEDED'`,
        FAMILY_DAILY_ROLLOVER_JOB,
        survivors,
        BUSINESS_DATE_D,
      );
      // BY IDENTITY. Not «219 rows» — «these 219 households», so a run row for
      // one family standing in for a missing one cannot pass.
      expect(new Set(rows.map((r) => r.family_id))).toEqual(new Set(survivors));
    }, 300_000);

    it('NO FAMILY WAS PROCESSED TWICE — one run row each, and one habit marked once', async () => {
      const dupes = await raw<Array<{ family_id: string; c: number }>>(
        `SELECT "family_id", count(*)::int AS c FROM "job_runs"
          WHERE "job_name" = $1 AND "family_id" = ANY($2::uuid[]) AND "business_date" = $3::date
          GROUP BY "family_id" HAVING count(*) > 1`,
        FAMILY_DAILY_ROLLOVER_JOB,
        cohort,
        BUSINESS_DATE_D,
      );
      expect(dupes).toEqual([]);

      // And the job BODY ran once, not merely the bookkeeping row: a second
      // execution would have marked the same habit MISSED a second time.
      const missedTwice = await raw<Array<{ habit_id: string }>>(
        `SELECT hc."habit_id" FROM "habit_completions" hc
           JOIN "habits" h ON h."id" = hc."habit_id"
          WHERE h."family_id" = ANY($1::uuid[]) AND hc."date" = $2::date AND hc."status" = 'MISSED'
          GROUP BY hc."habit_id" HAVING count(*) > 1`,
        survivors,
        BUSINESS_DATE_D,
      );
      expect(missedTwice).toEqual([]);
    }, 300_000);

    it('A FAMILY DELETED MID-SWEEP IS NOT ROLLED OVER', async () => {
      const rows = await count(
        `SELECT count(*)::int AS c FROM "job_runs"
          WHERE "job_name" = $1 AND "family_id" = $2::uuid AND "business_date" = $3::date`,
        FAMILY_DAILY_ROLLOVER_JOB,
        deletedAhead,
        BUSINESS_DATE_D,
      );
      // It was live when the sweep started and gone before the page that would
      // have carried it was read. Rolling it over would be doing work for a
      // household that has asked to be gone.
      expect(rows).toBe(0);
    }, 300_000);

    it('A FAMILY INSERTED AHEAD OF THE CURSOR IS PICKED UP BY THE SAME SWEEP', async () => {
      const rows = await count(
        `SELECT count(*)::int AS c FROM "job_runs"
          WHERE "job_name" = $1 AND "family_id" = $2::uuid AND "business_date" = $3::date
            AND "status" = 'SUCCEEDED'`,
        FAMILY_DAILY_ROLLOVER_JOB,
        insertedAhead,
        BUSINESS_DATE_D,
      );
      // Exactly one — reached because the cursor names a position and this row
      // is past it, and reached ONCE because the position does not move when
      // the table grows behind it.
      expect(rows).toBe(1);
    }, 300_000);

    it('A FAMILY INSERTED BEHIND THE CURSOR IS DEFERRED, NEVER LOST', async () => {
      // Not this pass: the sweep had already walked past that position.
      const during = await count(
        `SELECT count(*)::int AS c FROM "job_runs"
          WHERE "job_name" = $1 AND "family_id" = $2::uuid AND "business_date" = $3::date`,
        FAMILY_DAILY_ROLLOVER_JOB,
        insertedBehind,
        BUSINESS_DATE_D,
      );
      expect(during).toBe(0);

      // THE HALF THAT MAKES THE FIRST HALF ACCEPTABLE. «Not this pass» is only
      // benign if the next pass gets it, and the next pass starts its cursor at
      // the beginning — so the household is deferred by one tick rather than
      // dropped until someone notices. This is the assertion that separates a
      // keyset from the OFFSET bug, where the row was gone for good.
      await resetJob();
      const second = await runner.runJob(FAMILY_DAILY_ROLLOVER_JOB, { now: INSTANT_D, trigger: 'MANUAL' });
      expect(second.claimed).toBe(true);

      const after = await count(
        `SELECT count(*)::int AS c FROM "job_runs"
          WHERE "job_name" = $1 AND "family_id" = $2::uuid AND "business_date" = $3::date
            AND "status" = 'SUCCEEDED'`,
        FAMILY_DAILY_ROLLOVER_JOB,
        insertedBehind,
        BUSINESS_DATE_D,
      );
      expect(after).toBe(1);

      // And the re-run did not give anybody a second run row.
      const dupes = await raw<Array<{ family_id: string }>>(
        `SELECT "family_id" FROM "job_runs"
          WHERE "job_name" = $1 AND "family_id" = ANY($2::uuid[]) AND "business_date" = $3::date
          GROUP BY "family_id" HAVING count(*) > 1`,
        FAMILY_DAILY_ROLLOVER_JOB,
        cohort,
        BUSINESS_DATE_D,
      );
      expect(dupes).toEqual([]);
    }, 300_000);
  });
});
