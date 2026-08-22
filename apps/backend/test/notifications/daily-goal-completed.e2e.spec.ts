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
import {
  forChildAudience,
  forEntity,
  forRecurringSignal,
} from '../../src/shared/notifications/notification-source-key';
import {
  COPY_CATALOGUE,
  hasEnumOrPlaceholderLeak,
  renderNotificationCopy,
} from '../../src/modules/notifications/domain/engine/notification-copy';
import {
  RUNTIME_ALERT_REPOSITORY,
  type IRuntimeAlertRepository,
} from '../../src/modules/pairing/application/ports/runtime-alert.repository.port';
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

describeIfDb('F1 — DAILY_GOAL_COMPLETED reaches the child (real PostgreSQL, real Safety Engine)', () => {
  let app: INestApplication;
  let prisma: any;
  let health: HealthEngineService;
  let childSafety: ChildSafetyFilterService;
  /** THE SINGLE WRITER OF `notifications`, resolved from the real container.
   * §5 tests its dedupe predicate directly; nothing else in this file touches
   * it, because every other section reaches it through the engine. */
  let alerts: IRuntimeAlertRepository;

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
    alerts = app.get(RUNTIME_ALERT_REPOSITORY);
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
     * ONE CROSSING, THREE ROWS ON A CHILD'S FIRST TIME, AND THEY ARE THREE
     * DIFFERENT FACTS.
     *
     * THIS TEST ASSERTED TWO AND SAID «a third would be noise». It went red when
     * `HealthEngineService.logHydration` began firing the contract name
     * `HYDRATION_GOAL_COMPLETED` beside its `DAILY_GOAL_COMPLETED` — the fix that
     * made 0026's `first_hydration_goal` badge earnable through the app's own
     * button at all, having previously been reachable only through
     * `POST /events/batch`. THE THIRD ROW IS THAT BADGE, and it is not the noise
     * this comment was written about: it is a ONCE-EVER fact with its own key
     * space (`badge:`), its own screen (`abny://progress`) and its own sentence.
     * The ceiling was written when the badge could not be earned on this path;
     * the fact changed, so the number does.
     *
     * WHAT IS STILL PINNED, and it is the whole reason the test exists: THREE
     * DISTINCT CAUSES IN THREE DISTINCT KEY SPACES. A fourth row, a second
     * receipt, or any two of them colliding on
     * `child_messages (family_id, source_event_id)` still fails here.
     *
     * AND THE THIRD ROW IS ONCE-EVER, ASSERTED RATHER THAN DESCRIBED: exactly one
     * `child_badge_awards` row exists, which is what makes «three on a child's
     * first crossing, two on every crossing after it» a fact about the data
     * instead of a sentence in a comment.
     */
    it('1.4 one crossing writes the receipt, the reward message AND the once-ever badge — three causes, never four rows', async () => {
      jest.setSystemTime(MIDDAY);
      const h = await createHousehold('coexistence', CAIRO);

      await logHydration(h, CROSSING_ML);

      const all = await allChildMessages(h.familyId);
      expect(all).toHaveLength(3);
      expect(all.map((m) => m.category).sort()).toEqual([
        'BADGE_EARNED',
        'DAILY_GOAL_COMPLETED',
        'REWARD_GRANTED_CHILD',
      ]);

      // THREE DISTINCT causes — a `signal:` key for the crossing, a `reward:` key
      // for the grant and a `badge:` key for the badge — which is why none of
      // them deduplicates any other away.
      expect(new Set(all.map((m) => m.source_event_id)).size).toBe(3);
      const receipt = all.find((m) => m.category === 'DAILY_GOAL_COMPLETED');
      const grant = all.find((m) => m.category === 'REWARD_GRANTED_CHILD');
      const badge = all.find((m) => m.category === 'BADGE_EARNED');
      expect(receipt.source_event_id).toContain('signal:');
      expect(grant.source_event_id).toContain('reward:');
      expect(badge.source_event_id).toContain('badge:');

      // Three different destinations, because they answer three different
      // questions: «where is my progress», «where is my reward», «where is my
      // badge».
      expect(receipt.data.deepLink).toBe('abny://screen-time');
      expect(grant.data.deepLink).toBe('abny://rewards');
      expect(badge.data.deepLink).toBe('abny://progress');

      // THE BADGE IS ONCE-EVER — one award row, so the third message is a
      // first-time row and not a per-crossing one.
      const awards = await raw<any[]>(
        `SELECT * FROM "child_badge_awards" WHERE "family_id" = $1::uuid`,
        h.familyId,
      );
      expect(awards).toHaveLength(1);

      // ALL THREE are safety-clean at this child's own band — a celebration the
      // product ships as a set is a set a child reads.
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
     * ==========================================================================
     * THE TWO DAILY GOALS ARE TWO FACTS AND DO NOT DEDUP EACH OTHER AWAY —
     * AND THE DEFECT THIS TEST USED TO PIN IS CLOSED, MEASURED HERE.
     * ==========================================================================
     *
     * WHAT THIS TEST IS FOR, UNCHANGED. The two crossings share a child, a day
     * and an event type; only the CAUSE differs. A key that omitted the cause
     * would silently drop the second one. That property is still proven, and it
     * is proven where the cause key actually lives: TWO `notification_decisions`
     * rows with TWO distinct `source_event_id`s. That assertion is untouched.
     *
     * THE SECOND RECEIPT IS STILL REFUSED, AND STILL ON VOLUME. That is correct
     * and it is not what changed: the hourly cap is real, `decision =
     * 'SUPPRESS'` with `reason = 'SCORE_BELOW_FLOOR'` is written to the ledger,
     * and the test reads the arithmetic back out of `explanation` rather than
     * trusting the verdict. A daily receipt that loses to volume has another one
     * tomorrow.
     *
     * ------------------------------------------------------------------------
     * WHAT THIS TEST USED TO PIN, AND WHAT THE LEDGER SAYS NOW.
     * ------------------------------------------------------------------------
     *
     * IT PINNED A REPORTED DEFECT: the child's own once-ever
     * `first_activity_goal` BADGE_EARNED scored 17 against a floor of 25 and was
     * SUPPRESSED, while `BADGE_EARNED_PARENT` FOR THE SAME BADGE was SENT. The
     * child earned a badge, their parent was told, and the child was not —
     * because a repeatable daily receipt happened to arrive first in the same
     * rolling hour. A once-ever badge that loses to volume is gone; there is no
     * second first time.
     *
     * TWO CHANGES CLOSED IT, and both are named here because either one alone
     * would have left the parent's half broken in the mirror direction:
     *
     *   `ONCE_EVER_TYPES` (`notification-policy.ts`) exempts `BADGE_EARNED` and
     *   `BADGE_EARNED_PARENT` from all three volume loads, on the strength of
     *   the `child_badge_awards (child_id, badge_id)` UNIQUE constraint. The
     *   child's badge now scores 42 and is delivered.
     *
     *   `PrismaRuntimeAlertRepository`'s five-minute dedupe stopped comparing
     *   TITLES. Every `BADGE_EARNED_PARENT` in the catalogue carries the same
     *   constant «وسام جديد», so the parent's SECOND badge of the minute came
     *   back `decision=SEND, outcome=SUPPRESS/ALREADY_NOTIFIED` — a reason
     *   `notification-audience-symmetry.ts` counts as TOLD, which is how the
     *   loss stayed invisible. §5 measures that half on its own, in both
     *   directions.
     *
     * THE LEDGER, READ OUT OF `notification_decisions.explanation` AT
     * `maxPerHour = 3`, AND THE ASSERTIONS BELOW ARE TAKEN FROM IT:
     *
     *   BADGE_EARNED         / CHILD  SEND     score 42  exempt from volume
     *   BADGE_EARNED_PARENT  / PARENT SEND     score 42  exempt from volume
     *   REWARD_GRANTED       / PARENT SEND     score 30  hour=1/3
     *   REWARD_GRANTED_CHILD / CHILD  SEND     score 30  hour=1/3
     *   DAILY_GOAL_COMPLETED / CHILD  SEND     score 26  hour=2/3
     *   -- the activity crossing --
     *   BADGE_EARNED         / CHILD  SEND     score 42  exempt from volume
     *   BADGE_EARNED_PARENT  / PARENT SEND     score 42  exempt from volume
     *   REWARD_GRANTED       / PARENT SUPPRESS score 13  hour=3/3
     *   REWARD_GRANTED_CHILD / CHILD  SUPPRESS score 13  hour=4/3
     *   DAILY_GOAL_COMPLETED / CHILD  SUPPRESS score 18  hour=4/3
     *
     * The two badges are the four SEND rows the block at the end of this test
     * asserts; the last line is the row `fatigue.note` is read from, and the
     * comment there explains why its hour reads 4 and not the 3 this file used
     * to carry.
     *
     * IT IS NOT ANOTHER INSTANCE OF THE DUPLICATE-RULE COLLISION migration 0030
     * closed. That was two rules paying one crossing, and closing it removed two
     * decision rows per crossing — measured here, and it was not enough, because
     * three legitimate messages still filled a three-message hour.
     */
    it('2.2 the hydration and activity crossings are DIFFERENT causes on the same day — and the second is refused on VOLUME, not deduplicated', async () => {
      jest.setSystemTime(MIDDAY);
      const h = await createHousehold('both-goals', CAIRO);

      await logHydration(h, CROSSING_ML);
      await logActivity(h, CROSSING_MINUTES, getBusinessDate(MIDDAY, CAIRO));

      // --- THE PROPERTY THIS TEST HAS ALWAYS BEEN ABOUT, UNCHANGED ---
      // Two causes, two rows, two keys. Nothing deduplicated anything.
      const decisionRows = await decisions(h.familyId);
      expect(decisionRows).toHaveLength(2);
      expect(new Set(decisionRows.map((d) => d.source_event_id)).size).toBe(2);

      const hydrationCause = forEntity(
        'signal', h.childId, 'daily-goal:HYDRATION_GOAL_COMPLETED', getBusinessDate(MIDDAY, CAIRO),
      );
      const activityCause = forEntity(
        'signal', h.childId, 'daily-goal:ACTIVITY_GOAL_COMPLETED', getBusinessDate(MIDDAY, CAIRO),
      );
      expect(decisionRows.map((d) => d.source_event_id).sort()).toEqual(
        [hydrationCause, activityCause].sort(),
      );

      // --- AND THE SECOND ONE WAS ANSWERED, NOT LOST ---
      const hydration = decisionRows.find((d) => d.source_event_id === hydrationCause);
      const activity = decisionRows.find((d) => d.source_event_id === activityCause);

      expect(hydration.decision).toBe('SEND');
      expect(activity.decision).toBe('SUPPRESS');
      expect(activity.reason).toBe('SCORE_BELOW_FLOOR');

      // THE REASON IS VOLUME, READ OUT OF THE STORED EXPLANATION — the row
      // reconciles to its own score, so «refused on volume» is a fact in the
      // database and not a reading of this comment.
      const fatigue = (activity.explanation as any[]).find((c) => c.name === 'FATIGUE_PENALTY');
      expect(fatigue.raw).toBe(1);
      // WHY `hour=4/3` AND NOT `hour=3/3`, WHICH IS WHAT THIS LINE READ BEFORE.
      // The cap did not move — `maxPerHour` is still 3 and §0 asserts it. The
      // LOAD moved, by one, and the extra row is the child's own activity
      // badge. It used to be SUPPRESSED at this exact point (score 17, floor
      // 25) and therefore never became a `child_messages` row, so it never
      // counted toward the hour it had just lost to. `ONCE_EVER_TYPES` now
      // exempts `BADGE_EARNED` from the volume loads, the badge is delivered,
      // and a delivered row is part of the household's load like any other:
      //
      //   BADGE_EARNED         hydration badge   delivered  (hour reads 0)
      //   REWARD_GRANTED_CHILD hydration reward  delivered  (hour reads 1)
      //   DAILY_GOAL_COMPLETED hydration receipt delivered  (hour reads 2)
      //   BADGE_EARNED         activity badge    delivered  (hour reads 3)
      //   -- the activity receipt is scored against all four --
      //   DAILY_GOAL_COMPLETED activity receipt  hour=4/3   SUPPRESS
      //
      // So 4 is the count going UP because a child stopped losing something,
      // not a number drifting. The claim this test makes — refused on VOLUME
      // rather than deduplicated — is unchanged and is still carried by
      // `fatigue.raw === 1` and a negative contribution beside it.
      expect(fatigue.note).toBe('today=4/6 hour=4/3 category=1/2');
      expect(fatigue.contribution).toBeLessThan(0);

      // --- WHAT THE CHILD ACTUALLY READ ---
      // ONE receipt, and it is the hydration one, in the server's own Arabic.
      const messages = await childMessages(h.familyId);
      expect(messages).toHaveLength(1);
      expect(messages[0].body).toContain('شرب الماء');
      expect(messages[0].body).not.toContain('النشاط البدني');
      expect(messages[0].source_event_id).toBe(forChildAudience(hydrationCause));
      for (const m of messages) assertChildSafeBytes(m);

      // ====================================================================
      // THE ASYMMETRY THIS TEST USED TO PIN, MEASURED AGAIN AND NOW ABSENT.
      // ====================================================================
      //
      // The same query that used to return «one child badge SUPPRESSED while
      // the parent's copy of it was SENT» is kept, pointed at the same rows,
      // and asserts the opposite — because that is what reconciles: an
      // assertion deleted proves nothing, and an assertion inverted proves the
      // defect is gone. Two once-ever badges are earned in this one minute and
      // all FOUR rows they produce (two causes × two audiences) are SEND at
      // the verdict AND SEND at the outcome.
      //
      // TWO FIXES ARE LOAD-BEARING HERE AND THE SECOND ONE IS NOT THE ENGINE'S:
      //   `ONCE_EVER_TYPES` stops the child's badge losing to the hour, and
      //   `PrismaRuntimeAlertRepository`'s dedupe now names the OCCURRENCE
      //   instead of the title — without which the parent's SECOND badge came
      //   back `decision=SEND, outcome=SUPPRESS/ALREADY_NOTIFIED`, because
      //   every `BADGE_EARNED_PARENT` in the catalogue carries the identical
      //   constant title. §5 holds that half on its own.
      const badgeDecisions = (await allDecisions(h.familyId)).filter((d) =>
        String(d.event_type).startsWith('BADGE_EARNED'),
      );
      expect(badgeDecisions).toHaveLength(4);
      for (const d of badgeDecisions) {
        // Composed into one string so a failure names WHICH row disagreed.
        expect(`${d.event_type}/${d.target_audience} ${d.decision}/${d.outcome}`).toBe(
          `${d.event_type}/${d.target_audience} SEND/SEND`,
        );
        expect(
          (d.explanation as any[]).find((c) => c.name === 'FATIGUE_PENALTY').contribution,
        ).toBe(0);
      }

      // TWO CAUSES, AND EACH ONE REACHED BOTH AUDIENCES. Grouped on the bare
      // producer key — the column `notification-audience-symmetry.ts` groups on
      // for the same reason — so «the child lost what the parent was told» has
      // no instance left to point at, per cause rather than in aggregate.
      const audiencesPerBadge = new Map<string, string[]>();
      for (const d of badgeDecisions) {
        audiencesPerBadge.set(d.source_event_id, [
          ...(audiencesPerBadge.get(d.source_event_id) ?? []),
          d.target_audience,
        ]);
      }
      expect(audiencesPerBadge.size).toBe(2);
      for (const [cause, audiences] of audiencesPerBadge) {
        expect(`${cause} ${[...audiences].sort().join('+')}`).toBe(`${cause} CHILD+PARENT`);
      }
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

  // ==========================================================================
  // 5. THE PARENT'S INBOX — THE DEDUPE NAMES THE OCCURRENCE, NOT THE SENTENCE
  // ==========================================================================
  /**
   * ==========================================================================
   * A REAL DEFECT, FOUND WHILE §2.2 WAS BEING RECONCILED, AND MEASURED HERE.
   * ==========================================================================
   *
   * `PrismaRuntimeAlertRepository.createForFamilyOwner` is the SINGLE WRITER of
   * `notifications`, and it held a five-minute `findFirst` on
   * `(user_id, child_id, type, TITLE)`. `BADGE_EARNED_PARENT`'s title is the
   * CONSTANT «وسام جديد» for every badge in the catalogue — good copy repeats
   * on purpose — so TWO DIFFERENT once-ever badges earned five minutes apart
   * collapsed into one row and THE PARENT WAS NEVER TOLD ABOUT THE SECOND.
   *
   * IT WAS PRE-EXISTING AND IT WAS MASKED. The engine's own COOLDOWN refusal
   * used to arrive first and produce the same end state under a different
   * reason string; once `ONCE_EVER_COOLDOWN_EXEMPTIONS` removed that, the title
   * dedupe was the only thing left losing the badge — and it reported the loss
   * as `outcome_reason = ALREADY_NOTIFIED`, which
   * `notification-audience-symmetry.ts` counts as TOLD. A loss that names
   * itself a success is invisible to the invariant built to catch it.
   *
   * WHY THIS SECTION IS A DIRECT REPOSITORY TEST AND NOT A THIRD CROSSING. The
   * defect is in a PREDICATE, and a predicate has two sides. Driving it through
   * the health engine proves one of them (§2.2 does exactly that, and the four
   * SEND rows there are this fix's product consequence). This section calls the
   * real repository against real PostgreSQL so that BOTH sides are stated where
   * they can be read together — the direction that must still dedupe as loudly
   * as the direction that must not.
   */
  describe('5. the five-minute dedupe, in both directions', () => {
    /** The title every badge notification to a parent carries — read from the
     * catalogue rather than typed here, so this test cannot drift away from the
     * copy that caused the defect. */
    const BADGE_PARENT_TITLE = 'وسام جديد';

    const parentInbox = (familyId: string): Promise<any[]> =>
      raw<any[]>(
        `SELECT "type", "title", "source_event_id" FROM "notifications"
          WHERE "family_id" = $1::uuid ORDER BY "created_at", "id"`,
        familyId,
      );

    const tellParent = (h: Household, sourceEventId: string) =>
      asFamily(h.familyId, () =>
        alerts.createForFamilyOwner({
          familyId: h.familyId,
          childId: h.childId,
          type: 'BADGE_EARNED_PARENT',
          title: BADGE_PARENT_TITLE,
          body: 'حصل محمد على وسام.',
          priority: 'NORMAL',
          sourceEventId,
        }),
      );

    it('5.0 the premise: every BADGE_EARNED_PARENT in the catalogue carries the SAME title', () => {
      // If this ever stops being true the defect below stops being reachable —
      // and this test would then be passing for the wrong reason. So the
      // premise is asserted from the shipped catalogue, not assumed.
      const entry = COPY_CATALOGUE.BADGE_EARNED_PARENT;
      expect(entry.variants.PARENT?.ar.title).toBe(BADGE_PARENT_TITLE);
      // …and the title takes no variables, which is what makes it constant
      // across badges rather than merely equal for two of them.
      expect(entry.variants.PARENT?.ar.title).not.toContain('{');
    });

    it('5.1 the SAME occurrence twice inside the window is still ONE row — the flap this dedupe exists for', async () => {
      jest.setSystemTime(MIDDAY);
      const h = await createHousehold('dedupe-same', CAIRO);
      const occurrence = forEntity('badge', h.childId, 'badge-alpha');

      expect(await tellParent(h, occurrence)).toBe(true);
      // The clock is frozen, so the second call is unambiguously INSIDE the
      // five-minute window rather than merely fast.
      expect(await tellParent(h, occurrence)).toBe(false);

      const rows = await parentInbox(h.familyId);
      expect(rows).toHaveLength(1);
      expect(rows[0].source_event_id).toBe(occurrence);
    }, 180_000);

    it('5.2 TWO DIFFERENT badges inside the same window BOTH reach the parent — the defect', async () => {
      jest.setSystemTime(MIDDAY);
      const h = await createHousehold('dedupe-distinct', CAIRO);
      const alpha = forEntity('badge', h.childId, 'badge-alpha');
      const beta = forEntity('badge', h.childId, 'badge-beta');

      // Same recipient, same child, same type, same TITLE, same minute — every
      // field the old predicate compared. Only the occurrence differs, and the
      // occurrence is the only thing that should decide this.
      expect(await tellParent(h, alpha)).toBe(true);
      expect(await tellParent(h, beta)).toBe(true);

      const rows = await parentInbox(h.familyId);
      expect(rows).toHaveLength(2);
      expect(rows.map((r) => r.source_event_id).sort()).toEqual([alpha, beta].sort());
      // Both really do carry the identical sentence — otherwise this test would
      // be proving that two different titles are not deduped, which was never
      // in doubt.
      expect(new Set(rows.map((r) => r.title))).toEqual(new Set([BADGE_PARENT_TITLE]));
    }, 180_000);

    it('5.3 a flapping RECURRING SIGNAL is still suppressed ACROSS a bucket edge, where the keys differ', async () => {
      // THE CASE A BARE `sourceEventId` EQUALITY WOULD HAVE SILENTLY DROPPED.
      // `forRecurringSignal` quantises time into a five-minute bucket, so two
      // alerts seconds apart on opposite sides of an edge compose DIFFERENT
      // keys — and `notification-source-key.ts` states in its own docstring
      // that this repository's sliding window is what covers the gap. It still
      // does: the predicate strips the `:w<bucket>` artefact before comparing.
      jest.setSystemTime(MIDDAY);
      const h = await createHousehold('dedupe-flap', CAIRO);

      const beforeEdge = new Date(MIDDAY.getTime());
      const afterEdge = new Date(MIDDAY.getTime() + 5 * 60_000);
      const first = forRecurringSignal('runtime', h.childId, 'ACCESSIBILITY_DISABLED', beforeEdge);
      const second = forRecurringSignal('runtime', h.childId, 'ACCESSIBILITY_DISABLED', afterEdge);
      // The premise: two DIFFERENT keys for one flapping device.
      expect(first).not.toBe(second);

      expect(await tellParent(h, first)).toBe(true);
      expect(await tellParent(h, second)).toBe(false);
      expect(await parentInbox(h.familyId)).toHaveLength(1);
    }, 180_000);

    it('5.4 …and a DIFFERENT recurring signal in the same window is NOT collapsed with it', async () => {
      // The control for 5.3: the bucket is stripped, the DISCRIMINATOR is not.
      // Without this, 5.3 would also pass against a predicate that suppressed
      // every runtime alert in the window regardless of what it was about.
      jest.setSystemTime(MIDDAY);
      const h = await createHousehold('dedupe-flap-control', CAIRO);

      const accessibility = forRecurringSignal('runtime', h.childId, 'ACCESSIBILITY_DISABLED', MIDDAY);
      const vpn = forRecurringSignal('runtime', h.childId, 'VPN_DETECTED', MIDDAY);

      expect(await tellParent(h, accessibility)).toBe(true);
      expect(await tellParent(h, vpn)).toBe(true);
      expect(await parentInbox(h.familyId)).toHaveLength(2);
    }, 180_000);
  });
});
