/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-var-requires */
/**
 * PHASE F (`F6-002` §9) — THE ADMIN ANALYTICS SURFACE, AGAINST REAL ROWS.
 *
 * §9 asks for sent, suppressed, open rate, action rate, duplicate rate,
 * AI-rewrite rate, delivery failure, top types and fatigue — filterable by
 * country, age, audience, category and date. The dashboard UI is out of scope;
 * the NUMBERS are not, and a number that has never been computed over real rows
 * is a schema, not a metric.
 *
 * So this suite drives real notifications through the real engine, marks one of
 * them read, and then reads the aggregate back through the REAL repository and
 * the REAL controller — including the guard, which is the half of an admin
 * surface that most often turns out to be missing.
 */
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';

import { AppModule } from '../../src/app.module';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { createTenantExtension } from '../../src/common/tenancy/tenant.extension';
import { runAsSystemAsync } from '../../src/common/tenancy/system-context';
import { runWithTenant } from '../../src/common/tenancy/tenant-context';
import { AI_PROVIDER } from '../../src/modules/ai-core/domain/ai-provider.port';
import { ROLES_METADATA } from '../../src/common/authz/roles.decorator';
import { SYSTEM_ROUTE_METADATA } from '../../src/common/tenancy/system-route.decorator';
import { SmartNotificationEngineService } from '../../src/modules/notification-engine/application/services/smart-notification-engine.service';
import { NotificationAnalyticsController } from '../../src/modules/notification-engine/presentation/controllers/notification-analytics.controller';
import { NotificationPolicyController } from '../../src/modules/notification-engine/presentation/controllers/notification-policy.controller';
import type { NotificationEventInput } from '../../src/modules/notification-engine/application/services/notification-context.assembler';
import type { DecisionAnalyticsReport } from '../../src/modules/notifications/application/ports/notification-decision.repository.port';
import { getBusinessDate, getBusinessTimeHHMM } from '../../src/common/time/family-date';
import { integrationDatabaseUrl } from '../tenancy/prisma-test-client';

const describeIfDb = integrationDatabaseUrl() ? describe : describe.skip;

const AFTERNOON = new Date('2026-02-24T15:00:00.000Z'); // 17:00 Cairo
const DEEP_NIGHT = new Date('2026-02-24T22:30:00.000Z'); // 00:30 Cairo
/**
 * TWO DATES, and the second one is the assertion.
 *
 * `DEEP_NIGHT` is 22:30 UTC on the 24th and 00:30 CAIRO on the 25th, so the two
 * quiet-hours decisions carry `business_date = 2026-02-25`. That is the whole
 * point of storing the FAMILY'S business date rather than a UTC one — «last
 * month» has to mean the household's month — and a range that covered only the
 * UTC day would silently lose them.
 *
 * ===========================================================================
 * FEBRUARY, NOT JANUARY, AND A BASELINE BESIDE IT. NEITHER IS COSMETIC.
 * ===========================================================================
 *
 * WHAT WAS MEASURED: `utcDayOnly.total` came back 3 against `toBe(1)`, and the
 * two extra rows belonged to `Golden Family e2e10en` — a fixture of `e2e-10`'s,
 * on `business_date = 2026-01-15`, carrying one `REWARD_GRANTED` and one
 * `REWARD_GRANTED_CHILD`. Those same two rows are why
 * `topTypes.every(t => t.type === 'REWARD_GRANTED')` returned false.
 *
 * `2026-01-15` is a shared literal across some twenty suites here, and
 * `GET /system/notifications/analytics` is a PLATFORM roll-up: its own
 * docstring argues at length that it must never accept or return a family id,
 * so there is no tenant filter to scope with and a test cannot add one. AN
 * ABSOLUTE COUNT TAKEN THROUGH IT IS A COUNT OF WHATEVER ELSE SHARES THAT
 * BUSINESS DATE on the reused `afdc_ci` database.
 *
 * This is the shape that has bitten this repository twice — most recently a
 * pagination guard that asserted foreign families EXIST, so it passed on a
 * reused database and failed on a clean one. Lowering `1` to `3` would have
 * reproduced it precisely: green today, red on a fresh database, red again the
 * day `e2e-10` renames a fixture.
 *
 * SO THERE ARE TWO DEFENCES AND THEY ARE INDEPENDENT ON PURPOSE.
 *
 *   A PRIVATE BUSINESS DATE. `2026-02-24`/`2026-02-25` appear in no other suite
 *   and no migration. Egypt is UTC+02:00 in February exactly as in January, so
 *   the Cairo-midnight geometry the assertions rest on is unchanged — and 0.1
 *   below READS that from tzdata rather than trusting this sentence.
 *
 *   A BASELINE. Every absolute count is asserted as a DELTA against `BASELINE`,
 *   captured through the same controller with the same arguments BEFORE this
 *   suite writes a row. If a future suite colonises the date anyway, the delta
 *   is still exactly this cohort's own contribution.
 *
 * `1` and `2` are this suite's own numbers and they do not move.
 */
const BUSINESS_DATE = '2026-02-24';
const NEXT_BUSINESS_DATE = '2026-02-25';

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

describeIfDb('PHASE F — notification analytics and the household policy surface', () => {
  let app: INestApplication;
  let prisma: any;
  let engine: SmartNotificationEngineService;
  let analytics: NotificationAnalyticsController;
  let policyApi: NotificationPolicyController;

  const stamp = Date.now();
  const createdFamilies: string[] = [];
  const createdUsers: string[] = [];
  let family: { familyId: string; childId: string; userId: string };
  let quietFamily: { familyId: string; childId: string; userId: string };
  let deferFamily: { familyId: string; childId: string; userId: string };

  /**
   * WHAT THE PLATFORM ALREADY HELD ON THIS SUITE'S TWO DATES, READ THROUGH THE
   * SAME CONTROLLER AND THE SAME ARGUMENTS, BEFORE THIS SUITE WROTE ANYTHING.
   *
   * Four windows because four assertions are absolute; every other assertion in
   * the file is a `>=` and needs no baseline. See the header for why an
   * absolute count through a cross-tenant roll-up cannot stand on its own.
   */
  let BASELINE: {
    firstDay: DecisionAnalyticsReport;
    secondDay: DecisionAnalyticsReport;
    rewardCategory: DecisionAnalyticsReport;
    otherBand: DecisionAnalyticsReport;
  };

  /**
   * The types whose count GREW between two readings of the same window — this
   * cohort's own contribution to a `topTypes` list that may also carry rows
   * nobody here wrote. Sorted, so a failure reads as a set and not as an
   * ordering accident.
   */
  const typesAddedSince = (
    before: DecisionAnalyticsReport,
    after: DecisionAnalyticsReport,
  ): string[] => {
    const was = new Map(before.topTypes.map((t) => [t.type, t.total]));
    return after.topTypes
      .filter((t) => t.total > (was.get(t.type) ?? 0))
      .map((t) => t.type)
      .sort();
  };

  const sys = (what: string, fn: () => Promise<any>): Promise<any> =>
    runAsSystemAsync('TEST_FIXTURE', `Phase F analytics suite: ${what}`, async () => await fn());

  const raw = <T>(sql: string, ...params: unknown[]): Promise<T> =>
    sys('raw sql', () => prisma.$queryRawUnsafe(sql, ...params)) as Promise<T>;

  const fire = (input: NotificationEventInput) =>
    runWithTenant({ familyId: input.familyId, actorType: 'SYSTEM', actorId: 'phase-f-analytics' }, () =>
      engine.handleEvent(input),
    );

  async function createFamily(label: string) {
    const fam = await sys('create family', () =>
      prisma.family.create({
        data: { name: `PF-an ${label} ${stamp}`, timezone: 'Africa/Cairo' },
        select: { id: true },
      }),
    );
    createdFamilies.push(fam.id);
    const user = await sys('create user', () =>
      prisma.user.create({
        data: {
          email: `pf.an.${label}.${stamp}@example.test`,
          passwordHash: 'x',
          fullName: 'PF',
          locale: 'ar',
        },
        select: { id: true },
      }),
    );
    createdUsers.push(user.id);
    await sys('membership', () =>
      prisma.familyMember.create({ data: { familyId: fam.id, userId: user.id, role: 'OWNER' } }),
    );
    const child = await sys('child', () =>
      prisma.child.create({
        data: { familyId: fam.id, firstName: 'محمد', dateOfBirth: new Date('2013-04-01T00:00:00.000Z') },
        select: { id: true },
      }),
    );
    return { familyId: fam.id, childId: child.id, userId: user.id };
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue(offlinePrismaService())
      .overrideProvider(AI_PROVIDER)
      .useValue({ complete: async () => 'صياغة بديلة من النموذج' })
      .compile();

    app = moduleRef.createNestApplication();
    await app.init();
    prisma = app.get(PrismaService);
    engine = app.get(SmartNotificationEngineService);
    analytics = app.get(NotificationAnalyticsController);
    policyApi = app.get(NotificationPolicyController);

    // BEFORE A SINGLE ROW OF THIS SUITE'S OWN EXISTS.
    BASELINE = {
      firstDay: await analytics.analytics(BUSINESS_DATE, BUSINESS_DATE),
      secondDay: await analytics.analytics(NEXT_BUSINESS_DATE, NEXT_BUSINESS_DATE),
      rewardCategory: await analytics.analytics(
        BUSINESS_DATE,
        NEXT_BUSINESS_DATE,
        undefined,
        undefined,
        undefined,
        'REWARD',
      ),
      otherBand: await analytics.analytics(BUSINESS_DATE, NEXT_BUSINESS_DATE, undefined, '5-7'),
    };

    family = await createFamily('sent');
    quietFamily = await createFamily('suppressed');
    deferFamily = await createFamily('deferred');

    // A DELIVERED parent notification, later marked read -> the open rate.
    await fire({
      familyId: family.familyId,
      childId: family.childId,
      eventType: 'REWARD_GRANTED',
      sourceEventId: `evt:${stamp}:an-sent`,
      trigger: 'DOMAIN_EVENT',
      reward: { kind: 'COINS', amount: 30, isMilestone: false },
      now: AFTERNOON,
    });
    // A SUPPRESSED reminder inside quiet hours -> the suppression rate.
    await fire({
      familyId: quietFamily.familyId,
      childId: quietFamily.childId,
      eventType: 'HYDRATION_REMINDER',
      sourceEventId: `signal:${stamp}:an-suppressed`,
      trigger: 'PERIODIC_SIGNAL',
      now: DEEP_NIGHT,
    });
    // A DEFERRED reward inside quiet hours -> the defer count.
    await fire({
      familyId: deferFamily.familyId,
      childId: deferFamily.childId,
      eventType: 'REWARD_GRANTED',
      sourceEventId: `evt:${stamp}:an-deferred`,
      trigger: 'DOMAIN_EVENT',
      reward: { kind: 'COINS', amount: 40, isMilestone: true },
      now: DEEP_NIGHT,
    });

    await raw(
      `UPDATE "notifications" SET "read_at" = NOW() WHERE "family_id" = $1::uuid`,
      family.familyId,
    );
  }, 90_000);

  afterAll(async () => {
    for (const id of createdFamilies) {
      await sys('cleanup family', () => prisma.family.delete({ where: { id } })).catch(() => undefined);
    }
    for (const id of createdUsers) {
      await sys('cleanup user', () => prisma.user.delete({ where: { id } })).catch(() => undefined);
    }
    await app?.close();
  }, 60_000);

  /**
   * THE PREMISE THE MOVE TO FEBRUARY RESTS ON, READ FROM tzdata RATHER THAN
   * ASSERTED IN A COMMENT. Egypt observes DST from the last Friday of April to
   * the last Thursday of October, so February is UTC+02:00 exactly as January
   * was — but «exactly as January was» is the kind of claim that is true until
   * a tzdata release says otherwise, and the date literals above are chosen for
   * this geometry and nothing else.
   */
  it('0.1 the two instants are 17:00 and 00:30 in Cairo, and only the household has crossed midnight', () => {
    expect(getBusinessTimeHHMM(AFTERNOON, 'Africa/Cairo')).toBe('17:00');
    expect(getBusinessTimeHHMM(DEEP_NIGHT, 'Africa/Cairo')).toBe('00:30');
    expect(getBusinessDate(AFTERNOON, 'Africa/Cairo')).toBe(BUSINESS_DATE);
    expect(getBusinessDate(DEEP_NIGHT, 'Africa/Cairo')).toBe(NEXT_BUSINESS_DATE);
    // UTC is still on the FIRST day at that instant — which is the entire
    // reason `business_date` exists and what the split assertion below proves.
    expect(DEEP_NIGHT.toISOString().slice(0, 10)).toBe(BUSINESS_DATE);
  });

  it('returns every §9 number over real rows, and the rates have a sane denominator', async () => {
    const report = await analytics.analytics(BUSINESS_DATE, NEXT_BUSINESS_DATE);

    expect(report.total).toBeGreaterThanOrEqual(3);
    expect(report.decidedSend).toBeGreaterThanOrEqual(1);
    expect(report.decidedDefer).toBeGreaterThanOrEqual(1);
    expect(report.decidedSuppress).toBeGreaterThanOrEqual(1);
    expect(report.delivered).toBeGreaterThanOrEqual(1);

    // The open rate is computed over NOTIFICATION ROWS, not over decisions — a
    // suppressed decision has nothing to open and must not sit in the
    // denominator.
    expect(report.notificationRows).toBeGreaterThanOrEqual(1);
    expect(report.opened).toBeGreaterThanOrEqual(1);
    expect(report.openRate).toBeGreaterThan(0);
    expect(report.openRate).toBeLessThanOrEqual(1);

    // Every rate is a finite number in 0..1. The failure this prevents is
    // `NaN%` on an empty range, which is how a dashboard loses its readers.
    for (const rate of [report.suppressionRate, report.duplicateRate, report.aiRewriteRate, report.openRate]) {
      expect(Number.isFinite(rate)).toBe(true);
      expect(rate).toBeGreaterThanOrEqual(0);
      expect(rate).toBeLessThanOrEqual(1);
    }

    // ACTION RATE IS `null`, DELIBERATELY. This product cannot measure «acted»
    // today; a fabricated zero would look like a measurement.
    expect(report.actionRate).toBeNull();

    expect(report.topTypes.length).toBeGreaterThan(0);
    expect(report.topTypes.map((t) => t.type)).toContain('REWARD_GRANTED');

    // THE BUSINESS DATE IS THE FAMILY'S. The two quiet-hours decisions were
    // taken at 22:30 UTC on the 24th, which is 00:30 in Cairo on the 25th, and
    // they are filed under the 25th. A UTC-dated ledger would have put a
    // household's midnight activity on the wrong day for every family east of
    // Greenwich.
    //
    // ONE row of this suite's landed on the UTC day and TWO on the Cairo day —
    // measured as a DELTA against what the platform held before this suite ran,
    // so the split is this cohort's own and not the database's history. See the
    // header.
    const utcDayOnly = await analytics.analytics(BUSINESS_DATE, BUSINESS_DATE);
    expect(utcDayOnly.total - BASELINE.firstDay.total).toBe(1);
    const cairoNextDay = await analytics.analytics(NEXT_BUSINESS_DATE, NEXT_BUSINESS_DATE);
    expect(cairoNextDay.total - BASELINE.secondDay.total).toBe(2);
  });

  it('an EMPTY range returns zeros and NO NaN — the case every dashboard hits first', async () => {
    const report = await analytics.analytics('2020-01-01', '2020-01-02');
    expect(report.total).toBe(0);
    expect(report.openRate).toBe(0);
    expect(report.suppressionRate).toBe(0);
    expect(report.duplicateRate).toBe(0);
    expect(report.aiRewriteRate).toBe(0);
    expect(report.topTypes).toEqual([]);
  });

  it('filters by AUDIENCE, CATEGORY and AGE BAND independently', async () => {
    const parents = await analytics.analytics(BUSINESS_DATE, NEXT_BUSINESS_DATE, undefined, undefined, 'PARENT');
    const children = await analytics.analytics(BUSINESS_DATE, NEXT_BUSINESS_DATE, undefined, undefined, 'CHILD');
    expect(parents.total + children.total).toBeGreaterThanOrEqual(3);

    const rewards = await analytics.analytics(
      BUSINESS_DATE,
      NEXT_BUSINESS_DATE,
      undefined,
      undefined,
      undefined,
      'REWARD',
    );
    expect(rewards.total - BASELINE.rewardCategory.total).toBe(2);
    // THE CATEGORY FILTER REALLY IS A FILTER: the only types this cohort added
    // to the REWARD bucket are its own two `REWARD_GRANTED` decisions. Asserted
    // as the set that GREW rather than as `every()` over the whole list —
    // `every()` over a cross-tenant roll-up is a claim about other people's
    // rows, and it is the assertion `Golden Family e2e10en`'s stray
    // `REWARD_GRANTED_CHILD` was failing.
    expect(typesAddedSince(BASELINE.rewardCategory, rewards)).toEqual(['REWARD_GRANTED']);

    const band = await analytics.analytics(BUSINESS_DATE, NEXT_BUSINESS_DATE, undefined, '11-13');
    expect(band.total).toBeGreaterThanOrEqual(3);
    // NOTHING OF THIS COHORT'S IS IN THE 5-7 BAND — the three children are all
    // born 2013. A bare `toBe(0)` here would be the same absolute-count trap as
    // the two above, one foreign seven-year-old away from red.
    const otherBand = await analytics.analytics(BUSINESS_DATE, NEXT_BUSINESS_DATE, undefined, '5-7');
    expect(otherBand.total - BASELINE.otherBand.total).toBe(0);
  });

  it('refuses an unparseable filter rather than silently ignoring it', async () => {
    await expect(analytics.analytics('nonsense', BUSINESS_DATE)).rejects.toThrow(/YYYY-MM-DD/);
    await expect(analytics.analytics(BUSINESS_DATE, NEXT_BUSINESS_DATE, 'egypt')).rejects.toThrow(/two-letter/);
    await expect(
      analytics.analytics(BUSINESS_DATE, NEXT_BUSINESS_DATE, undefined, '6-8'),
    ).rejects.toThrow(/Unknown ageBand/);
    await expect(
      analytics.analytics(BUSINESS_DATE, NEXT_BUSINESS_DATE, undefined, undefined, 'EVERYONE'),
    ).rejects.toThrow(/PARENT or CHILD/);
    await expect(analytics.analytics('2026-01-15', '2020-01-01')).rejects.toThrow(/must not be after/);
    await expect(analytics.analytics('2020-01-01', '2026-01-15')).rejects.toThrow(/must not exceed/);
  });

  it('the platform analytics route is a SystemRoute behind the InternalAdminGuard', async () => {
    // The half of an admin surface that is most often missing. Read off the
    // real metadata rather than trusted to the decorator being present in the
    // source, because a decorator that is imported and not applied looks
    // identical in a diff.
    const proto = NotificationAnalyticsController.prototype as any;
    const guards = Reflect.getMetadata('__guards__', proto.analytics) ?? [];
    expect(guards.map((g: any) => g.name)).toContain('InternalAdminGuard');
    const roles = Reflect.getMetadata(ROLES_METADATA, proto.analytics) ?? [];
    expect(roles).toContain('SUPER_ADMIN');
    const systemRoute = Reflect.getMetadata(SYSTEM_ROUTE_METADATA, proto.analytics);
    expect(systemRoute?.reason).toBe('ADMIN_CONSOLE');
    // The justification is REQUIRED to be a real sentence, not a word — the
    // `@SystemRoute` convention is what makes `grep -rn "@SystemRoute" src/` a
    // tenant-bypass audit trail rather than a list.
    expect(systemRoute?.justification.length).toBeGreaterThan(60);
  });

  it('the household policy surface reads the EFFECTIVE policy and accepts a bounded write', async () => {
    const token = { sub: family.userId, familyId: family.familyId } as any;

    const before = await runWithTenant(
      { familyId: family.familyId, actorType: 'USER', actorId: family.userId },
      () => policyApi.readPolicy(token),
    );
    expect(before.effective.maxPerDay).toBe(6);
    expect(before.effective.quietHoursStart).toBe('21:00');
    expect(before.overrides).toEqual({});
    expect(before.schemas.length).toBeGreaterThan(8);

    const after = await runWithTenant(
      { familyId: family.familyId, actorType: 'USER', actorId: family.userId },
      () => policyApi.setPolicy(token, 'notification.quietHours.start', { value: '22:30' }),
    );
    expect(after.effective.quietHoursStart).toBe('22:30');
    // Untouched keys still hold their defaults — one override does not reset the
    // household's whole policy.
    expect(after.effective.maxPerDay).toBe(6);

    await expect(
      runWithTenant({ familyId: family.familyId, actorType: 'USER', actorId: family.userId }, () =>
        policyApi.setPolicy(token, 'notification.cap.maxPerDay', { value: '9999' }),
      ),
    ).rejects.toThrow(/above maximum/);

    await expect(
      runWithTenant({ familyId: family.familyId, actorType: 'USER', actorId: family.userId }, () =>
        policyApi.setPolicy(token, 'notification.made.up.key', { value: '1' }),
      ),
    ).rejects.toThrow(/closed vocabulary/);
  });

  it('a parent can read their own household’s decisions — and the rows explain themselves', async () => {
    const token = { sub: quietFamily.userId, familyId: quietFamily.familyId } as any;
    const rows = await runWithTenant(
      { familyId: quietFamily.familyId, actorType: 'USER', actorId: quietFamily.userId },
      () => policyApi.listDecisions(token, '50'),
    );
    expect(rows.length).toBeGreaterThanOrEqual(1);
    const suppressed = rows.find((r) => r.decision === 'SUPPRESS');
    expect(suppressed).toBeDefined();
    expect(suppressed?.reason).toBe('QUIET_HOURS_CLASS_SUPPRESS');
    // The arithmetic travels with it, so «why» is answerable without a second
    // query and without this file's source.
    expect(Array.isArray(suppressed?.explanation)).toBe(true);
  });
});
