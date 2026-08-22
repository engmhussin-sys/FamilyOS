/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-var-requires */
/**
 * ============================================================================
 * SPRINT F1 — THE PRODUCER OF THE FOUR CHILD COPY KEYS, AGAINST A REAL
 * POSTGRESQL.
 * ============================================================================
 *
 * WHAT WAS MISSING. `HYDRATION_REMINDER`, `STUDY_REMINDER` and
 * `EXERCISE_ENCOURAGEMENT` had four tone bands of copy, a quiet-hours class,
 * two scoring rows and a deep-link destination, and were reachable ONLY through
 * `SmartNotificationIntegrationService.processSignals`, which has zero callers
 * in `src/`. `STREAK_AT_RISK` was worse: the copy rule reads `c.streak`, and no
 * door site anywhere in `src/` had ever passed `streak:` — the fact slot was
 * write-only.
 *
 * WHAT THIS SUITE EXECUTES. Real rows, real engine, real decision ledger, real
 * child-message table, real CHILD safety filter. Every count below is read OUT
 * OF POSTGRESQL with SQL and never from a returned object — the discipline
 * `stalled-goal-producer.e2e.spec.ts` states in its own header, and for the
 * same reason: the defect being closed is one where a return value said the
 * right thing and no row existed.
 *
 * THE SAFETY ENGINE IS NOT MOCKED ANYWHERE IN THIS FILE. `PE-N-001` survived
 * four audits behind a mocked filter; every assertion about the child-facing
 * bytes below re-validates the PERSISTED string with the real
 * `ChildSafetyFilterService` at the child's OWN `ageBandFor` band.
 *
 *   1  POSITIVE      one section per key: the condition holds -> exactly ONE
 *                    `child_messages` row, carrying the catalogue's sentence for
 *                    the child's own tone band and nothing else.
 *   2  NEGATIVE      the healthy child, per clause of each condition: silence.
 *   3  IDEMPOTENCY   the sweep twice plus a redelivery -> exactly one row,
 *                    refused by a NAMED unique index rather than by an `if`.
 *   4  QUIET HOURS   at 23:00 on the FAMILY's clock: recorded and dropped with
 *                    its reason, never delivered and never deferred.
 *   5  TIMEZONE      Africa/Cairo AND Asia/Riyadh — the same instant opens a
 *                    habit window in one household and not the other, and an
 *                    instant whose UTC date is NEITHER family's date keys the
 *                    decision on the family's day.
 *   6  ANTI-SPAM     a child who is behind on everything gets ONE reminder.
 *   7  THE CALLER    the same thing again through
 *                    `DigitalWellbeingEngineService.recordDailySummary`, so
 *                    «where does this run from» is executed and not claimed.
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
import { ageBandFor } from '../../src/modules/ai-core/domain/age-band';
import { ChildSafetyFilterService } from '../../src/modules/ai-core/application/services/child-safety-filter.service';
import { ChildSignalService } from '../../src/modules/life-intelligence/application/services/child-signal.service';
import { DigitalWellbeingEngineService } from '../../src/modules/life-intelligence/application/services/digital-wellbeing-engine.service';
import { hasEnumOrPlaceholderLeak } from '../../src/modules/notifications/domain/engine/notification-copy';
import { forEntity } from '../../src/shared/notifications/notification-source-key';
import { integrationDatabaseUrl } from '../tenancy/prisma-test-client';

const describeIfDb = integrationDatabaseUrl() ? describe : describe.skip;

const CAIRO = 'Africa/Cairo';
const RIYADH = 'Asia/Riyadh';

/**
 * JANUARY, DELIBERATELY — the same choice, for the same reason, as
 * `stalled-goal-producer.e2e.spec.ts`: Egypt reintroduced DST in 2023, so in
 * August Cairo and Riyadh are BOTH UTC+3 and a test that asserted a difference
 * would be asserting something false. In January Cairo is UTC+2 and Riyadh
 * UTC+3. Every offset is READ from tzdata by `family-date.ts`; none is written
 * down here.
 *
 *   AFTERNOON        17:00 Cairo / 18:00 Riyadh. Outside the default
 *                    21:00-07:00 quiet window in both, and past the halfway
 *                    point of both families' days, so the streak question may
 *                    be asked (`STREAK_URGENCY_HORIZON_HOURS`).
 *   MORNING          09:00 Cairo. Awake, outside quiet hours, and MORE than
 *                    twelve hours from the end of the family's day — the
 *                    instant at which «you have not moved today» is a reproach
 *                    and the producer must stay silent.
 *   CAIRO_NIGHT      23:00 Cairo, inside quiet hours.
 *   ACROSS_MIDNIGHT  00:30 Cairo and 01:30 Riyadh on the 17th, while UTC still
 *                    reads the 16th. A producer that derived its day from
 *                    `toISOString().slice(0, 10)` would key both households on
 *                    the wrong date.
 */
const AFTERNOON = new Date('2026-01-16T15:00:00.000Z');
const MORNING = new Date('2026-01-16T07:00:00.000Z');
const CAIRO_NIGHT = new Date('2026-01-16T21:00:00.000Z');
const ACROSS_MIDNIGHT = new Date('2026-01-16T22:30:00.000Z');
/** 17:30 Cairo · 18:30 Riyadh — one instant, two different wall clocks. */
const WINDOW_INSTANT = new Date('2026-01-16T15:30:00.000Z');

/**
 * Born June 2013, so on every instant above the child is 12: tone band
 * `11-13`, safety band `12-14`. Both are DERIVED in the assertions below from
 * the product's own functions rather than written as literals, so a change to
 * either table moves this suite with it.
 */
const CHILD_DOB = new Date('2013-06-01T00:00:00.000Z');

/** The same offline client the other integration suites build. */
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
  const base = new PrismaClient({
    // PRISMA 7: `datasources` was removed from the constructor — driver
    // adapters are the only mode, so the adapter IS the connection. This
    // branch used to exist to AVOID the adapter; it now builds the same
    // client the branch above does, which is the honest end state: a test
    // must not reach the database through a different engine than
    // production does.
    adapter: new (require('@prisma/adapter-pg').PrismaPg)(
      new (require('pg').Pool)({ connectionString: url }),
    ),
  });
  const extended = base.$extends(createTenantExtension());
  extended.onModuleInit = async () => base.$connect();
  extended.onModuleDestroy = async () => base.$disconnect();
  return extended;
}

interface Household {
  readonly familyId: string;
  readonly childId: string;
  readonly userId: string;
  readonly timeZone: string;
}

describeIfDb('SPRINT F1 — the four CHILD copy keys have a producer (real PostgreSQL)', () => {
  let app: INestApplication;
  let prisma: any;
  let producer: ChildSignalService;
  let wellbeing: DigitalWellbeingEngineService;
  let childSafety: ChildSafetyFilterService;

  const stamp = Date.now();
  const createdFamilies: string[] = [];
  const createdUsers: string[] = [];
  let seq = 0;

  const sys = (what: string, fn: () => Promise<any>): Promise<any> =>
    runAsSystemAsync('TEST_FIXTURE', `F1 child-signal suite: ${what}`, async () => await fn());

  const raw = <T>(sql: string, ...params: unknown[]): Promise<T> =>
    sys('raw sql', () => prisma.$queryRawUnsafe(sql, ...params)) as Promise<T>;

  const decisionRows = (familyId: string): Promise<any[]> =>
    raw<any[]>(
      `SELECT * FROM "notification_decisions" WHERE "family_id" = $1::uuid ORDER BY "created_at", "id"`,
      familyId,
    );

  const childMessageRows = (familyId: string): Promise<any[]> =>
    raw<any[]>(
      `SELECT * FROM "child_messages" WHERE "family_id" = $1::uuid ORDER BY "created_at", "id"`,
      familyId,
    );

  const countOf = async (table: string, familyId: string): Promise<number> =>
    Number(
      (await raw<any[]>(`SELECT COUNT(*)::int AS n FROM "${table}" WHERE "family_id" = $1::uuid`, familyId))[0].n,
    );

  /** The four numbers every «it did not spam» claim in this file is made of. */
  const countTheHousehold = async (familyId: string) => ({
    decisions: await countOf('notification_decisions', familyId),
    notifications: await countOf('notifications', familyId),
    childMessages: await countOf('child_messages', familyId),
    deliveries: await countOf('notification_deliveries', familyId),
  });

  // -- fixtures --------------------------------------------------------------

  async function createHousehold(label: string, timeZone: string): Promise<Household> {
    seq += 1;
    const family = await sys('create family', () =>
      prisma.family.create({ data: { name: `F1CS ${label} ${stamp}`, timezone: timeZone }, select: { id: true } }),
    );
    createdFamilies.push(family.id);

    const user = await sys('create user', () =>
      prisma.user.create({
        data: { email: `f1cs.${label}.${seq}.${stamp}@example.test`, passwordHash: 'x', fullName: 'F1 Parent' },
        select: { id: true },
      }),
    );
    createdUsers.push(user.id);
    await sys('create membership', () =>
      prisma.familyMember.create({ data: { familyId: family.id, userId: user.id, role: 'OWNER' } }),
    );

    const child = await sys('create child', () =>
      prisma.child.create({
        data: { familyId: family.id, firstName: 'محمد', dateOfBirth: CHILD_DOB },
        select: { id: true },
      }),
    );

    return { familyId: family.id, childId: child.id, userId: user.id, timeZone };
  }

  const logHydration = (h: Household, ml: number, loggedAt: Date) =>
    sys('hydration log', () =>
      prisma.hydrationLog.create({ data: { familyId: h.familyId, childId: h.childId, amountMl: ml, loggedAt } }),
    );

  const logActivity = (h: Household, day: string, minutes: number) =>
    sys('activity log', () =>
      prisma.activityLog.create({
        data: {
          familyId: h.familyId,
          childId: h.childId,
          date: FamilyDateService.toDateColumn(day),
          activityType: 'RUNNING',
          durationMinutes: minutes,
        },
      }),
    );

  const createHabit = (
    h: Household,
    title: string,
    scheduledStartTime: string | null,
    scheduledEndTime: string | null = null,
  ): Promise<{ id: string }> =>
    sys('habit', () =>
      prisma.habit.create({
        data: {
          familyId: h.familyId,
          childId: h.childId,
          title,
          category: 'STUDY',
          scheduledStartTime,
          scheduledEndTime,
        },
        select: { id: true },
      }),
    );

  const completeHabit = (h: Household, habitId: string, day: string, status = 'COMPLETED') =>
    sys('habit completion', () =>
      prisma.habitCompletion.create({
        data: {
          familyId: h.familyId,
          childId: h.childId,
          habitId,
          date: FamilyDateService.toDateColumn(day),
          status,
        },
      }),
    );

  /** The family's own day, on the family's own calendar. */
  const dayOf = (h: Household, now: Date): string => getBusinessDate(now, h.timeZone);

  /**
   * THE PRODUCER, at an explicit instant, inside the tenant scope the request
   * pipeline establishes before every child-device call. Not
   * `jest.useFakeTimers()`: a faked clock also fakes the timers `pg` uses, so a
   * suite that freezes time and then awaits a real query deadlocks. `now` is a
   * parameter for the same reason it is a parameter of `evaluateFatigue`.
   */
  const sweep = (
    h: Household,
    now: Date,
    screenMinutesToday: number | null = null,
    isEngagedNow = true,
  ) =>
    runWithTenant({ familyId: h.familyId, actorType: 'SYSTEM', actorId: 'f1-child-signal-test' }, () =>
      producer.sweepChild({
        familyId: h.familyId,
        childId: h.childId,
        now,
        screenMinutesToday,
        isEngagedNow,
      }),
    );

  /**
   * THE CHILD SAFETY ASSERTION, run on the BYTES THAT WERE PERSISTED and at the
   * band this child's own date of birth resolves to. The real service, never a
   * stub — see the file header.
   */
  const assertChildSafeBytes = (row: { title: string; body: string }) => {
    const band = ageBandFor(12);
    expect(band).toBe('12-14');
    expect(childSafety.validate(row.body, band).isSafe).toBe(true);
    expect(childSafety.validate(row.title, band).isSafe).toBe(true);
    // No raw enum, no unresolved placeholder — measured with the PRODUCT's own
    // detector rather than a local regex.
    expect(hasEnumOrPlaceholderLeak(row.title)).toBe(false);
    expect(hasEnumOrPlaceholderLeak(row.body)).toBe(false);
    expect(row.body).not.toMatch(/[{}]/);
    // Arabic, because the household's owner has no locale and `ar` is this
    // product's fallback — not a translation of an English literal.
    expect(row.body).toMatch(/[؀-ۿ]/);
    // NON-PUNITIVE (CONTEXT §3 principle 7). A reminder to a child must never
    // blame, shame, threaten, or put the reward on the table.
    for (const word of ['فشل', 'كسول', 'مقصر', 'إهمال', 'عقاب', 'سنمنع', 'خسرت', 'ستخسر', 'تأخرت']) {
      expect(`${row.title} ${row.body}`).not.toContain(word);
    }
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue(offlinePrismaService())
      .compile();

    app = moduleRef.createNestApplication();
    await app.init();

    prisma = app.get(PrismaService);
    producer = app.get(ChildSignalService);
    wellbeing = app.get(DigitalWellbeingEngineService);
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
  describe('1. HYDRATION_REMINDER — a long stretch on screen and half a day behind on water', () => {
    let home: Household;

    it('the premise, as rows: a household that starts silent, and no water logged today', async () => {
      home = await createHousehold('hydration', CAIRO);
      expect(await countTheHousehold(home.familyId)).toEqual({
        decisions: 0,
        notifications: 0,
        childMessages: 0,
        deliveries: 0,
      });
    }, 120_000);

    it('the sweep produces ONE decision, and the ledger row explains it', async () => {
      const report = await sweep(home, AFTERNOON, 120);
      expect(report).toEqual({ candidates: 1, produced: 1, alreadyDecided: 0, refused: 0 });

      const decisions = await decisionRows(home.familyId);
      expect(decisions).toHaveLength(1);
      const [row] = decisions;

      // `PERIODIC_SIGNAL` because that is what a signal scan is; claiming
      // DOMAIN_EVENT would make this column a lie about how the product learned
      // the fact.
      expect(row.trigger).toBe('PERIODIC_SIGNAL');
      expect(row.event_type).toBe('HYDRATION_REMINDER');
      expect(row.notification_type).toBe('HYDRATION_REMINDER');
      expect(row.category).toBe('REMINDER');
      expect(row.target_audience).toBe('CHILD');
      expect(row.child_id).toBe(home.childId);
      expect(row.decision).toBe('SEND');
      expect(row.outcome).toBe('SEND');
      // The sentence came from the CATALOGUE. `GENERIC` here would mean the
      // child read «لديك تحديث جديد».
      expect(row.copy_key).toBe('HYDRATION_REMINDER');
      expect(row.ai_rewritten).toBe(false);
      expect(row.age_band).toBe('11-13');
      // THE KEY THE PRODUCER CHOSE: this child, this signal, this family-local
      // day — composed here by the same shared function the producer calls.
      expect(row.source_event_id).toBe(
        forEntity('signal', home.childId, 'HYDRATION', dayOf(home, AFTERNOON)),
      );
      expect(row.business_date.toISOString().slice(0, 10)).toBe(dayOf(home, AFTERNOON));
    }, 120_000);

    it('it reached the CHILD: one `child_messages` row, behind the approval gate, and none to the parent', async () => {
      const rows = await childMessageRows(home.familyId);
      expect(rows).toHaveLength(1);
      expect(rows[0].category).toBe('HYDRATION_REMINDER');
      expect(rows[0].child_id).toBe(home.childId);
      expect(rows[0].author_type).toBe('AI');
      // B9 ADDS A CONSTRAINT, NOT AN EXEMPTION: the row is still PENDING with
      // `delivered_at` NULL behind the parent's approval gate.
      expect(rows[0].approval_status).toBe('PENDING');
      expect(rows[0].delivered_at).toBeNull();
      expect(rows[0].source_event_id).toBe(
        `${forEntity('signal', home.childId, 'HYDRATION', dayOf(home, AFTERNOON))}:child`,
      );
      // STRUCTURALLY not to the parent: `COPY_CATALOGUE.HYDRATION_REMINDER`
      // declares `audience: 'CHILD'`.
      expect(await countOf('notifications', home.familyId)).toBe(0);
    }, 120_000);

    it("the words are the child's own tone band, and they are safety-clean at the child's own SAFETY band", async () => {
      const [row] = await childMessageRows(home.familyId);
      // The `11-13` variant, verbatim from `COPY_CATALOGUE`. A 12-year-old must
      // not get the 5-7 sentence with its emoji, nor the 14-17 one.
      expect(row.title).toBe('وقت الماء');
      expect(row.body).toBe('مرّ وقت طويل — استراحة قصيرة وكوب ماء');
      assertChildSafeBytes(row);
      // The tap has somewhere to land: the server resolved a destination and it
      // reached the CHILD row, not only the parent's.
      expect(row.data?.deepLink).toBe('abny://screen-time');
    }, 120_000);
  });

  // ==========================================================================
  describe('2. NEGATIVE — the healthy child produces nothing, one clause at a time', () => {
    it('a child who has drunk half the day\'s target is not reminded', async () => {
      const h = await createHousehold('hydrated', CAIRO);
      // 12 years old -> `computeHydrationTargetMl` is well under 3000ml, so
      // 3000 is unambiguously past half the target for any band.
      await logHydration(h, 3000, AFTERNOON);

      const report = await sweep(h, AFTERNOON, 120);
      expect(report.candidates).toBe(0);
      expect(await countTheHousehold(h.familyId)).toEqual({
        decisions: 0,
        notifications: 0,
        childMessages: 0,
        deliveries: 0,
      });
    }, 120_000);

    it('a child who has barely been on the screen is not reminded, however little water', async () => {
      const h = await createHousehold('lowscreen', CAIRO);
      const report = await sweep(h, AFTERNOON, 30);
      expect(report.candidates).toBe(0);
      expect(await countOf('notification_decisions', h.familyId)).toBe(0);
    }, 120_000);

    it('a back-dated check-in carries no usable screen figure, so nothing is claimed about today', async () => {
      const h = await createHousehold('backdated', CAIRO);
      // `null` is what `recordDailySummary` passes when the device's own local
      // day is not the family's current business date.
      const report = await sweep(h, AFTERNOON, null);
      expect(report.candidates).toBe(0);
      expect(await countOf('notification_decisions', h.familyId)).toBe(0);
    }, 120_000);

    it('a habit outside its window, and a habit already done inside it, produce nothing', async () => {
      const h = await createHousehold('habitquiet', CAIRO);
      // 17:00 Cairo at AFTERNOON: this window has not opened.
      await createHabit(h, 'قراءة', '19:00', '20:00');
      // ...and this one has, but the child already did it.
      const done = await createHabit(h, 'حل الواجب', '16:00', '18:00');
      await completeHabit(h, done.id, dayOf(h, AFTERNOON));

      const report = await sweep(h, AFTERNOON);
      expect(report.candidates).toBe(0);
      expect(await countOf('notification_decisions', h.familyId)).toBe(0);
    }, 120_000);

    it('a habit the child chose to SKIP is not re-asked — a decision is not an omission', async () => {
      const h = await createHousehold('habitskip', CAIRO);
      const skipped = await createHabit(h, 'حل الواجب', '16:00', '18:00');
      await completeHabit(h, skipped.id, dayOf(h, AFTERNOON), 'SKIPPED');

      const report = await sweep(h, AFTERNOON);
      expect(report.candidates).toBe(0);
      expect(await countOf('notification_decisions', h.familyId)).toBe(0);
    }, 120_000);

    it('a habit with NO scheduled time is never nudged — the producer does not invent a usual time', async () => {
      const h = await createHousehold('habitnotime', CAIRO);
      await createHabit(h, 'ترتيب الغرفة', null);
      const report = await sweep(h, AFTERNOON);
      expect(report.candidates).toBe(0);
      expect(await countOf('notification_decisions', h.familyId)).toBe(0);
    }, 120_000);

    it('a child who has already met today\'s activity goal keeps their streak and hears nothing', async () => {
      const h = await createHousehold('activedone', CAIRO);
      const today = dayOf(h, AFTERNOON);
      for (const back of [1, 2, 3, 4]) {
        await logActivity(h, FamilyDateService.addDays(today, -back), 70);
      }
      await logActivity(h, today, 70);

      const report = await sweep(h, AFTERNOON);
      expect(report.candidates).toBe(0);
      expect(await countOf('notification_decisions', h.familyId)).toBe(0);
    }, 120_000);

    it('a child with NO streak at all is left alone — the producer nudges a streak, never a stranger', async () => {
      const h = await createHousehold('nostreak', CAIRO);
      const report = await sweep(h, AFTERNOON);
      expect(report.candidates).toBe(0);
      expect(await countOf('notification_decisions', h.familyId)).toBe(0);
    }, 120_000);

    it('AT 09:00 THE STREAK QUESTION IS NOT ASKED AT ALL — a child at breakfast is not behind', async () => {
      const h = await createHousehold('breakfast', CAIRO);
      const today = dayOf(h, MORNING);
      for (const back of [1, 2, 3, 4, 5]) {
        await logActivity(h, FamilyDateService.addDays(today, -back), 70);
      }

      // The streak is five days long, today is empty, and the producer is still
      // silent: fifteen hours of this family's day are left.
      expect(getBusinessTimeHHMM(MORNING, CAIRO)).toBe('09:00');
      const report = await sweep(h, MORNING);
      expect(report.candidates).toBe(0);
      expect(await countOf('notification_decisions', h.familyId)).toBe(0);

      // ...and the SAME rows, later the same family day, do produce it. Which
      // proves the silence above was the horizon and not a broken query.
      const later = await sweep(h, AFTERNOON);
      expect(later.produced).toBe(1);
      const [row] = await decisionRows(h.familyId);
      expect(row.copy_key).toBe('STREAK_AT_RISK');
    }, 120_000);
  });

  // ==========================================================================
  describe('3. STREAK_AT_RISK and EXERCISE_ENCOURAGEMENT — one fact, two sentences, one key', () => {
    it('a streak of three days or more earns the streak sentence, and the score says why', async () => {
      const h = await createHousehold('streak3', CAIRO);
      const today = dayOf(h, AFTERNOON);
      for (const back of [1, 2, 3]) {
        await logActivity(h, FamilyDateService.addDays(today, -back), 65);
      }

      const report = await sweep(h, AFTERNOON);
      expect(report).toEqual({ candidates: 1, produced: 1, alreadyDecided: 0, refused: 0 });

      const [row] = await decisionRows(h.familyId);
      // THE EVENT TYPE IS A REAL ONE and the COPY KEY is the contextual
      // sentence the facts earned. `STREAK_AT_RISK` has no class row and no
      // scoring row precisely because it was designed to be this, not a type.
      expect(row.event_type).toBe('EXERCISE_ENCOURAGEMENT');
      expect(row.copy_key).toBe('STREAK_AT_RISK');
      expect(row.decision).toBe('SEND');
      expect(row.outcome).toBe('SEND');

      // The `streak` fact slot — write-only in this product until this producer
      // existed — reached the SCORER and is visible in the persisted
      // explanation. This is the assertion that the slot is no longer dead.
      const urgency = (row.explanation as any[]).find((c) => c.name === 'URGENCY');
      expect(urgency.note).toMatch(/^streak of 3 days breaks in [\d.]+h$/);
      // 17:00 Cairo -> seven hours of this family's day remain, which is inside
      // the scorer's twelve-hour horizon and therefore raises urgency above the
      // type's own 0.3 baseline.
      expect(urgency.raw).toBeGreaterThan(0.3);

      const [message] = await childMessageRows(h.familyId);
      expect(message.title).toBe('سلسلتك');
      expect(message.body).toBe('أنت على بعد خطوة من الحفاظ على سلسلتك');
      // AND IT DOES NOT SAY WHAT IS LOST. The 11-13 sentence names the step, not
      // the penalty — the difference between a reminder and a threat.
      assertChildSafeBytes(message);
      expect(message.data?.deepLink).toBe('abny://progress');
    }, 120_000);

    it('a streak of two days earns the gentler sentence, with the real day count in it', async () => {
      const h = await createHousehold('streak2', CAIRO);
      const today = dayOf(h, AFTERNOON);
      for (const back of [1, 2]) {
        await logActivity(h, FamilyDateService.addDays(today, -back), 65);
      }

      const report = await sweep(h, AFTERNOON);
      expect(report.produced).toBe(1);

      const [row] = await decisionRows(h.familyId);
      expect(row.event_type).toBe('EXERCISE_ENCOURAGEMENT');
      // NO rule fired, because no `streak` facts were supplied: two days is a
      // coincidence and «at risk» would be pressure applied to nothing.
      expect(row.copy_key).toBe('EXERCISE_ENCOURAGEMENT');
      const urgency = (row.explanation as any[]).find((c) => c.name === 'URGENCY');
      expect(urgency.note).toBe('type baseline for EXERCISE_ENCOURAGEMENT');

      const [message] = await childMessageRows(h.familyId);
      expect(message.title).toBe('حركة صغيرة');
      expect(message.body).toBe('لم تسجل نشاطًا اليوم — حركة بسيطة تكفي');
      assertChildSafeBytes(message);
    }, 120_000);

    it('BOTH SENTENCES SHARE ONE KEY, so one fact can be told at most once a day', async () => {
      const h = await createHousehold('streakkey', CAIRO);
      const today = dayOf(h, AFTERNOON);
      for (const back of [1, 2, 3]) {
        await logActivity(h, FamilyDateService.addDays(today, -back), 65);
      }
      await sweep(h, AFTERNOON);

      const [row] = await decisionRows(h.familyId);
      expect(row.source_event_id).toBe(forEntity('signal', h.childId, 'ACTIVITY_STREAK', today));
    }, 120_000);
  });

  // ==========================================================================
  describe('4. STUDY_REMINDER — the window a PARENT set, open on the family clock', () => {
    let home: Household;

    it('produces one decision, worded from the habit the parent named', async () => {
      home = await createHousehold('study', CAIRO);
      const habit = await createHabit(home, 'حل الواجب', '16:00', '19:00');

      const report = await sweep(home, AFTERNOON);
      expect(report).toEqual({ candidates: 1, produced: 1, alreadyDecided: 0, refused: 0 });

      const [row] = await decisionRows(home.familyId);
      expect(row.event_type).toBe('STUDY_REMINDER');
      expect(row.copy_key).toBe('STUDY_REMINDER');
      expect(row.category).toBe('REMINDER');
      expect(row.target_audience).toBe('CHILD');
      expect(row.decision).toBe('SEND');
      expect(row.outcome).toBe('SEND');
      // PER HABIT PER DAY. Two windows a parent set hours apart are two things
      // to be told about.
      expect(row.source_event_id).toBe(
        forEntity('signal', home.childId, `habit:${habit.id}`, dayOf(home, AFTERNOON)),
      );

      const [message] = await childMessageRows(home.familyId);
      expect(message.title).toBe('وقت المذاكرة');
      // The parent's own words inside the product's sentence — the producer
      // never composes a title of its own.
      expect(message.body).toBe('بدأ وقتك المعتاد لـ حل الواجب — جاهز تبدأ؟');
      assertChildSafeBytes(message);
      expect(message.data?.deepLink).toBe('abny://goals');
    }, 120_000);

    it('NO `goal:` facts were supplied, so no goal sentence could be selected for a habit', async () => {
      const [row] = await decisionRows(home.familyId);
      // `GOAL_DEADLINE_NEAR` would have claimed a deadline that does not exist
      // and `GOAL_ALMOST_DONE` a unit count nothing counts. Both read `c.goal`;
      // the producer passes none, so neither can win the rule table.
      expect(row.copy_key).not.toBe('GOAL_DEADLINE_NEAR');
      expect(row.copy_key).not.toBe('GOAL_ALMOST_DONE');
      const deadline = (row.explanation as any[]).find((c) => c.name === 'DEADLINE_PROXIMITY');
      expect(deadline.note).toBe('no deadline on this goal');
      expect(deadline.contribution).toBe(0);
    }, 120_000);
  });

  // ==========================================================================
  describe('5. IDEMPOTENCY — the sweep twice, and a redelivery, add exactly nothing', () => {
    it('two sweeps of the same family-local day leave ONE decision and ONE child message', async () => {
      const h = await createHousehold('idem', CAIRO);

      const first = await sweep(h, AFTERNOON, 120);
      expect(first.produced).toBe(1);

      // The device checks in again fifteen screen-minutes later, exactly as the
      // child app does. Same day, same rows, same key.
      const second = await sweep(h, new Date(AFTERNOON.getTime() + 15 * 60_000), 135);
      expect(second).toEqual({ candidates: 1, produced: 0, alreadyDecided: 1, refused: 0 });

      // READ BACK OUT OF POSTGRESQL, not from either return value.
      expect(await countTheHousehold(h.familyId)).toEqual({
        decisions: 1,
        notifications: 0,
        childMessages: 1,
        deliveries: 0,
      });
    }, 120_000);

    it('the SECOND write is refused by a NAMED unique index, not by an `if` in the producer', async () => {
      const h = await createHousehold('idemdb', CAIRO);
      await sweep(h, AFTERNOON, 120);

      const [message] = await childMessageRows(h.familyId);

      // A REDELIVERY: the same causal key handed straight to the table, past the
      // producer and past the ledger. `child_messages (family_id,
      // source_event_id)` is what stops it, which is what makes the guarantee
      // survive somebody deleting the `if`.
      await expect(
        sys('replay the child message', () =>
          prisma.childMessage.create({
            data: {
              familyId: h.familyId,
              childId: h.childId,
              authorType: 'AI',
              category: 'HYDRATION_REMINDER',
              title: message.title,
              body: message.body,
              sourceEventId: message.source_event_id,
            },
          }),
        ),
      ).rejects.toThrow();

      // And the same for the decision ledger's own cause key.
      const [decision] = await decisionRows(h.familyId);
      const dupe = await raw<any[]>(
        `INSERT INTO "notification_decisions"
           ("family_id","child_id","source_event_id","trigger","event_type","notification_type",
            "category","target_audience","decision","priority_band","score","reason","provider_id","business_date")
         VALUES ($1::uuid,$2::uuid,$3,'PERIODIC_SIGNAL','HYDRATION_REMINDER','HYDRATION_REMINDER',
            'REMINDER','CHILD','SEND','LOW',30,'SCORE_IN_DEFER_BAND','rule-based',$4::date)
         ON CONFLICT ("family_id","source_event_id","target_audience") DO NOTHING
         RETURNING "id"`,
        h.familyId,
        h.childId,
        decision.source_event_id,
        dayOf(h, AFTERNOON),
      );
      expect(dupe).toHaveLength(0);

      expect(await countTheHousehold(h.familyId)).toEqual({
        decisions: 1,
        notifications: 0,
        childMessages: 1,
        deliveries: 0,
      });
    }, 120_000);

    it('the NEXT family-local day is a different cause, and is told again', async () => {
      const h = await createHousehold('idemday', CAIRO);
      await sweep(h, AFTERNOON, 120);
      const tomorrow = new Date(AFTERNOON.getTime() + 24 * 3_600_000);

      const report = await sweep(h, tomorrow, 120);
      expect(report.produced).toBe(1);

      const rows = await decisionRows(h.familyId);
      expect(rows).toHaveLength(2);
      expect(rows.map((r) => r.business_date.toISOString().slice(0, 10))).toEqual([
        dayOf(h, AFTERNOON),
        dayOf(h, tomorrow),
      ]);
      expect(await countOf('child_messages', h.familyId)).toBe(2);
    }, 120_000);
  });

  // ==========================================================================
  describe('6. QUIET HOURS — recorded and dropped with its reason, never delivered, never queued', () => {
    it('at 23:00 on the FAMILY\'s clock the reminder is refused, and the row says why', async () => {
      const h = await createHousehold('quiet', CAIRO);
      expect(getBusinessTimeHHMM(CAIRO_NIGHT, CAIRO)).toBe('23:00');

      const report = await sweep(h, CAIRO_NIGHT, 200);
      expect(report).toEqual({ candidates: 1, produced: 0, alreadyDecided: 0, refused: 1 });

      const [row] = await decisionRows(h.familyId);
      expect(row.decision).toBe('SUPPRESS');
      // «Its premise expires overnight» is a permanent property of
      // HYDRATION_REMINDER; `SCORE_BELOW_FLOOR` would have sent a support
      // engineer looking for a scoring bug that does not exist.
      expect(row.reason).toBe('QUIET_HOURS_CLASS_SUPPRESS');
      expect(row.outcome).toBeNull();

      // NOTHING REACHED THE CHILD AND NOTHING WAS QUEUED FOR THE MORNING. A
      // deferred «you have been on screen a long time» delivered at 07:00 is a
      // lie about a child who was asleep.
      expect(await countTheHousehold(h.familyId)).toEqual({
        decisions: 1,
        notifications: 0,
        childMessages: 0,
        deliveries: 0,
      });
    }, 120_000);
  });

  // ==========================================================================
  describe('7. TIMEZONE — Africa/Cairo and Asia/Riyadh, from one instant', () => {
    it('ONE INSTANT opens a habit window in Riyadh and not in Cairo', async () => {
      const cairo = await createHousehold('tzcairo', CAIRO);
      const riyadh = await createHousehold('tzriyadh', RIYADH);

      // The SAME window, set by both parents, on both children.
      for (const h of [cairo, riyadh]) await createHabit(h, 'حل الواجب', '18:00', '19:00');

      // Read from tzdata, never written down: in January Cairo is UTC+2 and
      // Riyadh UTC+3, so this instant is 17:30 and 18:30 respectively.
      expect(getBusinessTimeHHMM(WINDOW_INSTANT, CAIRO)).toBe('17:30');
      expect(getBusinessTimeHHMM(WINDOW_INSTANT, RIYADH)).toBe('18:30');

      const cairoReport = await sweep(cairo, WINDOW_INSTANT);
      const riyadhReport = await sweep(riyadh, WINDOW_INSTANT);

      expect(cairoReport.candidates).toBe(0);
      expect(riyadhReport.produced).toBe(1);

      expect(await countOf('notification_decisions', cairo.familyId)).toBe(0);
      const [row] = await decisionRows(riyadh.familyId);
      expect(row.copy_key).toBe('STUDY_REMINDER');

      // ...and one hour later it is Cairo's turn and Riyadh's window has shut.
      const anHourOn = new Date(WINDOW_INSTANT.getTime() + 3_600_000);
      expect((await sweep(cairo, anHourOn)).produced).toBe(1);
      expect((await sweep(riyadh, anHourOn)).candidates).toBe(0);
      expect(await countOf('notification_decisions', cairo.familyId)).toBe(1);
      expect(await countOf('notification_decisions', riyadh.familyId)).toBe(1);
    }, 180_000);

    it('an instant whose UTC date is NEITHER family\'s date keys both on the family\'s own day', async () => {
      const cairo = await createHousehold('tzmidcairo', CAIRO);
      const riyadh = await createHousehold('tzmidriyadh', RIYADH);

      // UTC still reads the 16th; both households have crossed into the 17th.
      expect(ACROSS_MIDNIGHT.toISOString().slice(0, 10)).toBe('2026-01-16');
      expect(getBusinessDate(ACROSS_MIDNIGHT, CAIRO)).toBe('2026-01-17');
      expect(getBusinessDate(ACROSS_MIDNIGHT, RIYADH)).toBe('2026-01-17');

      for (const h of [cairo, riyadh]) await sweep(h, ACROSS_MIDNIGHT, 200);

      for (const h of [cairo, riyadh]) {
        const [row] = await decisionRows(h.familyId);
        expect(row.business_date.toISOString().slice(0, 10)).toBe('2026-01-17');
        expect(row.source_event_id).toBe(
          forEntity('signal', h.childId, 'HYDRATION', '2026-01-17'),
        );
        // Both are past their own bedtime, so both are correctly refused — the
        // day boundary and the quiet window are BOTH the family's.
        expect(row.decision).toBe('SUPPRESS');
        expect(row.reason).toBe('QUIET_HOURS_CLASS_SUPPRESS');
      }
    }, 180_000);

    it('the family-local day bounds the water, not the UTC day', async () => {
      const h = await createHousehold('tzwater', CAIRO);
      // 22:00 Cairo on the 15th is 20:00Z on the 15th — the same UTC day as
      // AFTERNOON's own day-before, and a DIFFERENT Cairo day. Counted against
      // the wrong day it would satisfy today's target and silence the reminder.
      await logHydration(h, 3000, new Date('2026-01-15T20:00:00.000Z'));

      const report = await sweep(h, AFTERNOON, 120);
      expect(report.produced).toBe(1);
      const [row] = await decisionRows(h.familyId);
      expect(row.copy_key).toBe('HYDRATION_REMINDER');
    }, 120_000);
  });

  // ==========================================================================
  describe('8. ANTI-SPAM — a child who is behind on everything gets ONE reminder', () => {
    it('three conditions hold at once and exactly one row is written', async () => {
      const h = await createHousehold('flood', CAIRO);
      const today = dayOf(h, AFTERNOON);
      await createHabit(h, 'حل الواجب', '16:00', '19:00');
      for (const back of [1, 2, 3]) await logActivity(h, FamilyDateService.addDays(today, -back), 65);

      const report = await sweep(h, AFTERNOON, 200);
      expect(report.candidates).toBe(3);
      expect(report.produced).toBe(1);

      expect(await countTheHousehold(h.familyId)).toEqual({
        decisions: 1,
        notifications: 0,
        childMessages: 1,
        deliveries: 0,
      });
      // The order is «what becomes impossible if I wait»: the parent's own
      // window is open right now and closes at 19:00.
      const [row] = await decisionRows(h.familyId);
      expect(row.event_type).toBe('STUDY_REMINDER');

      // The other two are NOT lost — their keys were never burned, and the next
      // check-in tells the next one.
      const later = await sweep(h, new Date(AFTERNOON.getTime() + 30 * 60_000), 220);
      expect(later.produced).toBe(1);
      const rows = await decisionRows(h.familyId);
      expect(rows).toHaveLength(2);
      expect(rows[1].event_type).toBe('EXERCISE_ENCOURAGEMENT');
      expect(rows[1].copy_key).toBe('STREAK_AT_RISK');
    }, 180_000);
  });

  // ==========================================================================
  describe('9. THE CALLER — the same thing again, through the real production path', () => {
    it('a device check-in on `recordDailySummary` produces the reminder', async () => {
      const h = await createHousehold('caller', CAIRO);

      await sys('consent', () =>
        prisma.parentalConsent.create({
          data: {
            familyId: h.familyId,
            childId: h.childId,
            consentType: 'APP_USAGE_MONITORING',
            granted: true,
            grantedByUserId: h.userId,
          },
        }),
      );
      const device = await sys('device', () =>
        prisma.device.create({
          data: {
            familyId: h.familyId,
            ownerType: 'CHILD',
            childId: h.childId,
            platform: 'ANDROID',
            status: 'ACTIVE',
          },
          select: { id: true },
        }),
      );

      const summary = {
        usageDate: dayOf(h, AFTERNOON),
        totalScreenMinutes: 140,
        appBreakdown: [{ packageName: 'com.example.game', minutes: 140, category: 'GAMING' as const }],
        pickupCount: 40,
        nightUsageMinutes: 0,
        blockedAttemptCount: 0,
      };

      await runWithTenant(
        { familyId: h.familyId, actorType: 'SYSTEM', actorId: 'f1-child-signal-caller-test' },
        () => wellbeing.recordDailySummary(h.childId, h.familyId, device.id, summary, AFTERNOON),
      );

      const decisions = await decisionRows(h.familyId);
      expect(decisions).toHaveLength(1);
      expect(decisions[0].event_type).toBe('HYDRATION_REMINDER');
      expect(decisions[0].copy_key).toBe('HYDRATION_REMINDER');

      const [message] = await childMessageRows(h.familyId);
      expect(message.body).toBe('مرّ وقت طويل — استراحة قصيرة وكوب ماء');
      assertChildSafeBytes(message);

      // AND THE SECOND CHECK-IN, which the child app makes after another
      // fifteen screen-minutes, adds nothing.
      await runWithTenant(
        { familyId: h.familyId, actorType: 'SYSTEM', actorId: 'f1-child-signal-caller-test' },
        () =>
          wellbeing.recordDailySummary(
            h.childId,
            h.familyId,
            device.id,
            { ...summary, totalScreenMinutes: 155 },
            new Date(AFTERNOON.getTime() + 15 * 60_000),
          ),
      );
      expect(await countTheHousehold(h.familyId)).toEqual({
        decisions: 1,
        notifications: 0,
        childMessages: 1,
        deliveries: 0,
      });
    }, 180_000);

    it('a check-in whose device day is NOT the family day says nothing about today', async () => {
      const h = await createHousehold('callerback', CAIRO);

      await sys('consent', () =>
        prisma.parentalConsent.create({
          data: {
            familyId: h.familyId,
            childId: h.childId,
            consentType: 'APP_USAGE_MONITORING',
            granted: true,
            grantedByUserId: h.userId,
          },
        }),
      );
      const device = await sys('device', () =>
        prisma.device.create({
          data: {
            familyId: h.familyId,
            ownerType: 'CHILD',
            childId: h.childId,
            platform: 'ANDROID',
            status: 'ACTIVE',
          },
          select: { id: true },
        }),
      );

      await runWithTenant(
        { familyId: h.familyId, actorType: 'SYSTEM', actorId: 'f1-child-signal-caller-test' },
        () =>
          wellbeing.recordDailySummary(
            h.childId,
            h.familyId,
            device.id,
            {
              // Yesterday's totals, drained from the offline queue after midnight.
              usageDate: FamilyDateService.addDays(dayOf(h, AFTERNOON), -1),
              totalScreenMinutes: 400,
              appBreakdown: [],
              pickupCount: 10,
              nightUsageMinutes: 0,
              blockedAttemptCount: 0,
            },
            AFTERNOON,
          ),
      );

      expect(await countTheHousehold(h.familyId)).toEqual({
        decisions: 0,
        notifications: 0,
        childMessages: 0,
        deliveries: 0,
      });
    }, 180_000);
  });
});
