/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-var-requires */
/**
 * ============================================================================
 * «TODAY» IS THE FAMILY'S OWN DAY, AND «HISTORY» ENDS AT `now` —
 * MEASURED FROM PERSISTED ROWS, AGAINST A REAL POSTGRESQL.
 * ============================================================================
 *
 * TWO DEFECTS, BOTH IN THE SAME SENTENCE OF THE PERSISTED EXPLANATION.
 *
 * `notification_decisions.explanation` carries a `FATIGUE_PENALTY` component
 * whose note reads `today=n/6 hour=n/3 category=n/2`. Before this suite existed
 * NEITHER number meant what it said:
 *
 *   1. «TODAY» WAS A ROLLING TWENTY-FOUR HOURS.
 *      `notification-scoring.ts` bounded the daily count with
 *      `context.now − 24h`. That is a sliding window, and a sliding window never
 *      resets: a household at its daily maximum at 20:00 was still at its
 *      maximum at 07:00 the next morning, because the window had dragged the
 *      previous evening along with it. A household's notification budget is a
 *      DAY — it resets at the family's local midnight — and the arithmetic did
 *      not name a calendar at all, which made it undefined rather than merely
 *      wrong. `notification-context.ts` has documented `timeZone` as «every
 *      calendar question — quiet hours, THE DAILY CAP'S DAY BOUNDARY, a deadline
 *      in local time» since the field existed; the term simply did not read it.
 *
 *   2. THE WINDOW HAD NO CEILING.
 *      `NotificationContextAssembler.readHistory` bounded both inbox reads
 *      BELOW only (`created_at >= since`), so a row stamped AFTER the instant
 *      being evaluated counted as history. Every rule downstream measures AGE,
 *      and `now − createdAt` is NEGATIVE for such a row — smaller than any
 *      window — so it read as «two seconds ago» in the daily count, the hourly
 *      count and the duplicate window alike. MEASURED: a decision evaluated at a
 *      frozen January instant counted a `child_messages` row carrying the
 *      DATABASE's own `now()`, and its note read `hour=1` at a Jan-17 `now`,
 *      which is only possible for a row in the future.
 *
 * WHY BOTH ARE ONE SUITE. They are two halves of one sentence — «which
 * notifications count as this household's load right now» — and each one can
 * mask the other: an unbounded window pulls a future row into a rolling day,
 * and a rolling day hides a correct upper bound behind a count that was going
 * to be wrong anyway. Every section below therefore asserts the note as a whole
 * string, from the row PostgreSQL actually holds.
 *
 * ---------------------------------------------------------------------------
 * WHY JANUARY, AND WHY TWO ZONES.
 *
 * Egypt reintroduced DST in 2023, so in AUGUST Africa/Cairo and Asia/Riyadh are
 * BOTH UTC+3 and a suite written in August cannot tell a timezone bug from a
 * correct answer. In JANUARY Cairo is UTC+2 and Riyadh UTC+3. Every offset below
 * is READ from tzdata by `family-date.ts` and asserted; none is written down.
 *
 * §3 is the section a rolling window cannot pass by accident: ONE instant, two
 * households, and the two families disagree about what day it is — Cairo still
 * on the 15th, Riyadh already on the 16th, and UTC still on the 15th while
 * Riyadh's local midnight has already gone past. A sliding 24-hour window gives
 * both households the IDENTICAL answer at that instant; the family's own
 * calendar gives them two.
 *
 * ---------------------------------------------------------------------------
 * THE HISTORY IS SEEDED WITH EXPLICIT `created_at`, IN SQL.
 *
 * `notifications.created_at` and `child_messages.created_at` both default to
 * `CURRENT_TIMESTAMP` — the DATABASE's clock, not the process's — which is
 * exactly how defect (2) reached production data in the first place. A suite
 * that let the default stand could not place a row on a chosen family-local day
 * at all, and could not place one in the FUTURE on purpose. So every history row
 * below is INSERTed with the instant it is meant to carry, and every assertion
 * reads back out of PostgreSQL.
 *
 * The clock is frozen anyway (`freezeGoldenClock`, January) so that nothing on
 * the path — a dedupe window, a quiet-hours reading, an age in years — depends
 * on the day this suite happens to run.
 *
 * ---------------------------------------------------------------------------
 * THE VEHICLE: `REWARD_GRANTED`, AND IT MUST STAY A REPEATABLE TYPE.
 * ---------------------------------------------------------------------------
 *
 * NOTHING BELOW IS ABOUT REWARDS. This suite's subject is the family-local day
 * boundary and the ceiling on history; the notification type is only the
 * VEHICLE that has to carry a load across those boundaries and be scored
 * against it. So the type is chosen for three properties and no others:
 *
 *   PARENT audience   — the seeded history lives in `notifications`, so the
 *                       candidate must read the PARENT inbox (§5 uses
 *                       `REWARD_GRANTED_CHILD` for the `child_messages` half,
 *                       for the same reason in the mirror).
 *   DEFER class       — `notification-class.ts` classes it DEFER, so a decision
 *                       taken inside quiet hours is a deferral and §3 can assert
 *                       counts at 23:30/00:30 without the quiet-hours matrix
 *                       turning a SUPPRESS into the answer.
 *   REPEATABLE        — and this is the one that is easy to lose.
 *
 * THIS SUITE USED `BADGE_EARNED_PARENT` AND IT STOPPED WORKING AS A VEHICLE.
 * `ONCE_EVER_TYPES` (`notification-policy.ts`) now exempts `BADGE_EARNED` and
 * `BADGE_EARNED_PARENT` from ALL THREE volume loads, on the strength of the
 * `child_badge_awards (child_id, badge_id)` UNIQUE constraint. A type that is
 * exempt from volume cannot demonstrate a volume budget resetting: every
 * `FATIGUE_PENALTY` note came back prefixed `once-ever type — exempt from
 * volume; …` and every contribution came back 0, including the −25 that IS the
 * experiment in §1.2, §2.1 and §3.1.
 *
 * SO THE VEHICLE CHANGED AND THE EXPECTATIONS DID NOT. Every count string in
 * this file — `today=6/6 hour=0/3 category=6/2`, `today=0/6 hour=0/3
 * category=0/2`, `today=1/6 hour=1/3 category=1/2` — every contribution, every
 * verdict and every row count reproduced BYTE FOR BYTE across the swap, which
 * is the evidence that this suite was measuring the day boundary and not the
 * badge. `REWARD_GRANTED` is PARENT, DEFER and repeatable, and its category
 * (`REWARD`) is shared by the seeded history and the candidate alike, so the
 * per-category axis counts the same six rows it always did.
 *
 * DO NOT PUT A ONCE-EVER TYPE BACK IN — not here, and not in
 * `seedParentNotification`. The two must also stay the SAME type: the
 * `category=n/2` axis counts history rows whose category matches the
 * candidate's, so swapping one without the other silently changes the third
 * number in every note.
 */
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'crypto';

import { AppModule } from '../../src/app.module';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { createTenantExtension } from '../../src/common/tenancy/tenant.extension';
import { runAsSystemAsync } from '../../src/common/tenancy/system-context';
import { runWithTenant } from '../../src/common/tenancy/tenant-context';
import {
  getBusinessDate,
  getBusinessTimeHHMM,
  getStartOfBusinessDay,
} from '../../src/common/time/family-date';
import { SmartNotificationEngineService } from '../../src/modules/notification-engine/application/services/smart-notification-engine.service';
import { DEFAULT_NOTIFICATION_POLICY } from '../../src/modules/notifications/domain/engine/notification-policy';
import { freezeGoldenClock } from '../golden/golden-world';
import { integrationDatabaseUrl } from '../tenancy/prisma-test-client';

const describeIfDb = integrationDatabaseUrl() ? describe : describe.skip;

const CAIRO = 'Africa/Cairo';
const RIYADH = 'Asia/Riyadh';
const HOUR = 3_600_000;

/**
 * THE SIX INSTANTS THE «AT ITS DAILY MAXIMUM» HOUSEHOLDS ARE LOADED WITH.
 * 11:00–16:00 in Cairo and 12:00–17:00 in Riyadh — the same six instants land on
 * the 15th of January on BOTH calendars, which is what lets one seeding helper
 * serve both zones without either one's day being assumed.
 */
const SEEDS = [
  new Date('2026-01-15T09:00:00.000Z'),
  new Date('2026-01-15T10:00:00.000Z'),
  new Date('2026-01-15T11:00:00.000Z'),
  new Date('2026-01-15T12:00:00.000Z'),
  new Date('2026-01-15T13:00:00.000Z'),
  new Date('2026-01-15T14:00:00.000Z'),
];
const LAST_SEED = SEEDS[SEEDS.length - 1];

/** 20:00 Cairo on the 15th — the household's own evening, outside its quiet
 * window, and the SAME family-local day as all six seeds. */
const CAIRO_DAY1 = new Date('2026-01-15T18:00:00.000Z');
/** 20:00 Riyadh on the 15th, for the same reason one hour earlier in UTC. */
const RIYADH_DAY1 = new Date('2026-01-15T17:00:00.000Z');

/**
 * 07:00 Cairo / 08:00 Riyadh on the 16th. ONE instant, and it is the NEXT
 * family-local day in BOTH households — while being FIFTEEN HOURS after the last
 * seeded notification, i.e. comfortably inside a rolling twenty-four. That gap
 * is the whole experiment: a sliding window still counts all six, a real day
 * counts none.
 */
const DAY2 = new Date('2026-01-16T05:00:00.000Z');

/**
 * THE SPLIT INSTANT. 23:30 in Cairo on the 15th, 00:30 in Riyadh on the 16th,
 * and 21:30 in UTC on the 15th — so Riyadh's local midnight has passed while
 * neither Cairo's nor UTC's has.
 */
const SPLIT = new Date('2026-01-15T21:30:00.000Z');

/** The frozen wall clock. Nothing in this suite reads it for a decision — every
 * `now` is passed explicitly — but freezing it keeps the paths that DO read a
 * clock (dedupe windows, `@default(now())` on rows this suite does not seed)
 * from making the result depend on the day the suite runs. */
const FROZEN = new Date('2026-01-16T05:00:00.000Z');

interface Household {
  readonly familyId: string;
  readonly childId: string;
  readonly userId: string;
  readonly timeZone: string;
}

describeIfDb('THE FAMILY-LOCAL DAY, AND THE CEILING ON HISTORY (real PostgreSQL)', () => {
  let app: INestApplication;
  let prisma: any;
  let engine: SmartNotificationEngineService;

  const stamp = Date.now();
  const createdFamilies: string[] = [];
  const createdUsers: string[] = [];
  let seq = 0;

  const sys = (what: string, fn: () => Promise<any>): Promise<any> =>
    runAsSystemAsync('TEST_FIXTURE', `family-local-day suite: ${what}`, async () => await fn());

  const raw = <T>(sql: string, ...params: unknown[]): Promise<T> =>
    sys('raw sql', () => prisma.$queryRawUnsafe(sql, ...params)) as Promise<T>;

  const exec = (sql: string, ...params: unknown[]): Promise<any> =>
    sys('raw exec', () => prisma.$executeRawUnsafe(sql, ...params));

  const decisionRows = (familyId: string): Promise<any[]> =>
    raw<any[]>(
      `SELECT * FROM "notification_decisions" WHERE "family_id" = $1::uuid ORDER BY "created_at", "id"`,
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

  /** The persisted arithmetic for one term of one decision row. Read out of the
   * JSONB column, never recomputed — an explanation that has to be recomputed to
   * be checked is an explanation nobody can audit. */
  const componentOf = (row: any, name: string): any =>
    (row.explanation as any[]).find((c) => c.name === name);

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

  async function createHousehold(label: string, timeZone: string): Promise<Household> {
    seq += 1;
    const family = await sys('create family', () =>
      prisma.family.create({
        data: { name: `FLD ${label} ${stamp}`, timezone: timeZone },
        select: { id: true },
      }),
    );
    createdFamilies.push(family.id);

    const user = await sys('create user', () =>
      prisma.user.create({
        data: {
          email: `fld.${label}.${seq}.${stamp}@example.test`,
          passwordHash: 'x',
          fullName: 'FLD Parent',
          locale: 'ar',
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
    return { familyId: family.id, childId: child.id, userId: user.id, timeZone };
  }

  /**
   * ONE ROW IN THE PARENT'S INBOX, AT AN INSTANT THIS SUITE CHOSE.
   *
   * Written in SQL with an explicit `created_at` rather than through the
   * repository, because the column's default is the DATABASE's clock and the
   * whole subject of this suite is WHICH INSTANT a history row carries. The
   * causal key is unique per row, so nothing here is a duplicate of anything and
   * `DUPLICATE_PENALTY` stays out of the arithmetic being measured.
   *
   * THE TYPE MUST STAY A REPEATABLE ONE — see `THE VEHICLE` in the file header.
   */
  const seedParentNotification = (h: Household, at: Date): Promise<any> =>
    exec(
      `INSERT INTO "notifications"
         ("id", "family_id", "user_id", "child_id", "type", "title", "body",
          "priority", "source_event_id", "created_at")
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'REWARD_GRANTED',
               'مكافأة جديدة', 'حصل محمد على مكافأة جديدة اليوم.', 'NORMAL', $5::text, $6::timestamp)`,
      randomUUID(),
      h.familyId,
      h.userId,
      h.childId,
      `seed:${randomUUID()}`,
      at.toISOString().replace('Z', ''),
    );

  /** One row in the CHILD's inbox, the same way and for the same reason.
   * `source_event_id` is NOT NULL, because on `child_messages` that column is
   * the «is this a notification, or did a human write it?» test. */
  const seedChildMessage = (h: Household, at: Date): Promise<any> =>
    exec(
      `INSERT INTO "child_messages"
         ("id", "family_id", "child_id", "author_type", "approval_status",
          "category", "title", "body", "source_event_id", "created_at")
       VALUES ($1::uuid, $2::uuid, $3::uuid, 'AI', 'PENDING',
               'REWARD_GRANTED_CHILD', 'أحسنت', 'حصلت على نقاط.', $4::text, $5::timestamp)`,
      randomUUID(),
      h.familyId,
      h.childId,
      `seed:${randomUUID()}`,
      at.toISOString().replace('Z', ''),
    );

  /**
   * THE ENGINE'S REAL ENTRY POINT, at an explicit instant, inside the tenant
   * scope every producer establishes. `now` is a parameter of `handleEvent` for
   * the reason it is a parameter of every decision on this path: a persisted
   * score must be reproducible from the row it was computed for.
   *
   * `eventType` MUST BE A REPEATABLE TYPE — see `THE VEHICLE` in the file header.
   */
  const decide = (h: Household, eventType: string, now: Date) =>
    runWithTenant({ familyId: h.familyId, actorType: 'SYSTEM', actorId: 'fld-test' }, () =>
      engine.handleEvent({
        familyId: h.familyId,
        childId: h.childId,
        eventType,
        sourceEventId: `fld:${randomUUID()}`,
        trigger: 'DOMAIN_EVENT',
        now,
      }),
    );

  beforeAll(async () => {
    freezeGoldenClock(FROZEN);

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue(offlinePrismaService())
      .compile();

    app = moduleRef.createNestApplication();
    await app.init();

    prisma = app.get(PrismaService);
    engine = app.get(SmartNotificationEngineService);
  }, 180_000);

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
    jest.useRealTimers();
  }, 180_000);

  // ==========================================================================
  describe('0. THE PREMISES — every later assertion stands on these', () => {
    it('0.1 the two zones really are an hour apart in January, read from tzdata', () => {
      expect(getBusinessTimeHHMM(DAY2, CAIRO)).toBe('07:00');
      expect(getBusinessTimeHHMM(DAY2, RIYADH)).toBe('08:00');
      expect(getBusinessTimeHHMM(CAIRO_DAY1, CAIRO)).toBe('20:00');
      expect(getBusinessTimeHHMM(RIYADH_DAY1, RIYADH)).toBe('20:00');
    });

    it('0.2 the six seeds land on the 15th on BOTH calendars, and every evaluation instant is outside quiet hours', () => {
      for (const seed of SEEDS) {
        expect(getBusinessDate(seed, CAIRO)).toBe('2026-01-15');
        expect(getBusinessDate(seed, RIYADH)).toBe('2026-01-15');
      }
      // Otherwise a DEFER would be read as a suppression and §1/§2 would be
      // measuring the quiet-hours matrix instead of the daily budget.
      for (const [instant, tz] of [
        [CAIRO_DAY1, CAIRO],
        [RIYADH_DAY1, RIYADH],
        [DAY2, CAIRO],
        [DAY2, RIYADH],
      ] as Array<[Date, string]>) {
        const local = getBusinessTimeHHMM(instant, tz);
        const outside =
          local >= DEFAULT_NOTIFICATION_POLICY.quietHoursEnd &&
          local < DEFAULT_NOTIFICATION_POLICY.quietHoursStart;
        expect(`${tz} ${local} outside=${outside}`).toBe(`${tz} ${local} outside=true`);
      }
    });

    it('0.3 DAY2 is the NEXT family-local day in both households and LESS than 24 hours after the last notification', () => {
      // THE CASE A ROLLING WINDOW GETS WRONG AND A REAL DAY GETS RIGHT, stated
      // as arithmetic rather than as a claim.
      const elapsedHours = (DAY2.getTime() - LAST_SEED.getTime()) / HOUR;
      expect(elapsedHours).toBe(15);
      expect(elapsedHours).toBeLessThan(24);

      for (const tz of [CAIRO, RIYADH]) {
        expect(getBusinessDate(LAST_SEED, tz)).toBe('2026-01-15');
        expect(getBusinessDate(DAY2, tz)).toBe('2026-01-16');
        // …and the seeds are still INSIDE the 24-hour read window, so they are
        // fetched from PostgreSQL and then excluded by the day boundary. If they
        // fell outside the read this suite would prove nothing.
        expect(LAST_SEED.getTime()).toBeGreaterThan(DAY2.getTime() - 24 * HOUR);
        expect(getStartOfBusinessDay(DAY2, tz).getTime()).toBeGreaterThan(LAST_SEED.getTime());
      }
    });

    it('0.4 the caps this suite counts against are the SHIPPED ones', () => {
      expect(DEFAULT_NOTIFICATION_POLICY.maxPerDay).toBe(6);
      expect(DEFAULT_NOTIFICATION_POLICY.maxPerHour).toBe(3);
      expect(DEFAULT_NOTIFICATION_POLICY.categoryMaxPerDay).toBe(2);
      expect(SEEDS).toHaveLength(DEFAULT_NOTIFICATION_POLICY.maxPerDay);
    });
  });

  // ==========================================================================
  describe('1. AFRICA/CAIRO — the daily budget resets at the family\'s local midnight', () => {
    let h: Household;

    it('1.1 the premise, as rows: six notifications, all on Cairo\'s 15th, and a silent ledger', async () => {
      h = await createHousehold('cairo', CAIRO);
      for (const at of SEEDS) await seedParentNotification(h, at);

      const rows = await raw<any[]>(
        `SELECT "created_at" FROM "notifications" WHERE "family_id" = $1::uuid ORDER BY "created_at"`,
        h.familyId,
      );
      expect(rows).toHaveLength(6);
      for (const row of rows) {
        expect(getBusinessDate(new Date(row.created_at), CAIRO)).toBe('2026-01-15');
      }
      expect(await countOf('notification_decisions', h.familyId)).toBe(0);
    }, 120_000);

    it('1.2 at 20:00 on that same day the household IS at its maximum, and is refused with the arithmetic in the row', async () => {
      const result = await decide(h, 'REWARD_GRANTED', CAIRO_DAY1);
      expect(result.decision.targetAudience).toBe('PARENT');

      const [row] = await decisionRows(h.familyId);
      expect(row.business_date.toISOString().slice(0, 10)).toBe('2026-01-15');
      // ALL SIX ARE TODAY'S, counted on the family's own calendar — and NONE of
      // them is in the last hour, which is what makes `today` the axis being
      // measured here rather than `hour`.
      expect(componentOf(row, 'FATIGUE_PENALTY').note).toBe('today=6/6 hour=0/3 category=6/2');
      expect(componentOf(row, 'FATIGUE_PENALTY').contribution).toBe(-25);
      expect(row.decision).toBe('SUPPRESS');
      expect(row.reason).toBe('SCORE_BELOW_FLOOR');
      // Nothing reached the parent, and the six seeded rows are still all there.
      expect(await countOf('notifications', h.familyId)).toBe(6);
    }, 120_000);

    it('1.3 FIFTEEN HOURS LATER — a new family-local day, still inside a rolling 24h — the household is told again', async () => {
      const result = await decide(h, 'REWARD_GRANTED', DAY2);

      const rows = await decisionRows(h.familyId);
      expect(rows).toHaveLength(2);
      const second = rows[1];

      // THE DAY RESET, IN THE PERSISTED EXPLANATION. A rolling window would
      // still read `today=6/6` here — the six rows are inside it, and §0.3
      // asserts they are still fetched.
      expect(second.business_date.toISOString().slice(0, 10)).toBe('2026-01-16');
      expect(componentOf(second, 'FATIGUE_PENALTY').note).toBe('today=0/6 hour=0/3 category=0/2');
      expect(componentOf(second, 'FATIGUE_PENALTY').contribution).toBe(0);

      // AND THE PRODUCT CONSEQUENCE, which is the only reason any of this
      // matters: the parent is told.
      expect(second.decision).toBe('SEND');
      expect(second.outcome).toBe('SEND');
      expect(result.outcome?.decision).toBe('SEND');
      expect(await countOf('notifications', h.familyId)).toBe(7);
    }, 120_000);
  });

  // ==========================================================================
  describe('2. ASIA/RIYADH — the same household shape on a different calendar', () => {
    let h: Household;

    it('2.1 at 20:00 Riyadh on the 15th the household is at its maximum', async () => {
      h = await createHousehold('riyadh', RIYADH);
      for (const at of SEEDS) await seedParentNotification(h, at);

      await decide(h, 'REWARD_GRANTED', RIYADH_DAY1);

      const [row] = await decisionRows(h.familyId);
      expect(row.business_date.toISOString().slice(0, 10)).toBe('2026-01-15');
      expect(componentOf(row, 'FATIGUE_PENALTY').note).toBe('today=6/6 hour=0/3 category=6/2');
      expect(row.decision).toBe('SUPPRESS');
      expect(row.reason).toBe('SCORE_BELOW_FLOOR');
      expect(await countOf('notifications', h.familyId)).toBe(6);
    }, 120_000);

    it('2.2 at 08:00 Riyadh the next day — fifteen hours on — it is told again', async () => {
      await decide(h, 'REWARD_GRANTED', DAY2);

      const rows = await decisionRows(h.familyId);
      expect(rows).toHaveLength(2);
      expect(rows[1].business_date.toISOString().slice(0, 10)).toBe('2026-01-16');
      expect(componentOf(rows[1], 'FATIGUE_PENALTY').note).toBe('today=0/6 hour=0/3 category=0/2');
      expect(rows[1].decision).toBe('SEND');
      expect(await countOf('notifications', h.familyId)).toBe(7);
    }, 120_000);
  });

  // ==========================================================================
  describe('3. ONE INSTANT, TWO HOUSEHOLDS, TWO DIFFERENT «TODAY»s', () => {
    /**
     * THE SECTION A ROLLING WINDOW CANNOT PASS BY ACCIDENT.
     *
     * At 21:30Z on the 15th, Cairo reads 23:30 on the 15th and Riyadh reads
     * 00:30 on the 16th — so RIYADH'S LOCAL MIDNIGHT HAS PASSED WHILE UTC'S HAS
     * NOT, which is the case a `toISOString().slice(0, 10)` day and a rolling
     * window get wrong in the same direction. Both households hold the IDENTICAL
     * six rows at the IDENTICAL instants; a window measured in elapsed hours must
     * give them the same answer, and the family's own calendar gives them two.
     *
     * 23:30 and 00:30 are inside both households' quiet windows, so the VERDICT
     * at this instant belongs to the quiet-hours matrix and is not this section's
     * subject. What is asserted is the count and the business date — the two
     * things the calendar decides.
     */
    it('3.1 Cairo is still on the 15th and at its maximum; Riyadh has crossed into the 16th and is not', async () => {
      const cairo = await createHousehold('splitcairo', CAIRO);
      const riyadh = await createHousehold('splitriyadh', RIYADH);
      for (const h of [cairo, riyadh]) for (const at of SEEDS) await seedParentNotification(h, at);

      // The premise, from the product's own functions rather than from literals.
      expect(SPLIT.toISOString().slice(0, 10)).toBe('2026-01-15');
      expect(getBusinessTimeHHMM(SPLIT, CAIRO)).toBe('23:30');
      expect(getBusinessTimeHHMM(SPLIT, RIYADH)).toBe('00:30');
      expect(getBusinessDate(SPLIT, CAIRO)).toBe('2026-01-15');
      expect(getBusinessDate(SPLIT, RIYADH)).toBe('2026-01-16');

      await decide(cairo, 'REWARD_GRANTED', SPLIT);
      await decide(riyadh, 'REWARD_GRANTED', SPLIT);

      const [cairoRow] = await decisionRows(cairo.familyId);
      const [riyadhRow] = await decisionRows(riyadh.familyId);

      // ONE INSTANT. TWO CALENDARS. TWO ANSWERS.
      expect(cairoRow.business_date.toISOString().slice(0, 10)).toBe('2026-01-15');
      expect(riyadhRow.business_date.toISOString().slice(0, 10)).toBe('2026-01-16');
      expect(componentOf(cairoRow, 'FATIGUE_PENALTY').note).toBe('today=6/6 hour=0/3 category=6/2');
      expect(componentOf(riyadhRow, 'FATIGUE_PENALTY').note).toBe('today=0/6 hour=0/3 category=0/2');
      expect(componentOf(cairoRow, 'FATIGUE_PENALTY').contribution).toBe(-25);
      expect(componentOf(riyadhRow, 'FATIGUE_PENALTY').contribution).toBe(0);
    }, 180_000);
  });

  // ==========================================================================
  describe('4. THE CEILING — a row stamped in the future counts toward nothing (PARENT inbox)', () => {
    it('4.1 a `notifications` row an hour AHEAD of the decision is not history, on any axis', async () => {
      const h = await createHousehold('futureparent', CAIRO);
      const future = new Date(DAY2.getTime() + HOUR);
      // SAME family-local day as the decision, so the day boundary cannot be
      // what excludes it — only the ceiling can.
      expect(getBusinessDate(future, CAIRO)).toBe(getBusinessDate(DAY2, CAIRO));
      await seedParentNotification(h, future);

      await decide(h, 'REWARD_GRANTED', DAY2);

      const [row] = await decisionRows(h.familyId);
      expect(componentOf(row, 'FATIGUE_PENALTY').note).toBe('today=0/6 hour=0/3 category=0/2');
      expect(componentOf(row, 'FATIGUE_PENALTY').contribution).toBe(0);
      expect(row.decision).toBe('SEND');
    }, 120_000);

    it('4.2 the CONTROL: the identical row stamped half an hour in the PAST is counted on every axis', async () => {
      // Without this, §4.1 would also pass against a query that returned nothing
      // at all — «excluded» and «never found» are the same number.
      const h = await createHousehold('pastparent', CAIRO);
      const past = new Date(DAY2.getTime() - 30 * 60_000);
      expect(getBusinessDate(past, CAIRO)).toBe(getBusinessDate(DAY2, CAIRO));
      await seedParentNotification(h, past);

      await decide(h, 'REWARD_GRANTED', DAY2);

      const [row] = await decisionRows(h.familyId);
      expect(componentOf(row, 'FATIGUE_PENALTY').note).toBe('today=1/6 hour=1/3 category=1/2');
    }, 120_000);
  });

  // ==========================================================================
  describe('5. THE CEILING AND THE DAY — the CHILD\'s own inbox', () => {
    /**
     * `child_messages` IS THE OTHER HALF, and it is the half the defect was
     * measured on: a CHILD-audience candidate reads the child's own inbox, and
     * that read now goes through the single shared definition in
     * `shared/notifications/child-inbox-history.ts`. Three households, one clause
     * each, so a passing count can only mean one thing.
     */
    it('5.1 a child message stamped AFTER the decision counts toward nothing', async () => {
      const h = await createHousehold('futurechild', CAIRO);
      const future = new Date(DAY2.getTime() + HOUR);
      expect(getBusinessDate(future, CAIRO)).toBe(getBusinessDate(DAY2, CAIRO));
      await seedChildMessage(h, future);

      await decide(h, 'REWARD_GRANTED_CHILD', DAY2);

      const [row] = await decisionRows(h.familyId);
      expect(row.target_audience).toBe('CHILD');
      expect(componentOf(row, 'FATIGUE_PENALTY').note).toBe('today=0/6 hour=0/3 category=0/2');
    }, 120_000);

    it('5.2 a child message from YESTERDAY on the family\'s calendar — inside a rolling 24h — counts toward nothing either', async () => {
      const h = await createHousehold('yesterdaychild', CAIRO);
      await seedChildMessage(h, LAST_SEED);
      expect(getBusinessDate(LAST_SEED, CAIRO)).toBe('2026-01-15');
      expect(getBusinessDate(DAY2, CAIRO)).toBe('2026-01-16');

      await decide(h, 'REWARD_GRANTED_CHILD', DAY2);

      const [row] = await decisionRows(h.familyId);
      expect(componentOf(row, 'FATIGUE_PENALTY').note).toBe('today=0/6 hour=0/3 category=0/2');
    }, 120_000);

    it('5.3 the CONTROL: a child message half an hour ago, on the same family day, IS counted', async () => {
      const h = await createHousehold('todaychild', CAIRO);
      const past = new Date(DAY2.getTime() - 30 * 60_000);
      expect(getBusinessDate(past, CAIRO)).toBe(getBusinessDate(DAY2, CAIRO));
      await seedChildMessage(h, past);

      await decide(h, 'REWARD_GRANTED_CHILD', DAY2);

      const [row] = await decisionRows(h.familyId);
      expect(componentOf(row, 'FATIGUE_PENALTY').note).toBe('today=1/6 hour=1/3 category=1/2');
    }, 120_000);
  });
});
