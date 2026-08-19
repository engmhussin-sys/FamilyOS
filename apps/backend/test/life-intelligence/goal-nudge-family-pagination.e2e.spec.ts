/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-var-requires */
/**
 * ============================================================================
 * THE 501st HOUSEHOLD — the goal-nudge fan-out reaches every candidate family.
 * ============================================================================
 *
 * WHAT WAS BROKEN. `GoalNudgeService.sweep` read
 * `SQL_LIST_FAMILIES_WITH_GOAL_CANDIDATES` ONCE, with `MAX_FAMILIES_PER_SWEEP =
 * 500` and no loop. Past the 500th candidate household in uuid order the sweep
 * stopped, with no error, no log and no metric — the same shape as the
 * daily-rollover defect (`LIMIT 200 OFFSET 0`, called once) that this project
 * already found and fixed, and worse in one specific way:
 *
 *   the candidate set is a ±1-DAY WINDOW on `achievement_requests`, and a
 *   household refused for quiet hours REMAINS a candidate for that whole
 *   window. So the tail was not «deferred to the next tick» — the next tick
 *   re-read the same first 500 households and found the same first 500
 *   households. For the length of the window the tail was UNREACHABLE.
 *
 * WHAT THIS SUITE EXECUTES. Real rows in a real PostgreSQL, the PRODUCTION SQL
 * string, and the real `GoalNudgeService`. Nothing is mocked and no assertion
 * about who was swept is read from a return value — «the sweep says it did 7
 * families» is exactly the kind of claim the original defect satisfied. The set
 * of households that were actually swept is read back out of
 * `notification_decisions`, which is the row the engine writes for every
 * household it was given, whatever it then decides.
 *
 *   1  ISOLATION      the fan-out at this suite's instants returns THIS
 *                     cohort and nothing else, so every later assertion is a
 *                     statement about a known set.
 *   2  THE MATRIX     every way a cohort can fall across pages: fewer than one
 *                     page, EXACTLY one page (the full-last-page trap), more
 *                     than one page, and a page size of one.
 *   3  BY IDENTITY    the real sweep, across three pages: the SET of family ids
 *                     that got a decision equals the SET that existed, and each
 *                     appears exactly once. Not a count — a count can be right
 *                     while one household was visited twice and another never.
 *   4  THE CEILING    a bounded pass that stops early SAYS SO: `truncated`, an
 *                     ERROR log, and a thrown `GoalNudgeSweepTruncatedError`
 *                     from `sweep` so the runner writes a FAILED job row. The
 *                     next, unbounded pass finishes the households it left.
 *   5  THE MUTATION   the same walk against a MUTATED statement — `ORDER BY
 *                     family_id DESC`, and the seek predicate weakened to `>=`
 *                     — and both of them break it. A pagination test that
 *                     survives a mutation of the ordering key is not testing
 *                     pagination.
 *
 * DETERMINISTIC DATA, AND HOW THE SHARED DATABASE IS KEPT OUT. This database
 * holds families from a dozen other suites. The fan-out statement selects on
 * `achievement_requests.local_date` within ±1 UTC day of the instant it is
 * given, so this suite uses instants in 2029 that no other suite writes rows
 * near, and §1 ASSERTS that the enumeration returns exactly this cohort. If
 * another suite ever writes a 2029 attempt, §1 goes red and says so rather than
 * letting a later set-equality quietly weaken.
 *
 * THE CLOCK IS FROZEN BY CONSTRUCTION. `now` is a parameter of `sweepPass`, of
 * `sweepFamily` and of every statement below; nothing in this file reads a wall
 * clock, so «which households are candidates» is a function of rows plus one
 * stated instant and cannot change between noon and midnight.
 */
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';

import { AppModule } from '../../src/app.module';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { createTenantExtension } from '../../src/common/tenancy/tenant.extension';
import { runAsSystemAsync } from '../../src/common/tenancy/system-context';
import { GoalNudgeService } from '../../src/modules/life-intelligence/application/services/goal-nudge.service';
import { GoalNudgeSweepTruncatedError } from '../../src/modules/life-intelligence/domain/goal-nudge.types';
import { SQL_LIST_FAMILIES_WITH_GOAL_CANDIDATES_PAGE } from '../../src/modules/life-intelligence/infrastructure/goal-nudge.sql';
import { integrationDatabaseUrl } from '../tenancy/prisma-test-client';

const describeIfDb = integrationDatabaseUrl() ? describe : describe.skip;

/**
 * TWO COHORTS ON TWO DAYS, three calendar days apart so the ±1-day window of
 * one instant cannot see the other's rows. Seven and five, both deliberately
 * NOT round numbers and both prime, so no page size below divides them evenly
 * by accident.
 */
const COHORT_A_SIZE = 7;
const COHORT_B_SIZE = 5;

/** 12:00 UTC — outside the default 21:00-07:00 quiet window, so a refusal here
 * is never the clock. Every cohort family is `UTC`, so the family-local
 * business date IS the date in these constants. */
const INSTANT_A = new Date('2029-03-05T12:00:00.000Z');
const LOCAL_DATE_A = '2029-03-05';
const INSTANT_B = new Date('2029-03-09T12:00:00.000Z');
const LOCAL_DATE_B = '2029-03-09';

/**
 * `max_per_day = 3` with TWO verified attempts is `GOAL_ALMOST_DONE`'s exact
 * condition (`max_per_day - verified_today = 1`), and 3 rather than 2 because
 * `canNameUnits('AYAH', 2)` is FALSE — Arabic has no post-numeral form for the
 * dual, and the producer correctly stays silent rather than say it wrongly. A
 * cohort built on the dual would have produced nothing and proved nothing.
 */
const MAX_PER_DAY = 3;
const VERIFIED_TODAY = 2;

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

/** What one keyset walk did — the ids in the order they were seen, and the
 * arithmetic of the walk that produced them. */
interface Walk {
  readonly ids: string[];
  readonly pages: number;
  /** Pages PLUS the final seek that returned nothing. The only way, from
   * outside, to tell a loop that re-seeks after a full page from one that
   * stops. */
  readonly queries: number;
}

describeIfDb('THE 501st HOUSEHOLD — the goal-nudge fan-out is paged (real PostgreSQL)', () => {
  let app: INestApplication;
  let prisma: any;
  let producer: GoalNudgeService;

  const stamp = Date.now();
  const createdFamilies: string[] = [];
  const createdUsers: string[] = [];
  const cohortA: string[] = [];
  const cohortB: string[] = [];
  let seq = 0;

  const sys = (what: string, fn: () => Promise<any>): Promise<any> =>
    runAsSystemAsync('TEST_FIXTURE', `goal-nudge pagination suite: ${what}`, async () => await fn());

  const raw = <T>(sql: string, ...params: unknown[]): Promise<T> =>
    sys('raw sql', () => prisma.$queryRawUnsafe(sql, ...params)) as Promise<T>;

  // -- the walk --------------------------------------------------------------

  /**
   * THE KEYSET WALK, EXECUTED HERE RATHER THAN OBSERVED THROUGH THE SERVICE.
   *
   * It is deliberately a re-implementation of the four lines
   * `GoalNudgeService.sweepPass` uses, over the PRODUCTION statement, because
   * the properties in §2 are properties of the STATEMENT plus the loop shape:
   * how many queries a page division costs, and whether a full last page is
   * mistaken for the last page. Driving them through the real sweep would cost
   * one full engine round trip per household per page size and would measure
   * the engine instead. §3 then runs the REAL service over the same rows, so
   * nothing here is a claim about the service that the service does not also
   * make itself.
   *
   * `statement` is a parameter for §5 alone: every walk in §1-§4 passes the
   * production string.
   */
  async function walk(
    now: Date,
    pageSize: number,
    statement: string = SQL_LIST_FAMILIES_WITH_GOAL_CANDIDATES_PAGE,
    maxPages = 1_000,
  ): Promise<Walk> {
    const ids: string[] = [];
    let pages = 0;
    let queries = 0;
    let lastId: string | null = null;

    for (;;) {
      const rows: Array<{ family_id: string }> = await raw<Array<{ family_id: string }>>(
        statement,
        now,
        pageSize,
        lastId,
      );
      queries += 1;
      if (rows.length === 0) break;
      pages += 1;
      for (const r of rows) ids.push(r.family_id);
      if (rows.length < pageSize) break;
      lastId = rows[rows.length - 1].family_id;
      // A BOUND ON THE TEST, NOT ON THE PRODUCT. §5's mutated statements do not
      // terminate; a walk that ran forever would hang the suite instead of
      // failing it.
      if (pages >= maxPages) break;
    }

    return { ids, pages, queries };
  }

  /** The households THIS suite created, in the order the walk saw them —
   * everything else in the shared database filtered out. §1 proves the filter
   * removes nothing at these instants. */
  const mine = (ids: string[], cohort: string[]): string[] => {
    const set = new Set(cohort);
    return ids.filter((id) => set.has(id));
  };

  /** The arithmetic a CORRECT walk over `total` rows at `pageSize` must have.
   * A full last page costs one extra, empty query; a short page does not. */
  const expectedShape = (total: number, pageSize: number): { pages: number; queries: number } => {
    if (total === 0) return { pages: 0, queries: 1 };
    const pages = Math.ceil(total / pageSize);
    return { pages, queries: total % pageSize === 0 ? pages + 1 : pages };
  };

  // -- read-back -------------------------------------------------------------

  /** WHO WAS ACTUALLY SWEPT, read out of PostgreSQL. The engine records a
   * `notification_decisions` row for every household it is handed a candidate
   * for — SEND or SUPPRESS — so this is «was this household looked at», not
   * «did this household get a notification». */
  const decidedFamilies = async (cohort: string[]): Promise<Array<{ family_id: string; n: number }>> =>
    raw<Array<{ family_id: string; n: number }>>(
      `SELECT "family_id", COUNT(*)::int AS n
         FROM "notification_decisions"
        WHERE "family_id" = ANY($1::uuid[])
        GROUP BY "family_id"
        ORDER BY "family_id"`,
      cohort,
    );

  // -- fixtures --------------------------------------------------------------

  /**
   * ONE CANDIDATE HOUSEHOLD, written as rows.
   *
   * Deliberately NOT through `RewardProgramService.create` and
   * `AchievementService.start/submit/decide`: this suite is testing an
   * ENUMERATION, and driving twelve households through the whole rewards chain
   * would make the fixture the thing under test. The columns written are
   * exactly the columns those services write — `local_date` is a DATE on the
   * family's own calendar, and every family here is UTC so the two coincide by
   * construction rather than by luck.
   */
  async function createCandidateHousehold(label: string, localDate: string): Promise<string> {
    seq += 1;
    const family = await sys('create family', () =>
      prisma.family.create({
        data: { name: `GN-page ${label} ${stamp}`, timezone: 'UTC' },
        select: { id: true },
      }),
    );
    createdFamilies.push(family.id);

    const user = await sys('create user', () =>
      prisma.user.create({
        data: {
          email: `gnpage.${label}.${seq}.${stamp}@example.test`,
          passwordHash: 'x',
          fullName: 'GN Parent',
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
          firstName: 'محمد',
          dateOfBirth: new Date('2013-06-01T00:00:00.000Z'),
        },
        select: { id: true },
      }),
    );

    const program = await sys('create program', () =>
      prisma.rewardProgram.create({
        data: {
          familyId: family.id,
          childId: child.id,
          category: 'QURAN',
          // `QURAN_MEMORIZE_AYAH` maps to the `AYAH` unit kind, the one activity
          // where a finer noun than «جلسة» is a fact.
          activity: 'QURAN_MEMORIZE_AYAH',
          targetSpec: { surahNumber: 67, fromAyah: 1, toAyah: 1 },
          targetSummaryAr: 'حفظ آية من سورة الملك',
          durationMinutes: 15,
          verificationLevel: 'PARENT_CONFIRMATION',
          rewardSpec: { type: 'POINTS', amount: 10 },
          frequency: 'DAILY',
          maxPerDay: MAX_PER_DAY,
          maxPerWeek: 7,
          minAge: 0,
          // NULL: `GOAL_ALMOST_DONE` requires the program not to have expired,
          // and a NULL expiry is the honest «this goal has no deadline» rather
          // than a date chosen to be far enough away.
          expiresAt: null,
          status: 'ACTIVE',
          createdByUserId: user.id,
        },
        select: { id: true },
      }),
    );

    for (let attempt = 1; attempt <= VERIFIED_TODAY; attempt += 1) {
      await sys('create attempt', () =>
        prisma.achievementRequest.create({
          data: {
            familyId: family.id,
            programId: program.id,
            childId: child.id,
            status: 'VERIFIED',
            localDate: new Date(`${localDate}T00:00:00.000Z`),
            attemptNo: attempt,
            startedAt: new Date(`${localDate}T09:00:00.000Z`),
            submittedAt: new Date(`${localDate}T09:30:00.000Z`),
            decidedAt: new Date(`${localDate}T09:31:00.000Z`),
          },
        }),
      );
    }

    return family.id;
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue(offlinePrismaService())
      .compile();

    app = moduleRef.createNestApplication();
    await app.init();

    prisma = app.get(PrismaService);
    producer = app.get(GoalNudgeService);

    for (let i = 0; i < COHORT_A_SIZE; i += 1) {
      cohortA.push(await createCandidateHousehold(`a${i}`, LOCAL_DATE_A));
    }
    for (let i = 0; i < COHORT_B_SIZE; i += 1) {
      cohortB.push(await createCandidateHousehold(`b${i}`, LOCAL_DATE_B));
    }
  }, 300_000);

  afterAll(async () => {
    if (prisma) {
      for (const id of createdFamilies) {
        await sys('cleanup family', () => prisma.family.deleteMany({ where: { id } })).catch(
          () => undefined,
        );
      }
      for (const id of createdUsers) {
        await sys('cleanup user', () => prisma.user.deleteMany({ where: { id } })).catch(
          () => undefined,
        );
      }
    }
    await app?.close();
  }, 300_000);

  // ==========================================================================
  describe('1. THE COHORT — a known set, at an instant nothing else in this database occupies', () => {
    it('cohort A is what was created, and the enumeration at INSTANT_A returns exactly it', async () => {
      expect(cohortA).toHaveLength(COHORT_A_SIZE);
      expect(new Set(cohortA).size).toBe(COHORT_A_SIZE);

      const seen = await walk(INSTANT_A, 1_000);
      // EXACTLY the cohort — not a superset. If another suite ever writes a
      // 2029 attempt row this goes red HERE, loudly, instead of silently
      // weakening every set-equality below into a statement about a subset.
      expect(new Set(seen.ids)).toEqual(new Set(cohortA));
      // ASCENDING uuid order, which is the property the cursor depends on.
      expect(seen.ids).toEqual([...cohortA].sort());
    }, 300_000);

    it('cohort B is a different set on a different day, invisible from INSTANT_A', async () => {
      const seenB = await walk(INSTANT_B, 1_000);
      expect(new Set(seenB.ids)).toEqual(new Set(cohortB));

      const seenA = await walk(INSTANT_A, 1_000);
      for (const id of cohortB) expect(seenA.ids).not.toContain(id);
    }, 300_000);

    it('the ±1-day window is real: cohort A is still a candidate the day before and after', async () => {
      // Not a decoration. The whole reason a household stays reachable is that
      // this window is wider than one UTC day, and it is also the reason the
      // old ceiling was «unreachable» rather than «late»: a household past the
      // cut-off stayed past the cut-off for every tick of the window.
      const dayBefore = new Date(INSTANT_A.getTime() - 24 * 3_600_000);
      const dayAfter = new Date(INSTANT_A.getTime() + 24 * 3_600_000);
      expect(new Set((await walk(dayBefore, 1_000)).ids)).toEqual(new Set(cohortA));
      expect(new Set((await walk(dayAfter, 1_000)).ids)).toEqual(new Set(cohortA));
    }, 300_000);
  });

  // ==========================================================================
  /**
   * 2. THE PAGE-DIVISION MATRIX.
   *
   * §3 proves the sweep reaches everyone when the cohort spans three pages.
   * That is ONE row of a matrix, and it is the row a naive fix passes. The rows
   * that catch the remaining off-by-ones are the degenerate ones: a cohort
   * smaller than a page (does the loop terminate without paying a second
   * query?), a cohort that is EXACTLY a page (does a FULL page get mistaken for
   * the LAST page — which is precisely the shape of the original defect?), and
   * a page size of one (does the cursor advance every time, or only once?).
   *
   * Every row is asserted by IDENTITY against the same reference sequence. A
   * count can be right while the membership is wrong; one household visited
   * twice and another not at all is exactly the failure a count cannot see.
   */
  describe('2. THE MATRIX — fewer than, exactly, and many times one page', () => {
    let reference: string[] = [];

    beforeAll(async () => {
      reference = mine((await walk(INSTANT_A, 1_000)).ids, cohortA);
    }, 300_000);

    it('the reference walk sees the whole cohort exactly once, in ascending id order', () => {
      expect(reference).toHaveLength(COHORT_A_SIZE);
      expect(new Set(reference).size).toBe(COHORT_A_SIZE);
      expect(reference).toEqual([...cohortA].sort());
    });

    it('FEWER THAN ONE PAGE: a page bigger than the cohort is one page and no second query', async () => {
      const w = await walk(INSTANT_A, COHORT_A_SIZE + 5);
      expect(w.ids.length).toBeLessThan(COHORT_A_SIZE + 5);
      expect(w.pages).toBe(1);
      // The SHORT page IS the end. Paying a second query here would mean the
      // loop cannot tell a short page from a full one — which is the same
      // blindness, pointed the other way, as the bug being fixed.
      expect(w.queries).toBe(1);
      expect(mine(w.ids, cohortA)).toEqual(reference);
    }, 300_000);

    it('EXACTLY ONE PAGE: a full last page is not mistaken for the last page', async () => {
      const w = await walk(INSTANT_A, COHORT_A_SIZE);

      // THE TRAP. Every household fits in one page and that page comes back
      // FULL. A loop that stops on a full page gets the right answer HERE by
      // luck and the wrong answer on every larger cohort — which is the
      // original defect exactly. The only difference visible from outside is
      // that the correct loop issues a SECOND, EMPTY query, so that is what is
      // asserted.
      expect(w.ids).toHaveLength(COHORT_A_SIZE);
      expect(w.pages).toBe(1);
      expect(w.queries).toBe(2);
      expect(mine(w.ids, cohortA)).toEqual(reference);
    }, 300_000);

    it('MORE THAN ONE PAGE: the same households, in the same order, across a boundary', async () => {
      const w = await walk(INSTANT_A, 4);
      expect(w.pages).toBe(2);
      expect(w.queries).toBe(2);
      expect(mine(w.ids, cohortA)).toEqual(reference);
    }, 300_000);

    it('SEVERAL PAGES: a page size of one crosses every boundary there is', async () => {
      // The most hostile division available: EVERY page is full, so the
      // full-page branch is taken once per household instead of once per walk,
      // and the cursor must advance correctly seven times instead of twice. If
      // the seek predicate were `>=` this walk would never terminate; if the
      // cursor were read off the wrong row it would skip every other household.
      // Both are invisible at a page size of 500.
      const w = await walk(INSTANT_A, 1);
      expect(w.pages).toBe(COHORT_A_SIZE);
      expect(w.queries).toBe(COHORT_A_SIZE + 1);
      expect(mine(w.ids, cohortA)).toEqual(reference);
    }, 300_000);

    it('NO HOUSEHOLD TWICE AND NONE MISSING, at every page size, by identity', async () => {
      const wanted = new Set(reference);

      for (const pageSize of [1, 2, 3, 4, 6, 7, 8, 13, 500]) {
        const w = await walk(INSTANT_A, pageSize);

        // (a) internally duplicate-free — no id appeared on two pages
        expect(new Set(w.ids).size).toBe(w.ids.length);
        // (b) the page arithmetic describes the walk that really happened
        expect({ pages: w.pages, queries: w.queries }).toEqual(
          expectedShape(w.ids.length, pageSize),
        );
        // (c) SET EQUALITY on the cohort: nothing skipped, nothing repeated
        const seen = mine(w.ids, cohortA);
        expect(new Set(seen)).toEqual(wanted);
        expect(seen).toEqual(reference);
      }
    }, 300_000);
  });

  // ==========================================================================
  describe('3. THE SWEEP ITSELF — every household reached, proved by identity from the ledger', () => {
    let pass: any;

    it('one pass at a page size of two walks four pages and reaches all seven households', async () => {
      // Seven households at a page size of two is four pages: 2, 2, 2, 1. The
      // last page is SHORT, so the walk ends on it — and the three boundaries
      // before it are three chances to lose a household.
      pass = await producer.sweepPass(INSTANT_A, { pageSize: 2 });

      expect(pass.pages).toBe(4);
      expect(pass.truncated).toBe(false);
      expect(pass.families).toBe(COHORT_A_SIZE);
    }, 300_000);

    it('THE REGRESSION ITSELF: the households past the first page have decisions of their own', async () => {
      // Under the old code — one enumeration, no loop — households 3..7 in uuid
      // order were never handed to the engine and would have NO row here.
      const rows = await decidedFamilies(cohortA);
      const beyondFirstPage = [...cohortA].sort().slice(2);
      const decided = new Set(rows.map((r) => r.family_id));
      for (const id of beyondFirstPage) expect(decided.has(id)).toBe(true);
    }, 300_000);

    it('NO HOUSEHOLD SKIPPED AND NONE SWEPT TWICE — the SET of ids, not a count', async () => {
      const rows = await decidedFamilies(cohortA);

      // (a) THE SET that was decided equals THE SET that existed. This is the
      //     assertion the defect could not have passed, and it is deliberately
      //     set equality rather than `rows.length === 7`: a count of seven is
      //     also what «one household twice and one household never» produces.
      expect(new Set(rows.map((r) => r.family_id))).toEqual(new Set(cohortA));

      // (b) EXACTLY ONE decision each. A household that appeared on two pages —
      //     the failure a `>=` cursor or a missing ORDER BY produces — would be
      //     handed to the engine twice; the second call is refused by
      //     `notification_decisions_cause_uniq` and so would still leave ONE
      //     row, which is why (c) below reads the pass's own arithmetic too.
      for (const row of rows) expect(row.n).toBe(1);

      // (c) THE PASS VISITED SEVEN HOUSEHOLDS, not eight. Together with (a) and
      //     (b): seven ids existed, seven were decided, seven were visited —
      //     so no household was visited twice at the cost of another.
      expect(pass.families).toBe(COHORT_A_SIZE);
      expect(pass.candidates).toBe(COHORT_A_SIZE);
    }, 300_000);

    it('A SECOND PASS ON THE SAME DAY ADDS NOTHING — idempotency is the unique key, not the cursor', async () => {
      // The cursor guarantees the pass REACHES everyone; it guarantees nothing
      // about how often. What makes a re-run safe is
      // `notification_decisions_cause_uniq (family_id, source_event_id,
      // target_audience)`, and this is that sentence executed: every household
      // is enumerated again, every cause is refused, and the table is unchanged.
      const again = await producer.sweepPass(INSTANT_A, { pageSize: 3 });
      expect(again.families).toBe(COHORT_A_SIZE);
      expect(again.produced).toBe(0);
      expect(again.alreadyDecided).toBe(COHORT_A_SIZE);

      const rows = await decidedFamilies(cohortA);
      expect(new Set(rows.map((r) => r.family_id))).toEqual(new Set(cohortA));
      for (const row of rows) expect(row.n).toBe(1);
    }, 300_000);
  });

  // ==========================================================================
  describe('4. THE CEILING — a bounded pass that stops early says so loudly', () => {
    it('hitting maxPages is `truncated`, and the households past the cursor were NOT swept', async () => {
      const pass = await producer.sweepPass(INSTANT_B, { pageSize: 2, maxPages: 1 });

      expect(pass.truncated).toBe(true);
      expect(pass.pages).toBe(1);
      expect(pass.families).toBe(2);

      // AND IT IS VISIBLE IN THE DATABASE, not only in the return value: the
      // three households past the cursor have no decision row. This is what the
      // old defect looked like — the difference is that it is now REPORTED.
      const decided = new Set((await decidedFamilies(cohortB)).map((r) => r.family_id));
      const ordered = [...cohortB].sort();
      expect(decided).toEqual(new Set(ordered.slice(0, 2)));
      for (const id of ordered.slice(2)) expect(decided.has(id)).toBe(false);
    }, 300_000);

    it('`sweep` — the method the scheduler calls — THROWS, so the runner writes a FAILED job row', async () => {
      // `GoalNudgeSweepJob` has no field on `JobOutcome.details` that could
      // carry «this pass was incomplete», and a partial fan-out that reports
      // green is the defect this whole suite exists for. A thrown error is what
      // the runner turns into a FAILED `job_runs` row with the reason on
      // `scheduled_jobs.last_error`.
      //
      // THE CEILING CONSTANTS ARE MOVED, NOT THE METHOD. `sweep` takes no page
      // options on purpose — the scheduler must not be able to ask for a
      // partial sweep — so the only honest way to reach the ceiling in a test
      // is to lower it. Restored in `finally`, so no later test inherits it.
      const realPage = GoalNudgeService.FAMILIES_PER_PAGE;
      const realMax = GoalNudgeService.MAX_PAGES_PER_SWEEP;
      try {
        (GoalNudgeService as any).FAMILIES_PER_PAGE = 2;
        (GoalNudgeService as any).MAX_PAGES_PER_SWEEP = 1;

        await expect(producer.sweep(INSTANT_B)).rejects.toBeInstanceOf(
          GoalNudgeSweepTruncatedError,
        );
        // AND THE MESSAGE IS ACTIONABLE — both halves of the arithmetic, so an
        // operator can tell «raise the ceiling» from «something is generating
        // candidates that never leave the window».
        await expect(producer.sweep(INSTANT_B)).rejects.toThrow(/TRUNCATED after 1 page\(s\) \/ 2 households/);
      } finally {
        (GoalNudgeService as any).FAMILIES_PER_PAGE = realPage;
        (GoalNudgeService as any).MAX_PAGES_PER_SWEEP = realMax;
      }

      // The ceiling did not invent work: the same two households are decided,
      // still once each, and the three past the cursor are still untouched.
      const decided = await decidedFamilies(cohortB);
      expect(decided).toHaveLength(2);
      for (const row of decided) expect(row.n).toBe(1);
    }, 300_000);

    it('the unbounded default is genuinely unbounded — 500 per page, 50 pages, and both are named', () => {
      // The numbers themselves are a product decision, not a test fixture; what
      // matters here is that the page size is a WINDOW and the page count is
      // the only ceiling, so 25,000 candidate households fit in one tick.
      expect(GoalNudgeService.FAMILIES_PER_PAGE).toBe(500);
      expect(GoalNudgeService.MAX_PAGES_PER_SWEEP).toBe(50);
      expect((GoalNudgeService as any).MAX_FAMILIES_PER_SWEEP).toBeUndefined();
    });

    it('THE NEXT PASS, UNBOUNDED, FINISHES THE HOUSEHOLDS THE BOUNDED ONE LEFT', async () => {
      const pass = await producer.sweepPass(INSTANT_B, { pageSize: 2 });

      expect(pass.truncated).toBe(false);
      expect(pass.families).toBe(COHORT_B_SIZE);
      // The two already decided are refused by the ledger's unique key and
      // counted; the three that were never reached are produced or refused on
      // their own merits. Either way they are now IN the table.
      expect(pass.alreadyDecided).toBe(2);

      const rows = await decidedFamilies(cohortB);
      expect(new Set(rows.map((r) => r.family_id))).toEqual(new Set(cohortB));
      for (const row of rows) expect(row.n).toBe(1);
    }, 300_000);
  });

  // ==========================================================================
  /**
   * 5. THE MUTATION TEST.
   *
   * A pagination suite that still passes when the ordering key is mutated is
   * not testing pagination — it is testing that a small table fits in a page.
   * So the same walk is run against two DELIBERATELY BROKEN statements, and
   * each one must break it:
   *
   *   ORDER BY family_id DESC   the cursor predicate is `family_id > $3` and
   *                             therefore seeks FORWARD. Ordering backwards
   *                             makes the last row of each page the SMALLEST
   *                             id, so the next page re-reads the same rows
   *                             forever: duplicates, and a tail never reached.
   *   the seek weakened to `>=` a total order with the wrong strictness. The
   *                             boundary household is returned again on the
   *                             next page and the walk cannot advance.
   *
   * Both are run with a page bound, because a broken walk does not terminate
   * and a hanging suite is not a failing suite.
   */
  describe('5. THE MUTATION — the ordering key is load-bearing, and this proves it', () => {
    const MUTATED_ORDER_DESC = SQL_LIST_FAMILIES_WITH_GOAL_CANDIDATES_PAGE.replace(
      ' ORDER BY family_id\n',
      ' ORDER BY family_id DESC\n',
    );
    const MUTATED_SEEK_INCLUSIVE = SQL_LIST_FAMILIES_WITH_GOAL_CANDIDATES_PAGE.replace(
      'ar."family_id" > $3::uuid',
      'ar."family_id" >= $3::uuid',
    );

    it('the mutations really are mutations — each differs from production in exactly one clause', () => {
      expect(MUTATED_ORDER_DESC).not.toBe(SQL_LIST_FAMILIES_WITH_GOAL_CANDIDATES_PAGE);
      expect(MUTATED_ORDER_DESC).toContain('ORDER BY family_id DESC');
      expect(MUTATED_SEEK_INCLUSIVE).not.toBe(SQL_LIST_FAMILIES_WITH_GOAL_CANDIDATES_PAGE);
      expect(MUTATED_SEEK_INCLUSIVE).toContain('ar."family_id" >= $3::uuid');
      // And production is NOT already mutated.
      expect(SQL_LIST_FAMILIES_WITH_GOAL_CANDIDATES_PAGE).toContain(' ORDER BY family_id\n');
      expect(SQL_LIST_FAMILIES_WITH_GOAL_CANDIDATES_PAGE).toContain('ar."family_id" > $3::uuid');
    });

    it('ORDER BY family_id DESC: the walk repeats households and never reaches the tail', async () => {
      const good = mine((await walk(INSTANT_A, 2)).ids, cohortA);
      const bad = await walk(INSTANT_A, 2, MUTATED_ORDER_DESC, 12);
      const badIds = mine(bad.ids, cohortA);

      // The production walk is clean...
      expect(new Set(good)).toEqual(new Set(cohortA));
      expect(new Set(good).size).toBe(good.length);

      // ...and the mutant is not. Duplicates, and a set that is NOT the cohort:
      // the two assertions §2 and §3 are built on both fail.
      expect(new Set(badIds).size).toBeLessThan(badIds.length);
      expect(new Set(badIds)).not.toEqual(new Set(cohortA));
    }, 300_000);

    it('a `>=` seek: the boundary household is served on two pages and the walk crawls', async () => {
      const PAGE_BOUND = 12;
      const good = await walk(INSTANT_A, 2, SQL_LIST_FAMILIES_WITH_GOAL_CANDIDATES_PAGE, PAGE_BOUND);
      const bad = await walk(INSTANT_A, 2, MUTATED_SEEK_INCLUSIVE, PAGE_BOUND);
      const badIds = mine(bad.ids, cohortA);

      // The correct walk finishes inside the bound: seven households, four
      // pages, every id once.
      expect(good.pages).toBe(4);
      expect(mine(good.ids, cohortA)).toHaveLength(COHORT_A_SIZE);
      expect(new Set(good.ids).size).toBe(good.ids.length);

      // The mutant does not. Every page re-serves the household the cursor
      // stopped on, so the cursor advances by ONE row per page instead of by a
      // page: seven pages instead of four, and thirteen visits (2×6 + a short
      // final page) for seven households. Six of them were handed to the engine
      // TWICE. `notification_decisions_cause_uniq` would absorb the second
      // call, which is exactly why «no household twice» has to be asserted on
      // the walk and not only on the table.
      expect(bad.pages).toBe(COHORT_A_SIZE);
      expect(bad.pages).toBeGreaterThan(good.pages);
      expect(badIds).toHaveLength(2 * (COHORT_A_SIZE - 1) + 1);
      expect(new Set(badIds).size).toBeLessThan(badIds.length);
      expect(badIds.length).toBeGreaterThan(COHORT_A_SIZE);
    }, 300_000);
  });
});
