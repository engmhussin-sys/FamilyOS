/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-var-requires */
/**
 * ============================================================================
 * THE ASSESSMENT STRATEGY THAT COULD NEVER PAY — proven by execution, both
 * before and after.
 * ============================================================================
 *
 * WHAT WAS MEASURED BEFORE THE FIX, through this same real application, real
 * PostgreSQL and real Redis:
 *
 *   parent POST /reward-programs  verificationLevel=ASSESSMENT_SCORE -> 201
 *   learning_assessments rows in the entire database                 -> 0
 *   child submit #1 -> 201 FAILED  ASSESSMENT_NOT_FOUND  «لا يوجد تقييم مسجَّل
 *   child submit #2 -> 201 FAILED  ASSESSMENT_NOT_FOUND    لهذه المادة بعد.»
 *   child submit #3 -> 201 FAILED  ASSESSMENT_NOT_FOUND
 *   child submit #4 -> 201 ESCALATED ATTEMPTS_EXHAUSTED
 *   rewards_ledger_entries for the child                             -> 0
 *
 * A child told three times that they failed, for a condition NOTHING in this
 * product can satisfy: `latestAssessmentScore` reads `LearningAssessment`, and
 * `src/` has no writer for that table (see
 * `test/rewards/assessment-score-producer.guard.spec.ts`, which measures that
 * claim on every run instead of asserting it).
 *
 * WHAT THIS FILE FIXES IN PLACE. Two states, two different answers:
 *
 *   A PARENT CONFIGURING ONE NOW  -> 400 with a specific Arabic explanation.
 *      The failure is spent on the only person who can still choose a method
 *      that works, and it never reaches the child.
 *
 *   A PROGRAM THAT ALREADY EXISTS -> ESCALATED to the parent on submit.
 *      Not FAILED (blames the child for a defect that is not theirs), not zero,
 *      and NOT a proxy score derived from sessions, minutes or streaks — a
 *      score a child did not earn is worse than no score. Escalation is what
 *      this engine already does whenever the server cannot produce the input it
 *      needs (CODE_CHALLENGE since B5, RECITATION_SUBMISSION always).
 *
 * NOT BUILT HERE, deliberately and stated rather than implied: no quiz surface,
 * no grading, no assessment feature. The defect being fixed is that a parent
 * could configure a strategy that can never pay out while the product said
 * nothing — not that assessments are missing.
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
import { integrationDatabaseUrl } from '../tenancy/prisma-test-client';
import {
  MAX_VERIFICATION_ATTEMPTS,
  UNAVAILABLE_VERIFICATION_METHODS,
} from '../../src/shared/rewards/verification';

const describeIfDb = integrationDatabaseUrl() ? describe : describe.skip;

const SPEC = UNAVAILABLE_VERIFICATION_METHODS.ASSESSMENT_SCORE!;

/** A STUDY program whose only difference from a working one is the method. */
const ASSESSMENT_PROGRAM = {
  category: 'STUDY',
  activity: 'PRACTICE_SESSION',
  targetSpec: { quantity: 10, unit: 'مسألة' },
  durationMinutes: 20,
  verificationLevel: 'ASSESSMENT_SCORE',
  verificationConfig: { passScorePercent: 70, subject: 'MATH' },
  rewardSpec: { type: 'POINTS', amount: 20 },
  frequency: 'DAILY',
  maxPerDay: 5,
  maxPerWeek: 20,
};

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

describeIfDb('ASSESSMENT_SCORE — a strategy with no score producer (real PostgreSQL, real app)', () => {
  let app: INestApplication;
  let http: any;
  let prisma: any;
  let tokens: TokenService;
  let relay: OutboxRelay;

  const stamp = Date.now();
  const t: any = {};

  const sys = (what: string, fn: () => Promise<any>): Promise<any> =>
    runAsSystemAsync('TEST_FIXTURE', `assessment suite: ${what}`, async () => await fn());

  const asParent = () => ({ Authorization: `Bearer ${t.parentToken}` });
  const asChild = () => ({ Authorization: `Bearer ${t.deviceToken}` });

  beforeAll(async () => {
    {
      const Redis = require('ioredis');
      const client = new Redis(process.env.REDIS_URL as string);
      const keys = await client.keys('throttle:*');
      if (keys.length > 0) await client.del(...keys);
      await client.quit();
    }

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
    tokens = app.get(TokenService);
    relay = app.get(OutboxRelay);

    const email = `assess.${stamp}@example.com`;
    const password = 'Assess-Strategy-Passw0rd!23';
    const reg = await request(http)
      .post('/auth/register')
      .send({ email, password, fullName: 'Assess Parent', familyName: 'Assess Family', acceptedTerms: true });
    if (![200, 201].includes(reg.status)) throw new Error(`register -> ${reg.status} ${JSON.stringify(reg.body)}`);
    const login = await request(http).post('/auth/login').send({ email, password });
    t.parentToken = login.body.tokens?.accessToken ?? login.body.accessToken;
    const claims = JSON.parse(Buffer.from(t.parentToken.split('.')[1], 'base64').toString());
    t.familyId = claims.familyId;
    t.userId = claims.sub;

    const child = await request(http)
      .post('/children')
      .set(asParent())
      .send({ firstName: 'Assess Kid', dateOfBirth: '2015-04-01' });
    t.childId = child.body.id;

    const device: any = await sys('device', async () =>
      await prisma.device.create({
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
    const pair = await runWithTenant({ familyId: t.familyId, actorType: 'DEVICE', actorId: device.id }, () =>
      tokens.issueTokenPair({ subjectId: device.id, actorType: 'DEVICE', familyId: t.familyId }),
    );
    t.deviceToken = pair.accessToken;
  }, 120000);

  afterAll(async () => {
    if (app) await app.close();
  });

  // ==========================================================================
  // 1. THE PREMISE, RE-MEASURED ON EVERY RUN. Everything below is only worth
  //    reading while this is true, so it is asserted rather than assumed.
  // ==========================================================================
  it('nothing has put a single row in learning_assessments — the premise, measured', async () => {
    const rows = await sys('count assessments', async () => await prisma.learningAssessment.count({}));
    expect(rows).toBe(0);
  });

  // ==========================================================================
  // 2. THE REFUSAL — a parent cannot create one.
  // ==========================================================================
  describe('a parent configuring the strategy now', () => {
    it('is REFUSED at the service boundary, not told 201 and left to find out', async () => {
      const res = await request(http)
        .post('/reward-programs')
        .set(asParent())
        .send({ childId: t.childId, ...ASSESSMENT_PROGRAM });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('VERIFICATION_METHOD_UNAVAILABLE');

      // AND NOTHING WAS WRITTEN. A refusal that half-created the program would
      // be worse than the silent success it replaced.
      const programs = await sys('count programs', async () =>
        await prisma.rewardProgram.count({ where: { familyId: t.familyId } }),
      );
      expect(programs).toBe(0);
    });

    it('the refusal is a specific Arabic sentence a parent can act on — not a generic 400', async () => {
      const res = await request(http)
        .post('/reward-programs')
        .set(asParent())
        .send({ childId: t.childId, ...ASSESSMENT_PROGRAM });

      expect(res.body.messageAr).toBe(SPEC.messageAr);
      // Arabic, and it says the two things a parent needs: that this method
      // cannot work, and what to choose instead.
      expect(res.body.messageAr).toMatch(/[؀-ۿ]/);
      expect(res.body.messageAr).toContain('غير متاحة');
      expect(res.body.messageAr).toContain('اختبار قصير');
      // Never a stack trace, an exception string or an English fallback.
      expect(res.body.messageAr).not.toMatch(/Error|undefined|null|Exception/);
      expect(JSON.stringify(res.body)).not.toContain('at ');
      // The machine-readable half is there too, so a client can branch on it.
      expect(res.body.details?.scoreSourceModel).toBe('LearningAssessment');
    });

    it('every OTHER method on the very same program still creates — the gate is narrow', async () => {
      const res = await request(http)
        .post('/reward-programs')
        .set(asParent())
        .send({ childId: t.childId, ...ASSESSMENT_PROGRAM, verificationLevel: 'PARENT_CONFIRMATION' });
      expect([200, 201]).toContain(res.status);
      await sys('cleanup', async () => {
        await prisma.rewardRule.deleteMany({ where: { programId: res.body.id } });
        await prisma.rewardProgram.delete({ where: { id: res.body.id } });
      });
    });

    it('the catalogue the create form is built from SAYS SO, so the option is not offered blind', async () => {
      const res = await request(http).get('/reward-programs/catalogue').set(asParent());
      expect(res.status).toBe(200);
      const levels: any[] = res.body.verificationLevels;
      const assessment = levels.find((l) => l.code === 'ASSESSMENT_SCORE');
      expect(assessment.available).toBe(false);
      expect(assessment.unavailableReasonAr).toBe(SPEC.messageAr);
      // Every other method is still offered — the flag is not a blanket.
      expect(levels.filter((l) => l.available === false)).toHaveLength(1);
      expect(levels.find((l) => l.code === 'PARENT_CONFIRMATION').available).toBe(true);
      expect(levels.find((l) => l.code === 'PARENT_CONFIRMATION').unavailableReasonAr).toBeNull();
    });
  });

  // ==========================================================================
  // 3. THE PROGRAM THAT ALREADY EXISTS — the data the create gate cannot reach.
  // ==========================================================================
  describe("a program that already exists in someone's data", () => {
    let programId: string;
    /** ONE start + ONE submit, run once, asserted from several angles. A
     * second `start` on the same program is a 409 by design once an attempt is
     * open, so re-running the journey per test would be testing the fixture. */
    let submitted: any;

    /** Inserted through Prisma directly, which is exactly how it got there:
     * before the create gate existed, `POST /reward-programs` accepted it. */
    beforeAll(async () => {
      const program: any = await sys('legacy program', async () =>
        await prisma.rewardProgram.create({
          data: {
            familyId: t.familyId,
            childId: t.childId,
            category: ASSESSMENT_PROGRAM.category,
            activity: ASSESSMENT_PROGRAM.activity,
            targetSpec: ASSESSMENT_PROGRAM.targetSpec,
            targetSummaryAr: '10 مسألة',
            durationMinutes: ASSESSMENT_PROGRAM.durationMinutes,
            verificationLevel: 'ASSESSMENT_SCORE',
            verificationConfig: ASSESSMENT_PROGRAM.verificationConfig,
            rewardSpec: ASSESSMENT_PROGRAM.rewardSpec,
            frequency: 'DAILY',
            maxPerDay: 5,
            maxPerWeek: 20,
            status: 'ACTIVE',
            createdByUserId: t.userId,
          },
          select: { id: true },
        }),
      );
      programId = program.id;

      const started = await request(http).post('/self/achievements/start').set(asChild()).send({ programId });
      if (![200, 201].includes(started.status)) {
        throw new Error(`start -> ${started.status} ${JSON.stringify(started.body)}`);
      }
      submitted = await request(http)
        .post(`/self/achievements/${started.body.id}/submit`)
        .set(asChild())
        .send({ foregroundMinutes: 21, note: 'ذاكرت' });
    });

    afterAll(async () => {
      await sys('cleanup legacy', async () => {
        await prisma.verificationAttempt.deleteMany({ where: { familyId: t.familyId } });
        await prisma.achievementRequest.deleteMany({ where: { programId } });
        await prisma.rewardProgram.deleteMany({ where: { id: programId } });
      });
    });

    it('does not crash, does not score zero, and does not invent a score — it asks the parent', () => {
      expect(submitted.status).toBe(201);
      expect(submitted.body.status).toBe('PENDING_PARENT');
      expect(submitted.body.outcome.result).toBe('ESCALATED');
      expect(submitted.body.outcome.reasonCode).toBe('ASSESSMENT_SOURCE_UNAVAILABLE');
      // NOT a zero, NOT a proxy from sessions/minutes/streaks.
      expect(submitted.body.outcome.scorePercent).toBeNull();
      // And it happens on the FIRST attempt: the child is not sent back to
      // retry a condition that cannot change.
      expect(submitted.body.attemptsLeft).toBe(MAX_VERIFICATION_ATTEMPTS - 1);
    });

    it('the child reads Arabic that does not blame them for it', () => {
      expect(submitted.body.outcome.messageAr).toBe(SPEC.childMessageAr);
      expect(submitted.body.outcome.messageAr).toMatch(/[؀-ۿ]/);
      expect(submitted.body.outcome.messageAr).not.toMatch(/فشل|رسبت/);
      expect(submitted.body.outcome.messageAr).not.toMatch(/Error|Exception|undefined/);
    });

    it('nothing is granted and no reward event is emitted — an escalation is not a payout', async () => {
      for (let i = 0; i < 5; i++) {
        const pass = await relay.tick();
        if (pass.claimed === 0) break;
      }

      const ledger = await sys('ledger', async () =>
        await prisma.rewardsLedgerEntry.count({ where: { familyId: t.familyId, childId: t.childId } }),
      );
      expect(ledger).toBe(0);
      const verified = await sys('verified', async () =>
        await prisma.achievementRequest.count({ where: { programId, status: 'VERIFIED' } }),
      );
      expect(verified).toBe(0);
    });

    it('the attempt is still recorded as evidence — an escalation is not an erasure', async () => {
      const attempts = await sys('attempts', async () =>
        await prisma.verificationAttempt.count({
          where: { familyId: t.familyId, reasonCode: 'ASSESSMENT_SOURCE_UNAVAILABLE' },
        }),
      );
      expect(attempts).toBeGreaterThan(0);
    });

    it('a parent CAN still pause or archive it, and CANNOT put it back in front of the child', async () => {
      const paused = await request(http)
        .patch(`/reward-programs/${programId}`)
        .set(asParent())
        .send({ status: 'PAUSED' });
      expect([200, 201]).toContain(paused.status);

      // Re-activation is the hole a create-only gate would leave.
      const reactivated = await request(http)
        .patch(`/reward-programs/${programId}`)
        .set(asParent())
        .send({ status: 'ACTIVE' });
      expect(reactivated.status).toBe(400);
      expect(reactivated.body.code).toBe('VERIFICATION_METHOD_UNAVAILABLE');
      expect(reactivated.body.messageAr).toBe(SPEC.messageAr);

      const after = await sys('status', async () =>
        await prisma.rewardProgram.findFirst({ where: { id: programId }, select: { status: true } }),
      );
      expect(after.status).toBe('PAUSED');

      // Restore ACTIVE for the other tests' independence, by the same route the
      // legacy row arrived: directly, because the API now refuses it.
      await sys('restore', async () =>
        await prisma.rewardProgram.update({ where: { id: programId }, data: { status: 'ACTIVE' } }),
      );
    });
  });
});
