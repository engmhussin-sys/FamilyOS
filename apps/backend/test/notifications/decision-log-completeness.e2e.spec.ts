/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-var-requires */
/**
 * ============================================================================
 * THE DECISION LOG'S AI COLUMNS — ASSERTED ON THE REAL PERSISTED ROWS.
 * ============================================================================
 *
 * WHAT WAS BROKEN, AND IT WAS MEASURED BEFORE IT WAS FIXED.
 * `engine-quality.e2e.spec.ts §6.14` ran two households through the real
 * consumer — one with `NOTIFICATION_AI_REPHRASE_ENABLED` unset and the stub
 * provider recording ZERO calls, one with it set and the stub recording a call
 * whose answer the safety gate then refused — and the two persisted rows were
 * IDENTICAL: `ai_rewritten = false, ai_failed = false` on both. So the state
 * that describes the overwhelming majority of this table carried four mutually
 * exclusive histories:
 *
 *   1. the feature was OFF, or no provider was bound: no model was called;
 *   2. it was ON, the model WAS called, and safety REFUSED its answer;
 *   3. it was ON, the model WAS called, and it returned the same sentence;
 *   4. it was ON but the TEMPLATE ITSELF failed safety, so `GENERIC` shipped
 *      and the model was never offered a sentence at all.
 *
 * `ai_allowed`, `ai_invoked` and `ai_safety_rejection` are the three facts that
 * separate them, and all three already existed inside
 * `NotificationComposerService` and were thrown away by the engine.
 *
 * THE THREE CASES BELOW ARE THE THREE THE BRIEF NAMES, and each is driven
 * end-to-end through `NotificationRewardConsumer` rather than by calling the
 * composer directly — the point is what reaches PostgreSQL, not what a pure
 * function returns:
 *
 *   §1  ALLOWED AND INVOKED       flag on, provider bound, model answers.
 *   §2  ALLOWED AND NOT INVOKED   flag on, provider bound — and the
 *                                 DETERMINISTIC TEMPLATE loses its own safety
 *                                 check first, so the model is never called.
 *                                 This is the case that was previously
 *                                 indistinguishable from «the feature is off».
 *   §3  NOT ALLOWED               flag unset. Zero model calls, and the row
 *                                 now says so rather than implying it.
 *
 * THE MODEL-CALL COUNT IS ASSERTED IN EVERY CASE, from the stub, because
 * `ai_invoked` claiming a call that did not happen would be a worse defect than
 * the one being fixed.
 *
 * THE CLOCK IS FROZEN. `NotificationRewardConsumer` passes no instant, so the
 * assembler falls to `input.now ?? new Date()`; a suite that leaves it alone is
 * a suite whose quiet-hours behaviour depends on when CI happened to start, and
 * a DEFER writes no `child_messages` row for §2 to read. January, for
 * `engine-quality`'s timezone reason.
 */
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'crypto';

import { AppModule } from '../../src/app.module';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { createTenantExtension } from '../../src/common/tenancy/tenant.extension';
import { runAsSystemAsync } from '../../src/common/tenancy/system-context';
import { runWithTenant } from '../../src/common/tenancy/tenant-context';
import { AI_PROVIDER, type IAIProvider } from '../../src/modules/ai-core/domain/ai-provider.port';
import { NotificationRewardConsumer } from '../../src/modules/events/application/consumers/notification-reward.consumer';
import { GENERIC_COPY_KEY } from '../../src/modules/notifications/domain/engine/notification-copy';
import { freezeGoldenClock } from '../golden/golden-world';
import { integrationDatabaseUrl } from '../tenancy/prisma-test-client';

const describeIfDb = integrationDatabaseUrl() ? describe : describe.skip;

const CAIRO = 'Africa/Cairo';
/** 12:00 Cairo — outside quiet hours, so every candidate below is decided and
 * delivered rather than deferred. */
const MIDDAY = new Date('2026-01-21T10:00:00.000Z');

/** A closed reason, upper snake case, as `NotificationComposerService.validate`
 * returns them (`ENUM_OR_PLACEHOLDER_LEAK`, `PARENT_COPY_UNSAFE`, or whatever
 * `ChildSafetyFilterService` names — `TOO_LONG` for the case §2 drives). */
const CLOSED_REASON = /^[A-Z][A-Z0-9_]*$/;

/**
 * A GOAL TITLE THAT CANNOT FIT A SIX-TO-EIGHT-YEAR-OLD'S SENTENCE. §11.3's
 * ceiling for that band is 8 words / 90 characters, and
 * `COPY_CATALOGUE.ACHIEVEMENT_VERIFIED` for the `5-7` tone band renders
 * «أهلك أكدوا {goalTitle} ✅» — so a title this long makes the TEMPLATE ITSELF
 * fail the same gate a model's answer would, which is exactly the branch that
 * returns before the model is ever offered anything.
 */
const OVERLONG_TITLE =
  'الآيات من الأولى إلى الخامسة من سورة الملك مع التفسير والمعاني والمراجعة الكاملة مع المعلّم في نهاية الأسبوع القادم بإذن الله';

const aiStub: { calls: number; provider: IAIProvider } = {
  calls: 0,
  provider: {
    async complete() {
      aiStub.calls += 1;
      return 'صياغة بديلة من النموذج لهذا الإشعار';
    },
  },
};

interface Household {
  readonly familyId: string;
  readonly childId: string;
  readonly userId: string;
}

describeIfDb('DECISION LOG COMPLETENESS — what the row can now say about the AI', () => {
  let app: INestApplication;
  let prisma: any;
  let rewardConsumer: NotificationRewardConsumer;

  const stamp = Date.now();
  const createdFamilies: string[] = [];
  const createdUsers: string[] = [];

  const sys = (what: string, fn: () => Promise<any>): Promise<any> =>
    runAsSystemAsync('TEST_FIXTURE', `decision-log-completeness: ${what}`, async () => await fn());

  const raw = <T>(sql: string, ...params: unknown[]): Promise<T> =>
    sys('raw sql', () => prisma.$queryRawUnsafe(sql, ...params)) as Promise<T>;

  const decisionFor = async (familyId: string, audience: 'PARENT' | 'CHILD'): Promise<any> => {
    const rows = await raw<any[]>(
      `SELECT * FROM "notification_decisions" WHERE "family_id" = $1::uuid
        AND "target_audience" = $2::text ORDER BY "created_at", "id"`,
      familyId,
      audience,
    );
    return rows[0];
  };

  /** THE COLUMNS THE DATABASE ACTUALLY HAS — read from `information_schema`,
   * not from the Prisma schema, because this suite reports on PostgreSQL. */
  const decisionColumns = async (): Promise<string[]> => {
    const rows = await raw<Array<{ column_name: string }>>(
      `SELECT column_name::text AS column_name FROM information_schema.columns
        WHERE table_name = 'notification_decisions'`,
    );
    return rows.map((r) => r.column_name).sort();
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

  async function createHousehold(label: string, dob = '2013-06-01'): Promise<Household> {
    const family = await sys('create family', () =>
      prisma.family.create({
        data: { name: `DLC ${label} ${stamp}`, timezone: CAIRO },
        select: { id: true },
      }),
    );
    createdFamilies.push(family.id);

    const user = await sys('create user', () =>
      prisma.user.create({
        data: {
          email: `dlc.${label}.${stamp}@example.test`,
          passwordHash: 'x',
          fullName: 'DLC Parent',
          locale: 'ar',
        },
        select: { id: true },
      }),
    );
    createdUsers.push(user.id);
    await sys('create membership', () =>
      prisma.familyMember.create({ data: { familyId: family.id, userId: user.id, role: 'OWNER' } }),
    );

    const child = await sys('create child', () =>
      prisma.child.create({
        data: {
          familyId: family.id,
          firstName: 'محمد',
          dateOfBirth: new Date(`${dob}T00:00:00.000Z`),
        },
        select: { id: true },
      }),
    );
    return { familyId: family.id, childId: child.id, userId: user.id };
  }

  const rewardEnvelope = (h: Household, payload: Record<string, unknown>): any => {
    const id = randomUUID();
    return {
      envelopeVersion: '1',
      id,
      type: 'REWARD_GRANTED',
      schemaVersion: 1,
      familyId: h.familyId,
      childId: h.childId,
      deviceId: null,
      aggregateType: 'RewardGrant',
      aggregateId: randomUUID(),
      occurredAt: new Date().toISOString(),
      receivedAt: new Date().toISOString(),
      idempotencyKey: `dlc:${id}`,
      clientEventId: null,
      traceId: null,
      payload: { childId: h.childId, grantCount: 1, ...payload },
    };
  };

  const deliver = (h: Household, envelope: any): Promise<void> =>
    runWithTenant(
      { familyId: h.familyId, actorType: 'SYSTEM', actorId: 'decision-log-completeness-test' },
      () => rewardConsumer.handle(envelope),
    );

  beforeAll(async () => {
    freezeGoldenClock(MIDDAY);

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue(offlinePrismaService())
      .overrideProvider(AI_PROVIDER)
      .useValue(aiStub.provider)
      .compile();

    app = moduleRef.createNestApplication();
    await app.init();

    prisma = app.get(PrismaService);
    rewardConsumer = app.get(NotificationRewardConsumer);
  }, 180_000);

  afterAll(async () => {
    delete process.env.NOTIFICATION_AI_REPHRASE_ENABLED;
    if (prisma) {
      for (const id of createdFamilies) {
        await sys('cleanup family', () => prisma.family.deleteMany({ where: { id } })).catch(
          () => undefined,
        );
      }
      for (const id of createdUsers) {
        await sys('cleanup user', () => prisma.user.deleteMany({ where: { id } })).catch(
          () => undefined,
        );
      }
    }
    await app?.close();
    jest.useRealTimers();
  }, 180_000);

  beforeEach(() => {
    jest.setSystemTime(MIDDAY);
    aiStub.calls = 0;
    delete process.env.NOTIFICATION_AI_REPHRASE_ENABLED;
  });

  // ==========================================================================
  // 0. THE COLUMNS EXIST, IN POSTGRESQL
  // ==========================================================================
  describe('0. the schema', () => {
    it('0.1 notification_decisions carries ai_allowed, ai_invoked and ai_safety_rejection', async () => {
      const columns = await decisionColumns();
      expect(columns).toEqual(
        expect.arrayContaining([
          'ai_allowed',
          'ai_failed',
          'ai_invoked',
          'ai_rewritten',
          'ai_safety_rejection',
        ]),
      );
    });

    it('0.2 the two booleans are NOT NULL with a false default, and the reason is nullable', async () => {
      const rows = await raw<Array<{ column_name: string; is_nullable: string; column_default: string | null }>>(
        `SELECT column_name::text AS column_name, is_nullable::text AS is_nullable,
                column_default::text AS column_default
           FROM information_schema.columns
          WHERE table_name = 'notification_decisions'
            AND column_name IN ('ai_allowed', 'ai_invoked', 'ai_safety_rejection')`,
      );
      const by = Object.fromEntries(rows.map((r) => [r.column_name, r]));
      expect(by.ai_allowed.is_nullable).toBe('NO');
      expect(by.ai_allowed.column_default).toBe('false');
      expect(by.ai_invoked.is_nullable).toBe('NO');
      expect(by.ai_invoked.column_default).toBe('false');
      // NULL is the MEANING «the safety gate had no objection», so this one is
      // nullable on purpose and has no default.
      expect(by.ai_safety_rejection.is_nullable).toBe('YES');
    });
  });

  // ==========================================================================
  // 1. ALLOWED AND INVOKED
  // ==========================================================================
  describe('1. rewriting allowed AND invoked', () => {
    let row: any;

    beforeAll(async () => {
      jest.setSystemTime(MIDDAY);
      const h = await createHousehold('allowed-invoked');
      process.env.NOTIFICATION_AI_REPHRASE_ENABLED = 'true';
      aiStub.calls = 0;
      await deliver(h, rewardEnvelope(h, { sourceEventType: 'HABIT_COMPLETED' }));
      delete process.env.NOTIFICATION_AI_REPHRASE_ENABLED;
      row = await decisionFor(h.familyId, 'PARENT');
      // THE MODEL GENUINELY RAN. Without this, `ai_invoked = true` would be an
      // assertion about a flag rather than about a call.
      expect(aiStub.calls).toBeGreaterThan(0);
    }, 120_000);

    it('1.1 the persisted row says allowed, invoked, and rewritten', () => {
      expect(row.ai_allowed).toBe(true);
      expect(row.ai_invoked).toBe(true);
      expect(row.ai_rewritten).toBe(true);
      expect(row.ai_failed).toBe(false);
    });

    it('1.2 nothing was refused, so the rejection column is NULL', () => {
      expect(row.ai_safety_rejection).toBeNull();
    });
  });

  // ==========================================================================
  // 2. ALLOWED AND NOT INVOKED — the case that used to look like «off»
  // ==========================================================================
  describe('2. rewriting allowed and NOT invoked', () => {
    let row: any;
    let callsForThisHousehold = 0;

    beforeAll(async () => {
      jest.setSystemTime(MIDDAY);
      // A SEVEN-YEAR-OLD: safety band `6-8`, ceiling 8 words / 90 characters.
      const h = await createHousehold('allowed-not-invoked', '2018-06-01');
      process.env.NOTIFICATION_AI_REPHRASE_ENABLED = 'true';
      aiStub.calls = 0;
      await deliver(
        h,
        rewardEnvelope(h, {
          sourceEventType: 'ACHIEVEMENT_VERIFIED',
          verifiedBy: 'PARENT',
          achievementSummaryAr: OVERLONG_TITLE,
          pointsGranted: 20,
        }),
      );
      callsForThisHousehold = aiStub.calls;
      delete process.env.NOTIFICATION_AI_REPHRASE_ENABLED;
      row = await decisionFor(h.familyId, 'CHILD');
    }, 120_000);

    it('2.1 the row says rewriting WAS allowed', () => {
      expect(row.ai_allowed).toBe(true);
    });

    it('2.2 …and that the model was never entered for this composition', () => {
      expect(row.ai_invoked).toBe(false);
      expect(row.ai_rewritten).toBe(false);
      expect(row.ai_failed).toBe(false);
    });

    it('2.3 the reason it stopped early is on the row, as a closed reason', () => {
      // The TEMPLATE lost its own safety check, so `GENERIC` shipped and the
      // model was never offered a sentence to rephrase. Before this column that
      // fact left only a log line.
      expect(typeof row.ai_safety_rejection).toBe('string');
      expect(row.ai_safety_rejection).toMatch(CLOSED_REASON);
      expect(row.copy_key).toBe(GENERIC_COPY_KEY);
    });

    it('2.4 the PARENT facet of the same cause did call the model — so §2.2 is about THIS row', () => {
      // The household had rephrasing on and the parent's template is fine, so
      // the stub was called at least once for the cause. `ai_invoked = false` on
      // the CHILD row is therefore per-composition, not per-household — which is
      // the resolution the column has to have to be worth anything.
      expect(callsForThisHousehold).toBeGreaterThan(0);
    });
  });

  // ==========================================================================
  // 3. NOT ALLOWED
  // ==========================================================================
  describe('3. rewriting NOT allowed', () => {
    let row: any;
    let calls = 0;

    beforeAll(async () => {
      jest.setSystemTime(MIDDAY);
      const h = await createHousehold('not-allowed');
      delete process.env.NOTIFICATION_AI_REPHRASE_ENABLED;
      aiStub.calls = 0;
      await deliver(h, rewardEnvelope(h, { sourceEventType: 'HABIT_COMPLETED' }));
      calls = aiStub.calls;
      row = await decisionFor(h.familyId, 'PARENT');
    }, 120_000);

    it('3.1 zero model calls, and the row says NOT ALLOWED rather than merely «not rewritten»', () => {
      expect(calls).toBe(0);
      expect(row.ai_allowed).toBe(false);
      expect(row.ai_invoked).toBe(false);
      expect(row.ai_rewritten).toBe(false);
      expect(row.ai_failed).toBe(false);
      expect(row.ai_safety_rejection).toBeNull();
    });
  });

  // ==========================================================================
  // 4. THE FINDING THAT IS NOT CLOSED — CHANNEL
  // ==========================================================================
  /**
   * «WHICH CHANNEL DID THIS GO OUT ON» STILL HAS NO ANSWER, and this section
   * pins the absence rather than inventing a column so that the day it gains a
   * producer, this goes red and the finding is closed deliberately.
   *
   * WHY IT IS NOT CLOSED HERE. The only honest producer is
   * `PushFanoutOutcome` (`SENT` / `SKIPPED` / `NONE` / `RETRYABLE` /
   * `PERMANENT` / `NO_RECIPIENT`), computed inside
   * `PrismaRuntimeAlertRepository.createForFamilyOwner` and discarded there:
   * `IRuntimeAlertRepository.createForFamilyOwner` returns `Promise<boolean>`,
   * so the value cannot reach the ledger without changing that contract AND
   * `SmartNotificationIntegrationService.deliverNow` / `deliverEvaluated` /
   * `INotificationOutcome` with it.
   *
   * AND ANYTHING ELSE WOULD BE A RESTATEMENT. The routing this layer knows —
   * PARENT to `notifications` plus a best-effort push, CHILD to the
   * approval-gated `child_messages` with no push at all — is a pure function of
   * `target_audience` and `outcome`, both already on the row. A column that
   * repeats two columns is a second source of truth, and this table's own
   * history (the decision NOT to add a `GOAL_ALMOST_DONE` progress column)
   * is the precedent for not adding it.
   */
  describe('4. channel — reported as an open finding, not invented', () => {
    it('4.1 there is still no channel column on notification_decisions', async () => {
      const columns = await decisionColumns();
      expect(columns.filter((c) => c.includes('channel'))).toEqual([]);
    });
  });
});
