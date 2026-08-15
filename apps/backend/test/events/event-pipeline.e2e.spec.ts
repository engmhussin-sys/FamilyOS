/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-var-requires */
/**
 * F3 (R3) — THE CANONICAL CHAIN, PROVEN BY EXECUTION.
 *
 * CONTEXT §5:
 *
 *   event ingest -> Domain Event Bus -> Rewards Engine (idempotent grant)
 *     |- if and ONLY IF a reward was actually granted -> Notification Decision
 *        Engine (cooldown -> duplicate -> quiet hours -> daily max ->
 *        category max -> priority) -> notification dispatched
 *
 * Everything below runs against a REAL PostgreSQL and a REAL Redis, through the
 * REAL application: real `POST /api/v1/events/batch`, real DeviceJwtAuthGuard,
 * real device-keyed throttler, real global TenantContextInterceptor, real
 * Prisma tenant extension, real `RewardsEngineService`, real
 * `NotificationFatigueGuard`. Nothing in the pipeline is stubbed. The only
 * things this file constructs directly are FIXTURES (families, children,
 * devices, reward rules) and the CLOCK.
 *
 * ON THE CLOCK, STATED PLAINLY — three facts, in the order they matter.
 *
 * 1. The fatigue guard's quiet-hours rule (21:00-07:00) is a function of
 *    wall-clock time, so a suite that asserts "a notification IS dispatched" is
 *    non-deterministic unless it owns the clock: it would pass by day and fail
 *    by night. `jest.useFakeTimers` here fakes ONLY `Date` — every timer API is
 *    in `doNotFake`, so supertest's sockets, the pg pool and ioredis keep using
 *    real timers.
 *
 * 2. The fake day is deliberately set one day BEHIND the real clock, and that
 *    direction is load-bearing. Prisma generates `@default(now())` values in the
 *    CLIENT, so every timestamp Prisma writes (`outbox_messages.next_attempt_at`,
 *    `notifications.created_at`, ...) follows the fake clock, while the relay's
 *    raw SQL uses PostgreSQL's real `now()`. A fake clock in the FUTURE would
 *    make `next_attempt_at <= now()` false and the relay would silently claim
 *    nothing — the suite would fail for a reason that has nothing to do with the
 *    code under test. In the past, both agree.
 *
 * 3. Consequently the guard's own inputs (`created_at` vs `now()`) are both
 *    fake and therefore mutually consistent. Where a test must NOT be allowed to
 *    pass because the 5-minute DUPLICATE window silently swallowed a
 *    notification, it advances the clock explicitly and says so.
 */
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request = require('supertest');

import { AppModule } from '../../src/app.module';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { RedisService } from '../../src/common/redis/redis.service';
import { createTenantExtension } from '../../src/common/tenancy/tenant.extension';
import { runAsSystemAsync } from '../../src/common/tenancy/system-context';
import { runWithTenant } from '../../src/common/tenancy/tenant-context';
import { TokenService } from '../../src/modules/auth/application/services/token.service';
import { OutboxRelay } from '../../src/modules/events/application/outbox.relay';
import { SmartNotificationIntegrationService } from '../../src/modules/life-intelligence/application/services/smart-notification-integration.service';
import {
  MAX_EVENTS_PER_BATCH,
  EVENTS_RATE_LIMIT,
} from '../../src/shared/events/events-batch.contract';
import { integrationDatabaseUrl } from '../tenancy/prisma-test-client';

const describeIfDb = integrationDatabaseUrl() ? describe : describe.skip;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Fixed, deterministic, and one day BEHIND the real clock — see the header. */
const FAKE_DAY = new Date(Date.now() - DAY_MS).toISOString().slice(0, 10);
const at = (hhmm: string): Date => new Date(`${FAKE_DAY}T${hhmm}:00.000Z`);
const NOON = at('12:00');

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

interface Tenant {
  familyId: string;
  userId: string;
  parentToken: string;
  childId: string;
  habitId: string;
}

describeIfDb('F3 — event pipeline end to end (real PostgreSQL, real Redis, real app)', () => {
  let app: INestApplication;
  let http: any;
  let prisma: any;
  let relay: OutboxRelay;
  let tokens: TokenService;
  let redis: RedisService;
  let notifications: SmartNotificationIntegrationService;

  const stamp = Date.now();
  const A = {} as Tenant;
  const B = {} as Tenant;
  const createdFamilies: string[] = [];
  const createdUsers: string[] = [];
  /** Devices minted during the suite, so teardown removes exactly them. */
  const createdDevices: string[] = [];

  // -------------------------------------------------------------------------
  // fixtures
  // -------------------------------------------------------------------------

  /**
   * Fixtures and assertions read/write across both families, which is exactly
   * what `runAsSystem('TEST_FIXTURE', ...)` exists for (F2). Typed `any`
   * deliberately: the WASM Prisma client is untyped at this seam, and pretending
   * otherwise would mean casting at every call site instead of once here.
   */
  const sys = (what: string, fn: () => Promise<any>): Promise<any> =>
    runAsSystemAsync(
      'TEST_FIXTURE',
      `F3 pipeline suite fixture/assertion: ${what}`,
      // `await` INSIDE the scope, deliberately. A `PrismaPromise` is lazy: it
      // executes when `.then` is attached, not when it is constructed. Passing
      // `fn` straight through would build the promise inside the AsyncLocalStorage
      // scope and then resolve it outside — the extension would see no context
      // and deny by default. This is the same subtlety the bus tests assert for
      // handlers, showing up in the fixtures.
      async () => await fn(),
    );

  async function registerTenant(label: string, target: Tenant): Promise<void> {
    const email = `f3.${label}.${stamp}@example.com`;
    const password = 'F3-Pipeline-Passw0rd!23';

    const reg = await request(http).post('/auth/register').send({
      email,
      password,
      fullName: `F3 Parent ${label}`,
      familyName: `F3 Family ${label}`,
      acceptedTerms: true,
    });
    if (![200, 201].includes(reg.status)) {
      throw new Error(`register(${label}) -> ${reg.status} ${JSON.stringify(reg.body)}`);
    }

    const login = await request(http).post('/auth/login').send({ email, password });
    if (login.status !== 200) {
      throw new Error(`login(${label}) -> ${login.status} ${JSON.stringify(login.body)}`);
    }
    target.parentToken = login.body.tokens?.accessToken ?? login.body.accessToken;
    const claims = JSON.parse(Buffer.from(target.parentToken.split('.')[1], 'base64').toString());
    target.familyId = claims.familyId;
    target.userId = claims.sub;
    createdFamilies.push(target.familyId);
    createdUsers.push(target.userId);

    const child = await request(http)
      .post('/children')
      .set({ Authorization: `Bearer ${target.parentToken}` })
      .send({ firstName: `F3 Kid ${label}`, dateOfBirth: '2015-04-01' });
    if (![200, 201].includes(child.status)) {
      throw new Error(`child(${label}) -> ${child.status} ${JSON.stringify(child.body)}`);
    }
    target.childId = child.body.id;

    const habit = await request(http)
      .post(`/life-intelligence/habits/${target.childId}`)
      .set({ Authorization: `Bearer ${target.parentToken}` })
      .send({ title: `F3 Habit ${label}`, category: 'LEARNING' });
    if (![200, 201].includes(habit.status)) {
      throw new Error(`habit(${label}) -> ${habit.status} ${JSON.stringify(habit.body)}`);
    }
    target.habitId = habit.body.id;

    // A reward rule that matches every habit-builder completion. `{}` as the
    // trigger condition is a subset-match against the payload, so it matches
    // unconditionally — the point of this suite is the PIPELINE, not the rule
    // language, and an unconditional rule removes rule-matching as a variable.
    await sys('seed reward rule', () =>
      prisma.rewardRule.create({
        data: {
          familyId: target.familyId,
          triggerEngine: 'habit-builder',
          triggerCondition: {},
          rewardType: 'XP',
          rewardAmountOrBadgeId: '10',
          isActive: true,
        },
      }),
    );
  }

  /**
   * A real, ACTIVE, paired device row plus a REAL device access token issued by
   * the application's own `TokenService` — the same call `POST /pairing/device/
   * register` makes. The token is genuine and signature-verified by the guard;
   * only the pairing handshake that would have produced it is short-circuited.
   *
   * A fresh device per test keeps the per-device rate limit (12/hour) from
   * turning test ordering into a hidden dependency.
   */
  async function newDevice(t: Tenant): Promise<{ deviceId: string; token: string }> {
    const device = await sys('seed device', () =>
      prisma.device.create({
        data: {
          familyId: t.familyId,
          ownerType: 'CHILD',
          childId: t.childId,
          platform: 'ANDROID',
          status: 'ACTIVE',
          pairedAt: new Date(),
        },
        select: { id: true },
      }),
    );
    createdDevices.push(device.id);

    const pair = await runWithTenant(
      { familyId: t.familyId, actorType: 'DEVICE', actorId: device.id },
      () =>
        tokens.issueTokenPair({
          subjectId: device.id,
          actorType: 'DEVICE',
          familyId: t.familyId,
        }),
    );
    return { deviceId: device.id, token: pair.accessToken };
  }

  // -------------------------------------------------------------------------
  // helpers
  // -------------------------------------------------------------------------

  const habitEvent = (
    t: Tenant,
    opts: { clientEventId: string; occurredAt?: Date; localDate?: string; payload?: any } = {
      clientEventId: 'e1',
    },
  ) => ({
    clientEventId: opts.clientEventId,
    type: 'HABIT_COMPLETED',
    occurredAt: (opts.occurredAt ?? new Date()).toISOString(),
    localDate: opts.localDate ?? FAKE_DAY,
    payload: { habitId: t.habitId, ...(opts.payload ?? {}) },
  });

  const postBatch = (token: string, events: any[], idempotencyKey?: string) => {
    const req = request(http)
      .post('/events/batch')
      .set({ Authorization: `Bearer ${token}` })
      .send({ deviceTime: new Date().toISOString(), events });
    return idempotencyKey ? req.set('Idempotency-Key', idempotencyKey) : req;
  };

  /** Ticks the relay until it has nothing left to claim. Returns totals. */
  async function drainOutbox(maxPasses = 8): Promise<{ published: number; failed: number }> {
    let published = 0;
    let failed = 0;
    for (let i = 0; i < maxPasses; i++) {
      const pass = await relay.tick();
      published += pass.published;
      failed += pass.failed;
      if (pass.claimed === 0) break;
    }
    return { published, failed };
  }

  const count = (model: string, where: any): Promise<number> =>
    sys(`count ${model}`, () => prisma[model].count({ where }));

  const notificationCount = (t: Tenant, type = 'REWARD_GRANTED'): Promise<number> =>
    count('notification', { familyId: t.familyId, childId: t.childId, type });

  const ledgerCount = (t: Tenant): Promise<number> =>
    count('rewardsLedgerEntry', { familyId: t.familyId, childId: t.childId, type: 'EARN' });

  const eventsOfType = (t: Tenant, eventType: string): Promise<number> =>
    count('domainEvent', { familyId: t.familyId, eventType });

  /** Wipes the per-child observable state so each test starts from zero. */
  async function resetChildState(t: Tenant): Promise<void> {
    await sys('reset child state', async () => {
      await prisma.notification.deleteMany({ where: { familyId: t.familyId } });
      await prisma.rewardsLedgerEntry.deleteMany({ where: { familyId: t.familyId } });
      await prisma.rewardsAccount.deleteMany({ where: { familyId: t.familyId } });
      await prisma.consumedMessage.deleteMany({ where: { familyId: t.familyId } });
      await prisma.outboxMessage.deleteMany({ where: { familyId: t.familyId } });
      await prisma.domainEvent.deleteMany({ where: { familyId: t.familyId } });
      await prisma.habitCompletion.deleteMany({ where: { familyId: t.familyId } });
    });
  }

  // -------------------------------------------------------------------------
  // lifecycle
  // -------------------------------------------------------------------------

  beforeAll(async () => {
    // Fake ONLY Date. Every timer API stays real so supertest's sockets, the pg
    // pool and ioredis are untouched.
    jest.useFakeTimers({
      doNotFake: [
        'hrtime',
        'nextTick',
        'performance',
        'queueMicrotask',
        'requestAnimationFrame',
        'cancelAnimationFrame',
        'requestIdleCallback',
        'cancelIdleCallback',
        'setImmediate',
        'clearImmediate',
        'setInterval',
        'clearInterval',
        'setTimeout',
        'clearTimeout',
      ],
    });
    jest.setSystemTime(NOON);

    // The throttler counters live in the REAL Redis and are IP-keyed for
    // `/auth/register`. Left over from a previous run of this file they would
    // 429 the fixtures and make the suite fail for a reason that has nothing to
    // do with the pipeline. Cleared here, and cleared again after the
    // rate-limit test, so the suite is genuinely re-runnable.
    {
      const Redis = require('ioredis');
      const client = new Redis(process.env.REDIS_URL as string);
      const keys = await client.keys('throttle:*');
      if (keys.length > 0) await client.del(...keys);
      await client.quit();
    }

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue(offlinePrismaService())
      .compile();

    app = moduleRef.createNestApplication();
    // Mirrors main.ts: the DTO validation the endpoint's contract depends on.
    const { ValidationPipe } = require('@nestjs/common');
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();

    http = app.getHttpServer();
    prisma = app.get(PrismaService);
    relay = app.get(OutboxRelay);
    tokens = app.get(TokenService);
    redis = app.get(RedisService);
    notifications = app.get(SmartNotificationIntegrationService);

    await registerTenant('a', A);
    await registerTenant('b', B);
  }, 120_000);

  afterAll(async () => {
    if (prisma) {
      await sys('teardown', async () => {
        await prisma.device.deleteMany({ where: { id: { in: createdDevices } } });
        await prisma.family.deleteMany({ where: { id: { in: createdFamilies } } });
        await prisma.user.deleteMany({ where: { id: { in: createdUsers } } });
      });
    }
    jest.setSystemTime(NOON);
    jest.useRealTimers();
    await app?.close();
  });

  beforeEach(() => {
    jest.setSystemTime(NOON);
  });

  // =========================================================================
  // 1. THE JOURNEY
  // =========================================================================

  describe('the canonical chain: batch -> bus -> reward -> exactly one notification', () => {
    let device: { deviceId: string; token: string };

    beforeAll(async () => {
      await resetChildState(A);
      device = await newDevice(A);
    });

    it('ingests the batch and reports per-item results the device can prune on', async () => {
      const res = await postBatch(device.token, [
        habitEvent(A, { clientEventId: 'journey:seq:1' }),
      ]);

      expect(res.status).toBe(200);
      expect(res.body.data.accepted).toBe(1);
      expect(res.body.data.duplicates).toBe(0);
      expect(res.body.data.rejected).toBe(0);
      expect(res.body.data.results).toHaveLength(1);
      expect(res.body.data.results[0]).toMatchObject({
        clientEventId: 'journey:seq:1',
        status: 'ACCEPTED',
      });
      expect(res.body.data.results[0].eventId).toBeTruthy();
      // The device corrects its own drift from this, never the other way round.
      expect(res.body.data.serverTime).toBeTruthy();
    });

    it('wrote the domain event, its outbox message and the habit row in ONE transaction', async () => {
      expect(await eventsOfType(A, 'HABIT_COMPLETED')).toBe(1);
      expect(await count('outboxMessage', { familyId: A.familyId, status: 'PENDING' })).toBe(1);
      // The domain state change committed WITH the event — the single property
      // the entire outbox pattern exists to provide.
      expect(await count('habitCompletion', { familyId: A.familyId, habitId: A.habitId })).toBe(1);
    });

    it('has granted NOTHING yet — the outbox is a hand-off, not a side effect', async () => {
      expect(await ledgerCount(A)).toBe(0);
      expect(await notificationCount(A)).toBe(0);
    });

    it('the relay publishes it, the Rewards Engine grants exactly once', async () => {
      await drainOutbox();

      expect(await ledgerCount(A)).toBe(1);
      const account = await sys('read account', () =>
        prisma.rewardsAccount.findFirst({ where: { childId: A.childId } }),
      );
      expect(account.xp).toBe(10);
    });

    it('emitted REWARD_GRANTED — and ONLY because a row was really created', async () => {
      expect(await eventsOfType(A, 'REWARD_GRANTED')).toBe(1);
    });

    it('dispatched EXACTLY ONE notification', async () => {
      expect(await notificationCount(A)).toBe(1);
      const n = await sys('read notification', () =>
        prisma.notification.findFirst({ where: { familyId: A.familyId, type: 'REWARD_GRANTED' } }),
      );
      expect(n.userId).toBe(A.userId);
      // CONTEXT §3 principle 8: the push carries no child name and no habit
      // title — it is a pointer, the app fetches the content authenticated.
      expect(n.body).not.toContain(A.childId);
      expect(n.body).not.toContain('F3 Habit');
    });

    it('every outbox message reached PUBLISHED — nothing stranded, nothing dead', async () => {
      expect(await count('outboxMessage', { familyId: A.familyId, status: 'PENDING' })).toBe(0);
      expect(await count('outboxMessage', { familyId: A.familyId, status: 'PUBLISHING' })).toBe(0);
      expect(await count('outboxMessage', { familyId: A.familyId, status: 'DEAD' })).toBe(0);
      expect(
        await count('outboxMessage', { familyId: A.familyId, status: 'PUBLISHED' }),
      ).toBeGreaterThanOrEqual(2);
    });

    // ---- THE REPLAY ------------------------------------------------------

    it('THE REPLAY: the same batch again is a SUCCESS reported as DUPLICATE', async () => {
      // Ten minutes later — PAST the fatigue guard's 5-minute DUPLICATE window.
      // Without this the replay assertions below could pass for the wrong
      // reason: a notification wrongly produced by the replay would be
      // suppressed as a near-simultaneous duplicate and never counted. Moving
      // the clock removes that excuse, so "zero new notifications" can only be
      // true because no reward was granted.
      jest.setSystemTime(at('12:10'));

      const res = await postBatch(device.token, [
        habitEvent(A, { clientEventId: 'journey:seq:1', occurredAt: at('12:10') }),
      ]);

      expect(res.status).toBe(200);
      expect(res.body.data.accepted).toBe(0);
      expect(res.body.data.duplicates).toBe(1);
      expect(res.body.data.results[0].status).toBe('DUPLICATE');
    });

    it('THE REPLAY: zero new domain events, zero new outbox messages', async () => {
      jest.setSystemTime(at('12:10'));
      expect(await eventsOfType(A, 'HABIT_COMPLETED')).toBe(1);
      expect(await count('outboxMessage', { familyId: A.familyId, status: 'PENDING' })).toBe(0);
    });

    it('THE REPLAY: zero new rewards and ZERO NEW NOTIFICATIONS', async () => {
      jest.setSystemTime(at('12:10'));
      await drainOutbox();

      expect(await ledgerCount(A)).toBe(1);
      expect(await eventsOfType(A, 'REWARD_GRANTED')).toBe(1);
      expect(await notificationCount(A)).toBe(1);
    });

    it('THE REPLAY: even from a DIFFERENT device — the key is server-composed, not device-scoped', async () => {
      jest.setSystemTime(at('12:20'));
      const other = await newDevice(A);
      const res = await postBatch(other.token, [
        habitEvent(A, { clientEventId: 'other-device:seq:1', occurredAt: at('12:20') }),
      ]);

      expect(res.body.data.duplicates).toBe(1);
      await drainOutbox();
      expect(await ledgerCount(A)).toBe(1);
      expect(await notificationCount(A)).toBe(1);
    });
  });

  // =========================================================================
  // 2. NO GRANT => NO NOTIFICATION (CONTEXT §5, brief §46)
  // =========================================================================

  describe('a reward that does not happen produces no notification at all', () => {
    it('a completion with NO matching reward rule grants nothing and notifies nobody', async () => {
      await resetChildState(B);
      // Family B's rule is `habit-builder`. An EDUCATION_PROGRESS completion
      // routes to the `learning` engine, so zero rules match, so
      // `processTriggerEvent` returns 0, so no REWARD_GRANTED is emitted.
      const device = await newDevice(B);
      const res = await postBatch(device.token, [
        {
          clientEventId: 'nogrant:seq:1',
          type: 'EDUCATION_PROGRESS',
          occurredAt: new Date().toISOString(),
          localDate: FAKE_DAY,
          payload: { goalId: B.habitId, milestone: 1 },
        },
      ]);
      expect(res.body.data.accepted).toBe(1);

      await drainOutbox();

      expect(await eventsOfType(B, 'EDUCATION_PROGRESS')).toBe(1);
      expect(await ledgerCount(B)).toBe(0);
      expect(await eventsOfType(B, 'REWARD_GRANTED')).toBe(0);
      expect(await notificationCount(B)).toBe(0);
    });

    it('a reward attempt that FAILS notifies nobody, and the message retries instead', async () => {
      await resetChildState(A);
      const device = await newDevice(A);
      await postBatch(device.token, [habitEvent(A, { clientEventId: 'fail:seq:1' })]);

      // Make the Rewards Engine fail for real, at the point it grants.
      const engine = app.get(
        require('../../src/modules/life-intelligence/application/services/rewards-engine.service')
          .RewardsEngineService,
      );
      const spy = jest
        .spyOn(engine, 'processTriggerEvent')
        .mockRejectedValue(new Error('rewards ledger unavailable'));

      try {
        const pass = await relay.tick();
        expect(pass.failed).toBeGreaterThanOrEqual(1);
      } finally {
        spy.mockRestore();
      }

      // THE RULE: no grant => no REWARD_GRANTED => no notification. Not a check
      // somewhere downstream — there is no code path from here to a
      // notification at all.
      expect(await ledgerCount(A)).toBe(0);
      expect(await eventsOfType(A, 'REWARD_GRANTED')).toBe(0);
      expect(await notificationCount(A)).toBe(0);

      // And the message is FAILED with a backoff, not lost and not DEAD.
      const msg = await sys('read failed message', () =>
        prisma.outboxMessage.findFirst({
          where: { familyId: A.familyId, eventType: 'HABIT_COMPLETED' },
        }),
      );
      expect(msg.status).toBe('FAILED');
      expect(msg.attemptCount).toBe(1);
      expect(msg.lastError).toContain('rewards ledger unavailable');
      expect(new Date(msg.nextAttemptAt).getTime()).toBeGreaterThan(
        new Date(msg.createdAt).getTime(),
      );
    });

    it('once the engine recovers, the retried message grants once and notifies once', async () => {
      // Clear the backoff the way the passage of time would.
      await sys('expire backoff', () =>
        prisma.$executeRawUnsafe(
          `UPDATE "outbox_messages" SET "next_attempt_at" = now() - INTERVAL '1 second'
             WHERE "family_id" = $1::uuid AND "status" = 'FAILED'`,
          A.familyId,
        ),
      );

      await drainOutbox();

      expect(await ledgerCount(A)).toBe(1);
      expect(await notificationCount(A)).toBe(1);
    });
  });

  // =========================================================================
  // 2b. ONE COMPLETION PATH, FOUR PRODUCERS (CONTEXT §4, §47, §48)
  // =========================================================================

  describe('Education/Faith completions travel the SAME path as habits', () => {
    beforeAll(async () => {
      // Family A gains a `learning` rule. Note what is NOT needed to make
      // Education work: no new consumer, no new event handler, no branch in the
      // Rewards Engine. `EDUCATION_PROGRESS` is already in
      // `COMPLETION_EVENT_TYPES`, `RewardsCompletionConsumer` already subscribes
      // to all of them, and `COMPLETION_KIND_TO_REWARD_ENGINE` already maps
      // LEARNING_SESSION -> 'learning'. One row of configuration.
      await sys('seed learning reward rule', () =>
        prisma.rewardRule.create({
          data: {
            familyId: A.familyId,
            triggerEngine: 'learning',
            triggerCondition: {},
            rewardType: 'COINS',
            rewardAmountOrBadgeId: '5',
            isActive: true,
          },
        }),
      );
    });

    it('EDUCATION_PROGRESS grants once and notifies once, through the identical chain', async () => {
      await resetChildState(A);
      jest.setSystemTime(at('12:00'));
      const device = await newDevice(A);

      const res = await postBatch(device.token, [
        {
          clientEventId: 'edu:seq:1',
          type: 'EDUCATION_PROGRESS',
          occurredAt: at('12:00').toISOString(),
          localDate: FAKE_DAY,
          payload: { goalId: A.habitId, milestone: 1 },
        },
      ]);
      expect(res.body.data.accepted).toBe(1);

      await drainOutbox();

      expect(await ledgerCount(A)).toBe(1);
      expect(await eventsOfType(A, 'REWARD_GRANTED')).toBe(1);
      expect(await notificationCount(A)).toBe(1);

      const account = await sys('read account', () =>
        prisma.rewardsAccount.findFirst({ where: { childId: A.childId } }),
      );
      // COINS from the learning rule, not the habit rule's XP — the completion
      // was routed by `completionKind`, not by which endpoint it arrived on.
      expect(account.coins).toBe(5);
      expect(account.xp).toBe(0);
    });

    it('replaying the education event grants nothing and notifies nobody', async () => {
      jest.setSystemTime(at('12:15'));
      const device = await newDevice(A);
      const res = await postBatch(device.token, [
        {
          clientEventId: 'edu:seq:1-replay',
          type: 'EDUCATION_PROGRESS',
          occurredAt: at('12:15').toISOString(),
          localDate: FAKE_DAY,
          payload: { goalId: A.habitId, milestone: 1 },
        },
      ]);

      expect(res.body.data.duplicates).toBe(1);
      await drainOutbox();
      expect(await ledgerCount(A)).toBe(1);
      expect(await notificationCount(A)).toBe(1);
    });

    it('a DERIVED event: three consecutive habit days emit STREAK_ACHIEVED, which is itself a completion', async () => {
      await resetChildState(A);
      jest.setSystemTime(at('12:00'));
      const device = await newDevice(A);

      // Days D-2, D-1, D. The streak consumer does not count events — it
      // recomputes from the habit_completions rows, which is what makes it
      // idempotent under redelivery.
      for (const offset of [2, 1, 0]) {
        const day = new Date(NOON.getTime() - offset * DAY_MS).toISOString().slice(0, 10);
        await postBatch(device.token, [
          habitEvent(A, {
            clientEventId: `streak:seq:${offset}`,
            localDate: day,
            occurredAt: new Date(NOON.getTime() - offset * DAY_MS),
          }),
        ]);
        await drainOutbox();
      }

      expect(await count('habitCompletion', { familyId: A.familyId })).toBe(3);
      // Emitted by StreakDetectionConsumer, never by the device — the wire
      // contract refuses `STREAK_ACHIEVED` outright.
      expect(await eventsOfType(A, 'STREAK_ACHIEVED')).toBe(1);

      const streak = await sys('read streak event', () =>
        prisma.domainEvent.findFirst({
          where: { familyId: A.familyId, eventType: 'STREAK_ACHIEVED' },
        }),
      );
      expect(streak.payload.completionKind).toBe('STREAK');
      expect(streak.payload.metadata.streakDays).toBe(3);
      expect(streak.deviceId).toBe(device.deviceId);
    });

    it('the streak milestone is emitted ONCE however many times its cause is redelivered', async () => {
      await sys('force full redelivery', async () => {
        await prisma.consumedMessage.deleteMany({ where: { familyId: A.familyId } });
        await prisma.$executeRawUnsafe(
          `UPDATE "outbox_messages" SET "status" = 'PENDING', "published_at" = NULL,
                  "next_attempt_at" = now() WHERE "family_id" = $1::uuid`,
          A.familyId,
        );
      });

      await drainOutbox();

      expect(await eventsOfType(A, 'STREAK_ACHIEVED')).toBe(1);
    });
  });

  // =========================================================================
  // 3. OUTBOX SEMANTICS
  // =========================================================================

  describe('outbox at-least-once redelivery with idempotent consumers', () => {
    it('a redelivered message produces NO duplicate side effect, even with the marker gone', async () => {
      await resetChildState(A);
      const device = await newDevice(A);
      await postBatch(device.token, [habitEvent(A, { clientEventId: 'redeliver:seq:1' })]);
      await drainOutbox();

      const rewardsBefore = await ledgerCount(A);
      const notificationsBefore = await notificationCount(A);
      expect(rewardsBefore).toBe(1);
      expect(notificationsBefore).toBe(1);

      // Simulate the exact at-least-once failure mode: the relay published and
      // the consumers committed their work, then the process died before
      // `MARK_PUBLISHED`. The stale-lock sweep re-queues it.
      //
      // The ConsumedMessage markers are deleted TOO. That is the point: the
      // markers are an optimisation, and this test refuses to let them be the
      // thing that makes the assertion pass. What actually stops the double
      // grant is `rewards_ledger_entries (child_id, idempotency_key)` and
      // `domain_events (family_id, idempotency_key)`.
      await sys('force redelivery', async () => {
        await prisma.consumedMessage.deleteMany({ where: { familyId: A.familyId } });
        await prisma.$executeRawUnsafe(
          `UPDATE "outbox_messages"
              SET "status" = 'PENDING', "published_at" = NULL, "next_attempt_at" = now()
            WHERE "family_id" = $1::uuid`,
          A.familyId,
        );
      });

      const redelivered = await drainOutbox();
      expect(redelivered.published).toBeGreaterThanOrEqual(2);

      expect(await ledgerCount(A)).toBe(rewardsBefore);
      expect(await notificationCount(A)).toBe(notificationsBefore);
      expect(await eventsOfType(A, 'REWARD_GRANTED')).toBe(1);
    });

    it('the consumer idempotency marker is written per (consumer, event)', async () => {
      const markers = await sys('read markers', () =>
        prisma.consumedMessage.findMany({ where: { familyId: A.familyId } }),
      );
      const names = new Set(markers.map((m: any) => m.consumerName));
      expect(names.has('RewardsCompletionConsumer')).toBe(true);
      expect(names.has('NotificationRewardConsumer')).toBe(true);
      // Same event to two consumers = two markers, never one shared row.
      const keys = markers.map((m: any) => `${m.consumerName}:${m.domainEventId}`);
      expect(new Set(keys).size).toBe(keys.length);
    });

    it('the claim is safe under concurrent workers — SKIP LOCKED hands each row to one of them', async () => {
      await resetChildState(A);
      const device = await newDevice(A);
      // CHANGED IN B1 (PA-B-003). This used to manufacture five distinct keys by
      // sending five different `localDate` values from the client while the
      // events were 60 SECONDS apart — which is the exploit itself, written as
      // a fixture. The server now derives the day from `occurredAt`, so five
      // events one minute apart are ONE day and therefore one key.
      //
      // Five distinct keys now come from five distinct HABITS, which is a thing
      // a device cannot fabricate: each habit id is checked for existence and
      // ownership before its completion row is written.
      const habitIds: string[] = [];
      for (let i = 0; i < 5; i++) {
        const created = await request(http)
          .post(`/life-intelligence/habits/${A.childId}`)
          .set({ Authorization: `Bearer ${A.parentToken}` })
          .send({ title: `F3 Concurrent Habit ${i}`, category: 'LEARNING' });
        habitIds.push(created.body.id);
      }

      await postBatch(
        device.token,
        habitIds.map((habitId, i) =>
          habitEvent(A, {
            clientEventId: `concurrent:seq:${i}`,
            occurredAt: new Date(NOON.getTime() - i * 60_000),
            payload: { habitId },
          }),
        ),
      );
      expect(await count('outboxMessage', { familyId: A.familyId, status: 'PENDING' })).toBe(5);

      // Two relays, same table, at the same time. Each row must be claimed by
      // exactly one of them: no row delivered twice, no row skipped.
      const second = new OutboxRelay(prisma, app.get(require('../../src/modules/events/domain/event-bus.port').EVENT_PUBLISHER));
      const [one, two] = await Promise.all([relay.tick(1), second.tick(4)]);

      expect(one.claimed + two.claimed).toBe(5);
      await drainOutbox();
      // Five completions, five grants — not ten, and not three.
      expect(await ledgerCount(A)).toBe(5);
    });

    it('an outbox message dead-letters after its attempts instead of looping forever', async () => {
      await resetChildState(B);
      const device = await newDevice(B);
      await postBatch(device.token, [
        {
          clientEventId: 'dead:seq:1',
          type: 'HABIT_COMPLETED',
          occurredAt: new Date().toISOString(),
          localDate: FAKE_DAY,
          payload: { habitId: B.habitId },
        },
      ]);

      const engine = app.get(
        require('../../src/modules/life-intelligence/application/services/rewards-engine.service')
          .RewardsEngineService,
      );
      const spy = jest
        .spyOn(engine, 'processTriggerEvent')
        .mockRejectedValue(new Error('permanently broken'));

      try {
        // 8 attempts is OUTBOX_RELAY_DEFAULTS.maxAttempts. Each pass burns one;
        // the backoff is cleared between passes so the test does not sleep.
        for (let i = 0; i < 8; i++) {
          await sys('clear backoff', () =>
            prisma.$executeRawUnsafe(
              `UPDATE "outbox_messages" SET "next_attempt_at" = now() - INTERVAL '1 second'
                 WHERE "family_id" = $1::uuid AND "status" IN ('PENDING','FAILED')`,
              B.familyId,
            ),
          );
          await relay.tick();
        }
      } finally {
        spy.mockRestore();
      }

      const msg = await sys('read dead message', () =>
        prisma.outboxMessage.findFirst({
          where: { familyId: B.familyId, eventType: 'HABIT_COMPLETED' },
        }),
      );
      expect(msg.status).toBe('DEAD');
      expect(msg.attemptCount).toBeGreaterThanOrEqual(8);
      // A dead message is not retried again, and it still never produced a
      // notification.
      expect(await notificationCount(B)).toBe(0);
      const after = await relay.tick();
      expect(after.claimed).toBe(0);
    });

    it('a lock held by a dead worker is reclaimed, not stranded in PUBLISHING forever', async () => {
      await resetChildState(A);
      const device = await newDevice(A);
      await postBatch(device.token, [habitEvent(A, { clientEventId: 'stale:seq:1' })]);

      // A worker claimed it and vanished 10 minutes ago (the sweep threshold is
      // 120s). Without the reclaim, this event is silently never delivered.
      await sys('strand the message', () =>
        prisma.$executeRawUnsafe(
          `UPDATE "outbox_messages"
              SET "status" = 'PUBLISHING', "locked_by" = 'dead-worker',
                  "locked_at" = now() - INTERVAL '10 minutes'
            WHERE "family_id" = $1::uuid`,
          A.familyId,
        ),
      );

      await drainOutbox();

      expect(await ledgerCount(A)).toBe(1);
      expect(await notificationCount(A)).toBe(1);
    });

    it('reports its own backlog, which is what an alert would page on', async () => {
      const backlog = await relay.backlog();
      expect(typeof backlog.ageSeconds).toBe('number');
      expect(typeof backlog.pendingCount).toBe('number');
    });
  });

  // =========================================================================
  // 4. THE NOTIFICATION DECISION ENGINE ACTUALLY SUPPRESSES
  // =========================================================================

  describe('notification fatigue rules genuinely suppress', () => {
    /** Grants a reward for a fresh day and returns the notification delta. */
    /**
     * CHANGED IN B1 (PA-B-003). `dayOffset` used to move only the client's
     * `localDate` while `occurredAt` moved by SECONDS — a different day
     * asserted by the device, on the same real instant. That is exactly the
     * replay the sprint closes, so it no longer produces a second key.
     *
     * `occurredAt` now moves by whole days, which is what "a different day"
     * means to a server that derives the date. It stays inside the 48h past
     * bound `validate()` enforces, so `dayOffset` is usable for 0 and 1 — which
     * is all these fatigue cases need.
     */
    async function grantOnDay(t: Tenant, dayOffset: number): Promise<number> {
      const before = await notificationCount(t);
      const device = await newDevice(t);
      await postBatch(device.token, [
        habitEvent(t, {
          clientEventId: `fatigue:${dayOffset}:${Date.now()}`,
          occurredAt: new Date(NOON.getTime() - dayOffset * DAY_MS),
        }),
      ]);
      await drainOutbox();
      return (await notificationCount(t)) - before;
    }

    it('QUIET HOURS: a reward granted at 22:00 defers — the reward is still granted', async () => {
      await resetChildState(A);
      jest.setSystemTime(at('22:00'));

      const delta = await grantOnDay(A, 0);

      expect(delta).toBe(0); // no notification
      expect(await ledgerCount(A)).toBe(1); // but the reward happened
      expect(await eventsOfType(A, 'REWARD_GRANTED')).toBe(1);
      // A deferral is a HANDLED outcome, not a delivery failure — treating it
      // as one would retry it eight times and dead-letter a correct decision.
      expect(await count('outboxMessage', { familyId: A.familyId, status: 'DEAD' })).toBe(0);
      expect(
        await count('outboxMessage', {
          familyId: A.familyId,
          eventType: 'REWARD_GRANTED',
          status: 'PUBLISHED',
        }),
      ).toBe(1);
    });

    it('DUPLICATE: a second reward within the 5-minute window is suppressed', async () => {
      await resetChildState(A);
      jest.setSystemTime(NOON);

      expect(await grantOnDay(A, 0)).toBe(1);
      // A different day => a different idempotency key => a genuinely second
      // reward. Same wall-clock minute => the same TYPE within 5 minutes.
      expect(await grantOnDay(A, 1)).toBe(0);

      expect(await ledgerCount(A)).toBe(2); // two real rewards
      expect(await notificationCount(A)).toBe(1); // one notification
    });

    it('DAILY MAX: the 7th notification of the day is suppressed (policy dailyMax = 6)', async () => {
      await resetChildState(A);
      jest.setSystemTime(at('12:00'));

      // Six notifications already sent today, of six DIFFERENT types so that
      // neither the duplicate window nor the per-category max fires first —
      // this test must fail on DAILY_MAX and nothing else.
      await sys('seed a full day of notifications', () =>
        prisma.notification.createMany({
          data: [1, 2, 3, 4, 5, 6].map((i) => ({
            familyId: A.familyId,
            userId: A.userId,
            childId: A.childId,
            type: `SEED_TYPE_${i}`,
            title: 't',
            body: 'b',
            priority: 'NORMAL',
            createdAt: at('08:00'),
          })),
        }),
      );

      expect(await grantOnDay(A, 0)).toBe(0);
      expect(await ledgerCount(A)).toBe(1); // the reward still happened
    });

    it('CATEGORY MAX: the 3rd REWARD_GRANTED of the day is suppressed (categoryDailyMax = 2)', async () => {
      await resetChildState(A);
      jest.setSystemTime(at('12:00'));

      // Two REWARD_GRANTED already today, both older than the 5-minute
      // duplicate window, and only two notifications total so dailyMax (6) is
      // nowhere near — the only rule that can fire is CATEGORY_MAX.
      await sys('seed two of the same category', () =>
        prisma.notification.createMany({
          data: [at('08:00'), at('09:00')].map((createdAt) => ({
            familyId: A.familyId,
            userId: A.userId,
            childId: A.childId,
            type: 'REWARD_GRANTED',
            title: 't',
            body: 'b',
            priority: 'NORMAL',
            createdAt,
          })),
        }),
      );

      const before = await notificationCount(A);
      const device = await newDevice(A);
      await postBatch(device.token, [
        habitEvent(A, { clientEventId: `catmax:${Date.now()}` }),
      ]);
      await drainOutbox();

      expect(await notificationCount(A)).toBe(before);
      expect(await ledgerCount(A)).toBe(1);
    });

    /**
     * COOLDOWN, honestly scoped. `DEFAULT_FATIGUE_POLICY.cooldownMinutesByType`
     * has no entry for `REWARD_GRANTED`, so the named COOLDOWN rule CANNOT fire
     * on the reward path — claiming otherwise from a reward test would be
     * false. It is exercised here against the same decision engine, under the
     * same tenant context, with a type the policy does give a cooldown.
     */
    it('COOLDOWN: a HYDRATION_REMINDER inside its 120-minute cooldown is suppressed', async () => {
      await resetChildState(A);
      jest.setSystemTime(at('12:00'));

      await sys('seed a recent hydration reminder', () =>
        prisma.notification.create({
          data: {
            familyId: A.familyId,
            userId: A.userId,
            childId: A.childId,
            type: 'HYDRATION_REMINDER',
            title: 't',
            body: 'b',
            priority: 'NORMAL',
            // 30 minutes ago: past the 5-minute duplicate window, well inside
            // the 120-minute cooldown. So the rule that fires is COOLDOWN.
            createdAt: at('11:30'),
          },
        }),
      );

      const outcome = await runWithTenant(
        { familyId: A.familyId, actorType: 'SYSTEM', actorId: 'f3-test' },
        () =>
          notifications.notifyEvent(A.childId, A.familyId, {
            type: 'HYDRATION_REMINDER',
            priority: 'NORMAL',
            title: 'اشرب الماء',
            body: 'حان وقت شرب الماء.',
            targetAudience: 'PARENT',
          }),
      );

      expect(outcome.decision).toBe('SUPPRESS');
      expect(outcome.reason).toBe('COOLDOWN');
      expect(await notificationCount(A, 'HYDRATION_REMINDER')).toBe(1);
    });
  });

  // =========================================================================
  // 5. CLOCK SKEW, VALIDATION AND THE BATCH CONTRACT
  // =========================================================================

  describe('clock skew and per-item validation', () => {
    let device: { deviceId: string; token: string };

    beforeAll(async () => {
      await resetChildState(B);
      device = await newDevice(B);
    });

    it('rejects an event older than 48 hours — the PAST bound', async () => {
      const res = await postBatch(device.token, [
        {
          clientEventId: 'skew:old',
          type: 'HABIT_COMPLETED',
          occurredAt: new Date(Date.now() - 49 * 60 * 60 * 1000).toISOString(),
          payload: { habitId: B.habitId },
        },
      ]);

      expect(res.status).toBe(200);
      expect(res.body.data.rejected).toBe(1);
      expect(res.body.data.results[0]).toMatchObject({
        clientEventId: 'skew:old',
        status: 'REJECTED',
        errorCode: 'EVENT_CLOCK_SKEW',
      });
      expect(res.body.data.results[0].messageAr).toBeTruthy();
    });

    it('accepts an event 47 hours old — the bound is 48h, not "recent"', async () => {
      const res = await postBatch(device.token, [
        {
          clientEventId: 'skew:47h',
          type: 'HABIT_COMPLETED',
          occurredAt: new Date(Date.now() - 47 * 60 * 60 * 1000).toISOString(),
          localDate: new Date(Date.now() - 47 * 60 * 60 * 1000).toISOString().slice(0, 10),
          payload: { habitId: B.habitId },
        },
      ]);
      expect(res.body.data.results[0].status).toBe('ACCEPTED');
    });

    it('rejects an event more than 5 minutes in the future — the FUTURE bound', async () => {
      const res = await postBatch(device.token, [
        {
          clientEventId: 'skew:future',
          type: 'HABIT_COMPLETED',
          occurredAt: new Date(Date.now() + 6 * 60 * 1000).toISOString(),
          payload: { habitId: B.habitId },
        },
      ]);
      expect(res.body.data.results[0]).toMatchObject({
        status: 'REJECTED',
        errorCode: 'EVENT_CLOCK_SKEW',
      });
    });

    it('accepts an event 4 minutes in the future — ordinary device drift is tolerated', async () => {
      const res = await postBatch(device.token, [
        {
          clientEventId: 'skew:4min-future',
          type: 'HABIT_COMPLETED',
          occurredAt: new Date(Date.now() + 4 * 60 * 1000).toISOString(),
          localDate: FAKE_DAY,
          payload: { habitId: B.habitId },
        },
      ]);
      // Same localDate as an earlier accepted event would collide on the
      // idempotency key, so DUPLICATE is also a pass here — what must NOT
      // happen is a REJECTED.
      expect(['ACCEPTED', 'DUPLICATE']).toContain(res.body.data.results[0].status);
    });

    it('rejects the WHOLE batch when the device clock itself is more than 10 minutes out', async () => {
      const res = await request(http)
        .post('/events/batch')
        .set({ Authorization: `Bearer ${device.token}` })
        .send({
          deviceTime: new Date(Date.now() + 20 * 60 * 1000).toISOString(),
          events: [habitEvent(B, { clientEventId: 'batchskew:1' })],
        });

      expect(res.status).toBe(400);
      expect(res.body.code ?? res.body.message?.code).toBe('DEVICE_CLOCK_SKEW');
    });

    it('rejects one bad event without taking down its valid siblings', async () => {
      await resetChildState(B);
      const res = await postBatch(device.token, [
        {
          clientEventId: 'mixed:unknown',
          type: 'NOT_A_REAL_EVENT',
          occurredAt: new Date().toISOString(),
          payload: {},
        },
        {
          clientEventId: 'mixed:derived',
          type: 'REWARD_GRANTED',
          occurredAt: new Date().toISOString(),
          payload: {},
        },
        {
          clientEventId: 'mixed:badpayload',
          type: 'HABIT_COMPLETED',
          occurredAt: new Date().toISOString(),
          payload: { habitId: 'not-a-uuid' },
        },
        {
          clientEventId: 'mixed:good',
          type: 'HABIT_COMPLETED',
          occurredAt: new Date().toISOString(),
          // CHANGED IN B1: this used to carry `localDate: '2026-01-05'`, an
          // arbitrary client date that guaranteed a fresh key. The date is now
          // derived, so today's completion of B's habit is the SAME key as the
          // one an earlier case in this describe already accepted — hence the
          // reset, which is honest about why a fresh key exists.
          payload: { habitId: B.habitId },
        },
      ]);

      expect(res.status).toBe(200);
      const byId = Object.fromEntries(
        res.body.data.results.map((r: any) => [r.clientEventId, r]),
      );
      expect(byId['mixed:unknown'].errorCode).toBe('EVENT_UNKNOWN_TYPE');
      expect(byId['mixed:derived'].errorCode).toBe('EVENT_TYPE_NOT_DEVICE_INGESTIBLE');
      expect(byId['mixed:badpayload'].errorCode).toBe('EVENT_PAYLOAD_INVALID');
      expect(byId['mixed:good'].status).toBe('ACCEPTED');
      expect(res.body.data.accepted).toBe(1);
      expect(res.body.data.rejected).toBe(3);
    });

    it('a habit belonging to nobody is EVENT_SOURCE_NOT_FOUND, not a silent write', async () => {
      const res = await postBatch(device.token, [
        {
          clientEventId: 'orphan:1',
          type: 'HABIT_COMPLETED',
          occurredAt: new Date().toISOString(),
          localDate: FAKE_DAY,
          payload: { habitId: '99999999-9999-4999-8999-999999999999' },
        },
      ]);
      expect(res.body.data.results[0].errorCode).toBe('EVENT_SOURCE_NOT_FOUND');
    });

    it('a batch above the maximum size is rejected as a whole with 413', async () => {
      const events = Array.from({ length: MAX_EVENTS_PER_BATCH + 1 }, (_, i) =>
        habitEvent(B, { clientEventId: `big:${i}` }),
      );
      const res = await postBatch(device.token, events);
      expect(res.status).toBe(413);
      expect(res.body.code ?? res.body.message?.code).toBe('EVENT_BATCH_TOO_LARGE');
    });

    it('replays the whole batch from the Idempotency-Key cache without re-processing', async () => {
      // CHANGED IN B1: the fixture used to guarantee a fresh idempotency key
      // with `localDate: '2026-02-02'`. Client dates no longer create keys, so
      // the freshness now comes from resetting the tenant's event state — which
      // is what the test always actually needed.
      await resetChildState(B);
      const key = `f3-batch-${Date.now()}`;
      const events = [habitEvent(B, { clientEventId: 'batchreplay:1' })];

      const first = await postBatch(device.token, events, key);
      expect(first.body.data.accepted).toBe(1);

      const second = await postBatch(device.token, events, key);
      // Byte-identical answer, including the first response's serverTime — the
      // proof it was served from the replay cache rather than re-run.
      expect(second.body.data).toEqual(first.body.data);
    });
  });

  // =========================================================================
  // 6. AUTHENTICATION, TENANCY AND RATE LIMITING
  // =========================================================================

  describe('the endpoint is device-authenticated and tenant-derived', () => {
    it('rejects an unauthenticated batch', async () => {
      const res = await request(http)
        .post('/events/batch')
        .send({ deviceTime: new Date().toISOString(), events: [habitEvent(A, { clientEventId: 'x' })] });
      expect(res.status).toBe(401);
    });

    it('rejects a PARENT token — a device endpoint is not reachable with a parent session', async () => {
      const res = await request(http)
        .post('/events/batch')
        .set({ Authorization: `Bearer ${A.parentToken}` })
        .send({ deviceTime: new Date().toISOString(), events: [habitEvent(A, { clientEventId: 'x' })] });
      expect(res.status).toBe(401);
    });

    it('rejects a REVOKED device even though its token is perfectly valid', async () => {
      const device = await newDevice(A);
      await sys('revoke device', () =>
        prisma.device.update({ where: { id: device.deviceId }, data: { status: 'REVOKED' } }),
      );
      const res = await postBatch(device.token, [habitEvent(A, { clientEventId: 'revoked:1' })]);
      expect(res.status).toBe(403);
    });

    /**
     * TENANT ISOLATION ACROSS THE WHOLE PIPELINE. Family A's device sends an
     * event whose payload names family B's child, family B's family id and
     * family B's habit. Every one of those fields must be ignored.
     */
    it("family A's device cannot produce an event attributed to family B", async () => {
      await resetChildState(A);
      await resetChildState(B);
      const device = await newDevice(A);

      const res = await postBatch(device.token, [
        {
          clientEventId: 'tenant:1',
          type: 'HABIT_COMPLETED',
          occurredAt: new Date().toISOString(),
          localDate: FAKE_DAY,
          payload: {
            habitId: A.habitId,
            // Every one of these is a deliberate lie by the client.
            childId: B.childId,
            familyId: B.familyId,
            deviceId: '00000000-0000-4000-8000-000000000000',
            idempotencyKey: 'attacker-chosen-key',
          },
        },
      ]);
      expect(res.body.data.accepted).toBe(1);
      await drainOutbox();

      // Nothing at all landed in family B.
      expect(await count('domainEvent', { familyId: B.familyId })).toBe(0);
      expect(await ledgerCount(B)).toBe(0);
      expect(await notificationCount(B)).toBe(0);

      // Everything landed in family A, attributed to family A's own child.
      const event = await sys('read the event', () =>
        prisma.domainEvent.findFirst({ where: { familyId: A.familyId, eventType: 'HABIT_COMPLETED' } }),
      );
      expect(event.familyId).toBe(A.familyId);
      expect(event.childId).toBe(A.childId);
      expect(event.deviceId).toBe(device.deviceId);
      // The stored payload was overwritten with server-owned values, not merged.
      expect(event.payload.childId).toBe(A.childId);
      expect(event.payload.idempotencyKey).toBe(event.idempotencyKey);
      expect(event.idempotencyKey).not.toBe('attacker-chosen-key');
      expect(await ledgerCount(A)).toBe(1);
      expect(await notificationCount(A)).toBe(1);
    });

    it("family A's device cannot complete family B's habit — it is not even found", async () => {
      const device = await newDevice(A);
      const res = await postBatch(device.token, [
        {
          clientEventId: 'tenant:2',
          type: 'HABIT_COMPLETED',
          occurredAt: new Date().toISOString(),
          localDate: '2026-03-03',
          payload: { habitId: B.habitId },
        },
      ]);
      expect(res.body.data.results[0].errorCode).toBe('EVENT_SOURCE_NOT_FOUND');
      expect(await count('habitCompletion', { familyId: B.familyId, habitId: B.habitId })).toBe(0);
    });

    it('every row the pipeline writes carries a family_id — none is orphaned', async () => {
      const orphans = await sys('scan for orphans', () =>
        prisma.$queryRawUnsafe(
          `SELECT (SELECT count(*) FROM "domain_events"    WHERE "family_id" IS NULL)::int AS de,
                  (SELECT count(*) FROM "outbox_messages"  WHERE "family_id" IS NULL)::int AS om,
                  (SELECT count(*) FROM "consumed_messages" WHERE "family_id" IS NULL)::int AS cm`,
        ),
      );
      expect(orphans[0]).toEqual({ de: 0, om: 0, cm: 0 });
    });

    it('enforces the per-DEVICE rate limit, not a per-IP one', async () => {
      const device = await newDevice(A);
      let limited = 0;
      for (let i = 0; i < EVENTS_RATE_LIMIT.limit + 2; i++) {
        const res = await postBatch(device.token, [
          habitEvent(A, { clientEventId: `rate:${i}`, localDate: `2025-1${(i % 2) + 1}-0${(i % 9) + 1}` }),
        ]);
        if (res.status === 429) limited++;
      }
      expect(limited).toBeGreaterThanOrEqual(1);

      // A DIFFERENT device on the SAME IP is unaffected — the CGNAT case
      // docs/06 §9.2 calls out for the Egyptian market.
      const other = await newDevice(A);
      const res = await postBatch(other.token, [
        habitEvent(A, { clientEventId: 'rate:other', localDate: '2025-09-09' }),
      ]);
      expect(res.status).toBe(200);
    });

    afterAll(async () => {
      // The throttler counters live in the real Redis; leaving them behind
      // would make a re-run of this file fail for the wrong reason.
      const raw = redis.getRawClient();
      const keys = await raw.keys('throttle*');
      if (keys.length > 0) await raw.del(...keys);
    });
  });
});
