/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-var-requires */
/**
 * `GET /system/notifications/decision-breakdown` — THE OPERATOR VIEW OF THE
 * DECISION LOG, AGAINST REAL ROWS AND THROUGH THE REAL GUARD.
 *
 * WHAT THIS SUITE IS FOR. `analytics()` gave this product a platform
 * suppression rate and no way to ask WHERE the suppression is. The breakdown
 * route is that «where»: audience, notification type, source, provenance, date
 * and cause. A number that has only ever been computed in a unit test with a
 * stubbed repository is a shape, not a measurement, so every count below is
 * driven through the REAL `SmartNotificationEngineService` against a REAL
 * PostgreSQL and read back over REAL HTTP with the REAL `InternalAdminGuard` in
 * front of it.
 *
 * ── THE WINDOW, AND WHY IT IS IN 2025 ───────────────────────────────────────
 * `notification-analytics.e2e.spec.ts` asserts ABSOLUTE cross-tenant totals
 * over 2026-01-15/16 (`expect(utcDayOnly.total).toBe(1)`). This suite asserts
 * absolute cross-tenant totals too — the endpoint is platform-wide, so there is
 * no family to scope by — which means the two suites must not share a business
 * date or each would count the other's households and both would be flaky. The
 * window below is one nothing else in this repository writes into, and the
 * fixture households are deleted in `afterAll`, so the suite is re-runnable
 * against the same database.
 *
 * ── THE TWO CAIRO DATES ─────────────────────────────────────────────────────
 * `DEEP_NIGHT` is 22:30 UTC on the 20th and 00:30 CAIRO on the 21st, so the two
 * quiet-hours decisions are filed under the 21st. That is the whole point of
 * storing the HOUSEHOLD's business date, and `byDate` below is the first
 * surface in this product where an operator can actually see it.
 */
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request = require('supertest');

import { AppModule } from '../../src/app.module';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { createTenantExtension } from '../../src/common/tenancy/tenant.extension';
import { runAsSystemAsync } from '../../src/common/tenancy/system-context';
import { runWithTenant } from '../../src/common/tenancy/tenant-context';
import { AI_PROVIDER } from '../../src/modules/ai-core/domain/ai-provider.port';
import { ROLES_METADATA } from '../../src/common/authz/roles.decorator';
import { SYSTEM_ROUTE_METADATA } from '../../src/common/tenancy/system-route.decorator';
import { SmartNotificationEngineService } from '../../src/modules/notification-engine/application/services/smart-notification-engine.service';
import { NotificationOperationsController } from '../../src/modules/notifications/presentation/controllers/notification-operations.controller';
import {
  NOTIFICATION_DECISION_REPOSITORY,
  type DecisionBreakdownBucket,
  type DecisionBreakdownReport,
  type INotificationDecisionRepository,
} from '../../src/modules/notifications/application/ports/notification-decision.repository.port';
import type { NotificationEventInput } from '../../src/modules/notification-engine/application/services/notification-context.assembler';
import { integrationDatabaseUrl } from '../tenancy/prisma-test-client';

const describeIfDb = integrationDatabaseUrl() ? describe : describe.skip;

/** 17:00 Cairo on the 20th. */
const AFTERNOON = new Date('2025-11-20T15:00:00.000Z');
/** 00:30 Cairo on the 21st — the same UTC evening, the household's NEXT day. */
const DEEP_NIGHT = new Date('2025-11-20T22:30:00.000Z');

const DAY_ONE = '2025-11-20';
const DAY_TWO = '2025-11-21';

/**
 * The suite supplies the operator key if the environment has not. The guard
 * FAILS CLOSED on an unset secret, so without this the whole surface would
 * answer 401 and every assertion below would pass for the wrong reason. The
 * previous value is restored in `afterAll` so no other suite inherits it.
 */
const PREVIOUS_ADMIN_KEY = process.env.INTERNAL_ADMIN_API_KEY;
const ADMIN_KEY = PREVIOUS_ADMIN_KEY ?? 'decision-breakdown-suite-operator-key-0123456789';

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

/** Sums one count across a dimension's buckets. The grouping-set invariant —
 * every dimension sums to `totals` — is the property that makes the page's
 * tables comparable, and it is asserted rather than assumed. */
function sumOf(
  buckets: readonly DecisionBreakdownBucket[],
  key: keyof DecisionBreakdownBucket,
): number {
  return buckets.reduce((acc, b) => acc + (b[key] as number), 0);
}

function bucketNamed(
  buckets: readonly DecisionBreakdownBucket[],
  name: string,
): DecisionBreakdownBucket | undefined {
  return buckets.find((b) => b.bucket === name);
}

describeIfDb('the operator decision breakdown — real decisions, real guard', () => {
  let app: INestApplication;
  let http: any;
  let prisma: any;
  let engine: SmartNotificationEngineService;
  let ledger: INotificationDecisionRepository;

  const stamp = Date.now();
  const createdFamilies: string[] = [];
  const createdUsers: string[] = [];

  let sentFamily: Household;
  let erroredFamily: Household;
  let quietFamily: Household;
  let deferFamily: Household;
  let erroredDecisionId: string | null = null;
  let parentToken = '';

  interface Household {
    familyId: string;
    childId: string;
    userId: string;
  }

  const sys = (what: string, fn: () => Promise<any>): Promise<any> =>
    runAsSystemAsync('TEST_FIXTURE', `decision breakdown suite: ${what}`, async () => await fn());

  const fire = (input: NotificationEventInput): Promise<any> =>
    runWithTenant(
      { familyId: input.familyId, actorType: 'SYSTEM', actorId: 'decision-breakdown-suite' },
      () => engine.handleEvent(input),
    );

  /** The endpoint, as an operator calls it. */
  const breakdown = async (query: string): Promise<DecisionBreakdownReport> => {
    const res = await request(http)
      .get(`/system/notifications/decision-breakdown${query}`)
      .set('x-internal-admin-key', ADMIN_KEY);
    expect(res.status).toBe(200);
    return res.body as DecisionBreakdownReport;
  };

  const WINDOW = `?from=${DAY_ONE}&to=${DAY_TWO}`;

  async function createFamily(label: string): Promise<Household> {
    const fam = await sys('create family', () =>
      prisma.family.create({
        data: { name: `brk ${label} ${stamp}`, timezone: 'Africa/Cairo' },
        select: { id: true },
      }),
    );
    createdFamilies.push(fam.id);
    const user = await sys('create user', () =>
      prisma.user.create({
        data: {
          email: `brk.${label}.${stamp}@example.test`,
          passwordHash: 'x',
          fullName: 'BRK',
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
        data: {
          familyId: fam.id,
          firstName: 'سالم',
          dateOfBirth: new Date('2013-04-01T00:00:00.000Z'),
        },
        select: { id: true },
      }),
    );
    return { familyId: fam.id, childId: child.id, userId: user.id };
  }

  /** The register/login throttle is a Redis counter shared with every other
   * suite in this repository; a run that follows a busy one would otherwise be
   * refused before it started. */
  async function clearThrottle(): Promise<void> {
    const Redis = require('ioredis');
    const client = new Redis(process.env.REDIS_URL as string);
    const keys = await client.keys('throttle:*');
    if (keys.length > 0) await client.del(...keys);
    await client.quit();
  }

  beforeAll(async () => {
    process.env.INTERNAL_ADMIN_API_KEY = ADMIN_KEY;

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue(offlinePrismaService())
      .overrideProvider(AI_PROVIDER)
      .useValue({ complete: async () => 'صياغة بديلة من النموذج' })
      .compile();

    app = moduleRef.createNestApplication();
    await app.init();
    http = app.getHttpServer();
    prisma = app.get(PrismaService);
    engine = app.get(SmartNotificationEngineService);
    ledger = app.get(NOTIFICATION_DECISION_REPOSITORY);

    sentFamily = await createFamily('sent');
    erroredFamily = await createFamily('errored');
    quietFamily = await createFamily('suppressed');
    deferFamily = await createFamily('deferred');

    // DAY ONE — two rewards in the Cairo afternoon, both decided SEND.
    await fire({
      familyId: sentFamily.familyId,
      childId: sentFamily.childId,
      eventType: 'REWARD_GRANTED',
      sourceEventId: `evt:${stamp}:brk-sent`,
      trigger: 'DOMAIN_EVENT',
      reward: { kind: 'COINS', amount: 30, isMilestone: false },
      now: AFTERNOON,
    });
    const errored = await fire({
      familyId: erroredFamily.familyId,
      childId: erroredFamily.childId,
      eventType: 'REWARD_GRANTED',
      sourceEventId: `evt:${stamp}:brk-errored`,
      trigger: 'DOMAIN_EVENT',
      reward: { kind: 'COINS', amount: 35, isMilestone: false },
      now: AFTERNOON,
    });
    erroredDecisionId = errored?.decisionId ?? null;

    // DAY TWO (Cairo) — a suppression and a deferral, both at 00:30 local.
    await fire({
      familyId: quietFamily.familyId,
      childId: quietFamily.childId,
      eventType: 'HYDRATION_REMINDER',
      sourceEventId: `signal:${stamp}:brk-suppressed`,
      trigger: 'PERIODIC_SIGNAL',
      now: DEEP_NIGHT,
    });
    await fire({
      familyId: deferFamily.familyId,
      childId: deferFamily.childId,
      eventType: 'REWARD_GRANTED',
      sourceEventId: `evt:${stamp}:brk-deferred`,
      trigger: 'DOMAIN_EVENT',
      reward: { kind: 'COINS', amount: 40, isMilestone: true },
      now: DEEP_NIGHT,
    });

    /**
     * ONE DELIVERY ERROR, WRITTEN THROUGH THE PIPELINE'S OWN PORT.
     *
     * A push that fails at FCM cannot be provoked from a test without stubbing
     * the transport, and a stubbed transport would prove nothing about this
     * query. What CAN be driven honestly is the write the pipeline itself
     * performs when a send dies: `recordOutcome(...,'SUPPRESS','DELIVERY_ERROR')`
     * — the same port, the same statement, on a row the real engine created.
     * The alternative, an INSERT of a hand-built row, would have tested the
     * suite's own idea of the schema instead of the product's.
     */
    expect(erroredDecisionId).toBeTruthy();
    await runWithTenant(
      { familyId: erroredFamily.familyId, actorType: 'SYSTEM', actorId: 'decision-breakdown-suite' },
      () =>
        ledger.recordOutcome(
          erroredFamily.familyId,
          erroredDecisionId as string,
          'SUPPRESS',
          'DELIVERY_ERROR',
        ),
    );

    // A GENUINE parent token, for the refusal proof. Minted over HTTP so it is
    // signed by the same secret the running app verifies with.
    await clearThrottle();
    const email = `brk.parent.${stamp}@example.test`;
    const registered = await request(http)
      .post('/auth/register')
      .send({ email, password: 'Brk-Passw0rd!23', fullName: 'BRK Parent', acceptedTerms: true });
    expect(registered.status).toBe(201);
    createdFamilies.push(registered.body.familyId);
    createdUsers.push(registered.body.id);
    const login = await request(http)
      .post('/auth/login')
      .send({ email, password: 'Brk-Passw0rd!23' });
    expect(login.status).toBe(200);
    parentToken = login.body.tokens.accessToken;
  }, 120_000);

  afterAll(async () => {
    for (const id of createdFamilies) {
      await sys('cleanup family', () => prisma.family.delete({ where: { id } })).catch(
        () => undefined,
      );
    }
    for (const id of createdUsers) {
      await sys('cleanup user', () => prisma.user.delete({ where: { id } })).catch(() => undefined);
    }
    await app?.close();
    if (PREVIOUS_ADMIN_KEY === undefined) delete process.env.INTERNAL_ADMIN_API_KEY;
    else process.env.INTERNAL_ADMIN_API_KEY = PREVIOUS_ADMIN_KEY;
  }, 60_000);

  // ==========================================================================
  describe('the counts', () => {
    it('reports sent / deferred / suppressed and the delivery error over the real window', async () => {
      const report = await breakdown(WINDOW);

      expect(report.fromBusinessDate).toBe(DAY_ONE);
      expect(report.toBusinessDate).toBe(DAY_TWO);

      // FOUR DECISIONS, and every one of them was produced by the engine.
      expect(report.totals.total).toBe(4);
      expect(report.totals.decidedSend).toBe(2);
      expect(report.totals.decidedDefer).toBe(1);
      expect(report.totals.decidedSuppress).toBe(1);

      // THE ENGINE AND THE PIPELINE DISAGREE ON EXACTLY ONE ROW, which is the
      // row this endpoint exists for: two sends were decided, one was
      // delivered, and the other died with a delivery error.
      expect(report.totals.delivered).toBe(1);
      expect(report.totals.deliveryErrors).toBe(1);
    });

    it('every dimension sums to the same totals — the tables on the page are comparable', async () => {
      const report = await breakdown(WINDOW);
      const counts: (keyof DecisionBreakdownBucket)[] = [
        'total',
        'decidedSend',
        'decidedDefer',
        'decidedSuppress',
        'delivered',
        'deliveryErrors',
      ];

      // The four CLOSED dimensions come from one `GROUPING SETS` scan with the
      // grand total, so this holds by construction. Asserting it is what would
      // catch someone splitting the query into four and re-filtering one of
      // them differently.
      for (const dimension of [
        report.byAudience,
        report.bySource,
        report.byProvenance,
        report.byDate,
      ]) {
        for (const count of counts) {
          expect(sumOf(dimension, count)).toBe(report.totals[count]);
        }
      }
    });

    it('splits by AUDIENCE, and the buckets are the two the schema allows', async () => {
      const report = await breakdown(WINDOW);
      expect(report.byAudience.map((b) => b.bucket).sort()).toEqual(['CHILD', 'PARENT']);
    });

    it('splits by SOURCE — the trigger that set each decision off', async () => {
      const report = await breakdown(WINDOW);
      expect(bucketNamed(report.bySource, 'DOMAIN_EVENT')?.total).toBe(3);
      expect(bucketNamed(report.bySource, 'PERIODIC_SIGNAL')?.total).toBe(1);
      // The one suppression came from the periodic signal, not from a reward.
      expect(bucketNamed(report.bySource, 'PERIODIC_SIGNAL')?.decidedSuppress).toBe(1);
      expect(bucketNamed(report.bySource, 'DOMAIN_EVENT')?.decidedSuppress).toBe(0);
    });

    it('splits by PROVENANCE — which decision provider produced the verdict', async () => {
      const report = await breakdown(WINDOW);
      // One provider is registered today. The column exists so that the day a
      // second one ships, «which one decided this» is a question with an
      // answer rather than a schema change.
      expect(report.byProvenance).toHaveLength(1);
      expect(report.byProvenance[0].bucket).toBe('rule-based');
      expect(report.byProvenance[0].total).toBe(4);
    });

    it('splits by DATE — and the date is the HOUSEHOLD’s, not UTC', async () => {
      const report = await breakdown(WINDOW);
      // Both quiet-hours decisions were taken at 22:30 UTC on the 20th. A
      // UTC-dated ledger would have filed them under the 20th and told the
      // operator that a Cairo household's midnight happened the previous day.
      expect(report.byDate.map((b) => [b.bucket, b.total])).toEqual([
        [DAY_ONE, 2],
        [DAY_TWO, 2],
      ]);
    });

    it('lists the TOP CAUSES — the event that actually happened, not the message type', async () => {
      const report = await breakdown(WINDOW);
      expect(bucketNamed(report.topCauses, 'REWARD_GRANTED')?.total).toBe(3);
      expect(bucketNamed(report.topCauses, 'HYDRATION_REMINDER')?.total).toBe(1);
      // Ordered by count descending, so the first row is the loudest cause.
      expect(report.topCauses[0].bucket).toBe('REWARD_GRANTED');
    });

    it('lists notification TYPES, and a type is not a cause', async () => {
      const report = await breakdown(WINDOW);
      expect(report.byNotificationType.length).toBeGreaterThan(0);
      expect(sumOf(report.byNotificationType, 'total')).toBe(4);
      // Every bucket is a notification-class name, never a rendered sentence.
      for (const bucket of report.byNotificationType) {
        expect(bucket.bucket).toMatch(/^[A-Z0-9_]+$/);
      }
    });

    it('an EMPTY range answers with an honest row of zeros, not an absent object', async () => {
      // The first thing every dashboard hits. The `()` grouping set always
      // returns one row, so `totals` is a shape the page can render rather
      // than an `undefined` it has to guard.
      const report = await breakdown('?from=2019-03-01&to=2019-03-02');
      expect(report.totals.total).toBe(0);
      expect(report.totals.delivered).toBe(0);
      expect(report.byAudience).toEqual([]);
      expect(report.byDate).toEqual([]);
      expect(report.topCauses).toEqual([]);
      expect(report.byNotificationType).toEqual([]);
    });

    it('honours the AUDIENCE, CATEGORY and AGE-BAND filters over the same window', async () => {
      const parents = await breakdown(`${WINDOW}&audience=PARENT`);
      const children = await breakdown(`${WINDOW}&audience=CHILD`);
      expect(parents.totals.total + children.totals.total).toBe(4);
      // A filtered call collapses the audience dimension to the one asked for.
      expect(parents.byAudience.map((b) => b.bucket)).toEqual(['PARENT']);

      const otherBand = await breakdown(`${WINDOW}&ageBand=5-7`);
      expect(otherBand.totals.total).toBe(0);
      const ownBand = await breakdown(`${WINDOW}&ageBand=11-13`);
      expect(ownBand.totals.total).toBe(4);
    });
  });

  // ==========================================================================
  describe('what it must never leak', () => {
    /**
     * ON THE REAL PAYLOAD, RECURSIVELY, not on a hand-listed field. The
     * question is not «did we remember to omit familyId» — it is «is there any
     * key anywhere in this response that names a household», and only a walk of
     * the actual object answers that.
     */
    it('no key anywhere in the response identifies a household, a child or a message', async () => {
      const report = await breakdown(WINDOW);
      const keys = new Set<string>();
      const values: string[] = [];
      const walk = (node: unknown): void => {
        if (Array.isArray(node)) return node.forEach(walk);
        if (node !== null && typeof node === 'object') {
          for (const [key, value] of Object.entries(node)) {
            keys.add(key);
            walk(value);
          }
          return;
        }
        if (typeof node === 'string') values.push(node);
      };
      walk(report);

      for (const forbidden of [
        'familyId',
        'family_id',
        'childId',
        'child_id',
        'userId',
        'user_id',
        'sourceEventId',
        'source_event_id',
        'title',
        'body',
        'message',
        'explanation',
        'email',
        'firstName',
      ]) {
        expect([...keys]).not.toContain(forbidden);
      }

      // And no VALUE is an identifier either — a leak can hide in a bucket
      // name as easily as in a key. Every string this endpoint returns is a
      // closed-vocabulary name or a `YYYY-MM-DD`; none is a UUID.
      const uuid = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
      for (const value of values) {
        expect(value).not.toMatch(uuid);
      }
      // The households this suite created are not findable in it.
      const serialised = JSON.stringify(report);
      for (const familyId of createdFamilies) expect(serialised).not.toContain(familyId);
      for (const userId of createdUsers) expect(serialised).not.toContain(userId);
      expect(serialised).not.toContain(sentFamily.childId);
    });

    it('the response carries exactly the declared top-level keys — nothing crept in', async () => {
      const report = await breakdown(WINDOW);
      expect(Object.keys(report).sort()).toEqual(
        [
          'byAudience',
          'byDate',
          'byNotificationType',
          'byProvenance',
          'bySource',
          'fromBusinessDate',
          'limits',
          'toBusinessDate',
          'topCauses',
          'totals',
        ].sort(),
      );
      expect(Object.keys(report.totals).sort()).toEqual(
        [
          'bucket',
          'decidedDefer',
          'decidedSend',
          'decidedSuppress',
          'delivered',
          'deliveryErrors',
          'total',
        ].sort(),
      );
    });
  });

  // ==========================================================================
  describe('who may ask', () => {
    const path = `/system/notifications/decision-breakdown?from=${DAY_ONE}&to=${DAY_TWO}`;

    it('a real PARENT token is refused — this is not a family question', async () => {
      const res = await request(http).get(path).set('Authorization', `Bearer ${parentToken}`);
      expect([401, 403]).toContain(res.status);
      expect(JSON.stringify(res.body ?? {})).not.toContain('totals');
    });

    it('a MISSING operator key is refused', async () => {
      const res = await request(http).get(path);
      expect([401, 403]).toContain(res.status);
    });

    it('a WRONG operator key is refused — the guard compares, it does not merely require presence', async () => {
      const res = await request(http).get(path).set('x-internal-admin-key', 'not-the-key');
      expect([401, 403]).toContain(res.status);
    });

    it('a parent token AND a wrong key together are still refused', async () => {
      const res = await request(http)
        .get(path)
        .set('Authorization', `Bearer ${parentToken}`)
        .set('x-internal-admin-key', 'not-the-key');
      expect([401, 403]).toContain(res.status);
    });

    it('the route declares itself a SystemRoute for SUPER_ADMIN, with a real justification', async () => {
      // Read off the real metadata rather than trusted to the decorator being
      // present in the source: a decorator imported and not applied looks
      // identical in a diff.
      const proto = NotificationOperationsController.prototype as any;
      const guards = Reflect.getMetadata('__guards__', proto.decisionBreakdown) ?? [];
      expect(guards.map((g: any) => g.name)).toContain('InternalAdminGuard');
      const roles = Reflect.getMetadata(ROLES_METADATA, proto.decisionBreakdown) ?? [];
      expect(roles).toEqual(['SUPER_ADMIN']);
      const systemRoute = Reflect.getMetadata(SYSTEM_ROUTE_METADATA, proto.decisionBreakdown);
      expect(systemRoute?.reason).toBe('ADMIN_CONSOLE');
      expect(systemRoute?.justification.length).toBeGreaterThan(60);
    });
  });

  // ==========================================================================
  describe('the bounds', () => {
    it('refuses an over-long range instead of quietly clamping it', async () => {
      const res = await request(http)
        .get('/system/notifications/decision-breakdown?from=2020-01-01&to=2025-11-21')
        .set('x-internal-admin-key', ADMIN_KEY);
      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body)).toMatch(/must not exceed 92 days/);
    });

    it('refuses an inverted range and an unparseable date', async () => {
      const bad = async (query: string): Promise<number> =>
        (
          await request(http)
            .get(`/system/notifications/decision-breakdown${query}`)
            .set('x-internal-admin-key', ADMIN_KEY)
        ).status;
      expect(await bad(`?from=${DAY_TWO}&to=${DAY_ONE}`)).toBe(400);
      expect(await bad('?from=last-tuesday&to=2025-11-21')).toBe(400);
      expect(await bad(`${WINDOW}&country=egypt`)).toBe(400);
      expect(await bad(`${WINDOW}&audience=EVERYONE`)).toBe(400);
      expect(await bad(`${WINDOW}&ageBand=6-8`)).toBe(400);
    });

    it('the range cap is enforced BELOW the controller too, so a non-HTTP caller cannot skip it', async () => {
      // The bound that matters is the one on the query. A cap that lives only
      // in an HTTP layer is a cap the first scheduled report does not have.
      await expect(
        ledger.breakdown(
          {
            fromBusinessDate: '2020-01-01',
            toBusinessDate: DAY_TWO,
            countryCode: null,
            ageBand: null,
            audience: null,
            category: null,
          },
          { topLimit: 20, maxRangeDays: 92 },
        ),
      ).rejects.toThrow(/refusing a .* scan; the cap is 92 days/);
    });

    it('the top-N cap truncates the open vocabularies and SAYS it truncated', async () => {
      const report = await breakdown(WINDOW);
      // The route's own cap, echoed so the dashboard need not hard-code it.
      expect(report.limits.topLimit).toBe(20);
      expect(report.limits.maxRangeDays).toBe(92);
      // Two causes in this window, well under the cap: not truncated.
      expect(report.limits.causesTruncated).toBe(false);

      // Driven to the cap through the repository, because provoking twenty
      // distinct causes through the engine would mean inventing twenty
      // producers. `topLimit: 1` exercises the same LIMIT and the same flag.
      const capped = await ledger.breakdown(
        {
          fromBusinessDate: DAY_ONE,
          toBusinessDate: DAY_TWO,
          countryCode: null,
          ageBand: null,
          audience: null,
          category: null,
        },
        { topLimit: 1, maxRangeDays: 92 },
      );
      expect(capped.topCauses).toHaveLength(1);
      expect(capped.topCauses[0].bucket).toBe('REWARD_GRANTED');
      expect(capped.limits.causesTruncated).toBe(true);
      expect(capped.byNotificationType).toHaveLength(1);
      expect(capped.limits.typesTruncated).toBe(true);
      // The CLOSED dimensions are untouched by the top-N cap — it bounds the
      // list, not the scan.
      expect(capped.totals.total).toBe(4);
      expect(capped.byDate).toHaveLength(2);
    });
  });
});
