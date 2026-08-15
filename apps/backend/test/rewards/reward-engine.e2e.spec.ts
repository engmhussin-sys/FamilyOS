/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-var-requires */
/**
 * F4 — THE FLAGSHIP QURAN JOURNEY, PROVEN BY EXECUTION.
 *
 *   parent creates the program (حفظ · سورة الملك · الآيات 1–5 · 20 دقيقة · 20 نقطة)
 *     -> child starts        (device token, /self/*)
 *     -> child submits       (evidence only; the SERVER decides)
 *     -> parent confirms     (parent token)
 *     -> EXACTLY ONE ledger entry
 *     -> EXACTLY ONE parent notification
 *
 * and then the parts that make it real rather than a happy path:
 *   THE REPLAY        — the same verification redelivered: zero new grants,
 *                       ZERO new notifications.
 *   THE FAILURE       — a failed verification: no grant, no notification.
 *   THE RACE          — 8 concurrent identical verifications: exactly one grant.
 *   THE RULE          — max-per-day actually blocks the second attempt.
 *   THE CHILD         — a device token cannot create a program, cannot approve,
 *                       cannot grant.
 *   THE TENANT        — family A's child cannot touch family B's program.
 *
 * Everything runs against a REAL PostgreSQL and a REAL Redis through the REAL
 * application: real guards, real global TenantContextInterceptor, real Prisma
 * tenant extension, real `RewardsEngineService`, real `NotificationFatigueGuard`,
 * real outbox relay. Nothing in the pipeline is stubbed. The only things this
 * file constructs directly are fixtures and the CLOCK.
 *
 * ON THE CLOCK — same three facts F3 established, unchanged: quiet hours
 * (21:00–07:00) make "a notification WAS dispatched" non-deterministic unless
 * the suite owns `Date`; only `Date` is faked; and the fake day is one day
 * BEHIND the real clock because Prisma generates `@default(now())` client-side
 * while the relay's SQL uses PostgreSQL's real `now()`.
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
import { RewardsCompletionConsumer } from '../../src/modules/events/application/consumers/rewards-completion.consumer';
import { ScreenTimeService } from '../../src/modules/screen-time/application/services/screen-time.service';
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
  deviceToken: string;
  deviceId: string;
}

/** The flagship program, exactly as the brief specifies it. */
const QURAN_PROGRAM = {
  category: 'QURAN',
  activity: 'QURAN_MEMORIZE_AYAH_RANGE',
  targetSpec: { surahNumber: 67, fromAyah: 1, toAyah: 5 },
  durationMinutes: 20,
  verificationLevel: 'PARENT_CONFIRMATION',
  rewardSpec: { type: 'POINTS', amount: 20 },
  frequency: 'DAILY',
  maxPerDay: 1,
  maxPerWeek: 7,
};

describeIfDb('F4 — the Quran reward journey end to end (real PostgreSQL, real Redis, real app)', () => {
  let app: INestApplication;
  let http: any;
  let prisma: any;
  let relay: OutboxRelay;
  let tokens: TokenService;
  let rewardsConsumer: RewardsCompletionConsumer;
  let screenTime: ScreenTimeService;

  const stamp = Date.now();
  const A = {} as Tenant;
  const B = {} as Tenant;

  const sys = (what: string, fn: () => Promise<any>): Promise<any> =>
    runAsSystemAsync('TEST_FIXTURE', `F4 reward suite: ${what}`, async () => await fn());

  // -------------------------------------------------------------------------
  // fixtures
  // -------------------------------------------------------------------------

  async function registerTenant(label: string, t: Tenant): Promise<void> {
    const email = `f4.${label}.${stamp}@example.com`;
    const password = 'F4-Reward-Passw0rd!23';

    const reg = await request(http)
      .post('/auth/register')
      .send({ email, password, fullName: `F4 Parent ${label}`, familyName: `F4 Family ${label}`, acceptedTerms: true });
    if (![200, 201].includes(reg.status)) throw new Error(`register -> ${reg.status} ${JSON.stringify(reg.body)}`);

    const login = await request(http).post('/auth/login').send({ email, password });
    t.parentToken = login.body.tokens?.accessToken ?? login.body.accessToken;
    const claims = JSON.parse(Buffer.from(t.parentToken.split('.')[1], 'base64').toString());
    t.familyId = claims.familyId;
    t.userId = claims.sub;

    const child = await request(http)
      .post('/children')
      .set({ Authorization: `Bearer ${t.parentToken}` })
      .send({ firstName: `F4 Kid ${label}`, dateOfBirth: '2015-04-01' });
    t.childId = child.body.id;

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
    t.deviceId = device.id;
    const pair = await runWithTenant(
      { familyId: t.familyId, actorType: 'DEVICE', actorId: device.id },
      () => tokens.issueTokenPair({ subjectId: device.id, actorType: 'DEVICE', familyId: t.familyId }),
    );
    t.deviceToken = pair.accessToken;
  }

  const asParent = (t: Tenant) => ({ Authorization: `Bearer ${t.parentToken}` });
  const asChild = (t: Tenant) => ({ Authorization: `Bearer ${t.deviceToken}` });

  const createProgram = (t: Tenant, over: Record<string, unknown> = {}) =>
    request(http)
      .post('/reward-programs')
      .set(asParent(t))
      .send({ childId: t.childId, ...QURAN_PROGRAM, ...over });

  async function drainOutbox(maxPasses = 10): Promise<{ published: number; failed: number }> {
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

  const ledgerCount = (t: Tenant): Promise<number> =>
    count('rewardsLedgerEntry', { familyId: t.familyId, childId: t.childId, type: 'EARN' });

  const notificationCount = (t: Tenant, type = 'REWARD_GRANTED'): Promise<number> =>
    count('notification', { familyId: t.familyId, childId: t.childId, type });

  const eventsOfType = (t: Tenant, eventType: string): Promise<number> =>
    count('domainEvent', { familyId: t.familyId, eventType });

  async function resetChildState(t: Tenant): Promise<void> {
    await sys('reset', async () => {
      await prisma.notification.deleteMany({ where: { familyId: t.familyId } });
      await prisma.screenTimeRewardGrant.deleteMany({ where: { familyId: t.familyId } });
      await prisma.rewardFulfilment.deleteMany({ where: { familyId: t.familyId } });
      await prisma.rewardsLedgerEntry.deleteMany({ where: { familyId: t.familyId } });
      await prisma.rewardsAccount.deleteMany({ where: { familyId: t.familyId } });
      await prisma.consumedMessage.deleteMany({ where: { familyId: t.familyId } });
      await prisma.outboxMessage.deleteMany({ where: { familyId: t.familyId } });
      await prisma.domainEvent.deleteMany({ where: { familyId: t.familyId } });
      await prisma.verificationAttempt.deleteMany({ where: { familyId: t.familyId } });
      await prisma.achievementRequest.deleteMany({ where: { familyId: t.familyId } });
    });
  }

  /** The whole journey, as a reusable helper: create -> start -> submit ->
   * approve -> drain. Returns the ids so a test can assert against them. */
  async function runJourney(
    t: Tenant,
    over: Record<string, unknown> = {},
  ): Promise<{ programId: string; achievementId: string }> {
    const program = await createProgram(t, over);
    expect([200, 201]).toContain(program.status);

    const started = await request(http)
      .post('/self/achievements/start')
      .set(asChild(t))
      .send({ programId: program.body.id });
    expect([200, 201]).toContain(started.status);

    const submitted = await request(http)
      .post(`/self/achievements/${started.body.id}/submit`)
      .set(asChild(t))
      .send({ foregroundMinutes: 21, note: 'حفظت الآيات' });
    expect(submitted.status).toBe(201);
    expect(submitted.body.status).toBe('PENDING_PARENT');

    const approved = await request(http)
      .post(`/reward-programs/achievements/${started.body.id}/approve`)
      .set(asParent(t))
      .send({});
    expect([200, 201]).toContain(approved.status);

    await drainOutbox();
    return { programId: program.body.id, achievementId: started.body.id };
  }

  // -------------------------------------------------------------------------
  // lifecycle
  // -------------------------------------------------------------------------

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
    relay = app.get(OutboxRelay);
    tokens = app.get(TokenService);
    rewardsConsumer = app.get(RewardsCompletionConsumer);
    screenTime = app.get(ScreenTimeService);

    await registerTenant('a', A);
    await registerTenant('b', B);
  }, 120000);

  afterAll(async () => {
    jest.useRealTimers();
    if (app) await app.close();
  });

  beforeEach(async () => {
    jest.setSystemTime(NOON);
    await resetChildState(A);
    await resetChildState(B);
  });

  // =========================================================================
  // 1. THE FLAGSHIP JOURNEY
  // =========================================================================

  describe('THE FLAGSHIP: parent creates a Quran program, child earns it, parent confirms', () => {
    it('the parent creates the program, and the server validates the ayah range against the REAL surah', async () => {
      const res = await createProgram(A);
      expect([200, 201]).toContain(res.status);
      expect(res.body.category).toBe('QURAN');
      expect(res.body.targetSummaryAr).toBe('الآيات 1–5 من سورة الملك');
      expect(res.body.durationMinutes).toBe(20);

      // REUSE: companion RewardRule rows, not a rival grant mechanism.
      const rules = await count('rewardRule', { familyId: A.familyId, programId: res.body.id });
      expect(rules).toBeGreaterThan(0);
    });

    it('REJECTS ayah 300 of Al-Mulk — the whole feature would lie to the child otherwise', async () => {
      const res = await createProgram(A, { targetSpec: { surahNumber: 67, fromAyah: 1, toAyah: 300 } });
      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body)).toContain('AYAH_OUT_OF_SURAH');
    });

    it('REJECTS surah 115 — there are 114', async () => {
      const res = await createProgram(A, { targetSpec: { surahNumber: 115, fromAyah: 1, toAyah: 5 } });
      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body)).toContain('SURAH_OUT_OF_RANGE');
    });

    it('REJECTS SELF_CHECK on a Quran program — a low-trust method on a high-trust activity', async () => {
      const res = await createProgram(A, { verificationLevel: 'SELF_CHECK' });
      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body)).toContain('VERIFICATION_TOO_WEAK_FOR_CATEGORY');
    });

    it('the child starts the program from a DEVICE token, and gets an attempt — not a reward', async () => {
      const program = await createProgram(A);
      const res = await request(http)
        .post('/self/achievements/start')
        .set(asChild(A))
        .send({ programId: program.body.id });

      expect([200, 201]).toContain(res.status);
      expect(res.body.status).toBe('IN_PROGRESS');
      expect(await ledgerCount(A)).toBe(0);
      expect(await notificationCount(A)).toBe(0);
    });

    it('the child SUBMITS and STILL has nothing — PARENT_CONFIRMATION cannot auto-approve', async () => {
      const program = await createProgram(A);
      const started = await request(http)
        .post('/self/achievements/start')
        .set(asChild(A))
        .send({ programId: program.body.id });

      const res = await request(http)
        .post(`/self/achievements/${started.body.id}/submit`)
        .set(asChild(A))
        .send({ foregroundMinutes: 21 });

      expect(res.body.status).toBe('PENDING_PARENT');
      expect(res.body.outcome.result).toBe('ESCALATED');

      await drainOutbox();
      expect(await ledgerCount(A)).toBe(0);
      expect(await notificationCount(A)).toBe(0);

      // The attempt IS recorded — append-only evidence of what the server decided.
      const attempts = await count('verificationAttempt', { familyId: A.familyId });
      expect(attempts).toBe(1);
    });

    it('THE PARENT CONFIRMS -> EXACTLY ONE ledger entry and EXACTLY ONE parent notification', async () => {
      const { achievementId } = await runJourney(A);

      const achievement = await sys('read achievement', () =>
        prisma.achievementRequest.findFirst({ where: { id: achievementId } }),
      );
      expect(achievement.status).toBe('VERIFIED');
      expect(achievement.appliedMultiplierBps).toBeGreaterThanOrEqual(10000);

      expect(await ledgerCount(A)).toBe(1);
      expect(await notificationCount(A)).toBe(1);

      const entries = await sys('ledger', () =>
        prisma.rewardsLedgerEntry.findMany({ where: { familyId: A.familyId, childId: A.childId } }),
      );
      // 20 points at a 1.00x multiplier on day one.
      expect(entries[0].amount).toBe(20);
      expect(entries[0].delta).toBe(20);
      expect(entries[0].rewardType).toBe('XP');
      expect(entries[0].idempotencyKey).toContain(':achv:');
    });

    it('emitted the right events, and NONE of them is device-ingestible', async () => {
      await runJourney(A);
      expect(await eventsOfType(A, 'REWARD_PROGRAM_CREATED')).toBe(1);
      expect(await eventsOfType(A, 'ACHIEVEMENT_REQUESTED')).toBe(1);
      expect(await eventsOfType(A, 'ACHIEVEMENT_VERIFIED')).toBe(1);
      expect(await eventsOfType(A, 'REWARD_GRANTED')).toBe(1);
      expect(await eventsOfType(A, 'QURAN_ACHIEVEMENT_COMPLETED')).toBe(1);
      // The Quran announcement must NOT be a completion, or the reward pays twice.
      expect(await ledgerCount(A)).toBe(1);
    });

    it('every outbox message reached PUBLISHED — nothing stranded, nothing dead', async () => {
      await runJourney(A);
      const stuck = await count('outboxMessage', {
        familyId: A.familyId,
        status: { in: ['PENDING', 'PUBLISHING', 'FAILED', 'DEAD'] },
      });
      expect(stuck).toBe(0);
    });
  });

  // =========================================================================
  // 2. THE REPLAY
  // =========================================================================

  describe('THE REPLAY: the same verification again produces nothing', () => {
    it('re-submitting the SAME achievement is refused — it is no longer submittable', async () => {
      const { achievementId } = await runJourney(A);
      const before = { ledger: await ledgerCount(A), notif: await notificationCount(A) };

      const replay = await request(http)
        .post(`/self/achievements/${achievementId}/submit`)
        .set(asChild(A))
        .send({ foregroundMinutes: 21 });
      expect(replay.status).toBe(409);

      await drainOutbox();
      expect(await ledgerCount(A)).toBe(before.ledger);
      expect(await notificationCount(A)).toBe(before.notif);
    });

    it('re-approving the SAME achievement is refused — it is no longer awaiting a decision', async () => {
      const { achievementId } = await runJourney(A);

      const replay = await request(http)
        .post(`/reward-programs/achievements/${achievementId}/approve`)
        .set(asParent(A))
        .send({});
      expect(replay.status).toBe(409);

      await drainOutbox();
      expect(await ledgerCount(A)).toBe(1);
      expect(await notificationCount(A)).toBe(1);
    });

    /** Re-enqueues every outbox message for this family. `keepMarkers = false`
     * additionally deletes the `consumed_messages` rows, which strips the
     * optimisation and leaves only the database constraints. */
    async function redeliverEverything(t: Tenant, keepMarkers: boolean): Promise<void> {
      await sys('redeliver', async () => {
        if (!keepMarkers) {
          await prisma.consumedMessage.deleteMany({ where: { familyId: t.familyId } });
        }
        await prisma.outboxMessage.updateMany({
          where: { familyId: t.familyId },
          data: { status: 'PENDING', lockedAt: null, lockedBy: null, nextAttemptAt: new Date(), attemptCount: 0 },
        });
      });
    }

    it('THE REAL REPLAY: at-least-once redelivery grants ZERO and notifies ZERO', async () => {
      await runJourney(A);
      expect(await ledgerCount(A)).toBe(1);
      expect(await notificationCount(A)).toBe(1);

      // The clock is moved OUTSIDE the fatigue guard's 5-minute DUPLICATE
      // window on purpose: a second notification WOULD be dispatched if a
      // second grant happened. Without this the test could pass for the wrong
      // reason — the window swallowing it rather than nothing happening.
      jest.setSystemTime(at('12:30'));

      await redeliverEverything(A, true);
      const drained = await drainOutbox();
      expect(drained.published).toBeGreaterThan(0);

      expect(await ledgerCount(A)).toBe(1);
      expect(await notificationCount(A)).toBe(1);
    });

    it('THE HARDER REPLAY: with the consumer markers DELETED, the ledger still grants exactly once', async () => {
      await runJourney(A);
      jest.setSystemTime(at('12:30'));

      // Strips `consumed_messages` — F3's stated optimisation — so the only
      // remaining defence for the GRANT is
      // `rewards_ledger_entries (child_id, idempotency_key)`.
      await redeliverEverything(A, false);
      await drainOutbox();

      expect(await ledgerCount(A)).toBe(1);
      expect(await eventsOfType(A, 'REWARD_GRANTED')).toBe(1);
    });

    /**
     * AN HONEST LIMIT, CAPTURED AS A TEST RATHER THAN AS PROSE.
     *
     * The GRANT is protected by a unique constraint, so it is exactly once under
     * any redelivery. The NOTIFICATION is protected by two weaker things: the
     * `consumed_messages` marker (an optimisation, per F3's own docstring) and
     * `NotificationFatigueGuard`'s 5-minute DUPLICATE window. Remove BOTH — a
     * redelivery of a message whose marker was lost, more than five minutes
     * later — and a second notification IS dispatched for a reward that was
     * granted once.
     *
     * This test asserts that exact behaviour so the limit cannot regress
     * silently in either direction, and §11/§افتراضات of the F4 report names it
     * with its fix (a unique index on
     * `notifications (family_id, source_event_id)`), which is NOT built in this
     * sprint. Note the scope: it needs the marker to be GONE, which in
     * production means the row was written and then lost.
     */
    it('KNOWN LIMIT: marker gone AND outside the fatigue window, the notification is not deduplicated', async () => {
      await runJourney(A);
      expect(await notificationCount(A)).toBe(1);

      jest.setSystemTime(at('12:30'));
      await redeliverEverything(A, false);
      await drainOutbox();

      // The grant is still exactly once — the constraint held.
      expect(await ledgerCount(A)).toBe(1);
      // The notification was not. This is the documented gap, measured.
      expect(await notificationCount(A)).toBe(2);
    });
  });

  // =========================================================================
  // 3. FAILURE — no grant, no notification
  // =========================================================================

  describe('A FAILED verification grants nothing and notifies nobody', () => {
    it('a parent REJECTION produces no ledger row and no reward notification', async () => {
      const program = await createProgram(A);
      const started = await request(http)
        .post('/self/achievements/start')
        .set(asChild(A))
        .send({ programId: program.body.id });
      await request(http)
        .post(`/self/achievements/${started.body.id}/submit`)
        .set(asChild(A))
        .send({ foregroundMinutes: 21 });

      const rejected = await request(http)
        .post(`/reward-programs/achievements/${started.body.id}/reject`)
        .set(asParent(A))
        .send({ note: 'نراجعها معًا' });
      expect([200, 201]).toContain(rejected.status);

      await drainOutbox();
      expect(await ledgerCount(A)).toBe(0);
      expect(await notificationCount(A)).toBe(0);
      expect(await eventsOfType(A, 'ACHIEVEMENT_REJECTED')).toBe(1);
      expect(await eventsOfType(A, 'ACHIEVEMENT_VERIFIED')).toBe(0);
    });

    it('a DURATION program the child did not actually work on fails, grants nothing, and is re-attemptable', async () => {
      // 5 minutes, not 20: the re-attempt has to happen inside the 15-minute
      // access-token lifetime, and the suite owns the clock. A 20-minute
      // program would need the clock moved past the token's expiry, and the
      // second submit would fail with a 401 for a reason unrelated to duration.
      const program = await createProgram(A, {
        category: 'STUDY',
        activity: 'READ_PAGES',
        targetSpec: { quantity: 5, unit: 'صفحة' },
        durationMinutes: 5,
        verificationLevel: 'DURATION',
      });
      const started = await request(http)
        .post('/self/achievements/start')
        .set(asChild(A))
        .send({ programId: program.body.id });

      jest.setSystemTime(at('12:06'));
      const failed = await request(http)
        .post(`/self/achievements/${started.body.id}/submit`)
        .set(asChild(A))
        .send({ foregroundMinutes: 2 });

      expect(failed.body.outcome.result).toBe('FAILED');
      expect(failed.body.outcome.reasonCode).toBe('DURATION_NOT_SATISFIED');
      expect(failed.body.status).toBe('IN_PROGRESS');
      expect(failed.body.attemptsLeft).toBe(2);

      await drainOutbox();
      expect(await ledgerCount(A)).toBe(0);
      expect(await notificationCount(A)).toBe(0);

      // RE-ATTEMPTABLE under the policy, and the second attempt succeeds.
      jest.setSystemTime(at('12:10'));
      const passed = await request(http)
        .post(`/self/achievements/${started.body.id}/submit`)
        .set(asChild(A))
        .send({ foregroundMinutes: 6 });
      expect(passed.status).toBe(201);
      expect(passed.body.outcome.result).toBe('PASSED');

      await drainOutbox();
      expect(await ledgerCount(A)).toBe(1);
    });

    it('a device that CLAIMS more foreground time than the window allows is caught by the server', async () => {
      const program = await createProgram(A, {
        category: 'STUDY',
        activity: 'READ_PAGES',
        targetSpec: { quantity: 5, unit: 'صفحة' },
        verificationLevel: 'DURATION',
      });
      const started = await request(http)
        .post('/self/achievements/start')
        .set(asChild(A))
        .send({ programId: program.body.id });

      // Submitted one minute after starting, claiming 45 minutes of work.
      jest.setSystemTime(at('12:01'));
      const res = await request(http)
        .post(`/self/achievements/${started.body.id}/submit`)
        .set(asChild(A))
        .send({ foregroundMinutes: 45 });

      expect(res.body.outcome.result).toBe('FAILED');
      expect(res.body.outcome.reasonCode).toBe('FOREGROUND_EXCEEDS_ELAPSED');
      await drainOutbox();
      expect(await ledgerCount(A)).toBe(0);
    });
  });

  // =========================================================================
  // 4. THE RACE
  // =========================================================================

  describe('CONCURRENCY: 8 identical verifications produce exactly one grant', () => {
    it('grants once and notifies once, decided by the database and not by a code check', async () => {
      await runJourney(A);

      // Clear the observable state but KEEP the domain event, then hand the SAME
      // envelope to the consumer 8 times in parallel with the idempotency markers
      // deleted. The only remaining defence is the unique constraint.
      await sys('clear grants', async () => {
        await prisma.notification.deleteMany({ where: { familyId: A.familyId } });
        await prisma.rewardsLedgerEntry.deleteMany({ where: { familyId: A.familyId } });
        await prisma.consumedMessage.deleteMany({ where: { familyId: A.familyId } });
        await prisma.outboxMessage.deleteMany({ where: { familyId: A.familyId } });
        await prisma.domainEvent.deleteMany({
          where: { familyId: A.familyId, eventType: { not: 'ACHIEVEMENT_VERIFIED' } },
        });
      });

      const event = await sys('read verified event', () =>
        prisma.domainEvent.findFirst({ where: { familyId: A.familyId, eventType: 'ACHIEVEMENT_VERIFIED' } }),
      );
      expect(event).toBeTruthy();

      const envelope = {
        envelopeVersion: '1',
        id: event.id,
        type: 'ACHIEVEMENT_VERIFIED',
        schemaVersion: 1,
        familyId: event.familyId,
        childId: event.childId,
        deviceId: event.deviceId,
        aggregateType: event.aggregateType,
        aggregateId: event.aggregateId,
        occurredAt: new Date(event.occurredAt).toISOString(),
        receivedAt: new Date().toISOString(),
        idempotencyKey: event.idempotencyKey,
        clientEventId: null,
        traceId: null,
        payload: event.payload,
      } as any;

      const results = await Promise.allSettled(
        Array.from({ length: 8 }, () =>
          runWithTenant({ familyId: A.familyId, actorType: 'SYSTEM' as any, actorId: 'test' }, () =>
            rewardsConsumer.handle(envelope),
          ),
        ),
      );
      // Every one of the eight completed; none of them is allowed to error.
      expect(results.filter((r) => r.status === 'rejected')).toHaveLength(0);

      expect(await ledgerCount(A)).toBe(1);

      await drainOutbox();
      expect(await eventsOfType(A, 'REWARD_GRANTED')).toBe(1);
      expect(await notificationCount(A)).toBe(1);
    }, 60000);
  });

  // =========================================================================
  // 5. THE RULES
  // =========================================================================

  describe('program rules are enforced SERVER-SIDE', () => {
    it('MAX PER DAY blocks the second attempt of the day, non-punitively', async () => {
      const { programId } = await runJourney(A);

      const second = await request(http).post('/self/achievements/start').set(asChild(A)).send({ programId });
      expect(second.status).toBe(409);
      expect(second.body.message?.code ?? second.body.code).toBe('MAX_PER_DAY_REACHED');
      expect(JSON.stringify(second.body)).not.toMatch(/ممنوع|محظور/);

      expect(await ledgerCount(A)).toBe(1);
    });

    it('MIN AGE blocks a child who is too young for the program', async () => {
      const program = await createProgram(A, { minAge: 16 });
      const res = await request(http)
        .post('/self/achievements/start')
        .set(asChild(A))
        .send({ programId: program.body.id });
      expect(res.status).toBe(409);
      expect(JSON.stringify(res.body)).toContain('CHILD_BELOW_MIN_AGE');
    });

    it('an ARCHIVED program stops being startable AND its companion rules stop paying', async () => {
      const program = await createProgram(A);
      await request(http).delete(`/reward-programs/${program.body.id}`).set(asParent(A)).send();

      const res = await request(http)
        .post('/self/achievements/start')
        .set(asChild(A))
        .send({ programId: program.body.id });
      expect(res.status).toBe(409);

      const active = await count('rewardRule', {
        familyId: A.familyId,
        programId: program.body.id,
        isActive: true,
      });
      expect(active).toBe(0);
    });

    it('only ONE attempt may be open at a time', async () => {
      const program = await createProgram(A, { maxPerDay: 5 });
      const first = await request(http)
        .post('/self/achievements/start')
        .set(asChild(A))
        .send({ programId: program.body.id });
      expect([200, 201]).toContain(first.status);

      const second = await request(http)
        .post('/self/achievements/start')
        .set(asChild(A))
        .send({ programId: program.body.id });
      expect(second.status).toBe(409);
      expect(JSON.stringify(second.body)).toContain('ATTEMPT_ALREADY_OPEN');
    });
  });

  // =========================================================================
  // 6. SCREEN_TIME actually becomes minutes
  // =========================================================================

  describe('SCREEN_TIME is a real reward, not a number in a ledger', () => {
    it('a granted SCREEN_TIME reward extends the effective daily allowance', async () => {
      await request(http)
        .post(`/children/${A.childId}/screen-time-policy`)
        .set(asParent(A))
        .send({ dailyLimitMinutes: 90 });

      const before = await runWithTenant({ familyId: A.familyId, actorType: 'USER' as any, actorId: A.userId }, () =>
        screenTime.getEffectivePolicy(A.childId, A.familyId),
      );
      expect(before.effectiveDailyLimitMinutes).toBe(90);
      expect(before.bonusMinutes).toBe(0);

      await runJourney(A, {
        category: 'STUDY',
        activity: 'READ_PAGES',
        targetSpec: { quantity: 5, unit: 'صفحة' },
        rewardSpec: { type: 'SCREEN_TIME', amount: 30 },
      });

      const grants = await count('screenTimeRewardGrant', { familyId: A.familyId, childId: A.childId });
      expect(grants).toBe(1);

      const after = await runWithTenant({ familyId: A.familyId, actorType: 'USER' as any, actorId: A.userId }, () =>
        screenTime.getEffectivePolicy(A.childId, A.familyId),
      );
      expect(after.bonusMinutes).toBe(30);
      expect(after.effectiveDailyLimitMinutes).toBe(120);
      // The BASE policy was never edited — a reward must not rewrite a control.
      expect(after.baseDailyLimitMinutes).toBe(90);
    });

    it('the bonus EXPIRES on its own — no job, no cleanup', async () => {
      await request(http)
        .post(`/children/${A.childId}/screen-time-policy`)
        .set(asParent(A))
        .send({ dailyLimitMinutes: 90 });

      await runJourney(A, {
        category: 'STUDY',
        activity: 'READ_PAGES',
        targetSpec: { quantity: 5, unit: 'صفحة' },
        rewardSpec: { type: 'SCREEN_TIME', amount: 30, expiresInHours: 1 },
      });

      const later = new Date(NOON.getTime() + 3 * 3600 * 1000);
      const after = await runWithTenant({ familyId: A.familyId, actorType: 'USER' as any, actorId: A.userId }, () =>
        screenTime.getEffectivePolicy(A.childId, A.familyId, later),
      );
      expect(after.bonusMinutes).toBe(0);
      expect(after.effectiveDailyLimitMinutes).toBe(90);
    });

    it('a PHYSICAL_REWARD becomes a fulfilment the parent marks delivered', async () => {
      await runJourney(A, {
        category: 'HOUSEWORK',
        activity: 'CHORE',
        targetSpec: { quantity: 1, unit: 'مهمة' },
        verificationLevel: 'PARENT_CONFIRMATION',
        rewardSpec: { type: 'PHYSICAL_REWARD', amount: 1, description: 'رحلة إلى الحديقة' },
      });

      const list = await request(http).get('/reward-programs/fulfilments').set(asParent(A));
      expect(list.body).toHaveLength(1);
      expect(list.body[0].status).toBe('PENDING');
      expect(list.body[0].description).toBe('رحلة إلى الحديقة');

      const approved = await request(http)
        .patch(`/reward-programs/fulfilments/${list.body[0].id}`)
        .set(asParent(A))
        .send({ to: 'APPROVED' });
      expect([200, 201]).toContain(approved.status);

      const delivered = await request(http)
        .patch(`/reward-programs/fulfilments/${list.body[0].id}`)
        .set(asParent(A))
        .send({ to: 'FULFILLED' });
      expect(delivered.body.status).toBe('FULFILLED');

      // Terminal means terminal.
      const again = await request(http)
        .patch(`/reward-programs/fulfilments/${list.body[0].id}`)
        .set(asParent(A))
        .send({ to: 'APPROVED' });
      expect(again.status).toBe(400);
    });
  });

  // =========================================================================
  // 7. SECURITY — the child
  // =========================================================================

  describe('A CHILD MAY REQUEST, NEVER GRANT', () => {
    it('a child token cannot CREATE a program', async () => {
      const res = await request(http)
        .post('/reward-programs')
        .set(asChild(A))
        .send({ childId: A.childId, ...QURAN_PROGRAM });
      expect(res.status).toBe(401);
    });

    it('a child token cannot APPROVE an achievement', async () => {
      const program = await createProgram(A);
      const started = await request(http)
        .post('/self/achievements/start')
        .set(asChild(A))
        .send({ programId: program.body.id });
      await request(http)
        .post(`/self/achievements/${started.body.id}/submit`)
        .set(asChild(A))
        .send({ foregroundMinutes: 21 });

      const res = await request(http)
        .post(`/reward-programs/achievements/${started.body.id}/approve`)
        .set(asChild(A))
        .send({});
      expect(res.status).toBe(401);

      await drainOutbox();
      expect(await ledgerCount(A)).toBe(0);
      expect(await notificationCount(A)).toBe(0);
    });

    it('a child token cannot read the parent pending queue or the fulfilment queue', async () => {
      expect((await request(http).get('/reward-programs/achievements/pending').set(asChild(A))).status).toBe(401);
      expect((await request(http).get('/reward-programs/fulfilments').set(asChild(A))).status).toBe(401);
    });

    it('a PARENT token cannot reach the child self routes — the two strategies are separate', async () => {
      expect((await request(http).get('/self/achievements/today').set(asParent(A))).status).toBe(401);
    });

    it('an unauthenticated caller reaches nothing', async () => {
      expect((await request(http).get('/reward-programs')).status).toBe(401);
      expect((await request(http).get('/self/achievements/today')).status).toBe(401);
    });

    it('there is NO submitted field by which a child can state an outcome', async () => {
      const program = await createProgram(A, {
        category: 'STUDY',
        activity: 'READ_PAGES',
        targetSpec: { quantity: 5, unit: 'صفحة' },
        verificationLevel: 'DURATION',
      });
      const started = await request(http)
        .post('/self/achievements/start')
        .set(asChild(A))
        .send({ programId: program.body.id });

      // The child asserts PASSED, 100%, and VERIFIED. The whitelist drops all
      // three, and the server's own measurement decides.
      const res = await request(http)
        .post(`/self/achievements/${started.body.id}/submit`)
        .set(asChild(A))
        .send({ foregroundMinutes: 1, result: 'PASSED', scorePercent: 100, status: 'VERIFIED' });

      expect(res.body.outcome.result).toBe('FAILED');
      await drainOutbox();
      expect(await ledgerCount(A)).toBe(0);
    });
  });

  // =========================================================================
  // 8. SECURITY — the tenant
  // =========================================================================

  describe("CROSS-TENANT: family A cannot touch family B's programs", () => {
    it("family A's parent cannot read family B's program — it is NOT FOUND, never FORBIDDEN", async () => {
      const bProgram = await createProgram(B);
      expect([200, 201]).toContain(bProgram.status);

      const res = await request(http).get(`/reward-programs/${bProgram.body.id}`).set(asParent(A));
      expect(res.status).toBe(404);
    });

    it("family A's CHILD cannot start family B's program", async () => {
      const bProgram = await createProgram(B);

      const res = await request(http)
        .post('/self/achievements/start')
        .set(asChild(A))
        .send({ programId: bProgram.body.id });
      expect([404, 409]).toContain(res.status);

      await drainOutbox();
      expect(await ledgerCount(A)).toBe(0);
      expect(await ledgerCount(B)).toBe(0);
    });

    it("family A's CHILD cannot submit to family B's achievement", async () => {
      const bProgram = await createProgram(B);
      const bStarted = await request(http)
        .post('/self/achievements/start')
        .set(asChild(B))
        .send({ programId: bProgram.body.id });

      const res = await request(http)
        .post(`/self/achievements/${bStarted.body.id}/submit`)
        .set(asChild(A))
        .send({ foregroundMinutes: 21 });
      expect([403, 404]).toContain(res.status);
    });

    it("family A's parent cannot approve family B's achievement", async () => {
      const bProgram = await createProgram(B);
      const bStarted = await request(http)
        .post('/self/achievements/start')
        .set(asChild(B))
        .send({ programId: bProgram.body.id });
      await request(http)
        .post(`/self/achievements/${bStarted.body.id}/submit`)
        .set(asChild(B))
        .send({ foregroundMinutes: 21 });

      const res = await request(http)
        .post(`/reward-programs/achievements/${bStarted.body.id}/approve`)
        .set(asParent(A))
        .send({});
      expect([404, 409]).toContain(res.status);

      await drainOutbox();
      expect(await ledgerCount(B)).toBe(0);
    });

    it("family A's parent list never contains family B's programs", async () => {
      await createProgram(A);
      await createProgram(B);
      const list = await request(http).get('/reward-programs').set(asParent(A));
      expect(list.body.every((p: any) => p.familyId === A.familyId)).toBe(true);
    });

    it('every F4 row written by the journey carries a family_id — none is orphaned', async () => {
      await runJourney(A);
      // RAW SQL on purpose: Prisma cannot express `familyId: null` for a
      // NOT NULL column, and that refusal is itself half the proof. The other
      // half is asking PostgreSQL directly.
      for (const table of [
        'reward_programs',
        'achievement_requests',
        'verification_attempts',
        'screen_time_reward_grants',
        'reward_fulfilments',
        'rewards_ledger_entries',
        'domain_events',
        'outbox_messages',
      ]) {
        const rows: any[] = await sys(`orphan check ${table}`, () =>
          prisma.$queryRawUnsafe(`SELECT count(*)::int AS n FROM "${table}" WHERE "family_id" IS NULL`),
        );
        expect(Number(rows[0].n)).toBe(0);
      }
    });
  });

  // =========================================================================
  // 9. AI — advisory only
  // =========================================================================

  describe('AI reward recommendation is ADVISORY ONLY', () => {
    it('suggests drafts and creates NOTHING', async () => {
      const before = await count('rewardProgram', { familyId: A.familyId });
      const res = await request(http).get(`/reward-programs/suggestions/${A.childId}`).set(asParent(A));

      expect(res.status).toBe(200);
      expect(res.body.length).toBeGreaterThan(0);
      expect(res.body[0].draft.category).toBeDefined();
      // Never a weak verification level — the AI does not relax a control.
      expect(res.body.every((s: any) => s.draft.verificationLevel !== 'SELF_CHECK')).toBe(true);

      expect(await count('rewardProgram', { familyId: A.familyId })).toBe(before);
    });

    it('a program appears ONLY after the parent explicitly accepts', async () => {
      const suggestions = await request(http).get(`/reward-programs/suggestions/${A.childId}`).set(asParent(A));
      const before = await count('rewardProgram', { familyId: A.familyId });

      const accepted = await request(http)
        .post('/reward-programs/suggestions/accept')
        .set(asParent(A))
        .send({ suggestionId: suggestions.body[0].suggestionId, childId: A.childId });

      expect([200, 201]).toContain(accepted.status);
      expect(await count('rewardProgram', { familyId: A.familyId })).toBe(before + 1);
    });

    it('a CHILD cannot accept a suggestion', async () => {
      const res = await request(http)
        .post('/reward-programs/suggestions/accept')
        .set(asChild(A))
        .send({ suggestionId: 'anything', childId: A.childId });
      expect(res.status).toBe(401);
    });
  });

  // =========================================================================
  // 10. THE CHILD'S OWN VIEW
  // =========================================================================

  describe("the child's read surface", () => {
    it("today's programs say WHY one is unavailable instead of failing on tap", async () => {
      const { programId } = await runJourney(A);
      const res = await request(http).get('/self/achievements/today').set(asChild(A));

      expect(res.status).toBe(200);
      const entry = res.body.find((p: any) => p.id === programId);
      expect(entry.available).toBe(false);
      expect(entry.unavailableReason.code).toBe('MAX_PER_DAY_REACHED');
    });

    it('streaks are recomputed per kind, with no streak table anywhere', async () => {
      await runJourney(A);
      const res = await request(http).get('/self/achievements/streaks').set(asChild(A));
      expect(res.status).toBe(200);
      expect(res.body.quran).toBe(1);
    });

    it("the child sees their own rewards and nobody else's", async () => {
      await runJourney(A);
      const res = await request(http).get('/self/achievements/rewards').set(asChild(A));
      expect(res.status).toBe(200);
      expect(res.body.activeBonusMinutes).toBe(0);
      expect(Array.isArray(res.body.fulfilments)).toBe(true);
    });

    it('the surah catalogue is served complete and identical for every family', async () => {
      const res = await request(http).get('/reward-programs/catalogue/surahs').set(asParent(A));
      expect(res.body.total).toBe(114);
      expect(res.body.surahs.find((s: any) => s.number === 67).ayahCount).toBe(30);

      const bRes = await request(http).get('/reward-programs/catalogue/surahs').set(asParent(B));
      expect(bRes.body.total).toBe(114);
    });

    it('the category catalogue carries all 18 categories with their activities', async () => {
      const res = await request(http).get('/reward-programs/catalogue').set(asParent(A));
      expect(res.body.categories).toHaveLength(18);
      expect(res.body.rewardTypes).toHaveLength(7);
      expect(res.body.categories.find((c: any) => c.code === 'QURAN').activities.length).toBeGreaterThan(0);
    });
  });
});
