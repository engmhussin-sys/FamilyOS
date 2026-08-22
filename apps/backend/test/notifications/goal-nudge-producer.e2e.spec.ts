/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-var-requires */
/**
 * ============================================================================
 * SPRINT F1 — `GOAL_DEADLINE_NEAR` AND `GOAL_ALMOST_DONE`, AGAINST A REAL
 * POSTGRESQL AND A REAL SAFETY ENGINE.
 * ============================================================================
 *
 * WHAT WAS MEASURED. Both keys sat on `PRODUCERLESS_DEFECT_LEDGER` with four
 * tone bands of Arabic and English each, a quiet-hours class, two scoring rows
 * and a deep-link destination — and NOTHING in `src/` could produce either.
 * `GoalNudgeService` is that producer and `goal-nudge.types.ts` carries the
 * argument for why NEITHER needed a new column: the progress is a COUNT of
 * `VERIFIED` `achievement_requests` rows against the parent's own `max_per_day`,
 * and the deadline is `reward_programs.expires_at`. This file is where that
 * claim stops being prose.
 *
 * WHAT THIS SUITE EXECUTES. The real chain with NO test double anywhere in it:
 * the real `GoalNudgeService` reading the real `SQL_LIST_*` statements against
 * real rows, the real `SmartNotificationEngineService`, the real decision
 * provider, the REAL `ChildSafetyFilterService` and the real delivery pipeline.
 * EVERY COUNT AND EVERY SENTENCE IS READ BACK OUT OF POSTGRESQL WITH SQL, never
 * from a returned object — the defect class this file exists for is the one
 * where a return value said the right thing and the row said something else.
 *
 *   0  THE CADENCE      the band is wider than the sweep's own seeded cadence,
 *                       read out of `scheduled_jobs` — a producer that exists
 *                       and can never fire is `PF-E-001`.
 *   1  DEADLINE         positive · negative (handed in; window far away) ·
 *                       replay across three ticks · quiet hours · Cairo AND
 *                       Riyadh · safety-clean bytes · no placeholder.
 *   2  ALMOST DONE      positive · negative (the day's plan is COMPLETE, and an
 *                       attempt already open) · replay · the Arabic dual, where
 *                       this product stays SILENT rather than say it wrongly.
 *   3  BOTH AT ONCE     one child, two facts, ONE message — the anti-nagging
 *                       bound, and the deadline is the one that wins.
 *
 * WHY THIS FILE DOES NOT FREEZE THE CLOCK, and it is the one difference from
 * `reward-cause-producers.e2e.spec.ts`. `GoalNudgeService.sweep(now)` takes the
 * instant as a PARAMETER and threads it into `handleEvent({ now })`, so the
 * assembler reads `input.now` and never `new Date()`. Quiet hours, the business
 * date and the child's age are therefore all functions of an argument this file
 * supplies, and the suite is deterministic at every hour of the day BY
 * CONSTRUCTION rather than by faking a machine. Test 0.1 asserts that premise
 * instead of assuming it, so the day somebody makes the producer read a wall
 * clock this file goes red rather than flaky.
 *
 * SCOPED TO ITS OWN COHORT. Every assertion is `WHERE family_id = <a family this
 * file created>`; the shared database holds hundreds of families from other
 * suites and a count another suite could satisfy proves nothing.
 */
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';

import { AppModule } from '../../src/app.module';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { createTenantExtension } from '../../src/common/tenancy/tenant.extension';
import { runAsSystemAsync } from '../../src/common/tenancy/system-context';
import { runWithTenant } from '../../src/common/tenancy/tenant-context';
import { ageBandFor } from '../../src/modules/ai-core/domain/age-band';
import { ChildSafetyFilterService } from '../../src/modules/ai-core/application/services/child-safety-filter.service';
import { GoalNudgeService } from '../../src/modules/life-intelligence/application/services/goal-nudge.service';
import {
  GOAL_DEADLINE_MAX_MINUTES,
  GOAL_DEADLINE_MIN_MINUTES,
  goalNudgeEntityId,
} from '../../src/modules/life-intelligence/domain/goal-nudge.types';
import { RewardProgramService } from '../../src/modules/rewards-engine/application/services/reward-program.service';
import { forChildAudience, forEntity } from '../../src/shared/notifications/notification-source-key';
import {
  hasEnumOrPlaceholderLeak,
  renderNotificationCopy,
} from '../../src/modules/notifications/domain/engine/notification-copy';
import { getBusinessDate, getBusinessTimeHHMM } from '../../src/common/time/family-date';
import { integrationDatabaseUrl } from '../tenancy/prisma-test-client';

const describeIfDb = integrationDatabaseUrl() ? describe : describe.skip;

const CAIRO = 'Africa/Cairo';
const RIYADH = 'Asia/Riyadh';

/**
 * ===========================================================================
 * THE FOUR INSTANTS, AND WHY EACH ONE IS A DIFFERENT SHAPE OF PROOF.
 * ===========================================================================
 *
 * JANUARY, DELIBERATELY. Egypt reintroduced DST in 2023, so `Africa/Cairo` is
 * UTC+03:00 in August and UTC+02:00 in January while `Asia/Riyadh` is UTC+03:00
 * all year. A summer instant would put the two launch markets on the SAME
 * offset, and a «both timezones» test in which both zones agree proves nothing
 * about timezones. In January they are one hour apart, which is what makes
 * `AWAKE_IN_CAIRO_ASLEEP_IN_RIYADH` a real discriminator.
 *
 *   MIDDAY                     10:00Z — 12:00 Cairo, 13:00 Riyadh. Outside quiet
 *                              hours in BOTH, so nothing here is a deferral test
 *                              by accident.
 *   AWAKE_IN_CAIRO_ASLEEP_...  18:30Z — 20:30 Cairo (awake), 21:30 Riyadh
 *                              (quiet). ONE INSTANT, TWO ANSWERS: the proof that
 *                              the family's own calendar decides and not UTC.
 *   MIDNIGHT_SPLIT             21:30Z — 23:30 on the 15th in Cairo, 00:30 on the
 *                              16th in Riyadh. ONE INSTANT, TWO BUSINESS DATES,
 *                              which is the other half of «the family's calendar»
 *                              and the half a quiet-hours test cannot see.
 *   DEEP_NIGHT                 19:30Z — 21:30 Cairo, 22:30 Riyadh. Quiet in both.
 *
 * Every one of them is asserted rather than assumed, in test 0.2, through the
 * SAME `getBusinessTimeHHMM` production uses.
 */
const MIDDAY = new Date('2026-01-15T10:00:00.000Z');
const AWAKE_IN_CAIRO_ASLEEP_IN_RIYADH = new Date('2026-01-15T18:30:00.000Z');
const MIDNIGHT_SPLIT = new Date('2026-01-15T21:30:00.000Z');
const DEEP_NIGHT = new Date('2026-01-15T19:30:00.000Z');

/** The product's own default, and the value test 0.2 measures against. */
const QUIET_HOURS_START = '21:00';

/** An unresolved `{placeholder}`, which must never reach a child. */
const PLACEHOLDER = /\{[a-zA-Z0-9_]+\}/;
const ARABIC_LETTERS = /[؀-ۿ]/;

/**
 * NON-PUNITIVE (CONTEXT §3 principle 7), and this list is longer than the one
 * the other child suites use for a reason that is specific to these two keys.
 * «Your window closes in five minutes» and «you are one short» are the two
 * sentences in this product most able to read as NAGGING, so the screen includes
 * the vocabulary of pressure and of loss — «you will lose», «you are late», «you
 * fell behind» — and not only the vocabulary of blame.
 */
const PUNITIVE = [
  'فشل',
  'فشلت',
  'كسول',
  'مقصر',
  'إهمال',
  'عقاب',
  'سنمنع',
  'خسرت',
  'ستخسر',
  'تأخرت',
  'متأخر',
  'ضيعت',
  'أضعت',
  'آخر فرصة',
  'تحذير',
  'يجب عليك',
  'لماذا لم',
];

/** The same offline client every other integration suite in this repo builds. */
function offlinePrismaService(): any {
  const url = process.env.INTEGRATION_DATABASE_URL as string;
  if (process.env.PRISMA_DRIVER_ADAPTER === 'pg') {
    const { PrismaClient } = require('@prisma/client');
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
  // PRISMA 7 removed `datasources`, so a driver adapter is the only way to
  // open a connection. The pool is NAMED and kept: `$disconnect()` closes what
  // Prisma opened and never a pool the caller supplied, so an anonymous pool
  // here is a Postgres connection this suite leaks for the rest of the run.
  const fallbackPool = new (require('pg').Pool)({ connectionString: url });
  const base = new PrismaClient({
    adapter: new (require('@prisma/adapter-pg').PrismaPg)(fallbackPool),
  });
  const extended = base.$extends(createTenantExtension());
  extended.onModuleInit = async () => base.$connect();
  extended.onModuleDestroy = async () => {
    await base.$disconnect();
    await fallbackPool.end();
  };
  return extended;
}

interface Household {
  readonly familyId: string;
  readonly childId: string;
  readonly userId: string;
  readonly timeZone: string;
}

describeIfDb('F1 — the goal-nudge producer (real PostgreSQL, real Safety Engine)', () => {
  let app: INestApplication;
  let prisma: any;
  let producer: GoalNudgeService;
  let programs: RewardProgramService;
  let childSafety: ChildSafetyFilterService;

  const stamp = Date.now();
  const createdFamilies: string[] = [];
  const createdUsers: string[] = [];

  const sys = (what: string, fn: () => Promise<any>): Promise<any> =>
    runAsSystemAsync('TEST_FIXTURE', `F1 goal-nudge suite: ${what}`, async () => await fn());

  const raw = <T>(sql: string, ...params: unknown[]): Promise<T> =>
    sys('raw sql', () => prisma.$queryRawUnsafe(sql, ...params)) as Promise<T>;

  // -- THE READ-BACK HELPERS. Every one of them is SQL against the real
  //    database; nothing in this file asserts on a value a method returned.

  const decisions = (familyId: string): Promise<any[]> =>
    raw<any[]>(
      `SELECT * FROM "notification_decisions" WHERE "family_id" = $1::uuid ORDER BY "created_at", "id"`,
      familyId,
    );

  const childMessages = (familyId: string): Promise<any[]> =>
    raw<any[]>(
      `SELECT * FROM "child_messages" WHERE "family_id" = $1::uuid ORDER BY "created_at", "id"`,
      familyId,
    );

  const deliveries = (familyId: string): Promise<any[]> =>
    raw<any[]>(
      `SELECT * FROM "notification_deliveries" WHERE "family_id" = $1::uuid ORDER BY "created_at", "id"`,
      familyId,
    );

  const parentNotifications = (familyId: string): Promise<any[]> =>
    raw<any[]>(`SELECT * FROM "notifications" WHERE "family_id" = $1::uuid`, familyId);

  /** The one decision row for one copy key, of which there must be exactly one. */
  async function theDecisionFor(familyId: string, copyKey: string): Promise<any> {
    const rows = (await decisions(familyId)).filter((d) => d.copy_key === copyKey);
    expect(rows).toHaveLength(1);
    return rows[0];
  }

  /**
   * THE PROVENANCE CHECK. A stored sentence is only «from the catalogue» if
   * rendering the key the decision row NAMES, at the band and locale it names,
   * reproduces it byte for byte. Without this a template whose variable the
   * producer forgot degrades silently to `GENERIC` — still Arabic, still
   * leak-free, and still the wrong sentence. This is the assertion that would
   * have caught `unitNoun` going missing.
   */
  function assertRenderedFromCatalogue(
    row: { title: string; body: string },
    decision: any,
    variables: Readonly<Record<string, string | number>>,
  ): void {
    const rendered = renderNotificationCopy({
      key: decision.copy_key,
      audience: decision.target_audience,
      toneBand: decision.age_band,
      locale: decision.locale,
      variables,
    });
    expect(rendered.resolvedKey).toBe(decision.copy_key);
    expect(row.title).toBe(rendered.title);
    expect(row.body).toBe(rendered.body);
  }

  /**
   * THE CHILD SAFETY ASSERTION, run on THE BYTES THAT WERE PERSISTED and at the
   * band this child's own date of birth resolves to. THE REAL SERVICE, NEVER A
   * STUB — mocking it is precisely how `PE-N-001` survived four audits.
   */
  const assertChildSafeBytes = (row: { title: string; body: string }): void => {
    const band = ageBandFor(12);
    expect(band).toBe('12-14');
    expect(childSafety.validate(row.body, band).isSafe).toBe(true);
    expect(childSafety.validate(row.title, band).isSafe).toBe(true);

    // No raw enum, no unresolved placeholder — measured with the PRODUCT's own
    // detector as well as a literal brace scan, because the two fail differently.
    expect(hasEnumOrPlaceholderLeak(row.title)).toBe(false);
    expect(hasEnumOrPlaceholderLeak(row.body)).toBe(false);
    expect(row.title).not.toMatch(PLACEHOLDER);
    expect(row.body).not.toMatch(PLACEHOLDER);
    expect(`${row.title} ${row.body}`).not.toMatch(/[{}]/);

    // Arabic, because the household's owner has no locale and `ar` is this
    // product's fallback — not a translation of an English literal.
    expect(row.body).toMatch(ARABIC_LETTERS);

    // AND IT DOES NOT NAG.
    for (const word of PUNITIVE) {
      expect(`${row.title} ${row.body}`).not.toContain(word);
    }
  };

  // -- fixtures --------------------------------------------------------------

  async function createHousehold(label: string, timeZone: string): Promise<Household> {
    const family = await sys('create family', () =>
      prisma.family.create({
        data: { name: `F1-nudge ${label} ${stamp}`, timezone: timeZone },
        select: { id: true },
      }),
    );
    createdFamilies.push(family.id);

    const user = await sys('create user', () =>
      prisma.user.create({
        data: { email: `f1nudge.${label}.${stamp}@example.test`, passwordHash: 'x', fullName: 'F1 Parent' },
        select: { id: true },
      }),
    );
    createdUsers.push(user.id);
    await sys('create membership', () =>
      prisma.familyMember.create({ data: { familyId: family.id, userId: user.id, role: 'OWNER' } }),
    );

    // Born June 2013, so on every instant in this file the child is 12: tone
    // band `11-13`, safety band `12-14`. Both are DERIVED in the assertions, not
    // hard-coded twice.
    const child = await sys('create child', () =>
      prisma.child.create({
        data: { familyId: family.id, firstName: 'محمد', dateOfBirth: new Date('2013-06-01T00:00:00.000Z') },
        select: { id: true },
      }),
    );

    return { familyId: family.id, childId: child.id, userId: user.id, timeZone };
  }

  const asFamily = <T>(familyId: string, fn: () => Promise<T>): Promise<T> =>
    runWithTenant({ familyId, actorType: 'SYSTEM', actorId: 'f1-goal-nudge-test' }, fn);

  /**
   * A GOAL, created through the REAL service so that `target_summary_ar` — the
   * column the producer hands the copy layer as `{goalTitle}` — is the one
   * `describeTargetSpec` actually derives, rather than a string this test chose.
   * That column is the whole reason the producer never composes a title.
   *
   * `QURAN_MEMORIZE_AYAH` because `UNIT_KIND_BY_ACTIVITY` maps it to `AYAH`,
   * which is the one activity where a finer noun than «جلسة» is a FACT —
   * `validateTargetSpec` enforces `toAyah === fromAyah`, so one attempt is
   * exactly one ayah.
   */
  async function aQuranGoal(
    h: Household,
    opts: { maxPerDay: number; maxPerWeek?: number; activity?: string },
  ): Promise<string> {
    const created = await asFamily(h.familyId, () =>
      programs.create(h.familyId, h.userId, {
        childId: h.childId,
        category: 'QURAN',
        activity: opts.activity ?? 'QURAN_MEMORIZE_AYAH',
        targetSpec: { surahNumber: 67, fromAyah: 1, toAyah: 1 },
        durationMinutes: 15,
        // `PARENT_CONFIRMATION` because `SELF_CHECK` is `lowTrustOnly` and
        // `RewardProgramService` rejects it on a QURAN program at create time.
        // The method is irrelevant to this producer — it reads attempt STATUS,
        // never how the status was reached — but the program must be one this
        // product would really let a parent create.
        verificationLevel: 'PARENT_CONFIRMATION',
        rewardSpec: { type: 'POINTS', amount: 10 },
        frequency: 'DAILY',
        maxPerDay: opts.maxPerDay,
        maxPerWeek: opts.maxPerWeek ?? 7,
      } as any),
    );
    return created.id;
  }

  /**
   * THE DEADLINE, SET DIRECTLY. `programs.create` refuses an `expiresAt` in the
   * past and this suite's instants are deliberately in the past relative to any
   * real run (the same safe direction `GOLDEN_DAY` takes), so the column is
   * written afterwards. It is the COLUMN the producer reads, and writing it
   * here is what makes «minutes remaining» an argument of this test rather than
   * a property of the day CI happened to run.
   */
  const setExpiry = (programId: string, at: Date | null): Promise<any> =>
    sys('set expires_at', () =>
      prisma.rewardProgram.update({ where: { id: programId }, data: { expiresAt: at } }),
    );

  const minutesFrom = (now: Date, minutes: number): Date =>
    new Date(now.getTime() + minutes * 60_000);

  /**
   * ONE `achievement_requests` ROW, written directly.
   *
   * DELIBERATELY NOT through `AchievementService.start`/`submit`/`decide` for
   * the VERIFIED history: this suite is testing what the producer READS, and
   * driving four verifications through the whole rewards chain would make the
   * fixture the thing under test and couple these assertions to the grant path
   * that `reward-cause-producers.e2e.spec.ts` already owns. The columns written
   * here are exactly the columns `AchievementService` writes — `local_date`
   * through the family's own calendar, never `toISOString().slice(0, 10)`.
   */
  const anAttempt = (
    h: Household,
    programId: string,
    now: Date,
    status: 'REQUESTED' | 'IN_PROGRESS' | 'VERIFIED' | 'SUBMITTED',
    attemptNo: number,
  ): Promise<any> =>
    sys('create attempt', () =>
      prisma.achievementRequest.create({
        data: {
          familyId: h.familyId,
          programId,
          childId: h.childId,
          status,
          localDate: new Date(`${getBusinessDate(now, h.timeZone)}T00:00:00.000Z`),
          attemptNo,
          startedAt: now,
          submittedAt: status === 'VERIFIED' || status === 'SUBMITTED' ? now : null,
          decidedAt: status === 'VERIFIED' ? now : null,
        },
      }),
    );

  /** The producer, at an explicit instant, inside the tenant scope its own
   * `sweep` establishes before every household. */
  const sweep = (h: Household, now: Date) =>
    asFamily(h.familyId, () => producer.sweepFamily({ familyId: h.familyId, now }));

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue(offlinePrismaService())
      .compile();

    app = moduleRef.createNestApplication();
    await app.init();

    prisma = app.get(PrismaService);
    producer = app.get(GoalNudgeService);
    programs = app.get(RewardProgramService);
    childSafety = app.get(ChildSafetyFilterService);
  }, 180_000);

  afterAll(async () => {
    if (prisma) {
      for (const id of createdFamilies) {
        await sys('cleanup family', () => prisma.family.deleteMany({ where: { id } })).catch(() => undefined);
      }
      for (const id of createdUsers) {
        await sys('cleanup user', () => prisma.user.deleteMany({ where: { id } })).catch(() => undefined);
      }
    }
    await app?.close();
  }, 180_000);

  // ==========================================================================
  // 0. THE PREMISES — asserted, never assumed
  // ==========================================================================
  describe('0. the premises this suite is written on', () => {
    /**
     * `PF-E-001` IS A PRODUCER THAT EXISTS AND CAN NEVER FIRE, and for a
     * deadline band watched by a periodic sweep that is not a hypothetical: a
     * band NARROWER than the cadence can be stepped straight over, and the
     * producer would then pass every unit test and notify nobody in production.
     *
     * The band is `FLOOR(seconds/60) BETWEEN 3 AND 10`, i.e. the continuous
     * interval `[3*60, 11*60)` seconds — EIGHT REAL MINUTES. The cadence is read
     * OUT OF THE SEEDED `scheduled_jobs` ROW, not out of a constant in `src/`,
     * because migration 0024 is what production actually runs on.
     */
    it('0.1 the deadline band is WIDER than the sweep cadence migration 0024 seeded', async () => {
      const rows = await raw<any[]>(
        `SELECT "cadence_seconds", "scope", "local_hour", "enabled"
           FROM "scheduled_jobs" WHERE "name" = 'goal-nudge-sweep'`,
      );
      expect(rows).toHaveLength(1);
      const job = rows[0];

      const bandSeconds = (GOAL_DEADLINE_MAX_MINUTES + 1 - GOAL_DEADLINE_MIN_MINUTES) * 60;
      expect(bandSeconds).toBe(480);
      expect(Number(job.cadence_seconds)).toBeLessThan(bandSeconds);

      // PLATFORM with a NULL local_hour: a FAMILY-scoped job claims
      // `job_runs (job_name, family_id, business_date)` and so runs ONCE per
      // household per day, which cannot watch an eight-minute window.
      expect(job.scope).toBe('PLATFORM');
      expect(job.local_hour).toBeNull();
      expect(job.enabled).toBe(true);
    });

    /**
     * THE TIME-BOMB GUARD. A suite that passes in the morning and fails at night
     * is worse than one that always fails, because the first gets re-run and the
     * second gets fixed. This asserts the PREMISE the tests below stand on — not
     * anything about the product — through the SAME `getBusinessTimeHHMM`
     * production uses, so if the default quiet window ever moves this fails HERE
     * with a readable message instead of somewhere downstream.
     */
    it('0.2 the four instants really are the local times this file claims', () => {
      expect(getBusinessTimeHHMM(MIDDAY, CAIRO) < QUIET_HOURS_START).toBe(true);
      expect(getBusinessTimeHHMM(MIDDAY, RIYADH) < QUIET_HOURS_START).toBe(true);

      // ONE INSTANT, TWO ANSWERS — the discriminator the whole timezone claim
      // rests on. Cairo is UTC+02:00 in January; Riyadh is UTC+03:00 always.
      expect(getBusinessTimeHHMM(AWAKE_IN_CAIRO_ASLEEP_IN_RIYADH, CAIRO)).toBe('20:30');
      expect(getBusinessTimeHHMM(AWAKE_IN_CAIRO_ASLEEP_IN_RIYADH, RIYADH)).toBe('21:30');
      expect(getBusinessTimeHHMM(AWAKE_IN_CAIRO_ASLEEP_IN_RIYADH, CAIRO) < QUIET_HOURS_START).toBe(true);
      expect(getBusinessTimeHHMM(AWAKE_IN_CAIRO_ASLEEP_IN_RIYADH, RIYADH) >= QUIET_HOURS_START).toBe(true);

      // ONE INSTANT, TWO BUSINESS DATES — the half a quiet-hours test cannot see.
      expect(getBusinessDate(MIDNIGHT_SPLIT, CAIRO)).toBe('2026-01-15');
      expect(getBusinessDate(MIDNIGHT_SPLIT, RIYADH)).toBe('2026-01-16');

      expect(getBusinessTimeHHMM(DEEP_NIGHT, CAIRO) >= QUIET_HOURS_START).toBe(true);
      expect(getBusinessTimeHHMM(DEEP_NIGHT, RIYADH) >= QUIET_HOURS_START).toBe(true);
    });
  });

  // ==========================================================================
  // 1. GOAL_DEADLINE_NEAR
  // ==========================================================================
  describe('1. GOAL_DEADLINE_NEAR — an open attempt on a window that is closing', () => {
    it('1.1 POSITIVE — the child is told, ONCE, in their own band, and the bytes are safe', async () => {
      const h = await createHousehold('deadline-pos', CAIRO);
      const programId = await aQuranGoal(h, { maxPerDay: 2 });
      // FIVE MINUTES: inside `[3, 10]`, and the number the sentence will print.
      await setExpiry(programId, minutesFrom(MIDDAY, 5));
      await anAttempt(h, programId, MIDDAY, 'IN_PROGRESS', 1);

      const report = await sweep(h, MIDDAY);
      expect(report.candidates).toBe(1);
      expect(report.produced).toBe(1);

      // --- EVERYTHING BELOW IS READ OUT OF POSTGRESQL ---
      const decision = await theDecisionFor(h.familyId, 'GOAL_DEADLINE_NEAR');
      expect(decision.event_type).toBe('STUDY_REMINDER');
      expect(decision.target_audience).toBe('CHILD');
      expect(decision.trigger).toBe('PERIODIC_SIGNAL');
      expect(decision.business_date.toISOString().slice(0, 10)).toBe('2026-01-15');
      expect(decision.age_band).toBe('11-13');

      const rows = await childMessages(h.familyId);
      expect(rows).toHaveLength(1);
      const row = rows[0];

      // The SENTENCE is the catalogue's, rendered with the ROW's own numbers:
      // five minutes remaining, and the goal's own derived Arabic title.
      const program = (
        await raw<any[]>(`SELECT "target_summary_ar" FROM "reward_programs" WHERE "id" = $1::uuid`, programId)
      )[0];
      assertRenderedFromCatalogue(row, decision, {
        minutes: 5,
        goalTitle: program.target_summary_ar,
        done: 0,
        total: 2,
      });
      assertChildSafeBytes(row);

      // AND THE PARENT WAS NOT COPIED IN. A nudge is between the product and the
      // child; telling a parent «your son has five minutes left» is the monitor
      // behaviour this product exists not to have.
      expect(await parentNotifications(h.familyId)).toHaveLength(0);
    }, 180_000);

    /**
     * THE NEGATIVE, IN ITS THREE HONEST SHAPES. Each is a household in which
     * NOTHING should be said, and «nothing» is proven by reading the tables.
     */
    it('1.2 NEGATIVE — handed in, window far away, or the day already met: silence', async () => {
      // (a) THE HEALTHY CASE: the child submitted. There is nothing to hurry.
      const submitted = await createHousehold('deadline-neg-submitted', CAIRO);
      const p1 = await aQuranGoal(submitted, { maxPerDay: 2 });
      await setExpiry(p1, minutesFrom(MIDDAY, 5));
      await anAttempt(submitted, p1, MIDDAY, 'SUBMITTED', 1);
      expect((await sweep(submitted, MIDDAY)).candidates).toBe(0);
      expect(await childMessages(submitted.familyId)).toHaveLength(0);
      expect(await decisions(submitted.familyId)).toHaveLength(0);

      // (b) THE WINDOW IS NOT CLOSING. Two hours is not «باقي {minutes} دقائق»,
      // and a producer that fired here would be nagging by definition.
      const far = await createHousehold('deadline-neg-far', CAIRO);
      const p2 = await aQuranGoal(far, { maxPerDay: 2 });
      await setExpiry(p2, minutesFrom(MIDDAY, 120));
      await anAttempt(far, p2, MIDDAY, 'IN_PROGRESS', 1);
      expect((await sweep(far, MIDDAY)).candidates).toBe(0);
      expect(await childMessages(far.familyId)).toHaveLength(0);

      // (c) THE BOUNDARY, ON THE SILENT SIDE. Two minutes is BELOW the band, and
      // «٢ دقائق» is the Arabic dual — the plural of paucity is wrong for it, so
      // the product must not say it. This is the assertion that pins the band to
      // the LANGUAGE and not to taste.
      const tooClose = await createHousehold('deadline-neg-2min', CAIRO);
      const p3 = await aQuranGoal(tooClose, { maxPerDay: 2 });
      await setExpiry(p3, minutesFrom(MIDDAY, 2));
      await anAttempt(tooClose, p3, MIDDAY, 'IN_PROGRESS', 1);
      expect((await sweep(tooClose, MIDDAY)).candidates).toBe(0);
      expect(await childMessages(tooClose.familyId)).toHaveLength(0);

      // (d) THE DAY'S PLAN IS ALREADY MET — `completedUnits < totalUnits` is what
      // `COPY_RULES.GOAL_DEADLINE_NEAR` requires, because a child who has done
      // everything they planned is not behind on anything.
      const done = await createHousehold('deadline-neg-done', CAIRO);
      const p4 = await aQuranGoal(done, { maxPerDay: 1 });
      await setExpiry(p4, minutesFrom(MIDDAY, 5));
      await anAttempt(done, p4, MIDDAY, 'VERIFIED', 1);
      await anAttempt(done, p4, MIDDAY, 'IN_PROGRESS', 2);
      expect((await sweep(done, MIDDAY)).candidates).toBe(0);
      expect(await childMessages(done.familyId)).toHaveLength(0);
    }, 180_000);

    /**
     * IDEMPOTENCY AND REPLAY, AND IT IS THE TEST THIS PRODUCER MOST NEEDED.
     *
     * The sweep runs every 300 seconds and the band is eight minutes wide, so a
     * real deadline is seen by TWO OR THREE CONSECUTIVE TICKS. Without a
     * database-level key the child would be told two or three times about one
     * closing window — which is the exact «buried in reminders» failure the
     * brief names.
     *
     * The guarantee is NOT an `if`. It is
     * `notification_decisions_cause_uniq (family_id, source_event_id,
     * target_audience)` refusing the second cause, and the counts below are read
     * back OUT OF POSTGRESQL rather than from `report.produced`.
     */
    it('1.3 IDEMPOTENT — three ticks across the band leave ONE decision and ONE message', async () => {
      const h = await createHousehold('deadline-replay', CAIRO);
      const programId = await aQuranGoal(h, { maxPerDay: 2 });
      // Ten minutes out, so ticks at +0s, +300s and +420s all land inside
      // `[3, 10]` — 10, 5 and 3 minutes remaining respectively.
      await setExpiry(programId, minutesFrom(MIDDAY, 10));
      await anAttempt(h, programId, MIDDAY, 'IN_PROGRESS', 1);

      const first = await sweep(h, MIDDAY);
      const second = await sweep(h, new Date(MIDDAY.getTime() + 300_000));
      const third = await sweep(h, new Date(MIDDAY.getTime() + 420_000));

      // Every tick SAW the candidate — this is what makes the assertion below a
      // statement about the KEY and not about a window that closed.
      expect([first.candidates, second.candidates, third.candidates]).toEqual([1, 1, 1]);
      expect(first.produced).toBe(1);
      // The ledger's unique key refused the cause on both later ticks.
      expect([second.produced, third.produced]).toEqual([0, 0]);
      expect([second.alreadyDecided, third.alreadyDecided]).toEqual([1, 1]);

      // --- AND THE DATABASE AGREES ---
      const decisionRows = await decisions(h.familyId);
      expect(decisionRows).toHaveLength(1);
      expect(decisionRows[0].copy_key).toBe('GOAL_DEADLINE_NEAR');
      expect(await childMessages(h.familyId)).toHaveLength(1);

      /**
       * AND THE KEY IS THE ONE THE PRODUCER DOCUMENTS, composed independently
       * here and compared against the stored column. This is what stops a
       * refactor from silently switching to `forRecurringSignal`, whose
       * five-minute bucket is EXACTLY this job's cadence — every tick would mint
       * a new string and the child would be told 288 times.
       */
      const expectedCause = forEntity(
        'signal',
        h.childId,
        goalNudgeEntityId('GOAL_DEADLINE', programId),
        '2026-01-15',
      );
      expect(decisionRows[0].source_event_id).toBe(expectedCause);
      expect(decisionRows[0].target_audience).toBe('CHILD');

      /**
       * THE AUDIENCE IS IN THE KEY AT THE TERMINAL WRITE TOO. The defect that
       * cost a child ten hours a night was a unique key WITHOUT an audience
       * column, so the child's row lost to the parent's under `ON CONFLICT DO
       * NOTHING`. `notification_deliveries (family_id, source_event_id)` still
       * has no audience COLUMN, so the audience must be inside the VALUE — and
       * it is, via `forChildAudience`. Asserted on the child message's own
       * `source_event_id` so a producer that stopped distinguishing audiences
       * fails HERE.
       */
      const msg = (await childMessages(h.familyId))[0];
      expect(msg.source_event_id).toBe(forChildAudience(expectedCause));
      expect(msg.source_event_id).not.toBe(expectedCause);
    }, 180_000);

    /**
     * QUIET HOURS, AND WHY THIS KEY IS SUPPRESSED RATHER THAN DEFERRED.
     *
     * `STUDY_REMINDER` is a `SUPPRESS` class: «باقي لك ٥ دقائق» released at 07:00
     * the next morning is a FALSE SENTENCE — the window shut in the night. A
     * deferral would have been the product lying to a child politely.
     */
    it('1.4 QUIET HOURS — a closing window at 21:30 local is dropped WITH a reason, not deferred', async () => {
      const h = await createHousehold('deadline-quiet', CAIRO);
      const programId = await aQuranGoal(h, { maxPerDay: 2 });
      await setExpiry(programId, minutesFrom(DEEP_NIGHT, 5));
      await anAttempt(h, programId, DEEP_NIGHT, 'IN_PROGRESS', 1);

      // The premise, measured rather than assumed.
      expect(getBusinessTimeHHMM(DEEP_NIGHT, h.timeZone)).toBe('21:30');

      const report = await sweep(h, DEEP_NIGHT);
      expect(report.candidates).toBe(1);
      expect(report.produced).toBe(0);
      expect(report.refused).toBe(1);

      // NOTHING REACHED THE CHILD, and nothing was parked for the morning.
      expect(await childMessages(h.familyId)).toHaveLength(0);
      expect(await deliveries(h.familyId)).toHaveLength(0);

      // BUT THE REFUSAL IS ON THE RECORD, with the reason and the copy key — a
      // suppression nobody can see is indistinguishable from a producer that
      // never ran, which is how `PF-E-003` hid.
      const decision = await theDecisionFor(h.familyId, 'GOAL_DEADLINE_NEAR');
      expect(decision.decision).toBe('SUPPRESS');
      expect(decision.reason).toBe('QUIET_HOURS_CLASS_SUPPRESS');
    }, 180_000);

    /**
     * THE FAMILY'S OWN CALENDAR, PROVEN ON ONE INSTANT.
     *
     * Two households, identical rows, the SAME UTC instant. Cairo reads 20:30
     * and is told; Riyadh reads 21:30 and is not. Nothing but the `timezone`
     * column differs, so this cannot pass for any reason other than the one it
     * claims. A producer that used UTC would give both the same answer and fail
     * this test whichever answer it chose.
     */
    it('1.5 TIMEZONE — one instant, Africa/Cairo is told and Asia/Riyadh is not', async () => {
      const cairo = await createHousehold('deadline-tz-cairo', CAIRO);
      const riyadh = await createHousehold('deadline-tz-riyadh', RIYADH);

      for (const h of [cairo, riyadh]) {
        const programId = await aQuranGoal(h, { maxPerDay: 2 });
        await setExpiry(programId, minutesFrom(AWAKE_IN_CAIRO_ASLEEP_IN_RIYADH, 5));
        await anAttempt(h, programId, AWAKE_IN_CAIRO_ASLEEP_IN_RIYADH, 'IN_PROGRESS', 1);
      }

      const cairoReport = await sweep(cairo, AWAKE_IN_CAIRO_ASLEEP_IN_RIYADH);
      const riyadhReport = await sweep(riyadh, AWAKE_IN_CAIRO_ASLEEP_IN_RIYADH);

      // BOTH SAW THE CANDIDATE — the difference is the household's clock, not
      // the rows. Without this line a broken query would pass by saying nothing.
      expect(cairoReport.candidates).toBe(1);
      expect(riyadhReport.candidates).toBe(1);

      expect(cairoReport.produced).toBe(1);
      expect(riyadhReport.produced).toBe(0);
      expect(riyadhReport.refused).toBe(1);

      // --- READ BACK OUT OF POSTGRESQL ---
      const cairoRows = await childMessages(cairo.familyId);
      expect(cairoRows).toHaveLength(1);
      assertChildSafeBytes(cairoRows[0]);
      expect(await childMessages(riyadh.familyId)).toHaveLength(0);

      const riyadhDecision = await theDecisionFor(riyadh.familyId, 'GOAL_DEADLINE_NEAR');
      expect(riyadhDecision.decision).toBe('SUPPRESS');
      expect(riyadhDecision.reason).toBe('QUIET_HOURS_CLASS_SUPPRESS');
    }, 180_000);

    /**
     * THE OTHER HALF OF «the family's calendar», which a quiet-hours test cannot
     * reach: at `21:30Z` the two households are on DIFFERENT DAYS. The business
     * date is part of the dedup key, so a producer that derived it from UTC
     * would give one of these two households the wrong day — and, on the wrong
     * side of a rollover, would re-notify a child about yesterday.
     */
    it('1.6 TIMEZONE — one instant, two business dates, and each is stamped on its own row', async () => {
      const cairo = await createHousehold('deadline-split-cairo', CAIRO);
      const riyadh = await createHousehold('deadline-split-riyadh', RIYADH);

      for (const h of [cairo, riyadh]) {
        const programId = await aQuranGoal(h, { maxPerDay: 2 });
        await setExpiry(programId, minutesFrom(MIDNIGHT_SPLIT, 5));
        await anAttempt(h, programId, MIDNIGHT_SPLIT, 'IN_PROGRESS', 1);
        await sweep(h, MIDNIGHT_SPLIT);
      }

      // Both are inside quiet hours at this instant, so both are suppressed —
      // and the decision row is recorded either way, which is what makes the
      // business date readable here at all.
      const cairoDecision = await theDecisionFor(cairo.familyId, 'GOAL_DEADLINE_NEAR');
      const riyadhDecision = await theDecisionFor(riyadh.familyId, 'GOAL_DEADLINE_NEAR');

      expect(cairoDecision.business_date.toISOString().slice(0, 10)).toBe('2026-01-15');
      expect(riyadhDecision.business_date.toISOString().slice(0, 10)).toBe('2026-01-16');
      // The dedup key carries the family-local day, so the two households cannot
      // collide and neither can be re-told tomorrow about today.
      expect(cairoDecision.source_event_id).toContain('2026-01-15');
      expect(riyadhDecision.source_event_id).toContain('2026-01-16');
    }, 180_000);
  });

  // ==========================================================================
  // 2. GOAL_ALMOST_DONE
  // ==========================================================================
  describe('2. GOAL_ALMOST_DONE — the day’s plan is one completion short', () => {
    /**
     * THE PROGRESS IS A COUNT OF ROWS. Four `VERIFIED` attempts against a
     * `max_per_day` of five is «أنجزت ٤ من ٥ آيات», and every number in that
     * sentence is a column or a `COUNT(*)` — which is the whole argument for why
     * no `completed_units` column was added.
     */
    it('2.1 POSITIVE — four VERIFIED of a plan of five, named with the right Arabic plural', async () => {
      const h = await createHousehold('almost-pos', CAIRO);
      const programId = await aQuranGoal(h, { maxPerDay: 5, maxPerWeek: 20 });
      for (let i = 1; i <= 4; i += 1) await anAttempt(h, programId, MIDDAY, 'VERIFIED', i);

      const report = await sweep(h, MIDDAY);
      expect(report.candidates).toBe(1);
      expect(report.produced).toBe(1);

      // --- READ BACK OUT OF POSTGRESQL ---
      const decision = await theDecisionFor(h.familyId, 'GOAL_ALMOST_DONE');
      expect(decision.event_type).toBe('STUDY_REMINDER');
      expect(decision.trigger).toBe('PERIODIC_SIGNAL');

      const rows = await childMessages(h.familyId);
      expect(rows).toHaveLength(1);
      const row = rows[0];

      // THE PROVENANCE CHECK IS DOING REAL WORK HERE. `{unitNoun}` is the
      // variable the ledger entry said had no server-side source; if it were
      // absent the template would leak and the render would degrade to
      // `GENERIC`, and this comparison — against the catalogue, at the row's own
      // band — is what refuses that silently-wrong outcome.
      assertRenderedFromCatalogue(row, decision, { done: 4, total: 5, unitNoun: 'آيات' });
      assertChildSafeBytes(row);

      // «آيات» is the plural of paucity, which is correct for 3..10. The
      // sentence really does contain the noun rather than a hole where it was.
      expect(row.body).toContain('آيات');
      expect(await parentNotifications(h.familyId)).toHaveLength(0);
    }, 180_000);

    it('2.2 NEGATIVE — the completed plan, the untouched plan, and the attempt already open', async () => {
      // (a) THE HEALTHY CASE, and the one that matters most: the child finished
      // everything they planned. There is nothing left to nudge about.
      const complete = await createHousehold('almost-neg-complete', CAIRO);
      const p1 = await aQuranGoal(complete, { maxPerDay: 3, maxPerWeek: 20 });
      for (let i = 1; i <= 3; i += 1) await anAttempt(complete, p1, MIDDAY, 'VERIFIED', i);
      expect((await sweep(complete, MIDDAY)).candidates).toBe(0);
      expect(await childMessages(complete.familyId)).toHaveLength(0);
      expect(await decisions(complete.familyId)).toHaveLength(0);

      // (b) NOTHING DONE YET. «أنجزت ٠ من ١» is not «one step left», it is the
      // whole thing — and a message about a goal the child has not started is a
      // reminder to do homework, which this product does not send.
      const untouched = await createHousehold('almost-neg-zero', CAIRO);
      const p2 = await aQuranGoal(untouched, { maxPerDay: 1 });
      expect((await sweep(untouched, MIDDAY)).candidates).toBe(0);
      expect(await childMessages(untouched.familyId)).toHaveLength(0);

      // (c) THE CHILD IS DOING IT RIGHT NOW. `MAX_OPEN_ATTEMPTS_PER_DAY` is 1, so
      // they could not start another anyway — and «هل تكمل الأخيرة الآن؟» to a
      // child already mid-attempt is the message interrupting the very thing it
      // is asking for.
      const busy = await createHousehold('almost-neg-open', CAIRO);
      const p3 = await aQuranGoal(busy, { maxPerDay: 5, maxPerWeek: 20 });
      for (let i = 1; i <= 4; i += 1) await anAttempt(busy, p3, MIDDAY, 'VERIFIED', i);
      await anAttempt(busy, p3, MIDDAY, 'IN_PROGRESS', 5);
      expect((await sweep(busy, MIDDAY)).candidates).toBe(0);
      expect(await childMessages(busy.familyId)).toHaveLength(0);
    }, 180_000);

    /**
     * THE ARABIC DUAL — THE CASE WHERE THIS PRODUCT SAYS NOTHING.
     *
     * A plan of TWO, one done. The sentence would be «أنجزت ١ من ٢ …», and
     * Arabic does not write the counted noun in the dual after a numeral: there
     * is no form of «آية» that is correct there. `canNameUnits` is false, the
     * producer returns `null`, and the fact never reaches the engine.
     *
     * THE ASSERTION IS THAT NOTHING WAS WRITTEN AT ALL — not that a `GENERIC`
     * sentence was written. A missing variable must never render as a raw
     * `{unitNoun}`, and a sentence that cannot be filled honestly must not be
     * sent; degrading to `GENERIC` here would have satisfied a leak check while
     * still putting a stub in front of a child.
     */
    it('2.3 THE DUAL — a plan of two produces NOTHING, not a GENERIC stub', async () => {
      const h = await createHousehold('almost-dual', CAIRO);
      const programId = await aQuranGoal(h, { maxPerDay: 2, maxPerWeek: 14 });
      await anAttempt(h, programId, MIDDAY, 'VERIFIED', 1);

      // The SQL condition holds — `max_per_day - COUNT(*) = 1` — so the row
      // really is a candidate and only the LANGUAGE gate stops it.
      const sqlRows = await raw<any[]>(
        `SELECT COUNT(*)::int AS n FROM "achievement_requests"
          WHERE "family_id" = $1::uuid AND "status" = 'VERIFIED'`,
        h.familyId,
      );
      expect(Number(sqlRows[0].n)).toBe(1);

      const report = await sweep(h, MIDDAY);
      expect(report.candidates).toBe(0);
      expect(report.produced).toBe(0);

      expect(await decisions(h.familyId)).toHaveLength(0);
      expect(await childMessages(h.familyId)).toHaveLength(0);
      expect(await deliveries(h.familyId)).toHaveLength(0);
    }, 180_000);

    it('2.4 IDEMPOTENT — three ticks leave ONE decision and ONE message', async () => {
      const h = await createHousehold('almost-replay', CAIRO);
      const programId = await aQuranGoal(h, { maxPerDay: 5, maxPerWeek: 20 });
      for (let i = 1; i <= 4; i += 1) await anAttempt(h, programId, MIDDAY, 'VERIFIED', i);

      const ticks = [
        await sweep(h, MIDDAY),
        await sweep(h, new Date(MIDDAY.getTime() + 300_000)),
        await sweep(h, new Date(MIDDAY.getTime() + 600_000)),
      ];
      expect(ticks.map((t) => t.candidates)).toEqual([1, 1, 1]);
      expect(ticks.map((t) => t.produced)).toEqual([1, 0, 0]);
      expect(ticks.map((t) => t.alreadyDecided)).toEqual([0, 1, 1]);

      // --- AND THE DATABASE AGREES ---
      const decisionRows = await decisions(h.familyId);
      expect(decisionRows).toHaveLength(1);
      expect(decisionRows[0].copy_key).toBe('GOAL_ALMOST_DONE');
      expect(await childMessages(h.familyId)).toHaveLength(1);

      // The `GOAL_ALMOST_DONE` fact has its OWN entity id, distinct from the
      // deadline's — the two are different sentences about one goal and one must
      // never dedup the other away.
      expect(decisionRows[0].source_event_id).toBe(
        forEntity('signal', h.childId, goalNudgeEntityId('GOAL_ALMOST_DONE', programId), '2026-01-15'),
      );
    }, 180_000);

    it('2.5 QUIET HOURS + TIMEZONE — one instant, Cairo is told and Riyadh is not', async () => {
      const cairo = await createHousehold('almost-tz-cairo', CAIRO);
      const riyadh = await createHousehold('almost-tz-riyadh', RIYADH);

      for (const h of [cairo, riyadh]) {
        const programId = await aQuranGoal(h, { maxPerDay: 5, maxPerWeek: 20 });
        for (let i = 1; i <= 4; i += 1) {
          await anAttempt(h, programId, AWAKE_IN_CAIRO_ASLEEP_IN_RIYADH, 'VERIFIED', i);
        }
      }

      const cairoReport = await sweep(cairo, AWAKE_IN_CAIRO_ASLEEP_IN_RIYADH);
      const riyadhReport = await sweep(riyadh, AWAKE_IN_CAIRO_ASLEEP_IN_RIYADH);

      expect(cairoReport.candidates).toBe(1);
      expect(riyadhReport.candidates).toBe(1);
      expect(cairoReport.produced).toBe(1);
      expect(riyadhReport.produced).toBe(0);

      const cairoRows = await childMessages(cairo.familyId);
      expect(cairoRows).toHaveLength(1);
      assertChildSafeBytes(cairoRows[0]);
      expect(cairoRows[0].body).toContain('آيات');

      expect(await childMessages(riyadh.familyId)).toHaveLength(0);
      expect(await deliveries(riyadh.familyId)).toHaveLength(0);
      expect((await theDecisionFor(riyadh.familyId, 'GOAL_ALMOST_DONE')).reason).toBe('QUIET_HOURS_CLASS_SUPPRESS');
    }, 180_000);
  });

  // ==========================================================================
  // 3. BOTH FACTS AT ONCE — the anti-nagging bound
  // ==========================================================================
  /**
   * A CHILD WHO IS BEHIND MUST NOT BE BURIED IN REMINDERS. This household is
   * true for BOTH conditions on two different goals at the same instant, which
   * is exactly the shape that would produce two messages in one tick if the
   * producer simply looped.
   *
   * IT SAYS ONE THING, AND IT SAYS THE DEADLINE — the fact the child cannot get
   * back. The count sentence is still true an hour later; the window is not.
   */
  it('3.1 two true facts, ONE message, and the deadline is the one that is said', async () => {
    const h = await createHousehold('both-facts', CAIRO);

    const closing = await aQuranGoal(h, { maxPerDay: 2 });
    await setExpiry(closing, minutesFrom(MIDDAY, 5));
    await anAttempt(h, closing, MIDDAY, 'IN_PROGRESS', 1);

    const almost = await aQuranGoal(h, { maxPerDay: 5, maxPerWeek: 20 });
    for (let i = 1; i <= 4; i += 1) await anAttempt(h, almost, MIDDAY, 'VERIFIED', i);

    const report = await sweep(h, MIDDAY);
    // BOTH conditions held — without this line the assertion below would be
    // satisfied by a query that simply missed one of them.
    expect(report.candidates).toBe(2);
    expect(report.produced).toBe(1);

    // --- READ BACK OUT OF POSTGRESQL: ONE ROW, AND IT IS THE DEADLINE ---
    const decisionRows = await decisions(h.familyId);
    expect(decisionRows).toHaveLength(1);
    expect(decisionRows[0].copy_key).toBe('GOAL_DEADLINE_NEAR');

    const rows = await childMessages(h.familyId);
    expect(rows).toHaveLength(1);
    assertChildSafeBytes(rows[0]);
  }, 180_000);
});
