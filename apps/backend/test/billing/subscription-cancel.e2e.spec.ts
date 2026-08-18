/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-var-requires */
/**
 * ============================================================================
 * SPRINT F1 (DECISION 3) — A `GRACE_PERIOD` HOUSEHOLD CAN CANCEL.
 * ============================================================================
 *
 * WHAT WAS MEASURED. The cancel affordance was gated on `status === 'ACTIVE'`.
 * `GRACE_PERIOD` is in `ENTITLEMENT_BEARING_STATUSES` — Q17 grants full
 * permissions for the whole seven-day window and CONTEXT §3.7 forbids punitive
 * UX — so the product was treating those households as paying customers AND
 * refusing them the exit. A household lands in `GRACE_PERIOD` precisely because
 * its card has just failed, which is exactly the moment a customer is most
 * likely to want to leave. That is a bad experience and, in several
 * jurisdictions, a compliance problem: the right to withdraw does not pause
 * because a payment did.
 *
 * WHAT THIS SUITE PROVES, against a real PostgreSQL, reading every row back
 * with SQL rather than trusting a return value:
 *
 *   1  EVERY STATUS, both ways. Four that may cancel — `TRIAL`, `ACTIVE`,
 *      `PAST_DUE`, `GRACE_PERIOD` — and four that may not — `PENDING`,
 *      `CANCELLED`, `EXPIRED`, `REFUNDED` — each with the row afterwards.
 *   2  ENTITLEMENT IS NOT REVOKED EARLY. `entitlements` rows stay `ACTIVE`
 *      with their `valid_until` and `revoked_at` untouched, and
 *      `EntitlementService.describe` still lists every feature after the
 *      cancellation. Cancelling ENDS RENEWAL; a refund is what revokes.
 *   3  REPLAY. Cancelling twice does not move `canceled_at`, and the second
 *      call is refused with its own code.
 *   4  TIMEZONE. `Africa/Cairo` and `Asia/Riyadh` get the SAME answer at the
 *      same instant, and neither has its `current_period_end` shifted by a
 *      calendar — cancellation is an instant, not a business day, and the one
 *      way this could have gone wrong is by acquiring day semantics it has no
 *      use for.
 *
 * The services are the real ones out of `AppModule`; nothing here is mocked.
 */
import { INestApplication, ConflictException } from '@nestjs/common';
import { Test } from '@nestjs/testing';

import { AppModule } from '../../src/app.module';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { createTenantExtension } from '../../src/common/tenancy/tenant.extension';
import { runAsSystemAsync } from '../../src/common/tenancy/system-context';
import { runWithTenant } from '../../src/common/tenancy/tenant-context';
import { SubscriptionService } from '../../src/modules/billing/application/services/subscription.service';
import { EntitlementService } from '../../src/modules/billing/application/services/entitlement.service';
import {
  CANONICAL_SUBSCRIPTION_STATUSES,
  isCancellable,
  toPersistedStatus,
  type CanonicalSubscriptionStatus,
} from '../../src/modules/billing/domain/subscription-status';
import { integrationDatabaseUrl } from '../tenancy/prisma-test-client';

const describeIfDb = integrationDatabaseUrl() ? describe : describe.skip;

const CAIRO = 'Africa/Cairo';
const RIYADH = 'Asia/Riyadh';

/** The period the household already paid for. Cancelling must not move it. */
const PERIOD_END = new Date('2026-03-01T00:00:00.000Z');

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
  readonly userId: string;
  readonly subscriptionId: string;
  readonly timeZone: string;
}

describeIfDb('F1 DECISION 3 — who may cancel, and what they keep (real PostgreSQL)', () => {
  let app: INestApplication;
  let prisma: any;
  let subscriptions: SubscriptionService;
  let entitlements: EntitlementService;

  const stamp = Date.now();
  let seq = 0;
  const createdFamilies: string[] = [];
  const createdUsers: string[] = [];
  /** Whether THIS suite created the global PREMIUM plan row, so that it removes
   * only what it added from a database every other suite also reads. */
  let createdPlan = false;

  const sys = (what: string, fn: () => Promise<any>): Promise<any> =>
    runAsSystemAsync('TEST_FIXTURE', `F1 decision-3 suite: ${what}`, async () => await fn());

  const raw = <T>(sql: string, ...params: unknown[]): Promise<T> =>
    sys('raw sql', () => prisma.$queryRawUnsafe(sql, ...params)) as Promise<T>;

  /** THE ROW ITSELF, out of PostgreSQL — never the service's return value. */
  const subscriptionRow = async (familyId: string): Promise<any> =>
    (
      await raw<any[]>(
        `SELECT "status"::text AS status, "canceled_at", "current_period_end", "trial_ends_at"
           FROM "subscriptions" WHERE "family_id" = $1::uuid`,
        familyId,
      )
    )[0];

  const entitlementRows = (familyId: string): Promise<any[]> =>
    raw<any[]>(
      `SELECT "feature_key", "status"::text AS status, "valid_until", "revoked_at", "revoked_reason"
         FROM "entitlements" WHERE "family_id" = $1::uuid ORDER BY "feature_key"`,
      familyId,
    );

  const asFamily = <T>(familyId: string, fn: () => Promise<T>): Promise<T> =>
    runWithTenant({ familyId, actorType: 'SYSTEM', actorId: 'f1-d3-test' }, fn);

  /**
   * A household whose subscription is in one named state and whose PREMIUM
   * entitlements are live to `PERIOD_END`. The entitlements are granted through
   * the REAL `EntitlementService.grantForPlan`, so the rows under test are the
   * rows a verified purchase actually writes.
   */
  async function createHousehold(
    label: string,
    status: CanonicalSubscriptionStatus,
    timeZone: string = CAIRO,
  ): Promise<Household> {
    seq += 1;
    const family = await sys('create family', () =>
      prisma.family.create({ data: { name: `F1-D3 ${label} ${stamp}`, timezone: timeZone }, select: { id: true } }),
    );
    createdFamilies.push(family.id);

    const user = await sys('create user', () =>
      prisma.user.create({
        data: { email: `f1d3.${label}.${stamp}.${seq}@example.test`, passwordHash: 'x', fullName: 'F1-D3 Parent' },
        select: { id: true },
      }),
    );
    createdUsers.push(user.id);
    await sys('create membership', () =>
      prisma.familyMember.create({ data: { familyId: family.id, userId: user.id, role: 'OWNER' } }),
    );

    const row = await sys('create subscription', () =>
      prisma.subscription.create({
        data: {
          familyId: family.id,
          planTier: 'PREMIUM',
          status: toPersistedStatus(status),
          provider: 'APPLE_IAP',
          currentPeriodStart: new Date('2026-02-01T00:00:00.000Z'),
          currentPeriodEnd: PERIOD_END,
          countryCode: timeZone === RIYADH ? 'SA' : 'EG',
          currencyCode: timeZone === RIYADH ? 'SAR' : 'EGP',
        },
        select: { id: true },
      }),
    );

    await asFamily(family.id, () =>
      entitlements.grantForPlan({
        familyId: family.id,
        planTier: 'PREMIUM',
        source: 'APPLE_IAP',
        subscriptionId: row.id,
        validFrom: new Date('2026-02-01T00:00:00.000Z'),
        validUntil: PERIOD_END,
      }),
    );

    return { familyId: family.id, userId: user.id, subscriptionId: row.id, timeZone };
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue(offlinePrismaService())
      .compile();

    app = moduleRef.createNestApplication();
    await app.init();

    prisma = app.get(PrismaService);
    subscriptions = app.get(SubscriptionService);
    entitlements = app.get(EntitlementService);

    // THE PLAN THE ENTITLEMENTS COME FROM. `grantForPlan` reads
    // `PlanDefinition.features`, which is the existing Sprint 8 catalogue —
    // «what does Premium include» stays one editable list rather than forking
    // per provider — so a household with no plan row would be granted nothing
    // and every assertion below would be vacuous.
    //
    // CREATED ONLY IF ABSENT, AND REMOVED AGAIN IN `afterAll`. The catalogue is
    // GLOBAL — `plan_definitions` has no `family_id` — so a suite that left one
    // behind would change what every other suite in this shared database sees
    // `GET /billing/plans` return.
    const existingPlan = await sys('look for a PREMIUM plan', () =>
      prisma.planDefinition.findUnique({ where: { tier: 'PREMIUM' }, select: { id: true } }),
    );
    if (!existingPlan) {
      await sys('create the PREMIUM plan', () =>
        prisma.planDefinition.create({
          data: {
            tier: 'PREMIUM',
            name: 'Premium',
            priceCents: 17900,
            currency: 'EGP',
            billingIntervalMonths: 1,
            features: ['ADVANCED_ANALYTICS', 'UNLIMITED_CHILDREN'],
            isActive: true,
          },
        }),
      );
      createdPlan = true;
    }
  }, 180_000);

  afterAll(async () => {
    if (prisma) {
      for (const id of createdFamilies) {
        await sys('cleanup family', () => prisma.family.deleteMany({ where: { id } })).catch(() => undefined);
      }
      for (const id of createdUsers) {
        await sys('cleanup user', () => prisma.user.deleteMany({ where: { id } })).catch(() => undefined);
      }
      if (createdPlan) {
        await sys('cleanup the PREMIUM plan', () =>
          prisma.planDefinition.deleteMany({ where: { tier: 'PREMIUM' } }),
        ).catch(() => undefined);
      }
    }
    await app?.close();
  }, 180_000);

  // ==========================================================================
  // 0. ANTI-VACUITY
  // ==========================================================================
  it('the fixture really grants entitlements — otherwise every «not revoked» below proves nothing', async () => {
    const home = await createHousehold('anti-vacuity', 'ACTIVE');
    const rows = await entitlementRows(home.familyId);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.status).toBe('ACTIVE');
      expect(new Date(row.valid_until).toISOString()).toBe(PERIOD_END.toISOString());
    }
    const described = await asFamily(home.familyId, () => entitlements.describe(home.familyId, new Date('2026-02-10T00:00:00.000Z')));
    expect(described.features.length).toBeGreaterThan(0);
  }, 120_000);

  // ==========================================================================
  // 1. EVERY STATUS THAT MAY CANCEL
  // ==========================================================================

  const MAY: Array<[CanonicalSubscriptionStatus, string]> = [
    ['TRIAL', 'a trial ends by BECOMING a charge — stopping that is the commonest cancellation there is'],
    ['ACTIVE', 'the ordinary case, unchanged'],
    ['PAST_DUE', 'the provider is retrying a failed card, and the customer may refuse the retry'],
    ['GRACE_PERIOD', 'THE DEFECT: entitled, treated as paying, and previously with no way out'],
  ];

  it.each(MAY)('1. CAN cancel from %s — %s', async (status) => {
    const home = await createHousehold(`may-${status}`, status);

    const result = await asFamily(home.familyId, () => subscriptions.cancel(home.familyId, home.userId));

    // ===== THE ROW, READ BACK OUT OF POSTGRESQL =====
    const row = await subscriptionRow(home.familyId);
    expect(row.status).toBe('CANCELED');
    expect(row.canceled_at).not.toBeNull();

    // ===== AND ENTITLEMENT WAS NOT REVOKED EARLY =====
    // The period the household already paid for is untouched: same
    // `current_period_end`, every `Entitlement` still ACTIVE with its original
    // `valid_until` and a NULL `revoked_at`. A refund revokes because money
    // went back; a cancellation ends renewal and nothing else.
    expect(new Date(row.current_period_end).toISOString()).toBe(PERIOD_END.toISOString());
    for (const ent of await entitlementRows(home.familyId)) {
      expect(`${status}:${ent.feature_key}:${ent.status}`).toBe(`${status}:${ent.feature_key}:ACTIVE`);
      expect(ent.revoked_at).toBeNull();
      expect(ent.revoked_reason).toBeNull();
      expect(new Date(ent.valid_until).toISOString()).toBe(PERIOD_END.toISOString());
    }
    // The server's own answer to «what am I allowed to do» is unchanged inside
    // the period — asked through the real service, not inferred from the rows.
    const described = await asFamily(home.familyId, () =>
      entitlements.describe(home.familyId, new Date('2026-02-10T00:00:00.000Z')),
    );
    expect(described.features.sort()).toEqual(['ADVANCED_ANALYTICS', 'UNLIMITED_CHILDREN']);

    // ===== THE SHAPE THE CLIENT NOW GETS =====
    expect(result.status).toBe('CANCELLED');
    expect(result.accessUntil && new Date(result.accessUntil).toISOString()).toBe(PERIOD_END.toISOString());

    // And the server now REPORTS what it enforced.
    const after = await asFamily(home.familyId, () => subscriptions.describeCancellability(home.familyId));
    expect(after).toEqual({
      canCancel: false,
      status: 'CANCELLED',
      accessUntil: expect.any(Date),
    });
  }, 120_000);

  // ==========================================================================
  // 2. EVERY STATUS THAT MAY NOT
  // ==========================================================================

  const MAY_NOT: Array<[CanonicalSubscriptionStatus, string]> = [
    ['PENDING', 'an unsettled kiosk reference: nothing charged, nothing entitled, nothing renewing'],
    ['CANCELLED', 'renewal has already ended — refused with its own code so a client can say so'],
    ['EXPIRED', 'the period is over and nothing renews'],
    ['REFUNDED', 'terminal: the money has gone back'],
  ];

  it.each(MAY_NOT)('2. CANNOT cancel from %s — %s', async (status) => {
    const home = await createHousehold(`not-${status}`, status);
    const before = await subscriptionRow(home.familyId);

    await expect(asFamily(home.familyId, () => subscriptions.cancel(home.familyId, home.userId))).rejects.toBeInstanceOf(
      ConflictException,
    );

    // ===== AND THE ROW DID NOT MOVE =====
    const after = await subscriptionRow(home.familyId);
    expect(after.status).toBe(before.status);
    expect(after.canceled_at).toEqual(before.canceled_at);
    expect(after.current_period_end).toEqual(before.current_period_end);

    // The server reports the same refusal it enforced.
    expect(await asFamily(home.familyId, () => subscriptions.describeCancellability(home.familyId))).toMatchObject({
      canCancel: false,
      status,
    });
  }, 120_000);

  /**
   * THE TWO SETS TOGETHER ARE THE WHOLE VOCABULARY. Written as a scan over
   * `CANONICAL_SUBSCRIPTION_STATUSES` rather than as a count, so a ninth status
   * fails this by name instead of slipping through untested.
   */
  it('2b. the two tables above cover every canonical status, and agree with the domain rule', () => {
    const covered = [...MAY.map(([s]) => s), ...MAY_NOT.map(([s]) => s)].sort();
    expect(covered).toEqual([...CANONICAL_SUBSCRIPTION_STATUSES].sort());
    for (const [status] of MAY) expect(`${status}:${isCancellable(status)}`).toBe(`${status}:true`);
    for (const [status] of MAY_NOT) expect(`${status}:${isCancellable(status)}`).toBe(`${status}:false`);
  });

  // ==========================================================================
  // 3. REPLAY
  // ==========================================================================

  it('3. REPLAY — a second cancel is refused and does not move canceled_at', async () => {
    const home = await createHousehold('replay', 'GRACE_PERIOD');

    await asFamily(home.familyId, () => subscriptions.cancel(home.familyId, home.userId));
    const first = await subscriptionRow(home.familyId);
    expect(first.status).toBe('CANCELED');
    expect(first.canceled_at).not.toBeNull();

    const error = await asFamily(home.familyId, () => subscriptions.cancel(home.familyId, home.userId)).catch(
      (err) => err,
    );
    expect(error).toBeInstanceOf(ConflictException);
    expect((error.getResponse() as { code: string }).code).toBe('SUBSCRIPTION_ALREADY_CANCELLED');

    // THE TIMESTAMP IS THE CUSTOMER'S DECISION, and a second press must not
    // rewrite when they made it — `canceled_at` is what a support engineer and
    // a regulator both read.
    const second = await subscriptionRow(home.familyId);
    expect(second.canceled_at).toEqual(first.canceled_at);
    expect(second.current_period_end).toEqual(first.current_period_end);

    // And the entitlements are still where they were after BOTH attempts.
    for (const ent of await entitlementRows(home.familyId)) {
      expect(ent.status).toBe('ACTIVE');
      expect(ent.revoked_at).toBeNull();
    }
  }, 120_000);

  // ==========================================================================
  // 4. TIMEZONE
  // ==========================================================================

  /**
   * CANCELLATION IS AN INSTANT, NOT A BUSINESS DAY, AND THAT IS THE PROPERTY
   * UNDER TEST.
   *
   * Every question this product asks about a family's DAY goes through
   * `FamilyDateService` — quiet hours, `maxPerDay`, the growth cohort. «May
   * this household cancel?» is deliberately NOT one of them: it is a question
   * about a subscription's state, and giving it calendar semantics would make
   * two households in different zones answerable differently for no reason a
   * customer could understand. So the same instant produces the same answer in
   * `Africa/Cairo` and `Asia/Riyadh`, and `current_period_end` — the one date
   * the customer actually cares about — is byte-identical in both.
   */
  it('4. TIMEZONE — Cairo and Riyadh get the same answer and keep the same period end', async () => {
    const cairo = await createHousehold('tz-cairo', 'GRACE_PERIOD', CAIRO);
    const riyadh = await createHousehold('tz-riyadh', 'GRACE_PERIOD', RIYADH);

    // THE PREMISE: two different calendars, asserted rather than assumed.
    const zones = await raw<any[]>(
      `SELECT "timezone" FROM "families" WHERE "id" = ANY($1::uuid[]) ORDER BY "timezone"`,
      [cairo.familyId, riyadh.familyId],
    );
    expect(zones.map((z) => z.timezone)).toEqual([CAIRO, RIYADH]);

    for (const home of [cairo, riyadh]) {
      expect(await asFamily(home.familyId, () => subscriptions.describeCancellability(home.familyId))).toMatchObject({
        canCancel: true,
        status: 'GRACE_PERIOD',
      });
      const result = await asFamily(home.familyId, () => subscriptions.cancel(home.familyId, home.userId));
      expect(result.status).toBe('CANCELLED');

      const row = await subscriptionRow(home.familyId);
      expect(row.status).toBe('CANCELED');
      // THE SAME PERIOD END IN BOTH ZONES. A cancellation that had acquired a
      // family-local day would have moved one of these and not the other.
      expect(new Date(row.current_period_end).toISOString()).toBe(PERIOD_END.toISOString());
      for (const ent of await entitlementRows(home.familyId)) {
        expect(`${home.timeZone}:${ent.status}`).toBe(`${home.timeZone}:ACTIVE`);
        expect(new Date(ent.valid_until).toISOString()).toBe(PERIOD_END.toISOString());
      }
    }
  }, 180_000);
});
