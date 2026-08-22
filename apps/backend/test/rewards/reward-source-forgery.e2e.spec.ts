/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-var-requires */
/**
 * PHASE C / P0 — THE REWARD-SOURCE FORGE MATRIX, EXECUTED AS ATTACKS.
 *
 * B1+B2 established the rule this suite re-tests on every remaining surface:
 *
 *   THE BUSINESS DATE IS A SERVER OUTPUT. `FamilyDateService` only. Never UTC,
 *   never server-local, and NEVER a date the child's device supplied.
 *
 * B1 applied it to Habits, B4 to Faith, and `LearningEngineService` carries its
 * own `resolveSessionDate`. `HealthEngineService.logActivity` did not get one,
 * and `POST /life-intelligence/self/health/activity-logs` — a DEVICE-token
 * route — passed `dto.date` straight through to `ActivityLog.date`, the column
 * the activity streak reads back VERBATIM (`getDailyActivityTotals`, which is
 * documented as timezone-free precisely because the column «already holds a
 * business date»). It held whatever the child typed.
 *
 * `PC-B-003` below is that exploit, written as the attack it is: a child with a
 * modified client backfills a month of exercise it never did, in one HTTP
 * conversation, and collects the 30-day `STREAK_ACHIEVED` reward.
 *
 * Every other test here is a NEGATIVE control on the same axis — the paths that
 * already hold, asserted so a future change cannot quietly un-hold them.
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
import { integrationDatabaseUrl } from '../tenancy/prisma-test-client';

const describeIfDb = integrationDatabaseUrl() ? describe : describe.skip;

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

/** `YYYY-MM-DD`, N days before today, on the UTC calendar the test family uses. */
const daysAgo = (n: number): string =>
  new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

describeIfDb('PHASE C — reward-source forgery (real PostgreSQL + Redis, real guards)', () => {
  let app: INestApplication;
  let http: any;
  let prisma: any;
  let tokens: TokenService;

  const stamp = Date.now();
  let familyId = '';
  let userId = '';
  let childId = '';
  let parentToken = '';
  let deviceToken = '';
  const createdDevices: string[] = [];

  const sys = (what: string, fn: () => Promise<any>): Promise<any> =>
    runAsSystemAsync('TEST_FIXTURE', `Phase C forgery suite: ${what}`, async () => await fn());

  const count = (model: string, where: any): Promise<number> =>
    sys(`count ${model}`, () => prisma[model].count({ where }));

  const ledgerSources = (): Promise<Array<{ source: string; idempotencyKey: string }>> =>
    sys('read ledger', () =>
      prisma.rewardsLedgerEntry.findMany({
        where: { familyId, childId, type: 'EARN' },
        select: { source: true, idempotencyKey: true },
      }),
    );

  const activityDates = (): Promise<string[]> =>
    sys('read activity dates', async () => {
      const rows = await prisma.activityLog.findMany({
        where: { familyId, childId },
        select: { date: true },
        orderBy: { date: 'asc' },
      });
      return rows.map((r: { date: Date }) => r.date.toISOString().slice(0, 10));
    });

  async function reset(): Promise<void> {
    await sys('reset', async () => {
      await prisma.rewardsLedgerEntry.deleteMany({ where: { familyId } });
      await prisma.rewardsAccount.deleteMany({ where: { familyId } });
      await prisma.activityLog.deleteMany({ where: { familyId } });
      await prisma.notification.deleteMany({ where: { familyId } });
      await prisma.lifeTimelineEvent.deleteMany({ where: { familyId } });
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
    tokens = app.get(TokenService);

    const email = `pc.forge.${stamp}@example.com`;
    const password = 'PhaseC-Forge-Passw0rd!23';
    await request(http)
      .post('/auth/register')
      .send({ email, password, fullName: 'PC Forge Parent', familyName: 'PC Forge Family', acceptedTerms: true });
    const login = await request(http).post('/auth/login').send({ email, password });
    parentToken = login.body.tokens?.accessToken ?? login.body.accessToken;
    const claims = JSON.parse(Buffer.from(parentToken.split('.')[1], 'base64').toString());
    familyId = claims.familyId;
    userId = claims.sub;

    const child = await request(http)
      .post('/children')
      .set({ Authorization: `Bearer ${parentToken}` })
      .send({ firstName: 'PC Forge Kid', dateOfBirth: '2014-03-01' });
    childId = child.body.id;

    // A streak rule on the HEALTH engine that pays for a 30-day activity
    // streak. `{}` matches unconditionally so the test measures the STREAK
    // input, not the rule language.
    await sys('seed streak rule', () =>
      prisma.rewardRule.create({
        data: {
          familyId,
          triggerEngine: 'health',
          eventType: 'STREAK_ACHIEVED',
          triggerCondition: { metric: 'activity', streakDays: 30 },
          rewardType: 'COINS',
          rewardAmountOrBadgeId: '100',
          isActive: true,
        },
      }),
    );

    const device = await sys('seed device', () =>
      prisma.device.create({
        data: {
          familyId,
          ownerType: 'CHILD',
          childId,
          platform: 'ANDROID',
          status: 'ACTIVE',
          pairedAt: new Date(),
        },
        select: { id: true },
      }),
    );
    createdDevices.push(device.id);
    const pair = await runWithTenant(
      { familyId, actorType: 'DEVICE', actorId: device.id },
      () => tokens.issueTokenPair({ subjectId: device.id, actorType: 'DEVICE', familyId }),
    );
    deviceToken = pair.accessToken;
  }, 120_000);

  afterAll(async () => {
    if (prisma) {
      await sys('teardown', async () => {
        await prisma.device.deleteMany({ where: { id: { in: createdDevices } } });
        await prisma.family.deleteMany({ where: { id: familyId } });
        await prisma.user.deleteMany({ where: { id: userId } });
      });
    }
    await app?.close();
    // Return the register-throttle budget this suite consumed.
    await clearRegisterThrottle();
  });

  // =========================================================================
  // PC-B-003 — THE ATTACK
  // =========================================================================

  describe('PC-B-003: forging the DATE of an activity log to manufacture a streak', () => {
    beforeAll(reset);

    it('THE EXPLOIT: a child backfills 30 days of exercise it never did, in one conversation', async () => {
      // The whole attack. No timing, no race, no privileged token — a paired
      // child device posting a field the DTO happily validates.
      for (let d = 29; d >= 0; d -= 1) {
        const res = await request(http)
          .post('/life-intelligence/self/health/activity-logs')
          .set({ Authorization: `Bearer ${deviceToken}` })
          .send({ date: daysAgo(d), activityType: 'running', durationMinutes: 60 });
        expect([200, 201]).toContain(res.status);
      }

      // WHAT THE SERVER MUST BELIEVE: every one of those logs happened TODAY,
      // because a device does not get to choose the day. Thirty rows on one
      // business date, not thirty business dates.
      const dates = await activityDates();
      expect(new Set(dates).size).toBe(1);
      expect(dates[0]).toBe(daysAgo(0));
    });

    it('and therefore collects NO 30-day streak reward — the streak is one day long', async () => {
      const streakGrants = (await ledgerSources()).filter((e) =>
        e.idempotencyKey.startsWith(`streak:${childId}:activity:`),
      );
      // `streak:{child}:activity:30` is the key the exploit was mining. A
      // one-day-old history cannot reach 3, let alone 30.
      expect(streakGrants.map((g) => g.idempotencyKey)).not.toContain(
        `streak:${childId}:activity:30`,
      );
      expect(streakGrants).toHaveLength(0);
      expect(await count('rewardsLedgerEntry', { familyId, childId, rewardType: 'COINS' })).toBe(0);
    });
  });

  // =========================================================================
  // PC-B-005 — THE VERIFICATION FLOOR, FORGED IN ONE JSON FIELD
  // =========================================================================

  describe('PC-B-005: forging `verifiedBy` to clear a rule that demands a parent', () => {
    let floorRuleId = '';
    let habitId = '';
    let relay: any;

    beforeAll(async () => {
      await reset();
      relay = app.get(
        require('../../src/modules/events/application/outbox.relay').OutboxRelay,
      );

      const habit = await request(http)
        .post(`/life-intelligence/habits/${childId}`)
        .set({ Authorization: `Bearer ${parentToken}` })
        .send({ title: 'PC Floor Habit', category: 'LEARNING' });
      habitId = habit.body.id;

      // THE PARENT'S INTENT, expressed the way B4 says to express it: «pay for
      // this habit ONLY when I have confirmed it». `minVerifiedBy: 'PARENT'` is
      // the whole control, and it is the highest rank in VERIFICATION_RANK.
      const rule = await sys('seed PARENT-floor rule', () =>
        prisma.rewardRule.create({
          data: {
            familyId,
            triggerEngine: 'habit-builder',
            eventType: 'HABIT_COMPLETED',
            triggerCondition: {},
            rewardType: 'XP',
            rewardAmountOrBadgeId: '250',
            minVerifiedBy: 'PARENT',
            isActive: true,
          },
          select: { id: true },
        }),
      );
      floorRuleId = rule.id;
    });

    it('THE EXPLOIT: the child posts its own completion and simply says a parent verified it', async () => {
      const res = await request(http)
        .post('/events/batch')
        .set({ Authorization: `Bearer ${deviceToken}` })
        .send({
          deviceTime: new Date().toISOString(),
          events: [
            {
              clientEventId: 'forge:verifiedBy:1',
              type: 'HABIT_COMPLETED',
              occurredAt: new Date().toISOString(),
              localDate: daysAgo(0),
              // One word. No race, no timing, no privileged token — a field on
              // a free-form payload that `EventIngestionService` copied
              // verbatim and `meetsVerificationFloor` then treated as fact.
              payload: { habitId, verifiedBy: 'PARENT' },
            },
          ],
        });
      expect(res.body.data.accepted).toBe(1);

      for (let i = 0; i < 4; i += 1) await relay.tick();

      // The rule demanded a parent. No parent was involved. Nothing is paid.
      const granted = (await ledgerSources()).filter(
        (e) => e.source === `reward_rule:${floorRuleId}`,
      );
      expect(granted).toHaveLength(0);
      expect(await count('rewardsLedgerEntry', { familyId, childId, amount: 250 })).toBe(0);
    });

    it('the claim survives as TELEMETRY, named so it cannot be mistaken for authority', async () => {
      const event = await sys('read stored event', () =>
        prisma.domainEvent.findFirst({
          where: { familyId, eventType: 'HABIT_COMPLETED' },
          select: { payload: true },
        }),
      );
      const payload = event.payload as Record<string, unknown>;
      // The authoritative field is the server's answer...
      expect(payload.verifiedBy).toBe('SELF');
      // ...and the device's claim is kept, under a name that states what it is,
      // exactly as B1 did for `clientReportedLocalDate`.
      expect(payload.clientReportedVerifiedBy).toBe('PARENT');
    });

    it('and a genuine PARENT-verified completion still clears the same floor', async () => {
      // The parent's own route asserts PARENT server-side, from the session —
      // which is the only place that claim can honestly come from.
      const res = await request(http)
        .post(`/life-intelligence/habits/${childId}/${habitId}/complete`)
        .set({ Authorization: `Bearer ${parentToken}` })
        .send({});
      expect([200, 201]).toContain(res.status);

      const granted = (await ledgerSources()).filter(
        (e) => e.source === `reward_rule:${floorRuleId}`,
      );
      expect(granted).toHaveLength(1);
    });
  });

  // =========================================================================
  // NEGATIVE CONTROLS — the surfaces that already hold
  // =========================================================================

  describe('the parent keeps a bounded back-fill; the device never gets one', () => {
    beforeAll(reset);

    it('a PARENT may back-date an activity log — a real product need, and a different trust level', async () => {
      const res = await request(http)
        .post(`/life-intelligence/health/${childId}/activity-logs`)
        .set({ Authorization: `Bearer ${parentToken}` })
        .send({ date: daysAgo(3), activityType: 'swimming', durationMinutes: 45 });
      expect([200, 201]).toContain(res.status);
      expect(await activityDates()).toEqual([daysAgo(3)]);
    });

    it('but never into the future — a future date is clamped to today, not stored', async () => {
      const future = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      await request(http)
        .post(`/life-intelligence/health/${childId}/activity-logs`)
        .set({ Authorization: `Bearer ${parentToken}` })
        .send({ date: future, activityType: 'cycling', durationMinutes: 30 });

      const dates = await activityDates();
      expect(dates).not.toContain(future);
      expect(dates).toContain(daysAgo(0));
    });
  });

  describe('the sources B1/B2/B4 already closed stay closed', () => {
    it('HABIT: a device-supplied date on /self/habits/:id/complete is not a field the route reads', async () => {
      const habit = await request(http)
        .post(`/life-intelligence/habits/${childId}`)
        .set({ Authorization: `Bearer ${parentToken}` })
        .send({ title: 'PC Forge Habit', category: 'LEARNING' });

      await request(http)
        .post(`/life-intelligence/self/habits/${habit.body.id}/complete`)
        .set({ Authorization: `Bearer ${deviceToken}` })
        .send({ date: daysAgo(10) });

      const rows = await sys('read completions', () =>
        prisma.habitCompletion.findMany({ where: { familyId, childId }, select: { date: true } }),
      );
      // EVERY completion sits on the family's today. The claim is about the
      // DAY, not the row count — earlier blocks in this suite legitimately
      // completed habits of their own.
      const dates = new Set(rows.map((r: { date: Date }) => r.date.toISOString().slice(0, 10)));
      expect([...dates]).toEqual([daysAgo(0)]);
    });

    it('EDUCATION: a device-supplied date on /self/learning/sessions is replaced by the family day', async () => {
      await request(http)
        .post('/life-intelligence/self/learning/sessions')
        .set({ Authorization: `Bearer ${deviceToken}` })
        .send({ subject: 'math', durationMinutes: 20, date: daysAgo(12) });

      const rows = await sys('read sessions', () =>
        prisma.learningSession.findMany({ where: { familyId, childId }, select: { date: true } }),
      );
      expect(rows.map((r: { date: Date }) => r.date.toISOString().slice(0, 10))).toEqual([daysAgo(0)]);
    });

    it('FAITH: a device-supplied date on /self/faith/:id/log is replaced by the family day', async () => {
      const practice = await request(http)
        .post(`/life-intelligence/faith/${childId}/practices`)
        .set({ Authorization: `Bearer ${parentToken}` })
        .send({ type: 'AZKAR', title: 'PC Forge Azkar' });

      await request(http)
        .post(`/life-intelligence/self/faith/${practice.body.id}/log`)
        .set({ Authorization: `Bearer ${deviceToken}` })
        .send({ date: daysAgo(8) });

      const rows = await sys('read faith logs', () =>
        prisma.faithPracticeLog.findMany({ where: { familyId, childId }, select: { date: true } }),
      );
      expect(rows.map((r: { date: Date }) => r.date.toISOString().slice(0, 10))).toEqual([daysAgo(0)]);
    });

    it('HYDRATION: the DTO carries no date at all — `loggedAt` is the server clock', async () => {
      const rejected = await request(http)
        .post('/life-intelligence/self/health/hydration-logs')
        .set({ Authorization: `Bearer ${deviceToken}` })
        .send({ amountMl: 250, loggedAt: new Date(Date.now() - 86_400_000).toISOString() });
      // `forbidNonWhitelisted` names the offending property rather than
      // silently dropping it — an old or hostile client learns it was refused.
      expect(rejected.status).toBe(400);
    });
  });

  // =========================================================================
  // THE OTHER FORGEABLE FIELDS — amount, result, rule, approval
  // =========================================================================

  describe('a child cannot state a reward amount, a verification result, or a rule', () => {
    it('REWARD AMOUNT: there is no device-reachable route that creates a reward rule', async () => {
      const res = await request(http)
        .post(`/life-intelligence/rewards/rules`)
        .set({ Authorization: `Bearer ${deviceToken}` })
        .send({
          triggerEngine: 'health',
          eventType: 'STREAK_ACHIEVED',
          rewardType: 'COINS',
          amount: 5000,
        });
      // A device token is not a parent session: the parent strategy rejects it
      // before any handler runs.
      expect([401, 403, 404]).toContain(res.status);
      expect(await count('rewardRule', { familyId, rewardAmountOrBadgeId: '5000' })).toBe(0);
    });

    it('MANUAL GRANT: the direct trigger endpoint is parent-only and refuses a device token', async () => {
      const res = await request(http)
        .post(`/life-intelligence/rewards/${childId}/trigger`)
        .set({ Authorization: `Bearer ${deviceToken}` })
        .send({ engine: 'health', type: 'STREAK_ACHIEVED', payload: { metric: 'activity', streakDays: 30 } });
      expect([401, 403, 404]).toContain(res.status);
    });

    it('APPROVAL: a child cannot approve its own redemption', async () => {
      const res = await request(http)
        .post('/life-intelligence/rewards/redemptions/00000000-0000-0000-0000-000000000001/approve')
        .set({ Authorization: `Bearer ${deviceToken}` })
        .send({});
      expect([401, 403, 404]).toContain(res.status);
    });

    it('DERIVED EVENTS: a device cannot post REWARD_GRANTED or STREAK_ACHIEVED on the wire', async () => {
      for (const type of ['REWARD_GRANTED', 'STREAK_ACHIEVED']) {
        const res = await request(http)
          .post('/events/batch')
          .set({ Authorization: `Bearer ${deviceToken}` })
          .send({
            deviceTime: new Date().toISOString(),
            events: [
              {
                clientEventId: `forge:${type}`,
                type,
                occurredAt: new Date().toISOString(),
                localDate: daysAgo(0),
                payload: { metric: 'activity', streakDays: 30 },
              },
            ],
          });
        expect(res.body.data.rejected).toBe(1);
        expect(res.body.data.results[0].errorCode).toBe('EVENT_TYPE_NOT_DEVICE_INGESTIBLE');
      }
    });
  });
});
