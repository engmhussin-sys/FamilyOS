/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-var-requires */
/**
 * ============================================================================
 * SPRINT F1 — THE PRODUCER OF `GOAL_STALLED_PARENT`, AGAINST A REAL POSTGRESQL.
 * ============================================================================
 *
 * WHAT WAS MISSING, measured by `e2e-14` and pinned there at zero:
 * `GOAL_STALLED_PARENT` had a sentence, a quiet-hours class, an urgency weight,
 * an achievement baseline and a deep-link destination — five deliberate rows in
 * five tables — and NOTHING IN `src/` EVER EMITTED IT. A goal that is not
 * finished emits no domain event, so no consumer could carry it and no
 * scheduled job asked the question.
 *
 * WHAT THIS SUITE EXECUTES. Real rows, real engine, real delivery pipeline,
 * real deferral table. Every count below is read OUT OF POSTGRESQL with SQL and
 * not from a returned object — the discipline `quiet-hours-deferral.e2e.spec.ts`
 * states in its own header, and for the same reason: the defect being closed is
 * one where a returned value said the right thing and no row existed.
 *
 *   1  POSITIVE      the condition holds -> exactly ONE notification, through
 *                    the engine, with the ledger row that explains it.
 *   2  NEGATIVE      a goal being worked on, a goal already completed, and a
 *                    goal the parent archived: three silences, each for a
 *                    named clause of the condition.
 *   3  IDEMPOTENCY   the sweep twice, plus a redelivery — one row, refused by a
 *                    NAMED unique index rather than by an `if` in the producer.
 *   4  QUIET HOURS   at the hour the rollover really runs (02:00 family-local):
 *                    DEFERRED and held, not delivered and not lost.
 *   5  TIMEZONE      Africa/Cairo AND Asia/Riyadh, at one instant whose UTC
 *                    date is NOT either family's date.
 *   6  THE CALLER    the same thing again through `FamilyDailyRolloverJob`,
 *                    so «where does this run from» is executed and not claimed.
 *
 * SCOPED TO ITS OWN COHORT. Every assertion is `WHERE family_id = <a family
 * this file created>`. The shared database holds hundreds of families from
 * other suites and a count that could be satisfied by one of them would be a
 * count that proves nothing.
 */
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';

import { AppModule } from '../../src/app.module';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { createTenantExtension } from '../../src/common/tenancy/tenant.extension';
import { runAsSystemAsync } from '../../src/common/tenancy/system-context';
import { runWithTenant } from '../../src/common/tenancy/tenant-context';
import { getBusinessDate, getBusinessTimeHHMM } from '../../src/common/time/family-date';
import { FamilyDateService } from '../../src/common/time/family-date.service';
import { QuietHoursReleaseService } from '../../src/modules/life-intelligence/application/services/quiet-hours-release.service';
import { StalledGoalService } from '../../src/modules/life-intelligence/application/services/stalled-goal.service';
import { stalledGoalUnits } from '../../src/modules/life-intelligence/domain/stalled-goal.types';
import { FamilyDailyRolloverJob } from '../../src/modules/scheduler/application/jobs/family-daily-rollover.job';
import { hasEnumOrPlaceholderLeak } from '../../src/modules/notifications/domain/engine/notification-copy';
import { forEntity } from '../../src/shared/notifications/notification-source-key';
import { integrationDatabaseUrl } from '../tenancy/prisma-test-client';

const describeIfDb = integrationDatabaseUrl() ? describe : describe.skip;

const CAIRO = 'Africa/Cairo';
const RIYADH = 'Asia/Riyadh';

/**
 * JANUARY, DELIBERATELY — the same choice, for the same reason, as
 * `quiet-hours-deferral.e2e.spec.ts`: Egypt reintroduced DST in 2023, so in
 * August Cairo and Riyadh are BOTH UTC+3 and a test that asserted a difference
 * would be asserting something false. In January Cairo is UTC+2 and Riyadh
 * UTC+3. Every offset below is READ from tzdata by `family-date.ts` and none of
 * them is written down here.
 *
 * `STALLED_EVENING` is the evening the child opened an attempt and stopped.
 * `MORNING_AFTER` is 09:00 in Cairo the next day — the family's day has closed,
 * and 09:00 is outside the default 21:00–07:00 quiet window, so the SEND path
 * is exercised. `DEEP_NIGHT` is 02:00 Cairo, which is the hour
 * `family-daily-rollover` is actually scheduled at (`local_hour = 2`,
 * migration 0011) and therefore the hour the DEFER path is really taken in
 * production.
 */
const STALLED_EVENING = new Date('2026-01-15T18:00:00.000Z'); // 20:00 Cairo
const MORNING_AFTER = new Date('2026-01-16T07:00:00.000Z'); // 09:00 Cairo
const DEEP_NIGHT = new Date('2026-01-16T00:00:00.000Z'); // 02:00 Cairo
const RELEASE_MORNING = new Date('2026-01-16T05:30:00.000Z'); // 07:30 Cairo
/**
 * ONE INSTANT WHOSE UTC DATE IS NEITHER FAMILY'S DATE. 22:30Z is 00:30 on the
 * 16th in Cairo and 01:30 on the 16th in Riyadh, while UTC still reads the
 * 15th. A sweep that derived its day from `toISOString().slice(0, 10)` would
 * ask both households about the wrong day, and section 5 executes exactly that
 * mistake and shows it finds nothing.
 */
const ACROSS_MIDNIGHT = new Date('2026-01-15T22:30:00.000Z');

/** The same offline client the other integration suites build. */
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

interface Household {
  readonly familyId: string;
  readonly childId: string;
  readonly userId: string;
  readonly childName: string;
  readonly timeZone: string;
}

describeIfDb('SPRINT F1 — GOAL_STALLED_PARENT has a producer (real PostgreSQL)', () => {
  let app: INestApplication;
  let prisma: any;
  let producer: StalledGoalService;
  let release: QuietHoursReleaseService;
  let rollover: FamilyDailyRolloverJob;

  const stamp = Date.now();
  const createdFamilies: string[] = [];
  const createdUsers: string[] = [];

  const sys = (what: string, fn: () => Promise<any>): Promise<any> =>
    runAsSystemAsync('TEST_FIXTURE', `F1 stalled-goal suite: ${what}`, async () => await fn());

  const raw = <T>(sql: string, ...params: unknown[]): Promise<T> =>
    sys('raw sql', () => prisma.$queryRawUnsafe(sql, ...params)) as Promise<T>;

  const decisionRows = (familyId: string): Promise<any[]> =>
    raw<any[]>(
      `SELECT * FROM "notification_decisions" WHERE "family_id" = $1::uuid ORDER BY "created_at", "id"`,
      familyId,
    );

  const notificationRows = (familyId: string): Promise<any[]> =>
    raw<any[]>(
      `SELECT * FROM "notifications" WHERE "family_id" = $1::uuid ORDER BY "created_at", "id"`,
      familyId,
    );

  const deliveryRows = (familyId: string): Promise<any[]> =>
    raw<any[]>(
      `SELECT * FROM "notification_deliveries" WHERE "family_id" = $1::uuid ORDER BY "created_at"`,
      familyId,
    );

  const countOf = async (table: string, familyId: string): Promise<number> =>
    Number(
      (
        await raw<any[]>(
          `SELECT COUNT(*)::int AS n FROM "${table}" WHERE "family_id" = $1::uuid`,
          familyId,
        )
      )[0].n,
    );

  /** The four numbers every «it did not spam» claim in this file is made of. */
  const countTheHousehold = async (familyId: string) => ({
    decisions: await countOf('notification_decisions', familyId),
    notifications: await countOf('notifications', familyId),
    childMessages: await countOf('child_messages', familyId),
    deliveries: await countOf('notification_deliveries', familyId),
  });

  // -- fixtures --------------------------------------------------------------

  async function createHousehold(label: string, timeZone: string, childName = 'محمد'): Promise<Household> {
    const family = await sys('create family', () =>
      prisma.family.create({ data: { name: `F1 ${label} ${stamp}`, timezone: timeZone }, select: { id: true } }),
    );
    createdFamilies.push(family.id);

    const user = await sys('create user', () =>
      prisma.user.create({
        data: { email: `f1.${label}.${stamp}@example.test`, passwordHash: 'x', fullName: 'F1 Parent' },
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
          firstName: childName,
          dateOfBirth: new Date('2014-04-01T00:00:00.000Z'),
        },
        select: { id: true },
      }),
    );

    return { familyId: family.id, childId: child.id, userId: user.id, childName, timeZone };
  }

  /**
   * A parent-authored goal, written with the columns the real
   * `RewardProgramService` writes. The Arabic summary is a literal here rather
   * than derived, because this suite is about the STALL condition and not about
   * `describeTargetSpec` — `e2e-14` pins that derivation against the producer's
   * own function.
   */
  async function createProgram(
    h: Household,
    overrides: Record<string, unknown> = {},
  ): Promise<{ id: string; title: string }> {
    const title = 'الآيات 1–5 من سورة الملك';
    const program = await sys('create program', () =>
      prisma.rewardProgram.create({
        data: {
          familyId: h.familyId,
          childId: h.childId,
          category: 'QURAN',
          activity: 'QURAN_MEMORIZE_AYAH_RANGE',
          targetSpec: { surahNumber: 67, fromAyah: 1, toAyah: 5 },
          targetSummaryAr: title,
          durationMinutes: 20,
          verificationLevel: 'PARENT_CONFIRMATION',
          rewardSpec: { type: 'POINTS', amount: 20 },
          createdByUserId: h.userId,
          ...overrides,
        },
        select: { id: true },
      }),
    );
    return { id: program.id, title };
  }

  /** One attempt row, on a FAMILY-LOCAL day, in whatever state the case needs. */
  async function createAttempt(
    h: Household,
    programId: string,
    businessDate: string,
    overrides: Record<string, unknown> = {},
  ): Promise<string> {
    const row = await sys('create attempt', () =>
      prisma.achievementRequest.create({
        data: {
          familyId: h.familyId,
          programId,
          childId: h.childId,
          status: 'IN_PROGRESS',
          localDate: FamilyDateService.toDateColumn(businessDate),
          attemptNo: 1,
          startedAt: STALLED_EVENING,
          ...overrides,
        },
        select: { id: true },
      }),
    );
    return row.id;
  }

  /**
   * THE PRODUCER, at an explicit instant, inside the tenant scope the job
   * runner establishes before every family handler. Not `jest.useFakeTimers()`:
   * a faked clock also fakes the timers `pg` uses, so a suite that freezes time
   * and then awaits a real query deadlocks. `now` is a parameter for the same
   * reason it is a parameter of `closableBusinessDate`.
   */
  const sweep = (h: Household, businessDate: string, now: Date) =>
    runWithTenant({ familyId: h.familyId, actorType: 'SYSTEM', actorId: 'f1-stalled-goal-test' }, () =>
      producer.sweepFamily({ familyId: h.familyId, businessDate, now }),
    );

  /** The day the child's attempt belonged to, on the FAMILY's calendar. */
  const stalledDay = (timeZone: string): string => getBusinessDate(STALLED_EVENING, timeZone);

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue(offlinePrismaService())
      .compile();

    app = moduleRef.createNestApplication();
    await app.init();

    prisma = app.get(PrismaService);
    producer = app.get(StalledGoalService);
    release = app.get(QuietHoursReleaseService);
    rollover = app.get(FamilyDailyRolloverJob);
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
  describe('1. POSITIVE — a goal started and never finished produces exactly one parent notification', () => {
    let home: Household;
    let programId = '';
    let goalTitle = '';

    it('the premise, as rows: an ACTIVE program and an attempt that was opened and never submitted', async () => {
      home = await createHousehold('positive', CAIRO);
      const program = await createProgram(home);
      programId = program.id;
      goalTitle = program.title;
      await createAttempt(home, programId, stalledDay(CAIRO));

      // Read back from the table, not from the create call.
      const [attempt] = await raw<any[]>(
        `SELECT * FROM "achievement_requests" WHERE "family_id" = $1::uuid`,
        home.familyId,
      );
      expect(attempt.status).toBe('IN_PROGRESS');
      expect(attempt.submitted_at).toBeNull();
      expect(attempt.decided_at).toBeNull();
      expect(attempt.local_date.toISOString().slice(0, 10)).toBe(stalledDay(CAIRO));

      // And the household starts silent, so section 1's «one» cannot be
      // inherited from anywhere.
      expect(await countTheHousehold(home.familyId)).toEqual({
        decisions: 0,
        notifications: 0,
        childMessages: 0,
        deliveries: 0,
      });
    }, 120_000);

    it('the sweep produces ONE decision, and the ledger row explains it', async () => {
      const report = await sweep(home, stalledDay(CAIRO), MORNING_AFTER);
      expect(report).toEqual({ candidates: 1, produced: 1, alreadyDecided: 0, refused: 0 });

      const decisions = await decisionRows(home.familyId);
      expect(decisions).toHaveLength(1);
      const [row] = decisions;

      // THE COLUMNS THE LEDGER EXISTS FOR. `trigger` is PERIODIC_SIGNAL because
      // that is what a sweep is; claiming DOMAIN_EVENT would make this column a
      // lie about how the product learned the fact.
      expect(row.trigger).toBe('PERIODIC_SIGNAL');
      expect(row.event_type).toBe('GOAL_STALLED_PARENT');
      expect(row.notification_type).toBe('GOAL_STALLED_PARENT');
      expect(row.category).toBe('GOAL');
      expect(row.target_audience).toBe('PARENT');
      expect(row.child_id).toBe(home.childId);
      expect(row.decision).toBe('SEND');
      expect(row.outcome).toBe('SEND');
      // The sentence came from the CATALOGUE. `GENERIC` here would mean the
      // parent read «لديك تحديث جديد».
      expect(row.copy_key).toBe('GOAL_STALLED_PARENT');
      expect(row.ai_rewritten).toBe(false);
      // THE KEY THE PRODUCER CHOSE: this child, this goal, this family-local
      // day — composed here by the same shared function the producer calls.
      expect(row.source_event_id).toBe(forEntity('signal', home.childId, programId, stalledDay(CAIRO)));
    }, 120_000);

    it('it reached the parent: one row in `notifications`, to the family OWNER, and none to the child', async () => {
      const rows = await notificationRows(home.familyId);
      expect(rows).toHaveLength(1);
      expect(rows[0].type).toBe('GOAL_STALLED_PARENT');
      expect(rows[0].user_id).toBe(home.userId);
      expect(rows[0].child_id).toBe(home.childId);

      // STRUCTURALLY not to the child: `COPY_CATALOGUE.GOAL_STALLED_PARENT`
      // declares `audience: 'PARENT'`, so this event — fired WITH a child id —
      // cannot reach `child_messages` at all. That is the strongest form of
      // «the child is not nagged»: a routing property, not a copy review.
      expect(await countOf('child_messages', home.familyId)).toBe(0);
    }, 120_000);

    it('the words are the parent\'s: actionable, Arabic, and nothing a child receives', async () => {
      const [row] = await notificationRows(home.familyId);

      expect(row.title).toBe('هدف بدأ ولم يكتمل');
      expect(row.body).toBe(`بدأ ${home.childName} هدف ${goalTitle} ولم يكمله — ربما يحتاج دفعة اليوم`);
      // WHAT HAPPENED and WHAT THE PARENT MIGHT DO — pinned separately, because
      // losing the second clause is the likeliest regression.
      expect(row.body).toContain('ولم يكمله');
      expect(row.body).toContain('ربما');
      expect(row.body).toContain('دفعة');
      // Arabic, and no raw enum or unresolved placeholder reached the parent —
      // measured against the PRODUCT's own detector, not only a local regex.
      expect(row.body).toMatch(/[؀-ۿ]/);
      expect(hasEnumOrPlaceholderLeak(row.title)).toBe(false);
      expect(hasEnumOrPlaceholderLeak(row.body)).toBe(false);
      expect(row.body).not.toMatch(/[{}]/);
      // Non-punitive (CONTEXT §3 principle 7), and no leverage on the reward.
      for (const word of ['فشل', 'كسول', 'مقصر', 'إهمال', 'عقاب', 'سنمنع', 'النقاط', 'المكافأة']) {
        expect(`${row.title} ${row.body}`).not.toContain(word);
      }
    }, 120_000);
  });

  // ==========================================================================
  describe('2. NEGATIVE — three goals that are NOT stalled, one per clause of the condition', () => {
    it('a goal being worked on (submitted, awaiting the parent) produces nothing', async () => {
      const h = await createHousehold('progressing', CAIRO);
      const program = await createProgram(h);
      await createAttempt(h, program.id, stalledDay(CAIRO), {
        status: 'PENDING_PARENT',
        submittedAt: STALLED_EVENING,
      });

      const report = await sweep(h, stalledDay(CAIRO), MORNING_AFTER);
      expect(report.candidates).toBe(0);
      expect(await countTheHousehold(h.familyId)).toEqual({
        decisions: 0,
        notifications: 0,
        childMessages: 0,
        deliveries: 0,
      });
    }, 120_000);

    it('a goal already COMPLETED that day produces nothing — even with an abandoned second attempt beside it', async () => {
      const h = await createHousehold('completed', CAIRO);
      const program = await createProgram(h, { maxPerDay: 2 });
      // The child finished it once...
      await createAttempt(h, program.id, stalledDay(CAIRO), {
        status: 'VERIFIED',
        submittedAt: STALLED_EVENING,
        decidedAt: STALLED_EVENING,
      });
      // ...and opened a second attempt they never handed in. A producer that
      // looked only at the open row would call this child stalled on a day they
      // completed the goal, which is the `NOT EXISTS` clause's whole purpose.
      await createAttempt(h, program.id, stalledDay(CAIRO), { attemptNo: 2 });

      const report = await sweep(h, stalledDay(CAIRO), MORNING_AFTER);
      expect(report.candidates).toBe(0);
      expect(await countTheHousehold(h.familyId)).toEqual({
        decisions: 0,
        notifications: 0,
        childMessages: 0,
        deliveries: 0,
      });
    }, 120_000);

    it('a goal the parent ARCHIVED produces nothing — they already acted', async () => {
      const h = await createHousehold('archived', CAIRO);
      const program = await createProgram(h, {
        status: 'ARCHIVED',
        archivedAt: STALLED_EVENING,
      });
      await createAttempt(h, program.id, stalledDay(CAIRO));

      const report = await sweep(h, stalledDay(CAIRO), MORNING_AFTER);
      expect(report.candidates).toBe(0);
      expect(await countTheHousehold(h.familyId)).toEqual({
        decisions: 0,
        notifications: 0,
        childMessages: 0,
        deliveries: 0,
      });
    }, 120_000);

    it('an EXPIRED program produces nothing — the nudge would invite an action the child cannot take', async () => {
      const h = await createHousehold('expired', CAIRO);
      const program = await createProgram(h, { expiresAt: STALLED_EVENING });
      await createAttempt(h, program.id, stalledDay(CAIRO));

      const report = await sweep(h, stalledDay(CAIRO), MORNING_AFTER);
      expect(report.candidates).toBe(0);
      expect(await countTheHousehold(h.familyId)).toEqual({
        decisions: 0,
        notifications: 0,
        childMessages: 0,
        deliveries: 0,
      });
    }, 120_000);
  });

  // ==========================================================================
  describe('3. IDEMPOTENCY — one notification per goal per business date, held by an index', () => {
    let h: Household;
    let programId = '';

    it('the sweep run three times — twice plus a redelivery — writes ONE row, counted in PostgreSQL', async () => {
      h = await createHousehold('idempotent', CAIRO);
      const program = await createProgram(h);
      programId = program.id;
      await createAttempt(h, programId, stalledDay(CAIRO));

      const first = await sweep(h, stalledDay(CAIRO), MORNING_AFTER);
      expect(first.produced).toBe(1);

      // An operator pressing «Run now», or a second replica ticking: the SAME
      // business day, minutes later.
      const second = await sweep(h, stalledDay(CAIRO), new Date(MORNING_AFTER.getTime() + 4 * 60_000));
      // A REDELIVERY: the same cause an hour later, which is past both the
      // five-minute duplicate window and the thirty-minute cooldown, so neither
      // of the two mechanisms that would trivially catch it applies.
      const third = await sweep(h, stalledDay(CAIRO), new Date(MORNING_AFTER.getTime() + 60 * 60_000));

      // «Already decided» is the ledger refusing the cause, not the engine
      // scoring it down — the two are counted separately for that reason.
      expect(second).toEqual({ candidates: 1, produced: 0, alreadyDecided: 1, refused: 0 });
      expect(third).toEqual({ candidates: 1, produced: 0, alreadyDecided: 1, refused: 0 });

      // THE ONLY NUMBERS THAT MATTER, READ OUT OF THE DATABASE.
      expect(await countTheHousehold(h.familyId)).toEqual({
        decisions: 1,
        notifications: 1,
        childMessages: 0,
        deliveries: 0,
      });
    }, 180_000);

    it('the refusal is a NAMED unique index, not an `if` in the producer', async () => {
      // The constraint that holds it, by name and by columns. A producer whose
      // idempotency lived in a conditional would still pass the count above on
      // a single process; this is the assertion that says it survives two.
      const [idx] = await raw<any[]>(
        `SELECT "indexdef" FROM pg_indexes
          WHERE "tablename" = 'notification_decisions'
            AND "indexname" = 'notification_decisions_cause_uniq'`,
      );
      expect(idx).toBeDefined();
      expect(idx.indexdef).toContain('UNIQUE');
      expect(idx.indexdef).toContain('family_id');
      expect(idx.indexdef).toContain('source_event_id');
      expect(idx.indexdef).toContain('target_audience');

      // And a hand-written second INSERT of the same cause really is refused —
      // the mechanism executed rather than described.
      const key = forEntity('signal', h.childId, programId, stalledDay(CAIRO));
      const inserted = await raw<any[]>(
        `INSERT INTO "notification_decisions" (
           "family_id", "child_id", "source_event_id", "trigger", "event_type",
           "notification_type", "category", "target_audience", "decision",
           "priority_band", "score", "reason", "explanation", "provider_id",
           "age_band", "locale", "country_code", "ai_rewritten", "ai_failed",
           "copy_key", "business_date"
         ) VALUES (
           $1::uuid, $2::uuid, $3::text, 'PERIODIC_SIGNAL', 'GOAL_STALLED_PARENT',
           'GOAL_STALLED_PARENT', 'GOAL', 'PARENT', 'SEND',
           'LOW', 30, 'SCORE_IN_DEFER_BAND', '[]'::jsonb, 'rule-based',
           'TEEN', 'ar', NULL, false, false,
           'GOAL_STALLED_PARENT', $4::date
         )
         ON CONFLICT ("family_id", "source_event_id", "target_audience") DO NOTHING
         RETURNING "id"`,
        h.familyId,
        h.childId,
        key,
        stalledDay(CAIRO),
      );
      expect(inserted).toHaveLength(0);
      expect(await countOf('notification_decisions', h.familyId)).toBe(1);
    }, 120_000);

    /**
     * THE OTHER HALF OF «ONE PER GOAL PER DAY»: the key dedupes A DAY, not a
     * goal forever. The same child stalling the same goal tomorrow is a
     * DIFFERENT cause, the ledger accepts it, and a SECOND DECISION ROW exists.
     *
     * AND WHAT THE PRODUCT THEN DOES WITH IT IS THE ENGINE'S CALL, NOT THE
     * PRODUCER'S — which is exactly the separation this whole design rests on,
     * so it is asserted rather than glossed. A household that was told about a
     * stalled goal yesterday morning is inside its own GOAL category load when
     * tomorrow's 02:00 rollover asks again, so the second one is scored down
     * and refused. That is a household-load fact recorded in a row with a
     * reason, not silence, and it is why «the parent is not nagged nightly»
     * does not depend on the producer having been careful.
     */
    it('the NEXT business date is a DIFFERENT cause — a second ledger row, and the engine decides it on its own merits', async () => {
      const nextDay = getBusinessDate(MORNING_AFTER, CAIRO);
      expect(nextDay).not.toBe(stalledDay(CAIRO));
      await createAttempt(h, programId, nextDay, { attemptNo: 1 });

      // 02:00 Cairo on the day after that — the hour the rollover really runs.
      const nextNight = new Date('2026-01-17T00:00:00.000Z');
      expect(getBusinessTimeHHMM(nextNight, CAIRO)).toBe('02:00');
      const report = await sweep(h, nextDay, nextNight);
      expect(report.candidates).toBe(1);
      // NOT «already decided» — the constraint did not refuse this one.
      expect(report.alreadyDecided).toBe(0);

      const decisions = await decisionRows(h.familyId);
      expect(decisions).toHaveLength(2);
      const keys = decisions.map((d) => d.source_event_id);
      expect(new Set(keys).size).toBe(2);
      expect(keys).toContain(forEntity('signal', h.childId, programId, stalledDay(CAIRO)));
      expect(keys).toContain(forEntity('signal', h.childId, programId, nextDay));

      // The second row is a DECISION with a stated reason, and the parent's
      // phone did not receive a second sentence.
      const second = decisions.find((d) => d.source_event_id.endsWith(nextDay));
      expect(second.decision).toBe('SUPPRESS');
      expect(second.reason).toBe('SCORE_BELOW_FLOOR');
      expect(await countOf('notifications', h.familyId)).toBe(1);
    }, 120_000);
  });

  // ==========================================================================
  describe('4. QUIET HOURS — at 02:00, the hour the rollover really runs, it is HELD and not delivered', () => {
    let h: Household;
    let key = '';

    it('the decision is DEFER for a named reason, and nothing reached the parent', async () => {
      h = await createHousehold('quiet', CAIRO);
      const program = await createProgram(h);
      await createAttempt(h, program.id, stalledDay(CAIRO));
      key = forEntity('signal', h.childId, program.id, stalledDay(CAIRO));

      // The premise, measured on the family's clock rather than assumed.
      expect(getBusinessTimeHHMM(DEEP_NIGHT, CAIRO)).toBe('02:00');

      const report = await sweep(h, stalledDay(CAIRO), DEEP_NIGHT);
      expect(report.produced).toBe(1);

      const [row] = await decisionRows(h.familyId);
      expect(row.decision).toBe('DEFER');
      expect(row.reason).toBe('QUIET_HOURS_ACTIVE');
      expect(row.outcome).toBe('DEFER');
      expect(row.outcome_reason).toBe('QUIET_HOURS');

      // NOT DELIVERED — the whole point of «deferred».
      expect(await countOf('notifications', h.familyId)).toBe(0);
      expect(await countOf('child_messages', h.familyId)).toBe(0);
    }, 120_000);

    it('and NOT LOST — one durable row, scheduled for 07:00 on the FAMILY\'s clock, carrying the producer\'s key', async () => {
      const deliveries = await deliveryRows(h.familyId);
      expect(deliveries).toHaveLength(1);
      expect(deliveries[0].type).toBe('GOAL_STALLED_PARENT');
      expect(deliveries[0].target_audience).toBe('PARENT');
      expect(deliveries[0].state).toBe('PENDING');
      expect(deliveries[0].defer_reason).toBe('QUIET_HOURS');
      expect(getBusinessTimeHHMM(new Date(deliveries[0].scheduled_for), CAIRO)).toBe('07:00');
      // THE CAUSAL KEY, CARRIED ACROSS THE DEFERRAL — which is what keeps the
      // held notification idempotent when 07:00 comes.
      expect(deliveries[0].source_event_id).toBe(key);
    }, 120_000);

    it('the morning sweep releases it EXACTLY once, and a re-run of the producer adds nothing', async () => {
      await release.sweep(RELEASE_MORNING);

      const delivered = await notificationRows(h.familyId);
      expect(delivered).toHaveLength(1);
      expect(delivered[0].type).toBe('GOAL_STALLED_PARENT');
      expect(delivered[0].source_event_id).toBe(key);

      // The producer runs again after the release — a catch-up run, an operator
      // pressing the button — and the household's counts do not move.
      const again = await sweep(h, stalledDay(CAIRO), RELEASE_MORNING);
      expect(again.alreadyDecided).toBe(1);
      expect(await countTheHousehold(h.familyId)).toEqual({
        decisions: 1,
        notifications: 1,
        childMessages: 0,
        deliveries: 1,
      });
    }, 180_000);
  });

  // ==========================================================================
  describe('5. TIMEZONE — the family\'s own calendar, in Africa/Cairo AND Asia/Riyadh', () => {
    /**
     * THE INSTANT IS SHARED AND THE DAY IS NOT. At 22:30Z on the 15th both
     * households are already living the 16th — Cairo at 00:30, Riyadh at 01:30
     * — while UTC still reads the 15th. So «which day is it» has three answers
     * at one instant, and only two of them are a family's.
     */
    it.each([
      ['Africa/Cairo', CAIRO, 'سلمى'],
      ['Asia/Riyadh', RIYADH, 'نورة'],
    ])(
      '%s — the goal is stalled on the FAMILY\'s business date, and NOT on the UTC one',
      async (label, timeZone, childName) => {
        const h = await createHousehold(`tz-${label.replace(/[^a-z]/gi, '')}`, timeZone, childName);
        const program = await createProgram(h);

        const familyDate = getBusinessDate(ACROSS_MIDNIGHT, timeZone);
        const utcDate = ACROSS_MIDNIGHT.toISOString().slice(0, 10);
        // THE PREMISE, ASSERTED: a UTC-derived sweep would ask about a
        // different day. Without this line the test could pass vacuously in a
        // month where the two happen to agree.
        expect(familyDate).not.toBe(utcDate);
        expect(getBusinessTimeHHMM(ACROSS_MIDNIGHT, timeZone)).toMatch(/^0[01]:30$/);

        // The attempt belongs to the family's day, exactly as
        // `AchievementService.start` would have written it.
        await createAttempt(h, program.id, familyDate);

        // 1. THE MISTAKE, EXECUTED: sweeping the UTC date finds nothing.
        const byUtc = await sweep(h, utcDate, MORNING_AFTER);
        expect(byUtc.candidates).toBe(0);
        expect(await countOf('notification_decisions', h.familyId)).toBe(0);

        // 2. THE FAMILY'S OWN DAY: exactly one, and the key carries that day.
        const byFamily = await sweep(h, familyDate, MORNING_AFTER);
        expect(byFamily.produced).toBe(1);

        const decisions = await decisionRows(h.familyId);
        expect(decisions).toHaveLength(1);
        expect(decisions[0].source_event_id).toBe(
          forEntity('signal', h.childId, program.id, familyDate),
        );
        expect(decisions[0].source_event_id).toContain(familyDate);
        expect(decisions[0].source_event_id).not.toContain(utcDate);

        const rows = await notificationRows(h.familyId);
        expect(rows).toHaveLength(1);
        expect(rows[0].body).toContain(childName);
      },
      180_000,
    );

    it('the two zones really are an hour apart at that instant — so the pair above is not one test twice', () => {
      const cairoHHMM = getBusinessTimeHHMM(ACROSS_MIDNIGHT, CAIRO);
      const riyadhHHMM = getBusinessTimeHHMM(ACROSS_MIDNIGHT, RIYADH);
      expect(cairoHHMM).toBe('00:30');
      expect(riyadhHHMM).toBe('01:30');
      // Same calendar day for both households, and it is NOT the UTC one.
      expect(getBusinessDate(ACROSS_MIDNIGHT, CAIRO)).toBe('2026-01-16');
      expect(getBusinessDate(ACROSS_MIDNIGHT, RIYADH)).toBe('2026-01-16');
      expect(ACROSS_MIDNIGHT.toISOString().slice(0, 10)).toBe('2026-01-15');
    });
  });

  // ==========================================================================
  describe('6. THE CALLER — this runs from the existing family rollover, not from a second scheduler', () => {
    it('`FamilyDailyRolloverJob` produces the notification and reports it in `job_runs.details`', async () => {
      const h = await createHousehold('rollover', CAIRO);
      const program = await createProgram(h);
      await createAttempt(h, program.id, stalledDay(CAIRO));

      // The handler, with the context `JobRunner.executeFamilies` builds: the
      // family's own zone and the business date IT closed, which is derived
      // from `Family.timezone` by `closableBusinessDate` and never from UTC.
      const outcome = await runWithTenant(
        { familyId: h.familyId, actorType: 'SYSTEM', actorId: 'scheduler:family-daily-rollover' },
        () =>
          rollover.run({
            scope: 'FAMILY',
            familyId: h.familyId,
            timeZone: CAIRO,
            businessDate: stalledDay(CAIRO),
            now: MORNING_AFTER,
          }),
      );

      expect(outcome.details.goals_stalled_found).toBe(1);
      expect(outcome.details.goals_stalled_notified).toBe(1);
      expect(outcome.affectedRows).toBeGreaterThanOrEqual(1);

      const rows = await notificationRows(h.familyId);
      expect(rows).toHaveLength(1);
      expect(rows[0].type).toBe('GOAL_STALLED_PARENT');
      expect(rows[0].source_event_id).toBe(forEntity('signal', h.childId, program.id, stalledDay(CAIRO)));
    }, 180_000);

    it('a second rollover for the same family-day writes nothing more', async () => {
      const h = await createHousehold('rollover-twice', CAIRO);
      const program = await createProgram(h);
      await createAttempt(h, program.id, stalledDay(CAIRO));

      const ctx = {
        scope: 'FAMILY' as const,
        familyId: h.familyId,
        timeZone: CAIRO,
        businessDate: stalledDay(CAIRO),
        now: MORNING_AFTER,
      };
      const asFamily = (fn: () => Promise<any>) =>
        runWithTenant({ familyId: h.familyId, actorType: 'SYSTEM', actorId: 'scheduler:family-daily-rollover' }, fn);

      await asFamily(() => rollover.run(ctx));
      const second = await asFamily(() =>
        rollover.run({ ...ctx, now: new Date(MORNING_AFTER.getTime() + 30 * 60_000) }),
      );

      expect(second.details.goals_stalled_notified).toBe(0);
      expect(second.details.goals_stalled_already_decided).toBe(1);
      expect(await countTheHousehold(h.familyId)).toEqual({
        decisions: 1,
        notifications: 1,
        childMessages: 0,
        deliveries: 0,
      });
    }, 180_000);
  });

  // ==========================================================================
  describe('7. THE UNIT COUNT — pure, and honest about what it cannot count', () => {
    it('reads a real ayah range, a quantity, and answers 0 rather than guessing', () => {
      expect(stalledGoalUnits({ surahNumber: 67, fromAyah: 1, toAyah: 5 })).toBe(5);
      expect(stalledGoalUnits({ surahNumber: 67, fromAyah: 3 })).toBe(1);
      expect(stalledGoalUnits({ quantity: 12, unit: 'صفحة' })).toBe(12);
      // A jsonb column may arrive parsed or as text; both are the same answer.
      expect(stalledGoalUnits('{"quantity":4}')).toBe(4);
      // NOT ONE. `notification-scoring.ts` reads `completedUnits >= totalUnits`
      // as «the goal was completed»; a default of 1 is a number nobody chose.
      expect(stalledGoalUnits({ reference: 'أي شيء' })).toBe(0);
      expect(stalledGoalUnits(null)).toBe(0);
      expect(stalledGoalUnits('not json')).toBe(0);
    });
  });
});
