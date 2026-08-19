/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-var-requires */
/**
 * ============================================================================
 * THE BOUNDARY AT THE REAL PAGE SIZE — 499, 500, 501 and 1001 households.
 * ============================================================================
 *
 * WHY THIS FILE EXISTS ALONGSIDE `goal-nudge-family-pagination.e2e.spec.ts`.
 * That suite proves set-completeness and uniqueness of the keyset walk at page
 * sizes {1,2,3,4,6,7,8,13,500} over cohorts of seven and five, and it mutates
 * the ordering key and the seek predicate to prove the assertions bite. What it
 * does NOT touch is the number the product actually runs with:
 * `GoalNudgeService.FAMILIES_PER_PAGE = 500`.
 *
 * THAT DISTINCTION IS THE WHOLE DEFECT. The thing that shipped was
 * `MAX_FAMILIES_PER_SWEEP = 500` fed to ONE un-looped statement, and the
 * daily-rollover defect before it was `LIMIT 200 OFFSET 0` called once. Both are
 * off-by-one failures AT THE DEFAULT PAGE SIZE: a cohort of seven at a page size
 * of two exercises the same four lines of loop, but it cannot distinguish
 * «the walk is correct» from «the walk is correct for cohorts smaller than the
 * production page». A suite whose largest cohort is seven would have been GREEN
 * on the code that lost the 501st household. So the four sizes that matter are
 * exercised here against the real 500, with real rows:
 *
 *   499   ONE SHORT OF A FULL PAGE. One page, and — because a SHORT page is the
 *         end of the enumeration — exactly ONE query. Paying a second query here
 *         would mean the loop cannot tell a short page from a full one, which is
 *         the same blindness as the bug, pointed the other way.
 *   500   EXACTLY A FULL PAGE — THE TRAP. One page, and the walk MUST issue a
 *         SECOND query and get zero rows. A loop that stops because the first
 *         page came back full gets the right ANSWER here (all 500 households are
 *         in the page) and the wrong answer on every larger cohort. The only
 *         thing visible from outside that separates the two is that second,
 *         empty query, so that is what is asserted.
 *   501   ONE OVER. Two pages, and the 501st household in uuid order — the exact
 *         household the original defect dropped — is enumerated once and swept
 *         once. Proved twice over: by identity from the walk, and by a real
 *         `notification_decisions` row written by the real engine for that
 *         household.
 *   1001  THREE PAGES: 500 + 500 + 1. More than one boundary, so a walk that is
 *         correct across the FIRST boundary and wrong across the second — a
 *         cursor read from the wrong row, a page counter compared before it is
 *         incremented — is visible. The 1001st household is the one a two-page
 *         cohort can never catch.
 *
 * EVERY SIZE IS ASSERTED BY IDENTITY, NEVER BY A COUNT. The original defect was
 * invisible to a count: 500 of 501 is a plausible number, and «one household
 * twice and another never» is a count that is exactly right. So each case
 * compares the SET of family ids the walk produced against the SET that exists,
 * elementwise, and separately asserts the sequence is duplicate-free.
 *
 * ------------------------------------------------------------------------
 * THE COST, AND WHERE FIDELITY IS TRADED FOR IT — stated rather than hidden.
 * ------------------------------------------------------------------------
 * 2,501 households is a real cost. Two trades were made, and NEITHER of them is
 * on the statement or the loop under test:
 *
 *   (1) THE FIXTURE IS WRITTEN AS BULK `INSERT ... SELECT generate_series`
 *       RATHER THAN THROUGH `RewardProgramService` / `AchievementService`.
 *       Four statements per cohort instead of five round trips per household.
 *       The COLUMNS written are exactly the columns those services write — the
 *       sibling suite makes the same trade for the same reason and says so — and
 *       the rows are REAL rows that the REAL production statement selects, which
 *       is the only property this file depends on.
 *
 *   (2) MOST HOUSEHOLDS ARE ENUMERABLE BUT CARRY NO CANDIDATE.
 *       `max_per_day = 5` against two VERIFIED attempts is not
 *       `GOAL_ALMOST_DONE` (which needs `max_per_day - verified = 1`), and a NULL
 *       `expires_at` is not `GOAL_DEADLINE_NEAR`. So `sweepFamily` runs its two
 *       real per-family statements and finds nothing, and the engine is not
 *       called. That matters because one engine round trip costs ~230ms
 *       (measured): 2,501 of them would be ten minutes of testing the
 *       notification engine, which has its own suites.
 *
 *       The households WHERE THE BOUNDARY ACTUALLY IS are exempt from that trade.
 *       In each cohort the households at the page edges — the last of a full
 *       page, the first of the next, the last of the last — are given
 *       `max_per_day = 3`, which IS the `GOAL_ALMOST_DONE` condition, so the real
 *       engine really is called for them and writes a real
 *       `notification_decisions` row. `THE LEDGER` tests below read those rows
 *       back: identity evidence from the database, for exactly the households an
 *       off-by-one loses, with no test-side bookkeeping in the middle.
 *
 *   For the households that carry no candidate, «was this household swept?» is
 *   read from a PASS-THROUGH observer on `GoalNudgeService.sweepFamily` — it
 *   records the family id it was handed and then calls the real method, which
 *   really runs. Nothing is faked and nothing is skipped; it is the only way to
 *   learn the IDENTITY of a household whose sweep is correctly a no-op.
 *
 * DETERMINISTIC DATA, AND HOW THE SHARED DATABASE IS KEPT OUT. Same discipline
 * as the sibling suite: instants in 2029 that no other suite writes rows near,
 * four days apart so the ±1-day candidate window of one cohort cannot see
 * another's, and an ISOLATION test per cohort that asserts the enumeration
 * returns EXACTLY that cohort. If a stray row ever lands in one of these
 * windows the isolation test goes red and says so, instead of silently turning
 * «500 households» into «501 households» and inverting the meaning of the trap.
 *
 * THE CLOCK IS FROZEN BY CONSTRUCTION. `now` is a parameter of `sweepPass`, of
 * `sweepFamily` and of every statement below; nothing in this file reads a wall
 * clock, so which households are candidates is a function of rows plus one
 * stated instant.
 */
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';

import { AppModule } from '../../src/app.module';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { createTenantExtension } from '../../src/common/tenancy/tenant.extension';
import { runAsSystemAsync } from '../../src/common/tenancy/system-context';
import { GoalNudgeService } from '../../src/modules/life-intelligence/application/services/goal-nudge.service';
import { SQL_LIST_FAMILIES_WITH_GOAL_CANDIDATES_PAGE } from '../../src/modules/life-intelligence/infrastructure/goal-nudge.sql';
import { integrationDatabaseUrl } from '../tenancy/prisma-test-client';

const describeIfDb = integrationDatabaseUrl() ? describe : describe.skip;

/**
 * THE PRODUCTION PAGE SIZE, READ FROM PRODUCTION. Never a literal 500 in the
 * cohort arithmetic below: if someone changes `FAMILIES_PER_PAGE`, this suite
 * must build cohorts around the NEW boundary rather than keep testing the old
 * one against a page size that no longer exists.
 */
const PAGE = GoalNudgeService.FAMILIES_PER_PAGE;

/** The four cohorts, each on its own day so the ±1-day windows are disjoint. */
const COHORTS = {
  short: { size: PAGE - 1, localDate: '2029-04-03', instant: new Date('2029-04-03T12:00:00.000Z') },
  exact: { size: PAGE, localDate: '2029-04-07', instant: new Date('2029-04-07T12:00:00.000Z') },
  over: { size: PAGE + 1, localDate: '2029-04-11', instant: new Date('2029-04-11T12:00:00.000Z') },
  multi: {
    size: 2 * PAGE + 1,
    localDate: '2029-04-15',
    instant: new Date('2029-04-15T12:00:00.000Z'),
  },
} as const;

/**
 * `max_per_day = 3` with TWO verified attempts is `GOAL_ALMOST_DONE`'s exact
 * condition (`max_per_day - verified_today = 1`), and 3 rather than 2 because
 * `canNameUnits('AYAH', 2)` is FALSE — Arabic has no post-numeral form for the
 * dual and the producer correctly stays silent. `max_per_day = 5` with the same
 * two attempts is three short of the plan and therefore NOT a candidate: same
 * rows, same joins, same enumeration, no engine call. See the header, trade (2).
 */
const VERIFIED_TODAY = 2;
const MAX_PER_DAY_CANDIDATE = 3;
const MAX_PER_DAY_QUIET = 5;

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

/** What one keyset walk did. `queries` is `pages` PLUS the final seek that
 * returned nothing — the only thing visible from outside that tells a loop
 * which re-seeks after a FULL page from one that stops on it. */
interface Walk {
  readonly ids: string[];
  readonly pages: number;
  readonly queries: number;
}

/** One built cohort: the family ids, and the subset given a real candidate. */
interface Cohort {
  /** Every family id, ASCENDING — the order the cursor walks them in. */
  ids: string[];
  /** The page-edge households that carry a real `GOAL_ALMOST_DONE` candidate. */
  candidateIds: string[];
}

describeIfDb('THE DEFAULT PAGE BOUNDARY — 499/500/501/1001 households at FAMILIES_PER_PAGE', () => {
  let app: INestApplication;
  let prisma: any;
  let producer: GoalNudgeService;

  const stamp = Date.now();
  const createdFamilies: string[] = [];
  const createdUsers: string[] = [];
  let ownerUserId = '';

  const cohorts: Record<keyof typeof COHORTS, Cohort> = {
    short: { ids: [], candidateIds: [] },
    exact: { ids: [], candidateIds: [] },
    over: { ids: [], candidateIds: [] },
    multi: { ids: [], candidateIds: [] },
  };

  const sys = (what: string, fn: () => Promise<any>): Promise<any> =>
    runAsSystemAsync('TEST_FIXTURE', `goal-nudge page-boundary suite: ${what}`, async () => fn());

  const raw = <T>(sql: string, ...params: unknown[]): Promise<T> =>
    sys('raw sql', () => prisma.$queryRawUnsafe(sql, ...params)) as Promise<T>;

  const exec = (sql: string, ...params: unknown[]): Promise<number> =>
    sys('raw exec', () => prisma.$executeRawUnsafe(sql, ...params)) as Promise<number>;

  // -- the walk --------------------------------------------------------------

  /**
   * THE KEYSET WALK, over the PRODUCTION statement.
   *
   * Deliberately a re-implementation of the four lines `sweepPass` uses, for the
   * reason the sibling suite states: the page arithmetic — how many queries a
   * division costs, and whether a full last page is mistaken for the last page —
   * is a property of the STATEMENT plus the loop shape, and it is the only
   * property that can be OBSERVED from outside. `THE REAL SWEEP` sections below
   * then drive the same rows through the real `GoalNudgeService`, so nothing
   * here is a claim about the service the service does not also make.
   *
   * `stopOnFullPage` and `statement` exist for the mutation section alone; every
   * walk outside it takes the production statement and the production loop.
   */
  async function walk(
    now: Date,
    pageSize: number,
    options: {
      statement?: string;
      maxPages?: number;
      stopOnFullPage?: boolean;
      alwaysReseek?: boolean;
    } = {},
  ): Promise<Walk> {
    const statement = options.statement ?? SQL_LIST_FAMILIES_WITH_GOAL_CANDIDATES_PAGE;
    const maxPages = options.maxPages ?? 1_000;
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
      // A SHORT PAGE IS THE END. `stopOnFullPage` mutates this into «any page is
      // the end», which is the original defect written as one character;
      // `alwaysReseek` mutates it the other way, into «only an EMPTY page is the
      // end», which is the same blindness pointed backwards.
      if (options.stopOnFullPage) break;
      if (!options.alwaysReseek && rows.length < pageSize) break;
      lastId = rows[rows.length - 1].family_id;
      // A BOUND ON THE TEST, NOT ON THE PRODUCT: a mutated walk need not
      // terminate, and a hanging suite is not a failing suite.
      if (pages >= maxPages) break;
    }

    return { ids, pages, queries };
  }

  /** The arithmetic a CORRECT walk over `total` rows at `pageSize` must have: a
   * full last page costs one extra, empty query; a short page does not. */
  const expectedShape = (total: number, pageSize: number): { pages: number; queries: number } => {
    if (total === 0) return { pages: 0, queries: 1 };
    const pages = Math.ceil(total / pageSize);
    return { pages, queries: total % pageSize === 0 ? pages + 1 : pages };
  };

  // -- the real service ------------------------------------------------------

  /**
   * THE REAL SWEEP, WITH THE IDENTITY OF EVERY HOUSEHOLD IT HANDED OFF.
   *
   * `sweepPass` returns COUNTS, and a count is exactly what the original defect
   * satisfied. So a PASS-THROUGH observer is installed on `sweepFamily`: it
   * records the family id it was given and then invokes the real method, which
   * really runs — the real timezone lookup, the real two per-family statements,
   * and the real engine call for the page-edge households that carry a
   * candidate. Nothing is stubbed, nothing is short-circuited, and the observer
   * is removed in `finally` so no later test inherits it.
   */
  async function sweepWithIdentity(
    now: Date,
    pageSize: number,
  ): Promise<{ pass: any; visited: string[] }> {
    const visited: string[] = [];
    const real = GoalNudgeService.prototype.sweepFamily;
    const observer = jest
      .spyOn(producer, 'sweepFamily')
      .mockImplementation(async (input: any) => {
        visited.push(input.familyId);
        return real.call(producer, input);
      });
    try {
      const pass = await producer.sweepPass(now, { pageSize });
      return { pass, visited };
    } finally {
      observer.mockRestore();
    }
  }

  /** WHO REACHED THE ENGINE, read out of PostgreSQL. The engine records a
   * `notification_decisions` row for every household it is handed a candidate
   * for — SEND or SUPPRESS — so this is «was this household looked at», not
   * «did this household get a notification». */
  const decidedFamilies = async (ids: string[]): Promise<Array<{ family_id: string; n: number }>> =>
    raw<Array<{ family_id: string; n: number }>>(
      `SELECT "family_id", COUNT(*)::int AS n
         FROM "notification_decisions"
        WHERE "family_id" = ANY($1::uuid[])
        GROUP BY "family_id"
        ORDER BY "family_id"`,
      ids,
    );

  // -- fixtures --------------------------------------------------------------

  /**
   * ONE COHORT, IN FOUR STATEMENTS — see the header, trade (1). Each household
   * gets one child, one ACTIVE reward program and two VERIFIED attempts on
   * `localDate`, which is precisely what the fan-out statement joins across:
   * `achievement_requests` → `reward_programs`, ACTIVE, un-archived, within ±1
   * UTC day. Every family is `UTC`, so the family-local business date IS the
   * date in these constants rather than a coincidence.
   */
  async function buildCohort(label: string, size: number, localDate: string): Promise<string[]> {
    const families = await raw<Array<{ id: string }>>(
      `INSERT INTO "families" ("id","name","timezone","created_at","updated_at")
       SELECT gen_random_uuid(), $1 || ' #' || g, 'UTC', now(), now()
         FROM generate_series(1, $2::int) g
       RETURNING "id"`,
      `GN-boundary ${label} ${stamp}`,
      size,
    );
    const ids = families.map((f) => f.id);
    createdFamilies.push(...ids);

    await exec(
      `INSERT INTO "children" ("id","family_id","first_name","date_of_birth","is_active","created_at","updated_at")
       SELECT gen_random_uuid(), f, 'محمد', DATE '2013-06-01', true, now(), now()
         FROM unnest($1::uuid[]) f`,
      ids,
    );

    await exec(
      `INSERT INTO "reward_programs" (
         "id","family_id","child_id","category","activity","target_spec","target_summary_ar",
         "duration_minutes","verification_level","reward_spec","frequency","max_per_day",
         "max_per_week","min_age","status","created_by_user_id","expires_at","created_at","updated_at")
       SELECT gen_random_uuid(), c."family_id", c."id", 'QURAN', 'QURAN_MEMORIZE_AYAH',
              '{"surahNumber":67,"fromAyah":1,"toAyah":1}'::jsonb, 'حفظ آية من سورة الملك',
              15, 'PARENT_CONFIRMATION', '{"type":"POINTS","amount":10}'::jsonb, 'DAILY',
              $2::int, 7, 0, 'ACTIVE', $3::uuid,
              -- NULL: GOAL_ALMOST_DONE requires the program not to have expired,
              -- and a NULL expiry is the honest «no deadline» rather than a date
              -- chosen to be far enough away. It also means the deadline
              -- condition contributes nothing to this cohort.
              NULL, now(), now()
         FROM "children" c
        WHERE c."family_id" = ANY($1::uuid[])`,
      ids,
      MAX_PER_DAY_QUIET,
      ownerUserId,
    );

    await exec(
      `INSERT INTO "achievement_requests" (
         "id","family_id","program_id","child_id","status","local_date","attempt_no",
         "started_at","submitted_at","decided_at","created_at","updated_at")
       SELECT gen_random_uuid(), rp."family_id", rp."id", rp."child_id", 'VERIFIED',
              $2::date, a.n,
              $2::date + time '09:00', $2::date + time '09:30', $2::date + time '09:31',
              now(), now()
         FROM "reward_programs" rp
        CROSS JOIN generate_series(1, $3::int) a(n)
        WHERE rp."family_id" = ANY($1::uuid[])`,
      ids,
      localDate,
      VERIFIED_TODAY,
    );

    return [...ids].sort();
  }

  /**
   * THE HOUSEHOLDS AT THE PAGE EDGES BECOME REAL CANDIDATES, so the real engine
   * really is called for them and leaves a `notification_decisions` row that can
   * be read back by identity. `at` is a list of INDEXES into the ascending id
   * order — which is the order the cursor walks — so «the last household of the
   * full first page» is `PAGE - 1` and «the first household of the second page»
   * is `PAGE`, stated as the arithmetic rather than as a magic number.
   */
  async function makeCandidates(sorted: string[], at: number[]): Promise<string[]> {
    const chosen = at.map((i) => sorted[i]);
    await exec(
      `UPDATE "reward_programs" SET "max_per_day" = $2::int, "updated_at" = now()
        WHERE "family_id" = ANY($1::uuid[])`,
      chosen,
      MAX_PER_DAY_CANDIDATE,
    );
    // The engine composes for a household that has an owner; these are the only
    // households in this suite that reach it, so they are the only ones that
    // need the membership the sibling suite gives every household.
    for (const familyId of chosen) {
      const user = await sys('create owner', () =>
        prisma.user.create({
          data: {
            email: `gnbound.${familyId.slice(0, 8)}.${stamp}@example.test`,
            passwordHash: 'x',
            fullName: 'GN Parent',
          },
          select: { id: true },
        }),
      );
      createdUsers.push(user.id);
      await sys('create membership', () =>
        prisma.familyMember.create({ data: { familyId, userId: user.id, role: 'OWNER' } }),
      );
    }
    return chosen;
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

    const owner = await sys('create program author', () =>
      prisma.user.create({
        data: {
          email: `gnbound.author.${stamp}@example.test`,
          passwordHash: 'x',
          fullName: 'GN Author',
        },
        select: { id: true },
      }),
    );
    ownerUserId = owner.id;
    createdUsers.push(owner.id);

    for (const key of ['short', 'exact', 'over', 'multi'] as const) {
      const spec = COHORTS[key];
      cohorts[key] = { ids: await buildCohort(key, spec.size, spec.localDate), candidateIds: [] };
    }

    // THE PAGE EDGES, per cohort — the households an off-by-one loses.
    cohorts.short.candidateIds = await makeCandidates(cohorts.short.ids, [0, PAGE - 2]);
    cohorts.exact.candidateIds = await makeCandidates(cohorts.exact.ids, [0, PAGE - 1]);
    cohorts.over.candidateIds = await makeCandidates(cohorts.over.ids, [0, PAGE - 1, PAGE]);
    cohorts.multi.candidateIds = await makeCandidates(cohorts.multi.ids, [
      PAGE - 1, // last of page 1
      PAGE, // first of page 2
      2 * PAGE - 1, // last of page 2
      2 * PAGE, // the only household of page 3 — invisible to a 501 cohort
    ]);
  }, 900_000);

  afterAll(async () => {
    if (prisma) {
      // One statement, not 2,501: `ON DELETE CASCADE` removes the children,
      // programs, attempts and decisions with them.
      await exec(`DELETE FROM "families" WHERE "id" = ANY($1::uuid[])`, createdFamilies).catch(
        () => undefined,
      );
      await exec(`DELETE FROM "users" WHERE "id" = ANY($1::uuid[])`, createdUsers).catch(
        () => undefined,
      );
    }
    await app?.close();
  }, 900_000);

  // ==========================================================================
  describe('0. THE COHORTS — four known sets, at four instants nothing else occupies', () => {
    it('the production page size is 500, and the cohorts are built around IT and not a literal', () => {
      expect(PAGE).toBe(500);
      expect(COHORTS.short.size).toBe(499);
      expect(COHORTS.exact.size).toBe(500);
      expect(COHORTS.over.size).toBe(501);
      expect(COHORTS.multi.size).toBe(1001);
    });

    it.each(['short', 'exact', 'over', 'multi'] as const)(
      'cohort %s: the enumeration at its instant returns EXACTLY it, in ascending id order',
      async (key) => {
        const { ids } = cohorts[key];
        const spec = COHORTS[key];
        expect(ids).toHaveLength(spec.size);
        expect(new Set(ids).size).toBe(spec.size);

        // A page far larger than any cohort: one query, the whole set. If a
        // stray 2029-April row from another suite ever lands in this window
        // this goes red HERE — loudly — instead of silently turning the 500
        // cohort into 501 and inverting the meaning of the trap below.
        const seen = await walk(spec.instant, 5_000);
        expect(new Set(seen.ids)).toEqual(new Set(ids));
        expect(seen.ids).toEqual(ids);
      },
      900_000,
    );

    it('the four windows are disjoint: no cohort is visible from another cohort’s instant', async () => {
      const keys = ['short', 'exact', 'over', 'multi'] as const;
      for (const here of keys) {
        const seen = new Set((await walk(COHORTS[here].instant, 5_000)).ids);
        for (const there of keys) {
          if (there === here) continue;
          for (const id of cohorts[there].ids) expect(seen.has(id)).toBe(false);
        }
      }
    }, 900_000);
  });

  // ==========================================================================
  /**
   * 1. THE FOUR BOUNDARY WALKS, at the REAL page size.
   *
   * Each one asserts three things and they are not interchangeable:
   *   (a) THE SHAPE — pages and queries. This is where 499 and 500 differ, and
   *       the difference is the entire trap.
   *   (b) NO DUPLICATES in the sequence the walk produced. A household served on
   *       two pages is swept twice; the ledger's unique key would absorb the
   *       second decision, so the duplicate is invisible in the table and has to
   *       be caught here.
   *   (c) SET EQUALITY with the cohort, elementwise. Not a count.
   */
  describe('1. THE WALK AT FAMILIES_PER_PAGE — 499, 500, 501, 1001', () => {
    it('499 — ONE SHORT OF A FULL PAGE: one page, ONE query, every household once', async () => {
      const w = await walk(COHORTS.short.instant, PAGE);

      expect(w.ids).toHaveLength(PAGE - 1);
      expect(w.pages).toBe(1);
      // ONE query, not two. The page came back SHORT — 499 of a possible 500 —
      // and a short page cannot be followed by another row, so re-seeking would
      // buy a round trip to learn what is already known. This is the assertion
      // that says the loop reads the page's LENGTH and not merely its
      // emptiness; the 500 case immediately below is the same loop reaching the
      // opposite conclusion from one more row.
      expect(w.queries).toBe(1);
      expect(w).toMatchObject(expectedShape(PAGE - 1, PAGE));

      expect(new Set(w.ids).size).toBe(w.ids.length);
      expect(new Set(w.ids)).toEqual(new Set(cohorts.short.ids));
      expect(w.ids).toEqual(cohorts.short.ids);
    }, 900_000);

    it('500 — EXACTLY A FULL PAGE: THE TRAP. One page, and a SECOND query that returns nothing', async () => {
      const w = await walk(COHORTS.exact.instant, PAGE);

      expect(w.ids).toHaveLength(PAGE);
      expect(w.pages).toBe(1);
      // THE ASSERTION THE ORIGINAL DEFECT FAILS. Every household fits in one
      // page and that page comes back FULL. A loop that stops there produces
      // the RIGHT SET here — all 500 ids — and the wrong set on 501. So set
      // equality alone cannot see the bug at this size; the only external
      // difference is the second, empty query, and this is it.
      expect(w.queries).toBe(2);
      expect(w).toMatchObject(expectedShape(PAGE, PAGE));

      expect(new Set(w.ids).size).toBe(w.ids.length);
      expect(new Set(w.ids)).toEqual(new Set(cohorts.exact.ids));
      expect(w.ids).toEqual(cohorts.exact.ids);
    }, 900_000);

    it('501 — ONE OVER: two pages, and the 501st household is enumerated exactly once', async () => {
      const w = await walk(COHORTS.over.instant, PAGE);

      expect(w.pages).toBe(2);
      // The second page holds ONE household and is therefore short: two pages,
      // two queries, no empty third.
      expect(w.queries).toBe(2);
      expect(w).toMatchObject(expectedShape(PAGE + 1, PAGE));

      expect(new Set(w.ids).size).toBe(w.ids.length);
      expect(new Set(w.ids)).toEqual(new Set(cohorts.over.ids));
      expect(w.ids).toEqual(cohorts.over.ids);

      // NAMED, NOT COUNTED. The 501st household in uuid order is the household
      // the shipped code dropped; it is on page two, it is there once, and it is
      // the last id the walk produced.
      const the501st = cohorts.over.ids[PAGE];
      expect(w.ids.filter((id) => id === the501st)).toEqual([the501st]);
      expect(w.ids[w.ids.length - 1]).toBe(the501st);
      expect(w.ids.indexOf(the501st)).toBe(PAGE);
    }, 900_000);

    it('1001 — THREE PAGES: two boundaries crossed, and the 1001st household is reached', async () => {
      const w = await walk(COHORTS.multi.instant, PAGE);

      // 500 + 500 + 1. The third page is what a 501-household cohort can never
      // ask for: a walk that is right across the first boundary and wrong across
      // the second — a cursor taken from the wrong row, a page counter compared
      // before it is incremented — is green on 501 and red here.
      expect(w.pages).toBe(3);
      expect(w.queries).toBe(3);
      expect(w).toMatchObject(expectedShape(2 * PAGE + 1, PAGE));

      expect(new Set(w.ids).size).toBe(w.ids.length);
      expect(new Set(w.ids)).toEqual(new Set(cohorts.multi.ids));
      expect(w.ids).toEqual(cohorts.multi.ids);

      // The households on either side of BOTH boundaries, by name.
      for (const index of [PAGE - 1, PAGE, 2 * PAGE - 1, 2 * PAGE]) {
        const id = cohorts.multi.ids[index];
        expect(w.ids.filter((seen) => seen === id)).toEqual([id]);
        expect(w.ids.indexOf(id)).toBe(index);
      }
    }, 900_000);
  });

  // ==========================================================================
  /**
   * 2. THE REAL SWEEP AT THE REAL PAGE SIZE.
   *
   * §1 is the statement plus a loop written here. This is `GoalNudgeService`
   * itself, with `pageSize` left at nothing but the default it ships with, over
   * the same rows — so the arithmetic proved above is proved of the code that
   * actually runs, and not only of a re-implementation of it.
   */
  describe('2. THE REAL SERVICE — sweepPass at the shipped default, by identity', () => {
    it('501 households: three pages of work become two, every household swept exactly once', async () => {
      const { pass, visited } = await sweepWithIdentity(COHORTS.over.instant, PAGE);

      expect(pass.pages).toBe(2);
      expect(pass.truncated).toBe(false);
      expect(pass.families).toBe(PAGE + 1);

      // (a) SET EQUALITY: the households handed to `sweepFamily` are exactly the
      //     households that exist. Under the shipped defect `visited` would have
      //     held 500 of the 501 and `families` would have said 500 — a plausible
      //     number, which is why it is the SET that is asserted.
      expect(new Set(visited)).toEqual(new Set(cohorts.over.ids));
      // (b) NONE TWICE.
      expect(visited).toHaveLength(PAGE + 1);
      expect(new Set(visited).size).toBe(visited.length);
      // (c) AND IN CURSOR ORDER, across the boundary.
      expect(visited).toEqual(cohorts.over.ids);
      // (d) THE 501st, NAMED.
      expect(visited.filter((id) => id === cohorts.over.ids[PAGE])).toHaveLength(1);
    }, 900_000);

    it('THE LEDGER AGREES: the 501st household has a real decision row of its own', async () => {
      // No test-side bookkeeping in this one. The page-edge households carry a
      // real `GOAL_ALMOST_DONE` candidate, so the real engine was called for
      // them and wrote `notification_decisions` rows. Under the shipped defect
      // the 501st household — first of page two — would have NO row here.
      const rows = await decidedFamilies(cohorts.over.ids);
      const decided = new Set(rows.map((r) => r.family_id));

      expect(decided).toEqual(new Set(cohorts.over.candidateIds));
      expect(decided.has(cohorts.over.ids[PAGE])).toBe(true); // the 501st
      expect(decided.has(cohorts.over.ids[PAGE - 1])).toBe(true); // the 500th
      // EXACTLY ONE each: a household served on two pages would be handed to the
      // engine twice. `notification_decisions_cause_uniq` absorbs the second
      // call, which is why §1 asserts uniqueness on the walk as well.
      for (const row of rows) expect(row.n).toBe(1);
    }, 900_000);

    it('500 households: the full page does not end the sweep — and nothing is swept twice', async () => {
      const { pass, visited } = await sweepWithIdentity(COHORTS.exact.instant, PAGE);

      expect(pass.pages).toBe(1);
      expect(pass.truncated).toBe(false);
      expect(pass.families).toBe(PAGE);
      expect(visited).toEqual(cohorts.exact.ids);
      expect(new Set(visited).size).toBe(visited.length);

      const decided = new Set((await decidedFamilies(cohorts.exact.ids)).map((r) => r.family_id));
      // The 500th household — the LAST row of the full page — really reached the
      // engine. A walk that fell one row short of a full page would lose it.
      expect(decided.has(cohorts.exact.ids[PAGE - 1])).toBe(true);
      expect(decided).toEqual(new Set(cohorts.exact.candidateIds));
    }, 900_000);

    it('499 households: one short page, every household swept, no household twice', async () => {
      const { pass, visited } = await sweepWithIdentity(COHORTS.short.instant, PAGE);

      expect(pass.pages).toBe(1);
      expect(pass.truncated).toBe(false);
      expect(pass.families).toBe(PAGE - 1);
      expect(visited).toEqual(cohorts.short.ids);
      expect(new Set(visited).size).toBe(visited.length);

      const decided = new Set((await decidedFamilies(cohorts.short.ids)).map((r) => r.family_id));
      expect(decided).toEqual(new Set(cohorts.short.candidateIds));
    }, 900_000);

    it('1001 households: three pages, and the household on the THIRD page is swept and decided', async () => {
      const { pass, visited } = await sweepWithIdentity(COHORTS.multi.instant, PAGE);

      expect(pass.pages).toBe(3);
      expect(pass.truncated).toBe(false);
      expect(pass.families).toBe(2 * PAGE + 1);

      expect(new Set(visited)).toEqual(new Set(cohorts.multi.ids));
      expect(visited).toHaveLength(2 * PAGE + 1);
      expect(new Set(visited).size).toBe(visited.length);
      expect(visited).toEqual(cohorts.multi.ids);

      const decided = new Set((await decidedFamilies(cohorts.multi.ids)).map((r) => r.family_id));
      expect(decided).toEqual(new Set(cohorts.multi.candidateIds));
      // The 1001st household is alone on page three: a boundary bug that only
      // shows on the third page has nowhere to hide here.
      expect(decided.has(cohorts.multi.ids[2 * PAGE])).toBe(true);
      expect(visited[visited.length - 1]).toBe(cohorts.multi.ids[2 * PAGE]);
    }, 900_000);

    it('A SECOND PASS ADDS NOTHING — idempotency is the unique key, not the cursor', async () => {
      // Re-run at the same instant and the same default page size: every one of
      // the 501 households is enumerated again, every cause the ledger already
      // holds is refused, and the table is unchanged. The cursor guarantees the
      // pass REACHES everyone; it guarantees nothing about how often, and this
      // is the sentence that says which layer does.
      const { pass, visited } = await sweepWithIdentity(COHORTS.over.instant, PAGE);

      expect(pass.families).toBe(PAGE + 1);
      expect(pass.produced).toBe(0);
      expect(pass.alreadyDecided).toBe(cohorts.over.candidateIds.length);
      expect(new Set(visited)).toEqual(new Set(cohorts.over.ids));

      const rows = await decidedFamilies(cohorts.over.ids);
      expect(new Set(rows.map((r) => r.family_id))).toEqual(new Set(cohorts.over.candidateIds));
      for (const row of rows) expect(row.n).toBe(1);
    }, 900_000);
  });

  // ==========================================================================
  /**
   * 3. THE MUTATIONS — a boundary test that survives an off-by-one is not a
   * boundary test.
   *
   * Three deliberate breakages, each one character wide in spirit, run against
   * the same rows the sections above pass on:
   *
   *   SEEK `>` → `>=`          the boundary household is served again on the
   *                            next page. Duplicates, and a walk that advances
   *                            by ONE row per page instead of by a page.
   *   `LIMIT $2` → `LIMIT $2-1` the page arithmetic off by one. The page comes
   *                            back one row SHORT of full, the loop concludes
   *                            the enumeration is over, and the tail is lost —
   *                            silently, which is what makes it the shape of the
   *                            original defect.
   *   STOP ON A FULL PAGE      the original defect itself, as a loop mutation.
   *                            It is GREEN on 499 and on the id-set of 500, and
   *                            red on the query count of 500 and on everything
   *                            larger — which is precisely why the 500 case
   *                            asserts `queries === 2`.
   *   ALWAYS RE-SEEK           the same blindness pointed backwards: a loop that
   *                            cannot tell a SHORT page from a full one and pays
   *                            a round trip to learn what it already knows. This
   *                            is the mutation the 499 case exists to catch, and
   *                            the only one of the four the 500 case survives.
   *
   * WHICH CASE CATCHES WHICH IS ASSERTED, NOT ASSUMED, INCLUDING THE SURVIVALS.
   * No single cohort catches all four — which is the argument for having four of
   * them, and the reason a suite whose largest cohort is seven was not enough.
   */
  describe('3. THE MUTATION — which off-by-one each new case catches, and which it survives', () => {
    const MUTATED_SEEK_INCLUSIVE = SQL_LIST_FAMILIES_WITH_GOAL_CANDIDATES_PAGE.replace(
      'ar."family_id" > $3::uuid',
      'ar."family_id" >= $3::uuid',
    );
    const MUTATED_LIMIT_SHORT = SQL_LIST_FAMILIES_WITH_GOAL_CANDIDATES_PAGE.replace(
      ' LIMIT $2',
      ' LIMIT ($2::int - 1)',
    );

    it('the mutations really are mutations, and production is not already mutated', () => {
      expect(MUTATED_SEEK_INCLUSIVE).not.toBe(SQL_LIST_FAMILIES_WITH_GOAL_CANDIDATES_PAGE);
      expect(MUTATED_SEEK_INCLUSIVE).toContain('ar."family_id" >= $3::uuid');
      expect(MUTATED_LIMIT_SHORT).not.toBe(SQL_LIST_FAMILIES_WITH_GOAL_CANDIDATES_PAGE);
      expect(MUTATED_LIMIT_SHORT).toContain('LIMIT ($2::int - 1)');
      expect(SQL_LIST_FAMILIES_WITH_GOAL_CANDIDATES_PAGE).toContain('ar."family_id" > $3::uuid');
      expect(SQL_LIST_FAMILIES_WITH_GOAL_CANDIDATES_PAGE).toContain(' LIMIT $2');
    });

    /**
     * SEEK `>` → `>=`, ONE COHORT AT A TIME, and the survivor is named.
     *
     * The mutation can only be reached by a walk that RE-SEEKS, so at 499 —
     * which is one short page and no second query — it changes nothing and the
     * case is GREEN. That is not a hole in the 499 case; it is what the 499 case
     * is for (it proves the loop does not pay a query it does not need), and it
     * is exactly why the cohort at 500 exists next to it. From 500 up, every
     * page boundary re-serves the household the cursor stopped on and the walk
     * produces MORE ids than there are households, which is what §1's
     * duplicate-free assertion catches.
     */
    it('SEEK `>=`: green on 499 by construction, and duplicates at 500, 501 and 1001', async () => {
      const seek = { statement: MUTATED_SEEK_INCLUSIVE, maxPages: 6 };

      // 499 — the mutation is unreachable: the loop never re-seeks. SURVIVES.
      const short = await walk(COHORTS.short.instant, PAGE, seek);
      expect(short.ids).toEqual(cohorts.short.ids);
      expect(new Set(short.ids).size).toBe(short.ids.length);

      // 500 — the cursor stops on the 500th id and an inclusive seek returns it
      // again on the second page. The SET is still complete, which is precisely
      // why uniqueness has to be asserted separately from completeness: «500
      // distinct households» is right while one of them was swept twice.
      const exact = await walk(COHORTS.exact.instant, PAGE, seek);
      expect(exact.ids).toHaveLength(PAGE + 1);
      expect(exact.ids.filter((id) => id === cohorts.exact.ids[PAGE - 1])).toHaveLength(2);
      expect(new Set(exact.ids).size).toBeLessThan(exact.ids.length);
      expect(new Set(exact.ids)).toEqual(new Set(cohorts.exact.ids));

      // 501 — same duplicate, and the second page is 2 rows instead of 1.
      const over = await walk(COHORTS.over.instant, PAGE, seek);
      expect(over.ids).toHaveLength(PAGE + 2);
      expect(over.ids.filter((id) => id === cohorts.over.ids[PAGE - 1])).toHaveLength(2);
      expect(new Set(over.ids).size).toBeLessThan(over.ids.length);

      // 1001 — TWO boundaries, so TWO households are served twice: the walk
      // advances by `pageSize - 1` per page and emits 1003 visits for 1001
      // households. Six of them in the sibling suite's seven-household cohort;
      // two of them here, at the real boundary.
      const multi = await walk(COHORTS.multi.instant, PAGE, seek);
      expect(multi.ids).toHaveLength(2 * PAGE + 3);
      expect(multi.ids.filter((id) => id === cohorts.multi.ids[PAGE - 1])).toHaveLength(2);
      expect(multi.ids.filter((id) => id === cohorts.multi.ids[2 * PAGE - 2])).toHaveLength(2);
      expect(new Set(multi.ids).size).toBe(2 * PAGE + 1);
      expect(new Set(multi.ids).size).toBeLessThan(multi.ids.length);
    }, 900_000);

    /**
     * `LIMIT $2` → `LIMIT $2 - 1`: THE PAGE ARITHMETIC OFF BY ONE, and the
     * survivor is again named and again the 499 case — for the OPPOSITE reason.
     * A page one row shorter than asked for is 499 rows, the loop reads a SHORT
     * page and correctly concludes the enumeration is over, and at a cohort of
     * 499 that conclusion happens to be TRUE. At every size at or above the page
     * size it is false and the tail is dropped in silence — the shape of the
     * original defect. So this mutation is what makes the 500 cohort, not the
     * 499 one, the boundary case.
     */
    it('LIMIT off by one: green on 499, and 500, 501, 1001 all lose their tail', async () => {
      const limit = { statement: MUTATED_LIMIT_SHORT, maxPages: 6 };
      const KEPT = PAGE - 1; // every walk stops after one short page of 499

      // 499 — a cohort that fits inside the mutated page. SURVIVES.
      const short = await walk(COHORTS.short.instant, PAGE, limit);
      expect(short.ids).toEqual(cohorts.short.ids);

      // 500 — the 500th household, the last row of what should be a full page,
      // is gone. This is the case the mutation exists to prove bites.
      const exact = await walk(COHORTS.exact.instant, PAGE, limit);
      expect(exact.ids).toEqual(cohorts.exact.ids.slice(0, KEPT));
      expect(new Set(exact.ids)).not.toEqual(new Set(cohorts.exact.ids));
      expect(exact.ids).not.toContain(cohorts.exact.ids[PAGE - 1]);

      // 501 — two households lost, including the one the defect is named after.
      const over = await walk(COHORTS.over.instant, PAGE, limit);
      expect(over.ids).toEqual(cohorts.over.ids.slice(0, KEPT));
      expect(over.ids).not.toContain(cohorts.over.ids[PAGE]);

      // 1001 — 502 households lost, the whole of pages two and three.
      const multi = await walk(COHORTS.multi.instant, PAGE, limit);
      expect(multi.ids).toEqual(cohorts.multi.ids.slice(0, KEPT));
      expect(multi.ids).not.toContain(cohorts.multi.ids[2 * PAGE]);
    }, 900_000);

    it('STOP ON A FULL PAGE — the original defect: green on 499, red from 500 up', async () => {
      // 499: a short page, so this mutation changes nothing. Stated rather than
      // omitted, because «which cases survive a mutation» is the honest reading
      // of what each case can and cannot catch.
      const short = await walk(COHORTS.short.instant, PAGE, { stopOnFullPage: true });
      expect(short.ids).toEqual(cohorts.short.ids);
      expect(short.queries).toBe(1);

      // 500: the id-set survives — every household really is on the one page —
      // and the QUERY COUNT does not. This is the trap, and this is the single
      // assertion in §1 that catches it.
      const exact = await walk(COHORTS.exact.instant, PAGE, { stopOnFullPage: true });
      expect(new Set(exact.ids)).toEqual(new Set(cohorts.exact.ids));
      expect(exact.queries).toBe(1);
      expect(exact.queries).not.toBe(expectedShape(PAGE, PAGE).queries);

      // 501: the household the defect was named after is GONE.
      const over = await walk(COHORTS.over.instant, PAGE, { stopOnFullPage: true });
      expect(over.ids).toHaveLength(PAGE);
      expect(new Set(over.ids)).not.toEqual(new Set(cohorts.over.ids));
      expect(over.ids).not.toContain(cohorts.over.ids[PAGE]);

      // 1001: 501 households lost, including the whole of page three.
      const multi = await walk(COHORTS.multi.instant, PAGE, { stopOnFullPage: true });
      expect(multi.ids).toHaveLength(PAGE);
      expect(multi.ids).not.toContain(cohorts.multi.ids[2 * PAGE]);
    }, 900_000);

    it('ALWAYS RE-SEEK — the mutation only the 499 case (and 501, and 1001) can see', async () => {
      // THE OTHER DIRECTION, and the reason 499 is in this file at all. A loop
      // that treats only an EMPTY page as the end never loses a household — the
      // SET is right at every size — so nothing about completeness or uniqueness
      // can see it. What it costs is a round trip per short page, which at 300
      // seconds a tick and 25,000 households is not free, and which the query
      // count is the only witness to.
      const reseek = { alwaysReseek: true };

      // 499 — one short page becomes two queries. §1's `queries === 1` is RED.
      const short = await walk(COHORTS.short.instant, PAGE, reseek);
      expect(short.ids).toEqual(cohorts.short.ids);
      expect(short.queries).toBe(2);
      expect(short.queries).not.toBe(expectedShape(PAGE - 1, PAGE).queries);

      // 500 — SURVIVES: the last page is FULL, so a correct loop re-seeks here
      // anyway and the two loops are indistinguishable. Stated rather than
      // omitted: the 500 cohort is the trap for one mutation and blind to this
      // one, which is why the file carries four cohorts and not one.
      const exact = await walk(COHORTS.exact.instant, PAGE, reseek);
      expect(exact.queries).toBe(expectedShape(PAGE, PAGE).queries);
      expect(exact.ids).toEqual(cohorts.exact.ids);

      // 501 and 1001 — the last page is short in both, so both are RED.
      const over = await walk(COHORTS.over.instant, PAGE, reseek);
      expect(over.queries).toBe(3);
      expect(over.queries).not.toBe(expectedShape(PAGE + 1, PAGE).queries);
      expect(over.ids).toEqual(cohorts.over.ids);

      const multi = await walk(COHORTS.multi.instant, PAGE, reseek);
      expect(multi.queries).toBe(4);
      expect(multi.queries).not.toBe(expectedShape(2 * PAGE + 1, PAGE).queries);
      expect(multi.ids).toEqual(cohorts.multi.ids);
    }, 900_000);
  });
});
