/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-var-requires */
/**
 * PHASE C / P0 — `PA-B-009`: THE PERMANENT LOSS OF `REWARD_GRANTED`, REPRODUCED
 * AND THEN CLOSED, PLUS THE RECOVERY PATH A DEAD-LETTERED GRANT NEVER HAD.
 *
 * Phase B recorded `PA-B-009` as «inference, not evidence» — a crash between
 * the grant and `outbox.write` was reasoned about, never injected. This suite
 * injects it, and what it measured is WORSE than what was inferred:
 *
 *   1. `RewardsCompletionConsumer.handle` grants (committed, its own
 *      transaction), then writes `REWARD_GRANTED` (a SECOND transaction).
 *   2. A failure between the two leaves the grant committed and the event
 *      unwritten. The relay marks the message FAILED and retries — correctly.
 *   3. ON THE RETRY, `processTriggerEvent` returns **0**, because the ledger
 *      rows already exist and the insert is `ON CONFLICT DO NOTHING`. The old
 *      `if (granted === 0) return;` then treated that as "nothing happened".
 *   4. The message is marked **PUBLISHED**. The reward is in the ledger, the
 *      event does not exist, the parent is never told, and the outbox reports
 *      SUCCESS.
 *
 * So the retry did not merely fail to help: it CONVERTED a recoverable failure
 * into a permanent, silent loss and then declared victory. That is the finding,
 * and `the loss` test below is the proof.
 *
 * THE INVARIANT EVERY TEST HERE ASSERTS:
 *   ONE BUSINESS EVENT -> ONE REWARD -> ONE TIMELINE ENTRY -> ONE NOTIFICATION.
 *
 * Everything runs against a REAL PostgreSQL and a REAL Redis through the REAL
 * application. The clock discipline is identical to `event-pipeline.e2e.spec.ts`
 * and for the same reasons — see that file's header; the fake day is one day
 * BEHIND the real clock so Prisma's client-generated defaults and the relay's
 * server-side `now()` agree.
 */
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request = require('supertest');

import { AppModule } from '../../src/app.module';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { createTenantExtension } from '../../src/common/tenancy/tenant.extension';
import { runAsSystemAsync } from '../../src/common/tenancy/system-context';
import { runWithTenant } from '../../src/common/tenancy/tenant-context';
import { TokenService } from '../../src/modules/auth/application/services/token.service';
import { OutboxRelay } from '../../src/modules/events/application/outbox.relay';
import { OutboxWriter } from '../../src/modules/events/application/outbox.writer';
import { integrationDatabaseUrl } from '../tenancy/prisma-test-client';

const describeIfDb = integrationDatabaseUrl() ? describe : describe.skip;

const DAY_MS = 24 * 60 * 60 * 1000;
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

describeIfDb('PHASE C — REWARD_GRANTED delivery, failure and recovery (real PostgreSQL + Redis)', () => {
  let app: INestApplication;
  let http: any;
  let prisma: any;
  let relay: OutboxRelay;
  let tokens: TokenService;
  let outbox: OutboxWriter;

  const stamp = Date.now();
  const A = {} as Tenant;
  const createdFamilies: string[] = [];
  const createdUsers: string[] = [];
  const createdDevices: string[] = [];

  const sys = (what: string, fn: () => Promise<any>): Promise<any> =>
    runAsSystemAsync('TEST_FIXTURE', `Phase C delivery suite: ${what}`, async () => await fn());

  async function registerTenant(label: string, target: Tenant): Promise<void> {
    const email = `pc.${label}.${stamp}@example.com`;
    const password = 'PhaseC-Delivery-Passw0rd!23';

    const reg = await request(http).post('/auth/register').send({
      email,
      password,
      fullName: `PC Parent ${label}`,
      familyName: `PC Family ${label}`,
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
      .send({ firstName: `PC Kid ${label}`, dateOfBirth: '2015-04-01' });
    if (![200, 201].includes(child.status)) {
      throw new Error(`child(${label}) -> ${child.status} ${JSON.stringify(child.body)}`);
    }
    target.childId = child.body.id;

    const habit = await request(http)
      .post(`/life-intelligence/habits/${target.childId}`)
      .set({ Authorization: `Bearer ${target.parentToken}` })
      .send({ title: `PC Habit ${label}`, category: 'LEARNING' });
    if (![200, 201].includes(habit.status)) {
      throw new Error(`habit(${label}) -> ${habit.status} ${JSON.stringify(habit.body)}`);
    }
    target.habitId = habit.body.id;

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
      () => tokens.issueTokenPair({ subjectId: device.id, actorType: 'DEVICE', familyId: t.familyId }),
    );
    return { deviceId: device.id, token: pair.accessToken };
  }

  const habitEvent = (t: Tenant, clientEventId: string) => ({
    clientEventId,
    type: 'HABIT_COMPLETED',
    occurredAt: new Date().toISOString(),
    localDate: FAKE_DAY,
    payload: { habitId: t.habitId },
  });

  const postBatch = (token: string, events: any[]) =>
    request(http)
      .post('/events/batch')
      .set({ Authorization: `Bearer ${token}` })
      .send({ deviceTime: new Date().toISOString(), events });

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

  const clearBackoff = (t: Tenant): Promise<any> =>
    sys('clear backoff', () =>
      prisma.$executeRawUnsafe(
        `UPDATE "outbox_messages" SET "next_attempt_at" = now() - INTERVAL '1 second'
           WHERE "family_id" = $1::uuid AND "status" IN ('PENDING','FAILED')`,
        t.familyId,
      ),
    );

  const count = (model: string, where: any): Promise<number> =>
    sys(`count ${model}`, () => prisma[model].count({ where }));

  /**
   * THE INJECTION POINT PA-B-009 NAMES: `processTriggerEvent` succeeds and
   * COMMITS, and only the announcement that follows it fails. Every other
   * outbox write — including the `HABIT_COMPLETED` write the ingestion
   * endpoint performs — goes through untouched, which is what keeps the
   * fixture honest: this is a failure of ONE step, not of the pipeline.
   */
  function failRewardGrantedWrite(message: string): jest.SpyInstance {
    const real = outbox.write.bind(outbox);
    return jest.spyOn(outbox, 'write').mockImplementation(async (draft) => {
      if (draft.type === 'REWARD_GRANTED') throw new Error(message);
      return real(draft);
    });
  }

  /**
   * THE FIVE NUMBERS THE INVARIANT IS.
   *
   * PHASE E (P0.5) — it was four. `child_messages` was missing, and it is the
   * OTHER table a notification can land in: `SmartNotificationIntegrationService`
   * routes a PARENT-audience candidate to `notifications` and a CHILD-audience
   * one to `FamilyCommunicationService.draftAiMessage`, which writes there.
   * «One event, one notification» was therefore being proven on one of the two
   * tables it has to hold on, and a duplicate on the child half of the surface —
   * protected by its own constraint, `child_messages (family_id,
   * source_event_id)` — would have been invisible to every assertion in this
   * file across a replay, a worker crash and a dead-letter recovery.
   *
   * PHASE F (`F6-006`) — AND `childMessages` STOPPED BEING ZERO. Until this
   * phase the fifth number was structurally 0 on every path: `child_messages`
   * was the table nothing on the reward loop could write to, because no
   * CHILD-audience producer existed (`PF-E-006`). The column was here to catch a
   * duplicate that could not happen yet, and it now measures the invariant it
   * was written for — ONE completion, ONE message to the child, surviving a
   * replay, a worker crash and a dead-letter recovery exactly as the parent's
   * notification does, refused by `child_messages (family_id, source_event_id)`.
   */
  const chain = async (t: Tenant): Promise<{
    rewards: number;
    events: number;
    timeline: number;
    notifications: number;
    childMessages: number;
  }> => ({
    rewards: await count('rewardsLedgerEntry', { familyId: t.familyId, childId: t.childId, type: 'EARN' }),
    events: await count('domainEvent', { familyId: t.familyId, eventType: 'REWARD_GRANTED' }),
    timeline: await count('lifeTimelineEvent', {
      familyId: t.familyId,
      childId: t.childId,
      eventType: 'reward_granted',
    }),
    notifications: await count('notification', {
      familyId: t.familyId,
      childId: t.childId,
      type: 'REWARD_GRANTED',
    }),
    childMessages: await count('childMessage', { familyId: t.familyId, childId: t.childId }),
  });

  async function resetChildState(t: Tenant): Promise<void> {
    await sys('reset child state', async () => {
      await prisma.notification.deleteMany({ where: { familyId: t.familyId } });
      // PHASE E (P0.5) — the other table a notification can land in. See `chain`.
      await prisma.childMessage.deleteMany({ where: { familyId: t.familyId } });
      await prisma.lifeTimelineEvent.deleteMany({ where: { familyId: t.familyId } });
      await prisma.rewardsLedgerEntry.deleteMany({ where: { familyId: t.familyId } });
      await prisma.rewardsAccount.deleteMany({ where: { familyId: t.familyId } });
      await prisma.consumedMessage.deleteMany({ where: { familyId: t.familyId } });
      await prisma.outboxMessage.deleteMany({ where: { familyId: t.familyId } });
      await prisma.domainEvent.deleteMany({ where: { familyId: t.familyId } });
      await prisma.habitCompletion.deleteMany({ where: { familyId: t.familyId } });
    });
  }


  /**
   * The `/auth/register` throttle counter lives in the SHARED Redis and is
   * IP-keyed, so every suite in a `--runInBand` run draws on one budget. This
   * suite clears it on the way IN (so a previous run cannot 429 its fixtures)
   * and on the way OUT (so it returns what it consumed to the suites that run
   * after it). Only the second half is new, and it is the half that matters in
   * a repository where several suites now register families.
   */
  async function clearRegisterThrottle(): Promise<void> {
    const Redis = require('ioredis');
    const client = new Redis(process.env.REDIS_URL as string);
    const keys = await client.keys('throttle:*');
    if (keys.length > 0) await client.del(...keys);
    await client.quit();
  }

  beforeAll(async () => {
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

    await clearRegisterThrottle();

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue(offlinePrismaService())
      .compile();

    app = moduleRef.createNestApplication();
    const { ValidationPipe } = require('@nestjs/common');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();

    http = app.getHttpServer();
    prisma = app.get(PrismaService);
    relay = app.get(OutboxRelay);
    tokens = app.get(TokenService);
    outbox = app.get(OutboxWriter);

    await registerTenant('a', A);
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
    // Return the register-throttle budget this suite consumed.
    await clearRegisterThrottle();
  });

  beforeEach(() => {
    jest.setSystemTime(NOON);
  });

  // =========================================================================
  // 1. THE HAPPY PATH — the baseline every failure test is measured against
  // =========================================================================

  describe('grant success and notification success', () => {
    it('one completion produces exactly {1 reward, 1 event, 1 timeline entry, 1 notification}', async () => {
      await resetChildState(A);
      const device = await newDevice(A);
      await postBatch(device.token, [habitEvent(A, 'pc:happy:1')]);

      await drainOutbox();

      expect(await chain(A)).toEqual({ rewards: 1, events: 1, timeline: 1, notifications: 1, childMessages: 1 });
      expect(await count('outboxMessage', { familyId: A.familyId, status: 'PENDING' })).toBe(0);
      expect(await count('outboxMessage', { familyId: A.familyId, status: 'DEAD' })).toBe(0);
    });
  });

  // =========================================================================
  // 2. PA-B-009 — THE LOSS, INJECTED
  // =========================================================================

  describe('PA-B-009: a failure between the committed grant and the REWARD_GRANTED write', () => {
    it('the grant commits and the announcement does not — the honest intermediate state', async () => {
      await resetChildState(A);
      const device = await newDevice(A);
      await postBatch(device.token, [habitEvent(A, 'pc:loss:1')]);

      // THE INJECTION. Not the whole engine — `processTriggerEvent` must
      // SUCCEED and COMMIT, and only the announcement that follows it may
      // fail. That is the exact window PA-B-009 names, and failing the engine
      // instead (as the F3 suite does) never enters it.
      const spy = failRewardGrantedWrite('connection terminated before REWARD_GRANTED committed');

      try {
        const pass = await relay.tick();
        expect(pass.failed).toBe(1);
      } finally {
        spy.mockRestore();
      }

      const after = await chain(A);
      // The reward is REAL and COMMITTED. The timeline entry too — it is
      // written inside `processTriggerEvent`, before the window opens.
      expect(after.rewards).toBe(1);
      expect(after.timeline).toBe(1);
      // And the announcement does not exist. So far this is CORRECT behaviour:
      // the message is FAILED, not PUBLISHED, and a retry is owed.
      expect(after.events).toBe(0);
      expect(after.notifications).toBe(0);

      const msg = await sys('read failed message', () =>
        prisma.outboxMessage.findFirst({
          where: { familyId: A.familyId, eventType: 'HABIT_COMPLETED' },
        }),
      );
      expect(msg.status).toBe('FAILED');
      expect(msg.lastError).toContain('connection terminated');
    });

    it('THE PROOF: the retry recovers the announcement instead of burying it', async () => {
      // No injection this time — the transient failure is over, which is what
      // a retry exists for. Pre-fix, `processTriggerEvent` returned 0 (the
      // ledger row already exists) and `if (granted === 0) return;` swallowed
      // the whole announcement; the message was then marked PUBLISHED and the
      // parent was never told, forever.
      await clearBackoff(A);
      await drainOutbox();

      expect(await chain(A)).toEqual({ rewards: 1, events: 1, timeline: 1, notifications: 1, childMessages: 1 });

      const msg = await sys('read recovered message', () =>
        prisma.outboxMessage.findFirst({
          where: { familyId: A.familyId, eventType: 'HABIT_COMPLETED' },
        }),
      );
      expect(msg.status).toBe('PUBLISHED');
    });

    it('a THIRD delivery of the same message adds nothing — recovery is not a duplicator', async () => {
      await sys('force redelivery', () =>
        prisma.$executeRawUnsafe(
          `UPDATE "outbox_messages"
              SET "status" = 'PENDING', "published_at" = NULL, "next_attempt_at" = now() - INTERVAL '1 second'
            WHERE "family_id" = $1::uuid AND "event_type" = 'HABIT_COMPLETED'`,
          A.familyId,
        ),
      );
      await sys('drop consumer markers', () =>
        prisma.consumedMessage.deleteMany({ where: { familyId: A.familyId } }),
      );

      await drainOutbox();

      expect(await chain(A)).toEqual({ rewards: 1, events: 1, timeline: 1, notifications: 1, childMessages: 1 });
    });
  });

  // =========================================================================
  // 2b. PC-B-006 — THE TIMELINE ENTRY, WHICH HAD NO CONSTRAINT AND NO RETRY
  // =========================================================================

  describe('PC-B-006: a timeline write that fails must not vanish silently', () => {
    it('THE FAILURE IS NOW VISIBLE: the message FAILS instead of being silently PUBLISHED', async () => {
      await resetChildState(A);
      const device = await newDevice(A);
      await postBatch(device.token, [habitEvent(A, 'pc:timeline:1')]);

      // `announceGrant` wraps its own timeline write in a try/catch that
      // swallows the error, and PC-B-006 does NOT change that: on the direct
      // `/self/*` path there is nothing to retry with, and a timeline failure
      // must never unwind a committed grant.
      //
      // WHAT WAS MEASURED BEFORE THE FIX, with the consumer's repair call
      // removed: `{rewards: 1, events: 1, notifications: 1, timeline: 0}` and
      // the outbox message marked PUBLISHED. Nothing failed, nothing retried,
      // nothing logged an error a human would see — the curated moment for a
      // real reward was gone forever and the pipeline reported success. That is
      // PA-B-009's exact shape, one table over.
      const timeline = app.get(
        require('../../src/modules/life-intelligence/application/services/life-timeline.service')
          .LifeTimelineService,
      );
      const real = timeline.record.bind(timeline);
      const spy = jest.spyOn(timeline, 'record').mockImplementation(async (...args: unknown[]) => {
        const input = args[0] as { eventType?: string };
        if (input.eventType === 'reward_granted') throw new Error('timeline store unavailable');
        return real(input);
      });

      try {
        await drainOutbox();
      } finally {
        spy.mockRestore();
      }

      const after = await chain(A);
      // The grant stands — it is committed and nothing here may unwind it.
      expect(after.rewards).toBe(1);
      // And the announcement is WITHHELD rather than sent: notifying a parent
      // about a reward that is missing from the timeline the notification tells
      // them to go and look at would be worse than waiting for the retry.
      expect(after.timeline).toBe(0);
      expect(after.events).toBe(0);
      expect(after.notifications).toBe(0);

      const msg = await sys('read failed message', () =>
        prisma.outboxMessage.findFirst({
          where: { familyId: A.familyId, eventType: 'HABIT_COMPLETED' },
        }),
      );
      expect(msg.status).toBe('FAILED');
      expect(msg.lastError).toContain('timeline store unavailable');
    });

    it('THE REPAIR: the retry restores the entry and completes the chain', async () => {
      await clearBackoff(A);

      await drainOutbox();

      // The grant already existed, so `processTriggerEvent` returns 0 and
      // `announceGrant` is never reached — the repair therefore cannot live
      // there. It lives in the consumer, keyed, and it is NOT swallowed, so a
      // failure retries instead of disappearing.
      expect(await chain(A)).toEqual({ rewards: 1, events: 1, timeline: 1, notifications: 1, childMessages: 1 });
    });

    it('THE CONSTRAINT: four more replays still yield exactly one entry', async () => {
      for (let i = 0; i < 4; i += 1) {
        await sys('force redelivery', () =>
          prisma.$executeRawUnsafe(
            `UPDATE "outbox_messages"
                SET "status" = 'PENDING', "published_at" = NULL, "next_attempt_at" = now() - INTERVAL '1 second'
              WHERE "family_id" = $1::uuid`,
            A.familyId,
          ),
        );
        await sys('drop consumer markers', () =>
          prisma.consumedMessage.deleteMany({ where: { familyId: A.familyId } }),
        );
        await drainOutbox();
      }

      // Enforced by `life_timeline_events_reward_source_key_uq`, not by the
      // consumer marker — the marker is deleted above on every pass.
      expect(await chain(A)).toEqual({ rewards: 1, events: 1, timeline: 1, notifications: 1, childMessages: 1 });
    });
  });

  // =========================================================================
  // 3. THE OTHER FAILURE MODES
  // =========================================================================

  describe('notification failure, retry and rollback', () => {
    it('a notification failure retries the message and never touches the committed grant', async () => {
      await resetChildState(A);
      const device = await newDevice(A);
      await postBatch(device.token, [habitEvent(A, 'pc:notif:1')]);

      const integration = app.get(
        require('../../src/modules/life-intelligence/application/services/smart-notification-integration.service')
          .SmartNotificationIntegrationService,
      );
      const spy = jest
        .spyOn(integration, 'notifyEvent')
        .mockRejectedValue(new Error('notification store unavailable'));

      try {
        // Pass 1 delivers HABIT_COMPLETED: the grant lands and REWARD_GRANTED
        // is written. Pass 2 delivers REWARD_GRANTED and the notification
        // consumer fails.
        await drainOutbox();
      } finally {
        spy.mockRestore();
      }

      expect(await count('rewardsLedgerEntry', { familyId: A.familyId, type: 'EARN' })).toBe(1);
      expect(await count('domainEvent', { familyId: A.familyId, eventType: 'REWARD_GRANTED' })).toBe(1);
      expect(await count('notification', { familyId: A.familyId, type: 'REWARD_GRANTED' })).toBe(0);

      const msg = await sys('read failed reward message', () =>
        prisma.outboxMessage.findFirst({
          where: { familyId: A.familyId, eventType: 'REWARD_GRANTED' },
        }),
      );
      expect(msg.status).toBe('FAILED');
      expect(msg.lastError).toContain('notification store unavailable');
    });

    it('the retry delivers exactly one notification — not zero and not two', async () => {
      await clearBackoff(A);
      await drainOutbox();

      expect(await chain(A)).toEqual({ rewards: 1, events: 1, timeline: 1, notifications: 1, childMessages: 1 });
    });

    it('DB ROLLBACK: an ingestion whose transaction aborts leaves no event, no message, no grant', async () => {
      await resetChildState(A);
      const device = await newDevice(A);

      // `ingestOne` writes the habit row, the domain event and the outbox
      // message in ONE transaction. Failing the LAST write must unwind the
      // first two — that is the whole reason the Outbox pattern exists.
      const spy = jest.spyOn(outbox, 'writeWithin').mockRejectedValue(new Error('rolled back'));
      try {
        const res = await postBatch(device.token, [habitEvent(A, 'pc:rollback:1')]);
        expect(res.body.data.rejected).toBe(1);
      } finally {
        spy.mockRestore();
      }

      expect(await count('domainEvent', { familyId: A.familyId, eventType: 'HABIT_COMPLETED' })).toBe(0);
      expect(await count('outboxMessage', { familyId: A.familyId })).toBe(0);
      expect(await count('habitCompletion', { familyId: A.familyId })).toBe(0);
      expect(await chain(A)).toEqual({ rewards: 0, events: 0, timeline: 0, notifications: 0, childMessages: 0 });
    });
  });

  describe('worker crash, redelivery and concurrency', () => {
    it('WORKER CRASH: a message stranded in PUBLISHING is reclaimed and completes the chain once', async () => {
      await resetChildState(A);
      const device = await newDevice(A);
      await postBatch(device.token, [habitEvent(A, 'pc:crash:1')]);

      // A worker claimed the message, granted the reward, and died before it
      // could write REWARD_GRANTED — the PA-B-009 window, this time expressed
      // as a real crash rather than a thrown error: the lock is orphaned and
      // the ledger row is already there.
      const spy = failRewardGrantedWrite('worker died');
      try {
        await relay.tick();
      } finally {
        spy.mockRestore();
      }

      await sys('strand the message', () =>
        prisma.$executeRawUnsafe(
          `UPDATE "outbox_messages"
              SET "status" = 'PUBLISHING', "locked_by" = 'dead-worker',
                  "locked_at" = now() - INTERVAL '10 minutes'
            WHERE "family_id" = $1::uuid AND "event_type" = 'HABIT_COMPLETED'`,
          A.familyId,
        ),
      );

      await drainOutbox();

      expect(await chain(A)).toEqual({ rewards: 1, events: 1, timeline: 1, notifications: 1, childMessages: 1 });
    });

    it('DUPLICATE EVENT: the same completion posted again grants nothing and notifies nobody', async () => {
      const before = await chain(A);
      const device = await newDevice(A);
      const res = await postBatch(device.token, [habitEvent(A, 'pc:crash:1:again')]);
      // Same habit, same server-derived day => same server-composed key.
      expect(res.body.data.duplicates).toBe(1);

      await drainOutbox();
      expect(await chain(A)).toEqual(before);
    });

    it('CONCURRENT DELIVERY: two relay passes racing on one message still produce one of everything', async () => {
      await resetChildState(A);
      const device = await newDevice(A);
      await postBatch(device.token, [habitEvent(A, 'pc:concurrent:1')]);

      // SKIP LOCKED hands the row to exactly one of them; the loser claims
      // nothing rather than blocking. Repeated until the chain is drained so
      // the derived REWARD_GRANTED message races too.
      for (let i = 0; i < 4; i++) {
        await Promise.all([relay.tick(), relay.tick(), relay.tick()]);
      }

      expect(await chain(A)).toEqual({ rewards: 1, events: 1, timeline: 1, notifications: 1, childMessages: 1 });
    });

    it('REDELIVERY: replaying every message with the consumer markers deleted changes nothing', async () => {
      await sys('force full redelivery', () =>
        prisma.$executeRawUnsafe(
          `UPDATE "outbox_messages"
              SET "status" = 'PENDING', "published_at" = NULL, "next_attempt_at" = now() - INTERVAL '1 second'
            WHERE "family_id" = $1::uuid`,
          A.familyId,
        ),
      );
      await sys('drop consumer markers', () =>
        prisma.consumedMessage.deleteMany({ where: { familyId: A.familyId } }),
      );

      await drainOutbox();

      expect(await chain(A)).toEqual({ rewards: 1, events: 1, timeline: 1, notifications: 1, childMessages: 1 });
    });
  });

  // =========================================================================
  // 4. THE RECOVERY PATH A DEAD-LETTERED GRANT NEVER HAD
  // =========================================================================

  describe('DEAD-letter observability and recovery', () => {
    it('a message that burns its attempts dead-letters, and the ledger keeps the grant', async () => {
      await resetChildState(A);
      const device = await newDevice(A);
      await postBatch(device.token, [habitEvent(A, 'pc:dead:1')]);

      const integration = app.get(
        require('../../src/modules/life-intelligence/application/services/smart-notification-integration.service')
          .SmartNotificationIntegrationService,
      );
      const spy = jest
        .spyOn(integration, 'notifyEvent')
        .mockRejectedValue(new Error('notification store down for hours'));

      try {
        for (let i = 0; i < 10; i++) {
          await clearBackoff(A);
          await relay.tick();
        }
      } finally {
        spy.mockRestore();
      }

      const dead = await sys('read dead reward message', () =>
        prisma.outboxMessage.findFirst({
          where: { familyId: A.familyId, eventType: 'REWARD_GRANTED' },
        }),
      );
      expect(dead.status).toBe('DEAD');
      // THE STATE THE PRODUCT COULD NOT SEE AND COULD NOT LEAVE: a real grant,
      // a real event, and a notification that will never arrive.
      expect(await count('rewardsLedgerEntry', { familyId: A.familyId, type: 'EARN' })).toBe(1);
      expect(await count('notification', { familyId: A.familyId, type: 'REWARD_GRANTED' })).toBe(0);
      expect((await relay.tick()).claimed).toBe(0);
    });

    it('OBSERVABILITY: the dead letter is surfaced by name, count and age', async () => {
      const report = await relay.deadLetters();
      expect(report.total).toBeGreaterThanOrEqual(1);
      const reward = report.byEventType.find((r) => r.eventType === 'REWARD_GRANTED');
      expect(reward).toBeDefined();
      expect(reward!.count).toBeGreaterThanOrEqual(1);
      expect(reward!.oldestAgeSeconds).toBeGreaterThanOrEqual(0);
      expect(report.messages.some((m) => m.eventType === 'REWARD_GRANTED')).toBe(true);
    });

    it('RECOVERY: requeueing the dead letter completes the chain — {1,1,1,1}, not {1,1,1,2}', async () => {
      const recovered = await relay.recoverDeadLetters({
        eventType: 'REWARD_GRANTED',
        familyId: A.familyId,
      });
      expect(recovered).toBe(1);

      await drainOutbox();

      expect(await chain(A)).toEqual({ rewards: 1, events: 1, timeline: 1, notifications: 1, childMessages: 1 });
      expect(await count('outboxMessage', { familyId: A.familyId, status: 'DEAD' })).toBe(0);
    });

    it('the operator route surfaces the same gauge, and refuses an unauthenticated caller', async () => {
      const anonymous = await request(http).get('/system/outbox/dead-letters');
      expect(anonymous.status).toBe(401);

      const authorised = await request(http)
        .get('/system/outbox/dead-letters')
        .set({ 'x-internal-admin-key': process.env.INTERNAL_ADMIN_API_KEY as string });
      expect(authorised.status).toBe(200);

      const body = authorised.body.data ?? authorised.body;
      // The backlog gauge comes back ALONGSIDE the dead letters, because
      // "12 dead and 0 pending" and "12 dead and 4,000 pending" are different
      // incidents and an operator should not need two calls to tell them apart.
      expect(body.backlog).toBeDefined();
      expect(Array.isArray(body.deadLetters.byEventType)).toBe(true);

      const refusedRecover = await request(http)
        .post('/system/outbox/dead-letters/recover')
        .send({ eventType: 'REWARD_GRANTED' });
      expect(refusedRecover.status).toBe(401);
    });

    it('RECOVERY IS IDEMPOTENT: running it again requeues nothing and changes nothing', async () => {
      const before = await chain(A);
      expect(await relay.recoverDeadLetters({ eventType: 'REWARD_GRANTED', familyId: A.familyId })).toBe(0);
      await drainOutbox();
      expect(await chain(A)).toEqual(before);
      // Scoped to THIS family: the gauge is cross-tenant by design, and a
      // shared integration database may carry another suite's leftovers.
      const report = await relay.deadLetters();
      expect(report.messages.filter((m) => m.familyId === A.familyId)).toHaveLength(0);
    });
  });
});
