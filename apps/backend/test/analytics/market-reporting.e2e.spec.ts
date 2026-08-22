/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-var-requires */
/**
 * F1 — THE PER-MARKET ADMIN READS, AGAINST A REAL POSTGRESQL.
 *
 * These are the endpoints the admin dashboard rendered as NOT MEASURED until
 * `families.country_code` existed. What makes them worth having is not that they
 * return numbers — it is that the numbers are ATTRIBUTED correctly, and this
 * suite exists to prove exactly that against real rows.
 *
 * ── HOW THIS SUITE AVOIDS PASSING FOR THE WRONG REASON ──────────────────────
 *
 * The integration database is SHARED with every other suite in the run, so an
 * absolute assertion like `expect(registered).toBe(2)` would be measuring the
 * whole database and would go green or red for reasons that have nothing to do
 * with this code. Two techniques are used instead, and neither of them is
 * "trust the endpoint":
 *
 *   STOCKS (families, plan mix, active counts) are asserted as DELTAS. The
 *   baseline is read BEFORE this suite's cohort is seeded and subtracted from
 *   the reading after, so what is asserted is exactly the effect of the rows
 *   this file created. The same `asOf` instant is used for both readings, or
 *   the 30-day active window would slide between them and the delta would
 *   include households this suite never touched.
 *
 *   FLOWS (goal completions, reward grants) are seeded into a WINDOW NO OTHER
 *   SUITE WRITES INTO — a fixed day in 2001 — and asserted absolutely. A
 *   `created_at` is an explicit column here, not `now()`, which is what makes
 *   that possible.
 *
 * And every expected value is ALSO counted independently, by this file, with
 * `id IN (this suite's ids)` — so the assertion is «the endpoint agrees with a
 * count of the rows I created», not «the endpoint agrees with itself».
 *
 * ── THE COHORT, AND WHY EACH HOUSEHOLD IS IN IT ─────────────────────────────
 *
 *   egOwn            country_code = 'EG'.                    -> EG
 *   egOwnSaLabel     country_code = 'EG', ad label says SA.   -> EG  (precedence)
 *   saOwn            country_code = 'SA'.                    -> SA
 *   saByLabel        country_code = NULL, ad label says SA.   -> SA  (fallback)
 *   noCountry        country_code = NULL, nothing else.       -> NEITHER, but IS
 *                                                                in the platform
 *
 * The offline-Prisma pattern and the `describeIfDb` skip are the ones
 * `growth-api.e2e.spec.ts` established.
 */
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request = require('supertest');

import { AppModule } from '../../src/app.module';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { createTenantExtension } from '../../src/common/tenancy/tenant.extension';
import { runAsSystemAsync } from '../../src/common/tenancy/system-context';
import { integrationDatabaseUrl } from '../tenancy/prisma-test-client';
import { KpiService } from '../../src/modules/analytics/application/kpi.service';
import {
  PLATFORM_SCOPE,
  familyCountryWhere,
} from '../../src/modules/analytics/domain/country-attribution';

const describeIfDb = integrationDatabaseUrl() ? describe : describe.skip;
const ADMIN_KEY = process.env.INTERNAL_ADMIN_API_KEY as string;

const DAY = 24 * 60 * 60 * 1000;

/**
 * THE FLOW WINDOW. A day in 2001 that nothing else in this repository writes
 * into, so goal and reward counts inside it can be asserted ABSOLUTELY rather
 * than as a delta. `[from, to)` is half-open, matching the endpoint.
 */
const FLOW_AT = new Date('2001-03-04T10:00:00.000Z');
const FLOW_FROM = new Date('2001-03-04T00:00:00.000Z');
const FLOW_TO = new Date('2001-03-05T00:00:00.000Z');

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

describeIfDb('F1 — the per-market admin reads (real PostgreSQL)', () => {
  let app: INestApplication;
  let http: any;
  let prisma: any;
  let kpis: KpiService;

  const stamp = Date.now();
  const cohortId = `f1-market-${stamp}`;
  const createdFamilies: string[] = [];
  const createdUsers: string[] = [];

  /** One instant for every reading, so no window slides between them. */
  const ASOF = new Date();

  let egOwn = '';
  let egOwnSaLabel = '';
  let saOwn = '';
  let saByLabel = '';
  let noCountry = '';
  let parentToken = '';

  /** Every household this suite created, for the independent counts. */
  const cohort = (): string[] => [egOwn, egOwnSaLabel, saOwn, saByLabel, noCountry];

  const sys = (what: string, fn: () => Promise<any>): Promise<any> =>
    runAsSystemAsync('TEST_FIXTURE', `F1 market-reporting suite: ${what}`, async () => await fn());

  interface Baseline {
    families: Record<string, { registered: number; active: number }>;
    mix: Record<string, { registeredFamilies: number; free: number; monthly: number; annual: number }>;
    people: Record<string, { parents: number; children: number }>;
  }
  const baseline: Baseline = { families: {}, mix: {}, people: {} };

  const getJson = async (path: string): Promise<any> => {
    const res = await request(http).get(path).set('x-internal-admin-key', ADMIN_KEY);
    expect(res.status).toBe(200);
    return res.body;
  };

  const kpiOf = async (countryCode: string, id: string): Promise<number | null> => {
    const snapshot = await kpis.snapshot({ countryCode, asOf: ASOF });
    return snapshot.values.find((v) => v.kpi === id)?.value ?? null;
  };

  async function clearThrottle(): Promise<void> {
    const Redis = require('ioredis');
    const client = new Redis(process.env.REDIS_URL as string);
    const keys = await client.keys('throttle:*');
    if (keys.length > 0) await client.del(...keys);
    await client.quit();
  }

  async function seedFamily(label: string, countryCode: string | null): Promise<string> {
    const family = await sys('create family', () =>
      prisma.family.create({
        data: {
          name: `f1 market ${label} ${stamp}`,
          timezone: 'UTC',
          ...(countryCode === null ? {} : { countryCode }),
        },
        select: { id: true },
      }),
    );
    createdFamilies.push(family.id);
    return family.id;
  }

  /** A parent user owning a heartbeating PARENT device — the ACTIVE_PARENTS signal. */
  async function seedParentDevice(familyId: string, label: string, lastSeenAt: Date): Promise<string> {
    const user = await sys('create user', () =>
      prisma.user.create({
        data: {
          email: `f1.market.${label}.${stamp}@example.test`,
          passwordHash: 'not-a-real-hash',
          fullName: `F1 Market ${label}`,
        },
        select: { id: true },
      }),
    );
    createdUsers.push(user.id);
    await sys('create parent device', () =>
      prisma.device.create({
        data: {
          familyId,
          ownerType: 'PARENT',
          userId: user.id,
          platform: 'ANDROID',
          status: 'ACTIVE',
          lastSeenAt,
        },
      }),
    );
    return user.id;
  }

  /** A child owning a heartbeating CHILD device — the ACTIVE_CHILDREN signal. */
  async function seedChildDevice(familyId: string, label: string, lastSeenAt: Date): Promise<string> {
    const child = await sys('create child', () =>
      prisma.child.create({
        data: {
          familyId,
          firstName: `F1 ${label}`,
          dateOfBirth: new Date('2015-06-01T00:00:00.000Z'),
        },
        select: { id: true },
      }),
    );
    await sys('create child device', () =>
      prisma.device.create({
        data: {
          familyId,
          ownerType: 'CHILD',
          childId: child.id,
          platform: 'ANDROID',
          status: 'ACTIVE',
          lastSeenAt,
        },
      }),
    );
    return child.id;
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useFactory({ factory: offlinePrismaService })
      .compile();

    app = moduleRef.createNestApplication();
    const { ValidationPipe } = require('@nestjs/common');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    http = app.getHttpServer();
    prisma = app.get(PrismaService);
    kpis = app.get(KpiService);

    // The launch-market catalogue. Asserted, not assumed: every expectation
    // below is about what `countries` says, and a suite that silently ran
    // against an empty catalogue would prove nothing.
    const countries = await sys('read catalogue', () =>
      prisma.country.findMany({ where: { isActive: true }, select: { code: true, currencyCode: true } }),
    );
    expect(countries.map((c: any) => c.code).sort()).toEqual(expect.arrayContaining(['EG', 'SA']));

    /**
     * THE PARENT TOKEN IS MINTED BEFORE THE BASELINE IS TAKEN, on purpose:
     * registering creates a household, and a household created after the
     * baseline would show up in every delta below as a phantom family.
     */
    await clearThrottle();
    const registered = await request(http).post('/auth/register').send({
      email: `f1.market.parent.${stamp}@example.test`,
      password: 'F1-Market-Passw0rd!23',
      fullName: 'F1 Market Parent',
      acceptedTerms: true,
    });
    expect(registered.status).toBe(201);
    createdFamilies.push(registered.body.familyId);
    createdUsers.push(registered.body.id);
    const login = await request(http).post('/auth/login').send({
      email: `f1.market.parent.${stamp}@example.test`,
      password: 'F1-Market-Passw0rd!23',
    });
    expect(login.status).toBe(200);
    parentToken = login.body.tokens.accessToken;

    // -- BASELINE, before a single fixture row exists -----------------------
    for (const scope of ['EG', 'SA', PLATFORM_SCOPE]) {
      const families = await getJson(`/admin/growth/families?countryCode=${scope}&asOf=${ASOF.toISOString()}`);
      baseline.families[scope] = { registered: families.registered, active: families.active };

      const mix = await getJson(`/admin/growth/subscriptions?countryCode=${scope}&asOf=${ASOF.toISOString()}`);
      baseline.mix[scope] = {
        registeredFamilies: mix.registeredFamilies,
        free: mix.free,
        monthly: mix.monthly,
        annual: mix.annual,
      };

      baseline.people[scope] = {
        parents: (await kpiOf(scope, 'ACTIVE_PARENTS')) ?? 0,
        children: (await kpiOf(scope, 'ACTIVE_CHILDREN')) ?? 0,
      };
    }

    // -- THE COHORT ---------------------------------------------------------
    egOwn = await seedFamily('eg-own', 'EG');
    egOwnSaLabel = await seedFamily('eg-own-sa-label', 'EG');
    saOwn = await seedFamily('sa-own', 'SA');
    saByLabel = await seedFamily('sa-by-label', null);
    noCountry = await seedFamily('no-country', null);

    // The untrusted marketing label. On `egOwnSaLabel` it CONTRADICTS the
    // server's record and must lose; on `saByLabel` it is the only thing there
    // is and must win.
    await sys('label eg-own-sa-label as SA', () =>
      prisma.acquisitionAttribution.create({
        data: { familyId: egOwnSaLabel, channel: 'TIKTOK', countryCode: 'SA' },
      }),
    );
    await sys('label sa-by-label as SA', () =>
      prisma.acquisitionAttribution.create({
        data: { familyId: saByLabel, channel: 'ORGANIC', countryCode: 'SA' },
      }),
    );

    // -- heartbeats. Recent = active; 100 days ago = registered but not active.
    const recent = new Date(ASOF.getTime() - 1 * DAY);
    const stale = new Date(ASOF.getTime() - 100 * DAY);

    await seedParentDevice(egOwn, 'eg-parent', recent);
    await seedChildDevice(egOwn, 'eg-child', recent);
    await seedParentDevice(saOwn, 'sa-parent', recent);
    await seedChildDevice(saOwn, 'sa-child', recent);
    await seedParentDevice(noCountry, 'nc-parent', recent);
    await seedChildDevice(noCountry, 'nc-child', recent);
    // Registered in SA, but silent for over three months.
    await seedParentDevice(saByLabel, 'sa-label-parent', stale);
    // `egOwnSaLabel` has no device at all — registered, never active.

    // -- subscriptions ------------------------------------------------------
    await sys('eg monthly subscription', () =>
      prisma.subscription.create({
        data: {
          familyId: egOwn,
          planTier: 'PREMIUM',
          status: 'ACTIVE',
          countryCode: 'EG',
          currencyCode: 'EGP',
          billingPeriod: 'MONTHLY',
        },
      }),
    );
    await sys('sa annual subscription', () =>
      prisma.subscription.create({
        data: {
          familyId: saOwn,
          planTier: 'FAMILY',
          status: 'ACTIVE',
          countryCode: 'SA',
          currencyCode: 'SAR',
          billingPeriod: 'ANNUAL',
        },
      }),
    );
    // CANCELED is not entitlement-bearing, so this household is FREE — which is
    // the case a `registered − paid` subtraction would have got right by luck
    // and a status filter gets right on purpose.
    await sys('eg canceled subscription', () =>
      prisma.subscription.create({
        data: {
          familyId: egOwnSaLabel,
          planTier: 'PREMIUM',
          status: 'CANCELED',
          countryCode: 'EG',
          currencyCode: 'EGP',
          billingPeriod: 'MONTHLY',
          canceledAt: new Date(ASOF.getTime() - 10 * DAY),
        },
      }),
    );

    // -- pilot invitations. The cohort id is unique to this run, so these can
    //    be asserted absolutely rather than as a delta.
    const invites: Array<[string, string, string | null]> = [
      ['eg-1', 'EG', egOwn],
      ['eg-2', 'EG', null],
      ['eg-3', 'EG', null],
      ['sa-1', 'SA', saOwn],
      ['sa-2', 'SA', saByLabel],
    ];
    for (const [label, country, redeemedBy] of invites) {
      await sys('create pilot invite', () =>
        prisma.pilotInvite.create({
          data: {
            email: `f1.pilot.${label}.${stamp}@example.test`,
            cohortId,
            countryCode: country,
            ...(redeemedBy ? { redeemedAt: new Date(), redeemedByFamilyId: redeemedBy } : {}),
          },
        }),
      );
    }

    // -- goals and rewards, inside the 2001 window --------------------------
    const category = await sys('read a program category', () =>
      prisma.rewardProgramCategory.findFirst({ where: { isActive: true }, select: { code: true } }),
    );
    expect(category).toBeTruthy();

    const seedGoalsAndRewards = async (
      familyId: string,
      label: string,
      requests: number,
      verified: number,
      earns: number,
      redeems: number,
    ): Promise<void> => {
      const owner = createdUsers[0];
      const program = await sys('create reward program', () =>
        prisma.rewardProgram.create({
          data: {
            familyId,
            category: category.code,
            activity: 'CUSTOM',
            targetSpec: {},
            targetSummaryAr: 'هدف اختباري',
            durationMinutes: 10,
            verificationLevel: 'PARENT_APPROVAL',
            rewardSpec: { type: 'COINS', amount: 5 },
            createdByUserId: owner,
          },
          select: { id: true },
        }),
      );
      const child = await sys('create goal child', () =>
        prisma.child.create({
          data: {
            familyId,
            firstName: `F1 goals ${label}`,
            dateOfBirth: new Date('2014-01-01T00:00:00.000Z'),
          },
          select: { id: true },
        }),
      );

      for (let i = 0; i < requests; i += 1) {
        const isVerified = i < verified;
        await sys('create achievement request', () =>
          prisma.achievementRequest.create({
            data: {
              familyId,
              programId: program.id,
              childId: child.id,
              status: isVerified ? 'VERIFIED' : 'SUBMITTED',
              localDate: new Date('2001-03-04T00:00:00.000Z'),
              attemptNo: i + 1,
              createdAt: FLOW_AT,
              ...(isVerified ? { decidedAt: FLOW_AT } : {}),
            },
          }),
        );
      }

      for (let i = 0; i < earns + redeems; i += 1) {
        const isEarn = i < earns;
        await sys('create ledger entry', () =>
          prisma.rewardsLedgerEntry.create({
            data: {
              familyId,
              childId: child.id,
              type: isEarn ? 'EARN' : 'REDEEM',
              rewardType: 'COINS',
              amount: 5,
              delta: isEarn ? 5 : -5,
              source: 'f1-market-suite',
              idempotencyKey: `f1-market-${stamp}-${label}-${i}`,
              createdAt: FLOW_AT,
            },
          }),
        );
      }
    };

    // EG: 3 goals started, 2 verified, 2 earns, 1 redeem.
    await seedGoalsAndRewards(egOwn, 'eg', 3, 2, 2, 1);
    // SA: 1 goal started, 1 verified, 1 earn, 0 redeems.
    await seedGoalsAndRewards(saOwn, 'sa', 1, 1, 1, 0);
    // NO COUNTRY: real activity that belongs to NEITHER market.
    await seedGoalsAndRewards(noCountry, 'nc', 1, 1, 1, 0);
  }, 180_000);

  afterAll(async () => {
    if (!app) return;
    await sys('cleanup', async () => {
      await prisma.$executeRawUnsafe('DELETE FROM "pilot_invites" WHERE "cohort_id" = $1', cohortId);
      await prisma.$executeRawUnsafe('DELETE FROM "families" WHERE "id" = ANY($1::uuid[])', createdFamilies);
      await prisma.$executeRawUnsafe('DELETE FROM "users" WHERE "id" = ANY($1::uuid[])', createdUsers);
    });
    await app.close();
  }, 60_000);

  /** Counts within THIS suite's households only — the independent check. */
  const countIn = (countryCode: string, ids: string[]): Promise<number> =>
    sys('count by market', () =>
      prisma.family.count({ where: { id: { in: ids }, ...familyCountryWhere(countryCode) } }),
    );

  // =========================================================================
  describe('0. THE GUARD — these are platform reads and nothing else reaches them', () => {
    const paths = [
      '/admin/growth/families?countryCode=EG',
      '/admin/growth/subscriptions?countryCode=EG',
      '/admin/growth/pilot?countryCode=EG',
      '/admin/growth/product?countryCode=EG',
    ];

    it('an UNAUTHENTICATED caller is refused by every new route', async () => {
      for (const path of paths) {
        const res = await request(http).get(path);
        expect([401, 403]).toContain(res.status);
        expect(JSON.stringify(res.body)).not.toContain('registered');
      }
    });

    it('a WRONG admin key is refused — the guard compares, it does not merely require presence', async () => {
      for (const path of paths) {
        const res = await request(http).get(path).set('x-internal-admin-key', 'not-the-key');
        expect([401, 403]).toContain(res.status);
      }
    });

    it("a real PARENT's access token is refused — there is no tenant form of these questions", async () => {
      for (const path of paths) {
        const res = await request(http).get(path).set('Authorization', `Bearer ${parentToken}`);
        expect([401, 403]).toContain(res.status);
      }
    });

    it('the internal admin key IS admitted — the guard is real, not a blanket denial', async () => {
      const res = await request(http)
        .get('/admin/growth/families?countryCode=EG')
        .set('x-internal-admin-key', ADMIN_KEY);
      expect(res.status).toBe(200);
      expect(typeof res.body.registered).toBe('number');
    });
  });

  // =========================================================================
  describe('1. FAMILIES PER COUNTRY — the number `families.country_code` unlocked', () => {
    it('EGYPT counts the two households the SERVER recorded as Egyptian, and no others', async () => {
      const body = await getJson(`/admin/growth/families?countryCode=EG&asOf=${ASOF.toISOString()}`);
      // egOwn + egOwnSaLabel. The second one's ad label says SA and is ignored.
      expect(body.registered - baseline.families.EG.registered).toBe(2);
      // Counted independently, from the ids this file created.
      expect(await countIn('EG', cohort())).toBe(2);
      expect(body.countryCode).toBe('EG');
      expect(body.currencyCode).toBe('EGP');
      expect(body.scopeIncludesUnattributable).toBe(false);
    });

    it('SAUDI ARABIA counts its own-country household AND the label-only one', async () => {
      const body = await getJson(`/admin/growth/families?countryCode=SA&asOf=${ASOF.toISOString()}`);
      // saOwn (own country) + saByLabel (NULL own country, label SA).
      expect(body.registered - baseline.families.SA.registered).toBe(2);
      expect(await countIn('SA', cohort())).toBe(2);
      expect(body.currencyCode).toBe('SAR');
    });

    it('THE MARKETS ARE DISJOINT: EG + SA never exceeds the platform', async () => {
      const eg = await getJson(`/admin/growth/families?countryCode=EG&asOf=${ASOF.toISOString()}`);
      const sa = await getJson(`/admin/growth/families?countryCode=SA&asOf=${ASOF.toISOString()}`);
      const platform = await getJson(
        `/admin/growth/families?countryCode=**&asOf=${ASOF.toISOString()}`,
      );

      const egDelta = eg.registered - baseline.families.EG.registered;
      const saDelta = sa.registered - baseline.families.SA.registered;
      const platformDelta = platform.registered - baseline.families[PLATFORM_SCOPE].registered;

      expect(platformDelta).toBe(5);
      expect(egDelta + saDelta).toBe(4);
      // The difference is EXACTLY the one household nothing knows the market of.
      // That is how the unattributable population stays observable without a
      // metric being invented to report it.
      expect(platformDelta - (egDelta + saDelta)).toBe(1);
    });

    it('A NULL-COUNTRY HOUSEHOLD IS IN NEITHER MARKET...', async () => {
      expect(await countIn('EG', [noCountry])).toBe(0);
      expect(await countIn('SA', [noCountry])).toBe(0);
    });

    it('...AND IS NOT DROPPED FROM THE PLATFORM EITHER, which the response says out loud', async () => {
      expect(await countIn(PLATFORM_SCOPE, [noCountry])).toBe(1);
      const platform = await getJson(`/admin/growth/families?countryCode=**`);
      // The flag is what lets the dashboard label the platform tile honestly
      // instead of a reader assuming the two country tiles add up to it.
      expect(platform.scopeIncludesUnattributable).toBe(true);
      expect(platform.currencyCode).toBeNull();
    });

    it('ACTIVE uses the MAU definition, and a household silent for 100 days is registered but NOT active', async () => {
      const eg = await getJson(`/admin/growth/families?countryCode=EG&asOf=${ASOF.toISOString()}`);
      const sa = await getJson(`/admin/growth/families?countryCode=SA&asOf=${ASOF.toISOString()}`);

      expect(eg.activeDefinition).toBe('MAU');
      expect(eg.activeWindowDays).toBe(30);

      // EG: egOwn heartbeat yesterday -> active. egOwnSaLabel has no device.
      expect(eg.active - baseline.families.EG.active).toBe(1);
      // SA: saOwn heartbeat yesterday -> active. saByLabel last seen 100 days
      // ago -> registered, not active. Active can never exceed registered.
      expect(sa.active - baseline.families.SA.active).toBe(1);
      expect(sa.active).toBeLessThanOrEqual(sa.registered);
    });

    it('A CURRENCY NEVER TRAVELS WITHOUT ITS COUNTRY, and EGP never appears in a Saudi answer', async () => {
      const eg = await getJson(`/admin/growth/families?countryCode=EG`);
      const sa = await getJson(`/admin/growth/families?countryCode=SA`);
      const platform = await getJson(`/admin/growth/families?countryCode=**`);

      expect(JSON.stringify(eg)).not.toContain('SAR');
      expect(JSON.stringify(sa)).not.toContain('EGP');
      // The platform scope refuses to name a currency at all rather than pick
      // one of two that cannot be added.
      expect(platform.currencyCode).toBeNull();
    });

    it('a malformed country is a typed 400, not a silent platform-wide answer', async () => {
      const res = await request(http)
        .get('/admin/growth/families?countryCode=E')
        .set('x-internal-admin-key', ADMIN_KEY);
      expect(res.status).toBe(400);
    });
  });

  // =========================================================================
  describe('2. THE PLAN MIX — free / monthly / annual, per market', () => {
    it('EGYPT: one monthly subscription, one CANCELED household counted as free', async () => {
      const body = await getJson(`/admin/growth/subscriptions?countryCode=EG&asOf=${ASOF.toISOString()}`);

      expect(body.registeredFamilies - baseline.mix.EG.registeredFamilies).toBe(2);
      expect(body.monthly - baseline.mix.EG.monthly).toBe(1);
      expect(body.annual - baseline.mix.EG.annual).toBe(0);
      // egOwnSaLabel: its subscription is CANCELED, which grants nothing.
      expect(body.free - baseline.mix.EG.free).toBe(1);
      expect(body.currencyCode).toBe('EGP');
      expect(body.entitlementBearingStatuses.sort()).toEqual(['ACTIVE', 'GRACE_PERIOD', 'TRIALING']);
    });

    it('SAUDI ARABIA: one ANNUAL subscription, and the annual one is NOT called monthly', async () => {
      const body = await getJson(`/admin/growth/subscriptions?countryCode=SA&asOf=${ASOF.toISOString()}`);

      expect(body.registeredFamilies - baseline.mix.SA.registeredFamilies).toBe(2);
      expect(body.annual - baseline.mix.SA.annual).toBe(1);
      expect(body.monthly - baseline.mix.SA.monthly).toBe(0);
      // saByLabel bought nothing.
      expect(body.free - baseline.mix.SA.free).toBe(1);
      expect(body.currencyCode).toBe('SAR');
    });

    it('THE EGYPTIAN AND SAUDI MIXES ARE NEVER MERGED — one plan, one market', async () => {
      const eg = await getJson(`/admin/growth/subscriptions?countryCode=EG`);
      const sa = await getJson(`/admin/growth/subscriptions?countryCode=SA`);

      // The Saudi ANNUAL row must not appear in the Egyptian annual count, and
      // the Egyptian MONTHLY row must not appear in the Saudi monthly count.
      expect(eg.annual - baseline.mix.EG.annual).toBe(0);
      expect(sa.monthly - baseline.mix.SA.monthly).toBe(0);
      expect(JSON.stringify(eg)).not.toContain('SAR');
      expect(JSON.stringify(sa)).not.toContain('EGP');
    });

    it('the plan-tier breakdown names the tier that was actually sold', async () => {
      const eg = await getJson(`/admin/growth/subscriptions?countryCode=EG`);
      const premium = eg.byPlanTier.find((row: any) => row.planTier === 'PREMIUM');
      expect(premium).toBeTruthy();
      const sa = await getJson(`/admin/growth/subscriptions?countryCode=SA`);
      expect(sa.byPlanTier.find((row: any) => row.planTier === 'FAMILY')).toBeTruthy();
    });

    it('the platform mix INCLUDES the unattributable household and says so', async () => {
      const platform = await getJson(`/admin/growth/subscriptions?countryCode=**`);
      expect(platform.registeredFamilies - baseline.mix[PLATFORM_SCOPE].registeredFamilies).toBe(5);
      // noCountry, egOwnSaLabel (canceled) and saByLabel bought nothing.
      expect(platform.free - baseline.mix[PLATFORM_SCOPE].free).toBe(3);
      expect(platform.currencyCode).toBeNull();
      expect(platform.scopeIncludesUnattributable).toBe(true);
    });
  });

  // =========================================================================
  describe('3. PILOT ENROLMENT — invited vs activated, by country and cohort', () => {
    it('EGYPT: three invited, one redeemed, two still pending', async () => {
      const body = await getJson(`/admin/growth/pilot?countryCode=EG&cohortId=${cohortId}`);
      expect(body.invited).toBe(3);
      expect(body.activated).toBe(1);
      expect(body.pending).toBe(2);
      expect(body.byCohort).toEqual([{ cohortId, invited: 3, activated: 1, pending: 2 }]);
    });

    it('SAUDI ARABIA: two invited, both redeemed, none pending', async () => {
      const body = await getJson(`/admin/growth/pilot?countryCode=SA&cohortId=${cohortId}`);
      expect(body.invited).toBe(2);
      expect(body.activated).toBe(2);
      expect(body.pending).toBe(0);
    });

    it('the two markets are counted separately and their sum is the cohort', async () => {
      const platform = await getJson(`/admin/growth/pilot?cohortId=${cohortId}`);
      expect(platform.invited).toBe(5);
      expect(platform.activated).toBe(3);
      expect(platform.pending).toBe(2);
      expect(platform.countryCode).toBeNull();
    });

    it('the counts match the invitation rows counted independently', async () => {
      const invited = await sys('count invites', () =>
        prisma.pilotInvite.count({ where: { cohortId } }),
      );
      const activated = await sys('count redeemed invites', () =>
        prisma.pilotInvite.count({ where: { cohortId, redeemedAt: { not: null } } }),
      );
      expect(invited).toBe(5);
      expect(activated).toBe(3);
    });

    it('a cohort that does not exist reports ZERO invitations rather than an error', async () => {
      // A wave nobody has started has genuinely no invitations. That is a
      // measured zero, not a missing measurement — the distinction this whole
      // surface is built on.
      const body = await getJson(`/admin/growth/pilot?countryCode=EG&cohortId=no-such-cohort-${stamp}`);
      expect(body.invited).toBe(0);
      expect(body.activated).toBe(0);
      expect(body.byCohort).toEqual([]);
    });
  });

  // =========================================================================
  describe('4. ACTIVE PARENTS AND ACTIVE CHILDREN — the same heartbeat, per person', () => {
    it('EGYPT: one parent and one child, on the device heartbeat DAU/WAU/MAU already use', async () => {
      const parents = (await kpiOf('EG', 'ACTIVE_PARENTS')) ?? 0;
      const children = (await kpiOf('EG', 'ACTIVE_CHILDREN')) ?? 0;
      expect(parents - baseline.people.EG.parents).toBe(1);
      expect(children - baseline.people.EG.children).toBe(1);
    });

    it('SAUDI ARABIA: its own one and one, and the 100-day-silent parent is NOT among them', async () => {
      const parents = (await kpiOf('SA', 'ACTIVE_PARENTS')) ?? 0;
      const children = (await kpiOf('SA', 'ACTIVE_CHILDREN')) ?? 0;
      // saByLabel's parent device was last seen 100 days ago.
      expect(parents - baseline.people.SA.parents).toBe(1);
      expect(children - baseline.people.SA.children).toBe(1);
    });

    it("the NULL-country household's people are in the platform total and in no market", async () => {
      const parents = (await kpiOf(PLATFORM_SCOPE, 'ACTIVE_PARENTS')) ?? 0;
      const children = (await kpiOf(PLATFORM_SCOPE, 'ACTIVE_CHILDREN')) ?? 0;
      // egOwn + saOwn + noCountry.
      expect(parents - baseline.people[PLATFORM_SCOPE].parents).toBe(3);
      expect(children - baseline.people[PLATFORM_SCOPE].children).toBe(3);
    });

    it('both KPIs are COUNTs with a null denominator and travel with the rest of the snapshot', async () => {
      const res = await request(http)
        .get(`/admin/growth/kpis?countryCode=EG&asOf=${ASOF.toISOString()}`)
        .set('x-internal-admin-key', ADMIN_KEY);
      expect(res.status).toBe(200);

      for (const id of ['ACTIVE_PARENTS', 'ACTIVE_CHILDREN']) {
        const value = res.body.values.find((v: any) => v.kpi === id);
        expect(value).toBeTruthy();
        expect(value.kind).toBe('COUNT');
        expect(value.provenance).toBe('ACTUAL');
        // A COUNT is not money and must never carry a currency.
        expect(value.currencyCode).toBeNull();
      }
    });

    it('the catalogue defines them, so the dashboard never has to hardcode a formula', async () => {
      const catalogue = await getJson('/admin/growth/catalogue');
      const ids = catalogue.kpis.map((k: any) => k.id);
      expect(ids).toContain('ACTIVE_PARENTS');
      expect(ids).toContain('ACTIVE_CHILDREN');
      const parents = catalogue.kpis.find((k: any) => k.id === 'ACTIVE_PARENTS');
      // The window is stated, so the tile can say "in 30 days" rather than
      // leaving a reader to guess what "active" means.
      expect(parents.windowDays).toBe(30);
      expect(parents.denominator).toBeNull();
    });
  });

  // =========================================================================
  describe('5. GOALS COMPLETED AND REWARDS GRANTED, per market', () => {
    const url = (scope: string): string =>
      `/admin/growth/product?countryCode=${scope}&from=${FLOW_FROM.toISOString()}&to=${FLOW_TO.toISOString()}`;

    it('EGYPT: 3 goals started, 2 completed, 2 rewards granted, 1 redeemed', async () => {
      const body = await getJson(url('EG'));
      expect(body.goalsRequested).toBe(3);
      expect(body.goalsCompleted).toBe(2);
      expect(body.rewardsGranted).toBe(2);
      expect(body.rewardsRedeemed).toBe(1);
      expect(body.childrenGrantedAReward).toBe(1);
    });

    it('SAUDI ARABIA: 1 goal, 1 completion, 1 grant — never the Egyptian rows', async () => {
      const body = await getJson(url('SA'));
      expect(body.goalsRequested).toBe(1);
      expect(body.goalsCompleted).toBe(1);
      expect(body.rewardsGranted).toBe(1);
      expect(body.rewardsRedeemed).toBe(0);
    });

    it('the numbers match the rows counted independently in this test', async () => {
      const verifiedEg = await sys('count verified', () =>
        prisma.achievementRequest.count({
          where: {
            familyId: egOwn,
            status: 'VERIFIED',
            decidedAt: { gte: FLOW_FROM, lt: FLOW_TO },
          },
        }),
      );
      const earnsEg = await sys('count earns', () =>
        prisma.rewardsLedgerEntry.count({
          where: { familyId: egOwn, type: 'EARN', createdAt: { gte: FLOW_FROM, lt: FLOW_TO } },
        }),
      );
      expect(verifiedEg).toBe(2);
      expect(earnsEg).toBe(2);
    });

    it("THE NULL-COUNTRY HOUSEHOLD'S ACTIVITY IS IN NEITHER MARKET, AND IN THE PLATFORM", async () => {
      const eg = await getJson(url('EG'));
      const sa = await getJson(url('SA'));
      const platform = await getJson(url('**'));

      // 3 + 1 + 1 goals started; the third household belongs to no market.
      expect(platform.goalsRequested).toBe(5);
      expect(eg.goalsRequested + sa.goalsRequested).toBe(4);
      expect(platform.goalsCompleted).toBe(4);
      expect(platform.rewardsGranted).toBe(4);
      expect(platform.scopeIncludesUnattributable).toBe(true);
    });

    it('a window with no activity reports a MEASURED ZERO, not a null', async () => {
      // The query ran and found nothing. That is a fact about the window, and
      // it is different from a field this schema cannot answer.
      const body = await getJson(
        '/admin/growth/product?countryCode=EG&from=1999-01-01T00:00:00.000Z&to=1999-01-02T00:00:00.000Z',
      );
      expect(body.goalsCompleted).toBe(0);
      expect(body.rewardsGranted).toBe(0);
    });

    it('WHAT CANNOT BE MEASURED IS NULL AND IS NAMED — never a confident zero', async () => {
      const body = await getJson(url('EG'));
      expect(body.aiSessions).toBeNull();
      const named = body.unmeasured.map((u: any) => u.field);
      expect(named).toContain('aiSessions');
      // Every declared gap carries its reason, so the dashboard renders "—"
      // with an explanation rather than an unexplained blank.
      for (const entry of body.unmeasured) {
        expect(typeof entry.reason).toBe('string');
        expect(entry.reason.length).toBeGreaterThan(40);
      }
    });

    it('the window is HALF-OPEN, so two adjacent windows partition rather than double-count', async () => {
      // `to` is exclusive: a window ENDING at the seeded instant sees nothing.
      const before = await getJson(
        `/admin/growth/product?countryCode=EG&from=${FLOW_FROM.toISOString()}&to=${FLOW_AT.toISOString()}`,
      );
      expect(before.goalsCompleted).toBe(0);
      // ...and `from` is inclusive: a window STARTING at it sees all of them.
      const after = await getJson(
        `/admin/growth/product?countryCode=EG&from=${FLOW_AT.toISOString()}&to=${FLOW_TO.toISOString()}`,
      );
      expect(after.goalsCompleted).toBe(2);
    });
  });
});
