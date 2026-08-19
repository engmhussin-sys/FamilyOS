/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-var-requires */
/**
 * ============================================================================
 * SPRINT F1 — `DAILY_GOAL_COMPLETED`, AND THE NAME THE SERVER NOW OWNS.
 * ============================================================================
 *
 * WHAT WAS MEASURED. `DAILY_GOAL_COMPLETED` had four tone bands of Arabic and
 * English, a quiet-hours class (`DEFER`), two scoring rows and a deep-link
 * destination — and NOTHING in `src/` produced it. It sat on
 * `PRODUCERLESS_DEFECT_LEDGER` for a precise reason: there was NO SERVER-OWNED
 * ARABIC NAME FOR A DAILY GOAL. `TYPE_SPECS.DAILY_GOAL_COMPLETED.aggregateType`
 * is `'DailyGoal'`, a model with no table behind it, and the only candidate text
 * was device-supplied `metadata` — client prose, which must never be rendered as
 * if the server wrote it.
 *
 * WHAT A DAILY GOAL ACTUALLY IS HERE, and this suite is the evidence rather than
 * the claim: `HealthEngineService` is the ONLY thing in this codebase that emits
 * that name server-side, and it emits exactly two — the HYDRATION target
 * (derived from the child's age by `computeHydrationTargetMl`) and the 60-minute
 * ACTIVITY target. Both targets are the server's, both crossings are summed from
 * stored rows on the family's business day, and neither takes a title, a label
 * or any other string from a device. So the NAME is the server's to write, and
 * it is written in `notification-nouns.ts` keyed on the originating domain event
 * type. THE DEVICE `metadata` THE LEDGER ENTRY REFUSED IS STILL REFUSED, and
 * test 4.1 is what keeps it refused.
 *
 * WHAT THIS SUITE EXECUTES. The real chain with NO test double in it: the real
 * `HealthEngineService` over real `hydration_logs` / `activity_logs` rows, the
 * real `SmartNotificationEngineService`, the real decision provider, the REAL
 * `ChildSafetyFilterService` and the real delivery pipeline. EVERY COUNT AND
 * EVERY SENTENCE IS READ BACK OUT OF POSTGRESQL WITH SQL, never from a returned
 * object.
 *
 * ===========================================================================
 * WHY THIS FILE FREEZES THE CLOCK AND `goal-nudge-producer.e2e.spec.ts` DOES NOT
 * ===========================================================================
 *
 * THE DIFFERENCE IS REAL AND IT IS THE WHOLE TIME-BOMB. `GoalNudgeService.sweep`
 * takes `now` as a PARAMETER and threads it into `handleEvent({ now })`, so that
 * suite can prove two timezones without touching a machine clock.
 * `HealthEngineService.logHydration` takes NO instant — it is standing at the
 * moment the child logged a glass of water, so it reads the WALL CLOCK, and
 * `NotificationContextAssembler.assemble` then reads `input.now ?? new Date()`.
 * That is correct production behaviour: whether it is safe to wake a household
 * is a question about NOW.
 *
 * It also means every assertion below about a DELIVERED row would otherwise be
 * an assertion about what time of day CI happened to run — the exact defect that
 * made `reward-cause-producers.e2e.spec.ts` pass on 2026-08-17 and fail 8/10 on
 * 2026-08-18 at the same commit. So the clock is frozen with `freezeGoldenClock`,
 * which fakes `Date` ONLY and leaves every timer real because `pg` and Redis need
 * working ones, and test 0.1 ASSERTS THE PREMISE rather than assuming it.
 *
 * The frozen instants are in the PAST relative to any real run, which is the
 * safe direction — the same reason, and the same direction, as `GOLDEN_DAY`.
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
import { HealthEngineService } from '../../src/modules/life-intelligence/application/services/health-engine.service';
import {
  dailyGoalCauses,
  dailyGoalName,
} from '../../src/modules/notifications/domain/engine/notification-nouns';
import { forChildAudience, forEntity } from '../../src/shared/notifications/notification-source-key';
import {
  hasEnumOrPlaceholderLeak,
  renderNotificationCopy,
} from '../../src/modules/notifications/domain/engine/notification-copy';
import { resolveNotificationDestination } from '../../src/modules/notifications/domain/engine/notification-destination';
import { getBusinessDate, getBusinessTimeHHMM } from '../../src/common/time/family-date';
import { integrationDatabaseUrl } from '../tenancy/prisma-test-client';
import { freezeGoldenClock } from '../golden/golden-world';

const describeIfDb = integrationDatabaseUrl() ? describe : describe.skip;

const CAIRO = 'Africa/Cairo';
const RIYADH = 'Asia/Riyadh';

/**
 * JANUARY, DELIBERATELY — `Africa/Cairo` is UTC+02:00 then and `Asia/Riyadh` is
 * UTC+03:00 always, so the two launch markets are ONE HOUR APART. In August both
 * are UTC+03:00 and a «both timezones» test in which both zones agree proves
 * nothing. See `goal-nudge-producer.e2e.spec.ts` for the same four instants and
 * the same argument.
 */
const MIDDAY = new Date('2026-01-15T10:00:00.000Z'); // 12:00 Cairo · 13:00 Riyadh
const AWAKE_IN_CAIRO_ASLEEP_IN_RIYADH = new Date('2026-01-15T18:30:00.000Z'); // 20:30 · 21:30
const DEEP_NIGHT = new Date('2026-01-15T19:30:00.000Z'); // 21:30 Cairo

const QUIET_HOURS_START = '21:00';

const PLACEHOLDER = /\{[a-zA-Z0-9_]+\}/;
const ARABIC_LETTERS = /[؀-ۿ]/;
const PUNITIVE = ['فشل', 'كسول', 'مقصر', 'إهمال', 'عقاب', 'سنمنع', 'خسرت', 'ستخسر', 'تأخرت', 'تحذير'];

/**
 * A TWELVE-YEAR-OLD'S HYDRATION TARGET. `computeHydrationTargetMl(12)` is 2100 —
 * the `9-13` band — and it is DERIVED in the assertions from the child's own
 * date of birth rather than trusted here. 2200 crosses it in ONE log, which
 * makes «the crossing» a single unambiguous event.
 */
const HYDRATION_TARGET_ML = 2100;
const CROSSING_ML = 2200;
/** `ACTIVITY_TARGET_MINUTES`, the same 60 the progress screen already uses. */
const ACTIVITY_TARGET_MINUTES = 60;
const CROSSING_MINUTES = 70;

/** The same offline client every other integration suite in this repo builds. */
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
  readonly timeZone: string;
}

describeIfDb('F1 — DAILY_GOAL_COMPLETED reaches the child (real PostgreSQL, real Safety Engine)', () => {
  let app: INestApplication;
  let prisma: any;
  let health: HealthEngineService;
  let childSafety: ChildSafetyFilterService;

  const stamp = Date.now();
  const createdFamilies: string[] = [];
  const createdUsers: string[] = [];

  const sys = (what: string, fn: () => Promise<any>): Promise<any> =>
    runAsSystemAsync('TEST_FIXTURE', `F1 daily-goal suite: ${what}`, async () => await fn());

  const raw = <T>(sql: string, ...params: unknown[]): Promise<T> =>
    sys('raw sql', () => prisma.$queryRawUnsafe(sql, ...params)) as Promise<T>;

  // -- READ-BACK HELPERS: SQL against the real database, every one of them.

  const allDecisions = (familyId: string): Promise<any[]> =>
    raw<any[]>(
      `SELECT * FROM "notification_decisions" WHERE "family_id" = $1::uuid ORDER BY "created_at", "id"`,
      familyId,
    );

  /** The decisions for THIS key. See `childMessages` for why the rewards path's
   * own row is present and why it is filtered rather than counted. */
  const decisions = async (familyId: string): Promise<any[]> =>
    (await allDecisions(familyId)).filter((d) => d.event_type === 'DAILY_GOAL_COMPLETED');

  const allChildMessages = (familyId: string): Promise<any[]> =>
    raw<any[]>(
      `SELECT * FROM "child_messages" WHERE "family_id" = $1::uuid ORDER BY "created_at", "id"`,
      familyId,
    );

  /**
   * THE ROWS THIS SUITE IS ABOUT, AND WHY THEY MUST BE FILTERED.
   *
   * A hydration crossing writes TWO child messages, and both are correct:
   *
   *   `DAILY_GOAL_COMPLETED`   the receipt this sprint added — «أكملت هدف شرب
   *                            الماء اليوم كما خططت», keyed on the crossing.
   *   `REWARD_GRANTED_CHILD`   the REWARDS path, which predates this work.
   *                            `HealthEngineService` has always fired a
   *                            `DAILY_GOAL_COMPLETED` REWARD TRIGGER at the same
   *                            crossing, platform Reward Rules pay it, and
   *                            SPRINT F1 DECISION 1 made the child hear about a
   *                            grant on BOTH reward paths. Its cause is a
   *                            `reward:` key, not a `signal:` one.
   *
   * They are two different facts — «you finished your goal» and «you earned
   * something» — with two different deep links, and test 1.4 pins that they stay
   * two rows with two distinct causes rather than one silently eating the other.
   * Filtering here rather than counting the table is what keeps every other
   * assertion in this file about the row it names.
   */
  const childMessages = async (familyId: string): Promise<any[]> =>
    (await allChildMessages(familyId)).filter((m) => m.category === 'DAILY_GOAL_COMPLETED');

  const deliveries = async (familyId: string): Promise<any[]> =>
    (
      await raw<any[]>(
        `SELECT * FROM "notification_deliveries" WHERE "family_id" = $1::uuid ORDER BY "created_at", "id"`,
        familyId,
      )
    ).filter((d) => d.type === 'DAILY_GOAL_COMPLETED');

  /**
   * PARENT rows of THIS key, which must always be none.
   *
   * Filtered rather than counted for the same reason `childMessages` is: the
   * rewards path that runs on the same crossing legitimately writes a
   * `REWARD_GRANTED` row to the parent, and it predates this work. What must
   * never exist is a PARENT copy of the CHILD'S RECEIPT — «your son finished his
   * water goal» is the monitor behaviour this product exists not to have, and
   * `NOTIFICATION_CLASSES.DAILY_GOAL_COMPLETED.audience` is `CHILD` for that
   * reason.
   */
  const parentNotifications = async (familyId: string): Promise<any[]> =>
    (await raw<any[]>(`SELECT * FROM "notifications" WHERE "family_id" = $1::uuid`, familyId)).filter(
      (n) => n.type === 'DAILY_GOAL_COMPLETED',
    );

  async function theDecisionFor(familyId: string, copyKey: string): Promise<any> {
    const rows = (await decisions(familyId)).filter((d) => d.copy_key === copyKey);
    expect(rows).toHaveLength(1);
    return rows[0];
  }

  /**
   * THE PROVENANCE CHECK. A stored sentence is «from the catalogue» only if
   * rendering the key the ROW names, at the band and locale it names, reproduces
   * it byte for byte. This is the assertion that refuses a silent degrade to
   * `GENERIC` — which is exactly what a missing `{goalTitle}` would cause, and
   * `{goalTitle}` is the variable this whole ledger entry was about.
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

  /** THE REAL SAFETY SERVICE on THE PERSISTED BYTES, at the band this child's
   * own date of birth resolves to. Never a stub — `PE-N-001` survived four
   * audits precisely because it was stubbed. */
  const assertChildSafeBytes = (row: { title: string; body: string }): void => {
    const band = ageBandFor(12);
    expect(band).toBe('12-14');
    expect(childSafety.validate(row.body, band).isSafe).toBe(true);
    expect(childSafety.validate(row.title, band).isSafe).toBe(true);

    expect(hasEnumOrPlaceholderLeak(row.title)).toBe(false);
    expect(hasEnumOrPlaceholderLeak(row.body)).toBe(false);
    expect(row.title).not.toMatch(PLACEHOLDER);
    expect(row.body).not.toMatch(PLACEHOLDER);
    expect(`${row.title} ${row.body}`).not.toMatch(/[{}]/);
    expect(row.body).toMatch(ARABIC_LETTERS);
    for (const word of PUNITIVE) expect(`${row.title} ${row.body}`).not.toContain(word);
  };

  // -- fixtures --------------------------------------------------------------

  async function createHousehold(label: string, timeZone: string): Promise<Household> {
    const family = await sys('create family', () =>
      prisma.family.create({
        data: { name: `F1-daily ${label} ${stamp}`, timezone: timeZone },
        select: { id: true },
      }),
    );
    createdFamilies.push(family.id);

    const user = await sys('create user', () =>
      prisma.user.create({
        data: { email: `f1daily.${label}.${stamp}@example.test`, passwordHash: 'x', fullName: 'F1 Parent' },
        select: { id: true },
      }),
    );
    createdUsers.push(user.id);
    await sys('create membership', () =>
      prisma.familyMember.create({ data: { familyId: family.id, userId: user.id, role: 'OWNER' } }),
    );

    // Born June 2013 — 12 years old on every instant in this file, so the tone
    // band is `11-13`, the safety band `12-14`, and the hydration target 2100.
    const child = await sys('create child', () =>
      prisma.child.create({
        data: { familyId: family.id, firstName: 'محمد', dateOfBirth: new Date('2013-06-01T00:00:00.000Z') },
        select: { id: true },
      }),
    );

    return { familyId: family.id, childId: child.id, userId: user.id, timeZone };
  }

  const asFamily = <T>(familyId: string, fn: () => Promise<T>): Promise<T> =>
    runWithTenant({ familyId, actorType: 'SYSTEM', actorId: 'f1-daily-goal-test' }, fn);

  /** The REAL engine method a child's own device calls, in the tenant scope the
   * request pipeline establishes. No instant argument exists — see the header. */
  const logHydration = (h: Household, amountMl: number) =>
    asFamily(h.familyId, () => health.logHydration(h.childId, h.familyId, { amountMl } as any));

  const logActivity = (h: Household, durationMinutes: number, date: string, activityType = 'running') =>
    asFamily(h.familyId, () =>
      health.logActivity(h.childId, h.familyId, {
        date,
        activityType,
        durationMinutes,
        socialContext: 'SOLO',
      } as any),
    );

  /** Wipes the day's hydration rows so the NEXT log crosses the target again —
   * the fixture that makes test 2.2 a REAL replay through the real producer
   * rather than a hand-composed second call. */
  const forgetHydration = (h: Household): Promise<any> =>
    sys('delete hydration logs', () =>
      prisma.$executeRawUnsafe(`DELETE FROM "hydration_logs" WHERE "child_id" = $1::uuid`, h.childId),
    );

  beforeAll(async () => {
    // BEFORE THE APP IS BUILT, so that every `@default(now())` this suite writes
    // is stamped with the same instant the notification door will read.
    freezeGoldenClock(MIDDAY);

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue(offlinePrismaService())
      .compile();

    app = moduleRef.createNestApplication();
    await app.init();

    prisma = app.get(PrismaService);
    health = app.get(HealthEngineService);
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
    jest.useRealTimers();
  }, 180_000);

  // ==========================================================================
  // 0. THE PREMISES
  // ==========================================================================
  describe('0. the premises this suite is written on', () => {
    /**
     * THE TIME-BOMB GUARD, and it is not decoration: this producer reads the
     * WALL CLOCK. Delete `freezeGoldenClock` above and this test fails at 09:00
     * exactly as it fails at 23:00 — which is the whole point, because without
     * it the suite would instead fail only at night, get re-run, and pass.
     */
    it('0.1 the wall clock the engine will read is MIDDAY, and MIDDAY is outside quiet hours', () => {
      expect(new Date().toISOString()).toBe(MIDDAY.toISOString());
      expect(Date.now()).toBe(MIDDAY.getTime());

      // Measured through the SAME function production uses, in both markets, so
      // moving the default quiet window fails HERE with a readable message.
      expect(getBusinessTimeHHMM(MIDDAY, CAIRO)).toBe('12:00');
      expect(getBusinessTimeHHMM(MIDDAY, RIYADH)).toBe('13:00');
      expect(getBusinessTimeHHMM(MIDDAY, CAIRO) < QUIET_HOURS_START).toBe(true);
      expect(getBusinessTimeHHMM(MIDDAY, RIYADH) < QUIET_HOURS_START).toBe(true);

      // And the two instants the later tests move the clock to.
      expect(getBusinessTimeHHMM(AWAKE_IN_CAIRO_ASLEEP_IN_RIYADH, CAIRO)).toBe('20:30');
      expect(getBusinessTimeHHMM(AWAKE_IN_CAIRO_ASLEEP_IN_RIYADH, RIYADH)).toBe('21:30');
      expect(getBusinessTimeHHMM(DEEP_NIGHT, CAIRO)).toBe('21:30');
    });

    /**
     * THE NAME IS THE SERVER'S, AND THE LIST IS CLOSED. Two causes, both already
     * in `DOMAIN_EVENT_TYPES`, each with a name in BOTH shipped languages. A
     * third daily goal cannot be added without a name, which is what stops the
     * next producer from reaching for device `metadata` again.
     */
    it('0.2 both daily-goal causes have a server-owned name in both languages', () => {
      expect([...dailyGoalCauses()].sort()).toEqual([
        'ACTIVITY_GOAL_COMPLETED',
        'HYDRATION_GOAL_COMPLETED',
      ]);
      for (const cause of dailyGoalCauses()) {
        for (const locale of ['ar', 'en'] as const) {
          const name = dailyGoalName(cause, locale);
          expect(typeof name).toBe('string');
          expect((name as string).trim().length).toBeGreaterThan(2);
          expect(name).not.toMatch(PLACEHOLDER);
        }
        // The Arabic really is Arabic, not an English literal in an `ar` slot.
        expect(dailyGoalName(cause, 'ar')).toMatch(ARABIC_LETTERS);
      }
      // AND AN UNKNOWN CAUSE HAS NO NAME — the contract that makes the producer
      // stay silent rather than invent one.
      expect(dailyGoalName('SOMETHING_A_DEVICE_SENT', 'ar')).toBeNull();
      expect(dailyGoalName(null, 'ar')).toBeNull();
    });
  });

  // ==========================================================================
  // 1. THE TWO CROSSINGS
  // ==========================================================================
  describe('1. the two daily goals this product actually has', () => {
    it('1.1 HYDRATION — crossing the age-derived target tells the child, in Arabic the server wrote', async () => {
      jest.setSystemTime(MIDDAY);
      const h = await createHousehold('hydration-pos', CAIRO);

      await logHydration(h, CROSSING_ML);

      // --- READ BACK OUT OF POSTGRESQL ---
      const decision = await theDecisionFor(h.familyId, 'DAILY_GOAL_COMPLETED');
      expect(decision.event_type).toBe('DAILY_GOAL_COMPLETED');
      expect(decision.target_audience).toBe('CHILD');
      // `DOMAIN_EVENT`, not `PERIODIC_SIGNAL`: unlike the goal-nudge producers
      // this one is standing at the moment the fact happened.
      expect(decision.trigger).toBe('DOMAIN_EVENT');
      expect(decision.age_band).toBe('11-13');
      expect(decision.business_date.toISOString().slice(0, 10)).toBe('2026-01-15');

      const rows = await childMessages(h.familyId);
      expect(rows).toHaveLength(1);
      const row = rows[0];

      // THE SENTENCE IS THE CATALOGUE'S, filled with the SERVER'S OWN NAME for
      // the goal. If `{goalTitle}` were missing the template would leak and the
      // render would degrade to `GENERIC`; this comparison refuses that.
      assertRenderedFromCatalogue(row, decision, { goalTitle: 'شرب الماء' });
      expect(row.body).toContain('شرب الماء');
      assertChildSafeBytes(row);

      // AND THE TARGET REALLY WAS THE SERVER'S, derived from the child's age —
      // the row that proves the crossing was not a number this test chose.
      const logged = await raw<any[]>(
        `SELECT COALESCE(SUM("amount_ml"), 0)::int AS ml FROM "hydration_logs" WHERE "child_id" = $1::uuid`,
        h.childId,
      );
      expect(Number(logged[0].ml)).toBe(CROSSING_ML);
      expect(CROSSING_ML).toBeGreaterThanOrEqual(HYDRATION_TARGET_ML);

      // A child's receipt is not a parent's alert.
      expect(await parentNotifications(h.familyId)).toHaveLength(0);
    }, 180_000);

    it('1.2 ACTIVITY — the other crossing, and it carries the OTHER server-owned name', async () => {
      jest.setSystemTime(MIDDAY);
      const h = await createHousehold('activity-pos', CAIRO);

      await logActivity(h, CROSSING_MINUTES, getBusinessDate(MIDDAY, CAIRO));

      const decision = await theDecisionFor(h.familyId, 'DAILY_GOAL_COMPLETED');
      const rows = await childMessages(h.familyId);
      expect(rows).toHaveLength(1);

      // «النشاط البدني», not «شرب الماء» — the two causes really do select two
      // different names, which is the whole point of keying on the cause.
      assertRenderedFromCatalogue(rows[0], decision, { goalTitle: 'النشاط البدني' });
      expect(rows[0].body).toContain('النشاط البدني');
      expect(rows[0].body).not.toContain('شرب الماء');
      assertChildSafeBytes(rows[0]);
      expect(CROSSING_MINUTES).toBeGreaterThanOrEqual(ACTIVITY_TARGET_MINUTES);
    }, 180_000);

    /**
     * THE NEGATIVE, AND IT IS THE ONE THAT MATTERS MOST FOR A CHILD: a child who
     * is SHORT of the target hears nothing at all. There is no «you are behind»
     * sentence on this path and this test is what keeps it that way.
     */
    it('1.3 NEGATIVE — short of the target, and a tenth glass after it: silence both times', async () => {
      jest.setSystemTime(MIDDAY);
      const h = await createHousehold('hydration-neg', CAIRO);

      // (a) WELL SHORT. Nothing is written anywhere.
      await logHydration(h, 500);
      expect(await decisions(h.familyId)).toHaveLength(0);
      expect(await childMessages(h.familyId)).toHaveLength(0);
      expect(await deliveries(h.familyId)).toHaveLength(0);

      // (b) THE CROSSING, once.
      await logHydration(h, CROSSING_ML);
      expect(await childMessages(h.familyId)).toHaveLength(1);

      // (c) AND THREE MORE GLASSES AFTER IT. The condition is «today's total
      // reached the target AND had not before THIS log», so a child who keeps
      // drinking is congratulated ONCE and not four times.
      await logHydration(h, 300);
      await logHydration(h, 300);
      await logHydration(h, 300);
      expect(await childMessages(h.familyId)).toHaveLength(1);
      expect(await decisions(h.familyId)).toHaveLength(1);
    }, 180_000);

    /**
     * ONE CROSSING, TWO ROWS, AND THEY ARE TWO DIFFERENT FACTS.
     *
     * This is pinned rather than assumed because it is the assertion that would
     * catch either of the two ways it can silently break: the new receipt eating
     * the rewards message (if the two causes ever collided on
     * `child_messages (family_id, source_event_id)`), or the receipt shipping
     * TWICE. «أكملت هدفك» and «حصلت على مكافأة» are different sentences with
     * different deep links, and the child should read both exactly once.
     *
     * It is also the anti-nagging bound for this key: TWO celebratory rows for
     * one crossing is the ceiling, and a third would be noise.
     */
    it('1.4 one crossing writes the receipt AND the reward message — two causes, never three rows', async () => {
      jest.setSystemTime(MIDDAY);
      const h = await createHousehold('coexistence', CAIRO);

      await logHydration(h, CROSSING_ML);

      const all = await allChildMessages(h.familyId);
      expect(all).toHaveLength(2);
      expect(all.map((m) => m.category).sort()).toEqual([
        'DAILY_GOAL_COMPLETED',
        'REWARD_GRANTED_CHILD',
      ]);

      // Two DISTINCT causes — a `signal:` key for the crossing and a `reward:`
      // key for the grant — which is why neither deduplicates the other away.
      expect(new Set(all.map((m) => m.source_event_id)).size).toBe(2);
      const receipt = all.find((m) => m.category === 'DAILY_GOAL_COMPLETED');
      const grant = all.find((m) => m.category === 'REWARD_GRANTED_CHILD');
      expect(receipt.source_event_id).toContain('signal:');
      expect(grant.source_event_id).toContain('reward:');

      // Two different destinations, because they are answers to two different
      // questions: «where is my progress» and «where is my reward».
      expect(receipt.data.deepLink).toBe('abny://screen-time');
      expect(grant.data.deepLink).toBe('abny://rewards');

      // BOTH are safety-clean at this child's own band — a celebration the
      // product ships as a pair is a pair a child reads.
      for (const m of all) assertChildSafeBytes(m);
    }, 180_000);
  });

  // ==========================================================================
  // 2. IDEMPOTENCY AND REPLAY
  // ==========================================================================
  describe('2. idempotency at the DATABASE, not by an `if`', () => {
    /**
     * THE CROSSING TEST IS AN `if`, AND IT IS DELIBERATELY NOT THE GUARANTEE.
     *
     * A retried request, a back-dated parent log or a second replica can all
     * re-enter `logHydration` with today's total already past the target and the
     * subtraction making the crossing look fresh. This test MANUFACTURES exactly
     * that: the day's hydration rows are deleted, the same amount is logged
     * again, and the producer genuinely re-enters the crossing branch and calls
     * `handleEvent` a SECOND TIME WITH THE SAME KEY.
     *
     * What stops the second row is
     * `notification_decisions_cause_uniq (family_id, source_event_id,
     * target_audience)`, and behind it
     * `child_messages (family_id, source_event_id)` — constraints, not code.
     */
    it('2.1 REPLAY — the same crossing, twice, leaves ONE decision and ONE message', async () => {
      jest.setSystemTime(MIDDAY);
      const h = await createHousehold('hydration-replay', CAIRO);

      await logHydration(h, CROSSING_ML);
      expect(await childMessages(h.familyId)).toHaveLength(1);

      // The producer re-enters the crossing branch for real.
      await forgetHydration(h);
      await logHydration(h, CROSSING_ML);

      // --- AND THE DATABASE REFUSED THE SECOND ONE ---
      const decisionRows = await decisions(h.familyId);
      expect(decisionRows).toHaveLength(1);
      expect(decisionRows[0].copy_key).toBe('DAILY_GOAL_COMPLETED');

      const messages = await childMessages(h.familyId);
      expect(messages).toHaveLength(1);

      /**
       * AND THE KEY IS THE ONE THE PRODUCER DOCUMENTS — composed independently
       * here and compared against the stored column, so a refactor that changed
       * the shape (to a per-minute bucket, say) fails HERE.
       */
      const expectedCause = forEntity(
        'signal',
        h.childId,
        'daily-goal:HYDRATION_GOAL_COMPLETED',
        getBusinessDate(MIDDAY, CAIRO),
      );
      expect(decisionRows[0].source_event_id).toBe(expectedCause);
      expect(decisionRows[0].target_audience).toBe('CHILD');

      /**
       * THE AUDIENCE IS IN THE KEY AT THE TERMINAL WRITE.
       * `notification_deliveries (family_id, source_event_id)` has NO audience
       * COLUMN — which is the exact shape of the defect that cost a child ten
       * hours a night, when their row lost to the parent's under `ON CONFLICT DO
       * NOTHING`. The audience therefore has to live inside the VALUE, and
       * `forChildAudience` is what puts it there.
       */
      expect(messages[0].source_event_id).toBe(forChildAudience(expectedCause));
      expect(messages[0].source_event_id).not.toBe(expectedCause);
    }, 180_000);

    /**
     * THE TWO DAILY GOALS ARE TWO FACTS AND MUST NOT DEDUP EACH OTHER AWAY. They
     * share a child, a day and an event type; only the CAUSE differs. A key that
     * omitted the cause would silently drop the second one — a child who drank
     * their water and then went running would be told about one of the two.
     */
    it('2.2 the hydration and activity crossings are DIFFERENT causes on the same day', async () => {
      jest.setSystemTime(MIDDAY);
      const h = await createHousehold('both-goals', CAIRO);

      await logHydration(h, CROSSING_ML);
      await logActivity(h, CROSSING_MINUTES, getBusinessDate(MIDDAY, CAIRO));

      const decisionRows = await decisions(h.familyId);
      expect(decisionRows).toHaveLength(2);
      expect(new Set(decisionRows.map((d) => d.source_event_id)).size).toBe(2);

      const messages = await childMessages(h.familyId);
      expect(messages).toHaveLength(2);
      const bodies = messages.map((m) => m.body).join(' | ');
      expect(bodies).toContain('شرب الماء');
      expect(bodies).toContain('النشاط البدني');
      for (const m of messages) assertChildSafeBytes(m);
    }, 180_000);
  });

  // ==========================================================================
  // 3. QUIET HOURS AND THE FAMILY'S OWN CALENDAR
  // ==========================================================================
  describe('3. quiet hours and the family’s own calendar', () => {
    /**
     * `DAILY_GOAL_COMPLETED` IS A `DEFER` CLASS, AND THE DIFFERENCE FROM THE
     * GOAL NUDGES IS THE POINT. «باقي لك ٥ دقائق» released at 07:00 would be a
     * lie — the window shut in the night — so `STUDY_REMINDER` is SUPPRESSED.
     * «أكملت هدف شرب الماء اليوم» is a RECEIPT for something that really
     * happened, and a receipt is still a receipt in the morning. So this one is
     * PARKED, not dropped.
     */
    it('3.1 QUIET HOURS — a 21:30 crossing is DEFERRED to the morning, not dropped and not delivered', async () => {
      jest.setSystemTime(DEEP_NIGHT);
      const h = await createHousehold('hydration-quiet', CAIRO);
      expect(getBusinessTimeHHMM(new Date(), h.timeZone)).toBe('21:30');

      await logHydration(h, CROSSING_ML);

      // NOTHING WOKE THE CHILD.
      expect(await childMessages(h.familyId)).toHaveLength(0);

      // BUT IT WAS NOT THROWN AWAY — the receipt is waiting for the morning.
      const parked = await deliveries(h.familyId);
      expect(parked).toHaveLength(1);
      expect(parked[0].state).toBe('PENDING');
      expect(parked[0].defer_reason).toBe('QUIET_HOURS');
      expect(parked[0].target_audience).toBe('CHILD');

      // AND THE PARKED BYTES ARE THE REAL SENTENCE, safety-clean and
      // placeholder-free — a deferred row is delivered verbatim later, so it is
      // the same bytes a child will read and must be screened now.
      assertChildSafeBytes(parked[0]);
      expect(parked[0].body).toContain('شرب الماء');

      const decision = await theDecisionFor(h.familyId, 'DAILY_GOAL_COMPLETED');
      expect(decision.decision).toBe('DEFER');
    }, 180_000);

    /**
     * ONE INSTANT, TWO ANSWERS. Two households with identical rows and identical
     * logs at the SAME frozen instant: Cairo reads 20:30 and the child is told
     * now; Riyadh reads 21:30 and the receipt is parked. Nothing but the
     * `timezone` column differs, so a producer using UTC would give both the
     * same answer and fail whichever answer it chose.
     */
    it('3.2 TIMEZONE — Africa/Cairo is told now and Asia/Riyadh is parked, at one instant', async () => {
      jest.setSystemTime(AWAKE_IN_CAIRO_ASLEEP_IN_RIYADH);
      const cairo = await createHousehold('tz-cairo', CAIRO);
      const riyadh = await createHousehold('tz-riyadh', RIYADH);

      await logHydration(cairo, CROSSING_ML);
      await logHydration(riyadh, CROSSING_ML);

      // --- CAIRO: DELIVERED ---
      const cairoRows = await childMessages(cairo.familyId);
      expect(cairoRows).toHaveLength(1);
      assertChildSafeBytes(cairoRows[0]);
      expect(await deliveries(cairo.familyId)).toHaveLength(0);
      expect((await theDecisionFor(cairo.familyId, 'DAILY_GOAL_COMPLETED')).decision).toBe('SEND');

      // --- RIYADH: PARKED, same instant, same rows ---
      expect(await childMessages(riyadh.familyId)).toHaveLength(0);
      const parked = await deliveries(riyadh.familyId);
      expect(parked).toHaveLength(1);
      expect(parked[0].defer_reason).toBe('QUIET_HOURS');
      assertChildSafeBytes(parked[0]);
      expect((await theDecisionFor(riyadh.familyId, 'DAILY_GOAL_COMPLETED')).decision).toBe('DEFER');

      // AND BOTH ROWS ARE STAMPED WITH THEIR OWN HOUSEHOLD'S DAY, read from the
      // family's own calendar rather than from UTC.
      const cairoDecision = await theDecisionFor(cairo.familyId, 'DAILY_GOAL_COMPLETED');
      const riyadhDecision = await theDecisionFor(riyadh.familyId, 'DAILY_GOAL_COMPLETED');
      expect(cairoDecision.business_date.toISOString().slice(0, 10)).toBe(
        getBusinessDate(AWAKE_IN_CAIRO_ASLEEP_IN_RIYADH, CAIRO),
      );
      expect(riyadhDecision.business_date.toISOString().slice(0, 10)).toBe(
        getBusinessDate(AWAKE_IN_CAIRO_ASLEEP_IN_RIYADH, RIYADH),
      );
    }, 180_000);
  });

  // ==========================================================================
  // 4. THE THING THE LEDGER ENTRY REFUSED, STILL REFUSED
  // ==========================================================================
  describe('4. the device’s own prose never becomes the server’s sentence', () => {
    /**
     * THE LEDGER ENTRY'S ACTUAL OBJECTION, PINNED.
     *
     * The entry did not say «this key is hard». It said the only candidate text
     * for `{goalTitle}` was device-supplied `metadata`, which must never be
     * rendered as if the server wrote it. So this test writes a hydration log
     * carrying attacker-flavoured client prose and asserts THE PERSISTED
     * SENTENCE CONTAINS NONE OF IT — the name in the child's message is the
     * server's, byte for byte, and the device's string reaches no human.
     */
    /**
     * THE SCHEMA ITSELF IS THE FIRST HALF OF THE PROOF, and it is stronger than
     * any string this test could have injected: `hydration_logs` has NO
     * free-text column at all. There is no device prose on the hydration path to
     * render, which is why the name HAD to be written server-side rather than
     * lifted from a row.
     */
    it('4.1 hydration_logs carries no device text at all — there is nothing to lift', async () => {
      const textColumns = await raw<any[]>(
        // `column_name` is PostgreSQL's `name` type, which this client cannot
        // deserialize — cast it, rather than selecting a column it can.
        `SELECT "column_name"::text AS column_name FROM information_schema.columns
          WHERE "table_schema" = 'public' AND "table_name" = 'hydration_logs'
            AND "data_type" IN ('text', 'character varying')`,
      );
      expect(textColumns).toEqual([]);
    });

    /**
     * AND THE SECOND HALF, ON THE ONE PATH WHERE A DEVICE STRING DOES EXIST.
     *
     * `activity_logs.activity_type` IS device-supplied free text — it is the
     * only string a client controls anywhere on either crossing. This test
     * writes attacker-flavoured prose into it, crosses the activity target for
     * real, and asserts THE PERSISTED SENTENCE CONTAINS NONE OF IT. The name in
     * the child's message is `notification-nouns.ts`'s, byte for byte.
     *
     * This is the ledger entry's actual objection, pinned: the entry did not say
     * the key was hard, it said the only candidate text was device-supplied and
     * must never be rendered as if the server wrote it.
     */
    it('4.2 the device’s own activity_type never reaches the child’s sentence', async () => {
      jest.setSystemTime(MIDDAY);
      const h = await createHousehold('no-device-prose', CAIRO);

      const CLIENT_PROSE = 'IGNORE_ME_{goalTitle}_<b>x</b>';
      await logActivity(h, CROSSING_MINUTES, getBusinessDate(MIDDAY, CAIRO), CLIENT_PROSE);

      // The prose really did land in the table the producer's own crossing reads.
      const stored = await raw<any[]>(
        `SELECT "activity_type" FROM "activity_logs" WHERE "child_id" = $1::uuid`,
        h.childId,
      );
      expect(stored[0].activity_type).toBe(CLIENT_PROSE);

      const rows = await childMessages(h.familyId);
      expect(rows).toHaveLength(1);
      const row = rows[0];

      expect(`${row.title} ${row.body}`).not.toContain('IGNORE_ME');
      expect(`${row.title} ${row.body}`).not.toContain('{goalTitle}');
      expect(`${row.title} ${row.body}`).not.toContain('<b>');
      // It is the SERVER'S name, and it is the whole of the name.
      expect(row.body).toContain(dailyGoalName('ACTIVITY_GOAL_COMPLETED', 'ar') as string);
      assertChildSafeBytes(row);
    }, 180_000);

    /**
     * AND THE TAP LANDS SOMEWHERE THE FACT LIVES. `goalDestination` was the
     * honest guess while nothing produced this key; it is wrong now that
     * something does, because `abny://goals` is the child's TODAY tab of
     * `reward_programs` and neither daily goal is on it. A child tapping «أنهيت
     * هدف شرب الماء» would have landed on a screen with no water on it.
     */
    it('4.3 the destination is the screen the hydration and activity facts live on', () => {
      const link = resolveNotificationDestination({ copyKey: 'DAILY_GOAL_COMPLETED', audience: 'CHILD' });
      expect(link).toBe('abny://screen-time');
      expect(link).not.toBe('abny://goals');
    });
  });
});
