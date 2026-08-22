/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-var-requires */
/**
 * ============================================================================
 * ONE COMPLETION ROW, ONE WRITER — THE OFFLINE DEVICE THAT WAS PAID FOR A DAY
 * IT WAS STILL RECORDED AS HAVING MISSED.
 * ============================================================================
 *
 * THE DEFECT. `habit_completions` had two writers and they had already diverged
 * by one line:
 *
 *   prisma-habit.repository.ts#recordCompletion   upsert … update: { status }
 *   event-ingestion.service.ts#writeHabitCompletion upsert … update: {}
 *                                                   create status hardcoded COMPLETED
 *
 * `family-daily-rollover` writes yesterday's `MISSED` rows for every active
 * habit with no completion. An offline device that syncs that completion the
 * next morning — well inside the 48-hour skew ingestion accepts — hits the
 * SECOND writer, whose `update: {}` touches nothing. The row stays `MISSED`.
 *
 * AND THE TWO HALVES DISAGREE ABOUT THE SAME FACT.
 * `findDistinctCompletionDates` filters `status IN (COMPLETED, COMPLETED_LATE)`,
 * so the day is not in the streak — while the domain event goes on to the
 * Rewards Engine and the completion IS PAID. The child is paid for a day the
 * product still records as missed, and their streak is broken by a completion
 * they actually made.
 *
 * The direct route PROMOTES the row; the ingest route could not, and could not
 * produce `COMPLETED_LATE` at all. Both doors now go through one
 * `recordHabitCompletion`, and both decide the status with one
 * `habitCompletionStatus`.
 *
 * EVERY ASSERTION BELOW READS THE PERSISTED ROW.
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
import { FamilyDateService } from '../../src/common/time/family-date.service';
import { getBusinessDate } from '../../src/common/time/family-date';
import { integrationDatabaseUrl } from '../tenancy/prisma-test-client';
import { freezeGoldenClock, GOLDEN_NOON } from '../golden/golden-world';

const describeIfDb = integrationDatabaseUrl() ? describe : describe.skip;

const CAIRO = 'Africa/Cairo';

/** A window that has certainly closed by the frozen noon, so «late» is not a
 *  coin flip: a habit due by 00:01 local is late at any hour after it. */
const EARLY_WINDOW_END = '00:01';

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
  const base = new PrismaClient({
    // PRISMA 7: `datasources` was removed from the constructor — driver
    // adapters are the only mode, so the adapter IS the connection. This
    // branch used to exist to AVOID the adapter; it now builds the same
    // client the branch above does, which is the honest end state: a test
    // must not reach the database through a different engine than
    // production does.
    adapter: new (require('@prisma/adapter-pg').PrismaPg)(
      new (require('pg').Pool)({ connectionString: url }),
    ),
  });
  const extended = base.$extends(createTenantExtension());
  extended.onModuleInit = async () => base.$connect();
  extended.onModuleDestroy = async () => base.$disconnect();
  return extended;
}

interface Household {
  familyId: string;
  userId: string;
  parentToken: string;
  childId: string;
  /** The habit the offline device completes for YESTERDAY. */
  habitId: string;
  /** A habit with a window that closed hours ago, for the LATE case,
   *  driven APP-DOOR first. */
  lateHabitId: string;
  /** The same shape of habit, driven DEVICE-DOOR ONLY — the case that proves
   *  the ingest path can produce `COMPLETED_LATE` on its own rather than
   *  inheriting a status the app door already wrote. */
  lateDeviceOnlyHabitId: string;
  deviceId: string;
  deviceToken: string;
}

describeIfDb('HABIT COMPLETIONS — the app button and the device event write one row one way', () => {
  let app: INestApplication;
  let http: any;
  let prisma: any;
  let tokens: TokenService;
  let relay: OutboxRelay;

  const stamp = Date.now();
  const H = {} as Household;

  let today: string;
  let yesterday: string;

  const sys = (what: string, fn: () => Promise<any>): Promise<any> =>
    runAsSystemAsync('TEST_FIXTURE', `habit completion one door: ${what}`, async () => await fn());

  // -- the readers -----------------------------------------------------------

  const completionRow = async (habitId: string, day: string): Promise<any> =>
    sys('completion row', () =>
      prisma.habitCompletion.findFirst({
        where: { habitId, date: FamilyDateService.toDateColumn(day) },
      }),
    );

  const ledger = (): Promise<any[]> =>
    sys('ledger', () =>
      prisma.rewardsLedgerEntry.findMany({ where: { childId: H.childId }, orderBy: { createdAt: 'asc' } }),
    );

  const parentAuth = () => ({ Authorization: `Bearer ${H.parentToken}` });
  const appAuth = () => ({ Authorization: `Bearer ${H.deviceToken}` });

  // -- the doors -------------------------------------------------------------

  /** DOOR B — the offline device, syncing a completion for a day that is over.
   *  `occurredAt` is inside ingestion's 48-hour past bound. */
  async function syncOfflineCompletion(habitId: string, occurredAt: Date, clientEventId: string): Promise<any> {
    const res = await request(http)
      .post('/events/batch')
      .set(appAuth())
      .send({
        deviceTime: new Date().toISOString(),
        events: [
          {
            clientEventId,
            type: 'HABIT_COMPLETED',
            occurredAt: occurredAt.toISOString(),
            payload: { habitId },
          },
        ],
      });
    await drainOutbox();
    return res;
  }

  async function drainOutbox(maxPasses = 8): Promise<void> {
    for (let i = 0; i < maxPasses; i++) {
      const pass = await relay.tick();
      if (pass.claimed === 0) break;
    }
  }

  // -- fixtures --------------------------------------------------------------

  async function pairDevice(familyId: string, childId: string): Promise<{ deviceId: string; token: string }> {
    const device = await sys('seed device', () =>
      prisma.device.create({
        data: { familyId, ownerType: 'CHILD', childId, platform: 'ANDROID', status: 'ACTIVE', pairedAt: new Date() },
        select: { id: true },
      }),
    );
    const pair = await runWithTenant({ familyId, actorType: 'DEVICE', actorId: device.id }, () =>
      tokens.issueTokenPair({ subjectId: device.id, actorType: 'DEVICE', familyId }),
    );
    return { deviceId: device.id, token: pair.accessToken };
  }

  async function createHabit(title: string, scheduledEndTime?: string): Promise<string> {
    const res = await request(http)
      .post(`/life-intelligence/habits/${H.childId}`)
      .set(parentAuth())
      .send({
        title,
        category: 'PERSONAL_CARE',
        recurrence: 'DAILY',
        ...(scheduledEndTime ? { scheduledStartTime: '00:00', scheduledEndTime } : {}),
      });
    if (!res.body?.id) throw new Error(`habit(${title}) -> ${res.status} ${JSON.stringify(res.body)}`);
    return res.body.id;
  }

  beforeAll(async () => {
    freezeGoldenClock(GOLDEN_NOON);
    today = getBusinessDate(new Date(), CAIRO);
    yesterday = FamilyDateService.addDays(today, -1);

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
    const { ValidationPipe } = require('@nestjs/common');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();

    http = app.getHttpServer();
    prisma = app.get(PrismaService);
    tokens = app.get(TokenService);
    relay = app.get(OutboxRelay);

    const email = `habit.onedoor.${stamp}@example.com`;
    const password = 'Habit-OneDoor-Passw0rd!23';
    const reg = await request(http).post('/auth/register').send({
      email,
      password,
      fullName: 'One Door Parent',
      familyName: 'One Door Family',
      timezone: CAIRO,
      acceptedTerms: true,
    });
    if (![200, 201].includes(reg.status)) {
      throw new Error(`register -> ${reg.status} ${JSON.stringify(reg.body)}`);
    }
    const login = await request(http).post('/auth/login').send({ email, password });
    H.parentToken = login.body.tokens?.accessToken ?? login.body.accessToken;
    if (!H.parentToken) throw new Error(`login -> ${JSON.stringify(login.body)}`);
    const claims = JSON.parse(Buffer.from(H.parentToken.split('.')[1], 'base64').toString());
    H.familyId = claims.familyId;
    H.userId = claims.sub;

    const child = await request(http)
      .post('/children')
      .set(parentAuth())
      .send({ firstName: 'One Door Kid', dateOfBirth: '2015-04-01' });
    if (!child.body?.id) throw new Error(`child -> ${child.status} ${JSON.stringify(child.body)}`);
    H.childId = child.body.id;

    H.habitId = await createHabit('قراءة قبل النوم');
    H.lateHabitId = await createHabit('صلاة الفجر', EARLY_WINDOW_END);
    H.lateDeviceOnlyHabitId = await createHabit('مراجعة الحفظ', EARLY_WINDOW_END);

    const paired = await pairDevice(H.familyId, H.childId);
    H.deviceId = paired.deviceId;
    H.deviceToken = paired.token;
  }, 300_000);

  afterAll(async () => {
    if (prisma) {
      await sys('teardown', async () => {
        await prisma.device.deleteMany({ where: { id: H.deviceId } });
        await prisma.family.deleteMany({ where: { id: H.familyId } });
        await prisma.user.deleteMany({ where: { id: H.userId } });
      });
    }
    jest.setSystemTime(GOLDEN_NOON);
    jest.useRealTimers();
    await app?.close();
  });

  // =========================================================================
  // 1. THE ROLLOVER WRITES YESTERDAY'S MISS — the ground the defect stands on.
  // =========================================================================

  describe('1. the day is over and the rollover has recorded it as missed', () => {
    it('marking yesterday missed writes a MISSED row for the untouched habit', async () => {
      const res = await request(http)
        .post(`/life-intelligence/habits/${H.childId}/mark-missed`)
        .set(parentAuth())
        .send({ date: yesterday });
      expect([200, 201]).toContain(res.status);

      const row = await completionRow(H.habitId, yesterday);
      expect(row).not.toBeNull();
      expect(row.status).toBe('MISSED');
    });
  });

  // =========================================================================
  // 2. THE OFFLINE SYNC — the assertion that was FALSE before the fix.
  // =========================================================================

  describe('2. the offline device syncs the completion it made yesterday', () => {
    it('the event is accepted', async () => {
      // Yesterday at Cairo noon: a real completion, 24h old, inside the 48h bound.
      const occurredAt = new Date(`${yesterday}T09:00:00.000Z`);
      const res = await syncOfflineCompletion(H.habitId, occurredAt, `offline-${stamp}`);
      expect([200, 201]).toContain(res.status);
      expect(res.body?.data?.results?.[0]?.status ?? res.body?.results?.[0]?.status).toBe('ACCEPTED');
    });

    /**
     * THE ROW, NOT THE RESPONSE. Before the fix this was `'MISSED'`: the ingest
     * writer's `update: {}` touched nothing on an existing row, so the rollover's
     * inferred miss outlived the real completion that disproved it.
     */
    it('THE ROW IS PROMOTED — a real completion beats an inferred miss', async () => {
      const row = await completionRow(H.habitId, yesterday);
      expect(row.status).toBe('COMPLETED');
    });

    /**
     * AND THE TWO HALVES NOW AGREE. This is the sentence the defect made false:
     * the reward was paid off the domain event while the streak query — which
     * filters `status IN (COMPLETED, COMPLETED_LATE)` — could not see the day.
     */
    it('the day the reward was paid for is a day the streak can see', async () => {
      const paid = (await ledger()).filter((e: any) => e.rewardType === 'XP');
      expect(paid.length).toBeGreaterThan(0);

      const score = await request(http)
        .get(`/life-intelligence/habits/${H.childId}/score`)
        .set(parentAuth());
      expect([200, 201]).toContain(score.status);
      // Yesterday is a qualifying day, so the trailing window counts it.
      expect(score.body.completedHabitDays).toBeGreaterThan(0);
    });
  });

  // =========================================================================
  // 3. THE STATUS THE INGEST DOOR COULD NOT PRODUCE AT ALL.
  // =========================================================================

  describe('3. COMPLETED_LATE is decided the same way at both doors', () => {
    it('the app button records a habit finished after its window as COMPLETED_LATE', async () => {
      const res = await request(http)
        .post(`/life-intelligence/self/habits/${H.lateHabitId}/complete`)
        .set(appAuth())
        .send({});
      expect([200, 201]).toContain(res.status);

      const row = await completionRow(H.lateHabitId, today);
      expect(row.status).toBe('COMPLETED_LATE');
    });

    it('and the device event for the same habit and day does not demote it', async () => {
      const res = await syncOfflineCompletion(H.lateHabitId, new Date(), `late-${stamp}`);
      expect([200, 201]).toContain(res.status);

      const row = await completionRow(H.lateHabitId, today);
      expect(row.status).toBe('COMPLETED_LATE');
    });

    /**
     * THE DEVICE DOOR ON ITS OWN — the assertion that was FALSE before the fix.
     * No app-door write precedes this one, so the status is entirely the ingest
     * path's own decision. It used to hardcode `COMPLETED` and could not express
     * lateness at all: the same habit finished at the same hour was on time or
     * late depending on whether the child's phone was online.
     */
    it('a habit the device alone reports, after its window, is COMPLETED_LATE', async () => {
      const res = await syncOfflineCompletion(
        H.lateDeviceOnlyHabitId,
        new Date(),
        `late-device-only-${stamp}`,
      );
      expect([200, 201]).toContain(res.status);

      const row = await completionRow(H.lateDeviceOnlyHabitId, today);
      expect(row).not.toBeNull();
      expect(row.status).toBe('COMPLETED_LATE');
    });

    it('and there is still exactly ONE row for that habit and day', async () => {
      const rows = await sys('rows', () =>
        prisma.habitCompletion.findMany({
          where: { habitId: H.lateHabitId, date: FamilyDateService.toDateColumn(today) },
        }),
      );
      expect(rows).toHaveLength(1);
    });
  });
});
