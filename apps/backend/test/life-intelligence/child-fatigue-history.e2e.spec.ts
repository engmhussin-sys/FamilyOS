/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-var-requires */
/**
 * ============================================================================
 * A PARENT AT THEIR DAILY MAXIMUM MUST NOT BE ABLE TO SILENCE THE CHILD.
 * ============================================================================
 *
 * WHAT WAS BROKEN. `SmartNotificationIntegrationService.fetchHistory` read
 * `notifications` — the PARENT's inbox — for EVERY candidate, and handed the
 * result to `evaluateFatigue`, whose `dailyMax`, `categoryDailyMax`,
 * `DUPLICATE` and per-type COOLDOWN all count over it. A message addressed to a
 * CHILD was therefore capped against THE PARENT'S DAY. `notification-class.ts`
 * forbids exactly that, in words, on `REWARD_GRANTED_CHILD`'s own `why`: «a
 * parent at their daily maximum must not be able to silence the child's own
 * news about their own work».
 *
 * AND THE MIRROR IMAGE, which is the half that is easy to miss: a child's
 * notifications are `child_messages` rows and are NOT in `notifications` in any
 * form. So the child's own cap never applied either — the array the guard
 * counted was, for a child, a stream about somebody else.
 *
 * THE SAME FIX, ONE LAYER DOWN. `NotificationContextAssembler.readHistory`
 * (`fb988c4`) made the engine's history audience-scoped; this suite is the same
 * property for the layer BELOW it, which the same commit did not touch:
 * `notifications` for PARENT, `child_messages` restricted to `source_event_id
 * IS NOT NULL` for CHILD, so a parent-typed «أحسنت» is not counted as a
 * notification.
 *
 * PRE-FIX AND POST-FIX, FROM THE SAME PERSISTED ROWS. `evaluateFatigue` is a
 * PURE function of (candidate, history, clock, policy), and the ONLY thing this
 * fix changed is which rows become `history`. So both answers are measurable
 * from one database state: §2 reads the parent's six rows out of PostgreSQL and
 * shows the guard refusing with `DAILY_MAX` — that is the pre-fix input and the
 * pre-fix answer, executed — and then reads the child's own inbox out of
 * PostgreSQL and shows the guard allowing. §3 then runs the REAL service end to
 * end and reads the `child_messages` row it wrote.
 *
 * THE CLOCK IS FROZEN BY CONSTRUCTION: `now` is a parameter of `notifyEvent`,
 * of `evaluateFatigue` and of every timestamp written below. Nothing in this
 * file reads a wall clock.
 */
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';

import { AppModule } from '../../src/app.module';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { createTenantExtension } from '../../src/common/tenancy/tenant.extension';
import { runAsSystemAsync } from '../../src/common/tenancy/system-context';
import { runWithTenant } from '../../src/common/tenancy/tenant-context';
import { getStartOfBusinessDay, getBusinessTimeHHMM } from '../../src/common/time/family-date';
import {
  DEFAULT_FATIGUE_POLICY,
  evaluateFatigue,
  type IRecentNotification,
} from '../../src/modules/life-intelligence/application/services/notification-fatigue-guard';
import { SmartNotificationIntegrationService } from '../../src/modules/life-intelligence/application/services/smart-notification-integration.service';
import { PrismaCommunicationRepository } from '../../src/modules/life-intelligence/infrastructure/repositories/prisma-communication.repository';
import { NOTIFICATION_REPOSITORY, type INotificationRepository } from '../../src/modules/notifications/application/ports/notification.repository.port';
import { integrationDatabaseUrl } from '../tenancy/prisma-test-client';

const describeIfDb = integrationDatabaseUrl() ? describe : describe.skip;

/** 12:00 on the family's own (UTC) clock — outside the default 21:00-07:00
 * quiet window, so nothing below is decided by the hour. 2029 so no other suite
 * in this shared database writes rows in the same window. */
const NOW = new Date('2029-04-10T12:00:00.000Z');
const TZ = 'UTC';

/** The window `fetchHistory` uses. Every seeded row is inside it AND inside the
 * family's own business day, so `dailyMax` and the rolling window agree and the
 * assertions are not resting on the difference. */
const HISTORY_WINDOW_HOURS = 24;

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

describeIfDb('THE CHILD IS NOT THE PARENT — fatigue history is the recipient\'s own inbox (real PostgreSQL)', () => {
  let app: INestApplication;
  let prisma: any;
  let integration: SmartNotificationIntegrationService;
  let childInbox: PrismaCommunicationRepository;
  let parentInbox: INotificationRepository;

  const stamp = Date.now();
  const createdFamilies: string[] = [];
  const createdUsers: string[] = [];

  let familyId = '';
  let childId = '';
  let userId = '';

  const sys = (what: string, fn: () => Promise<any>): Promise<any> =>
    runAsSystemAsync('TEST_FIXTURE', `child-fatigue-history suite: ${what}`, async () => await fn());

  const raw = <T>(sql: string, ...params: unknown[]): Promise<T> =>
    sys('raw sql', () => prisma.$queryRawUnsafe(sql, ...params)) as Promise<T>;

  const asFamily = <T>(fn: () => Promise<T>): Promise<T> =>
    runWithTenant({ familyId, actorType: 'SYSTEM', actorId: 'child-fatigue-history-test' }, fn);

  /** Both surfaces, read out of PostgreSQL. Never a return value. */
  const parentRows = (): Promise<any[]> =>
    raw<any[]>(
      `SELECT "type", "created_at" FROM "notifications"
        WHERE "family_id" = $1::uuid ORDER BY "created_at"`,
      familyId,
    );

  const childRows = (): Promise<any[]> =>
    raw<any[]>(
      `SELECT "category", "source_event_id", "approval_status", "created_at"
         FROM "child_messages"
        WHERE "family_id" = $1::uuid ORDER BY "created_at"`,
      familyId,
    );

  /** THE PRE-FIX INPUT: the parent's inbox, exactly as `fetchHistory` used to
   * build it for every candidate whatever its audience. */
  const historyAsPreFix = async (): Promise<IRecentNotification[]> => {
    const since = new Date(NOW.getTime() - HISTORY_WINDOW_HOURS * 3_600_000);
    const raws = await asFamily(() => parentInbox.findRecentForChild(childId, since));
    return raws.map((n: any) => ({
      type: n.type,
      priority: 'NORMAL' as const,
      createdAt: n.createdAt,
    }));
  };

  /**
   * THE POST-FIX INPUT for a CHILD candidate: the child's own inbox, over the
   * window the decision is actually being made in.
   *
   * BOTH BOUNDS ARE THE QUERY'S. `until: NOW` is required by
   * `readChildInboxHistory`, the one shared definition of this question, so a
   * row stamped after the instant under test is excluded by PostgreSQL — which
   * is why §3's «six seeded and not five» note below is about the row the real
   * service wrote with the DATABASE's clock.
   */
  const historyAsPostFix = async (): Promise<IRecentNotification[]> => {
    const since = new Date(NOW.getTime() - HISTORY_WINDOW_HOURS * 3_600_000);
    const raws = await asFamily(() =>
      childInbox.findRecentNotificationsForChild(childId, since, NOW),
    );
    return raws.map((m) => ({ type: m.type, priority: 'NORMAL' as const, createdAt: m.createdAt }));
  };

  /** The guard, over whichever history it is given, at the one frozen instant. */
  const guard = (history: IRecentNotification[], type = 'HYDRATION_REMINDER') =>
    evaluateFatigue(
      { type, priority: 'NORMAL', title: 'وقت الماء', body: 'استراحة قصيرة وكوب ماء', targetAudience: 'CHILD' },
      history,
      NOW,
      getBusinessTimeHHMM(NOW, TZ),
      getStartOfBusinessDay(NOW, TZ),
      DEFAULT_FATIGUE_POLICY,
    );

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue(offlinePrismaService())
      .compile();

    app = moduleRef.createNestApplication();
    await app.init();

    prisma = app.get(PrismaService);
    integration = app.get(SmartNotificationIntegrationService);
    childInbox = app.get(PrismaCommunicationRepository);
    parentInbox = app.get(NOTIFICATION_REPOSITORY);

    const family = await sys('create family', () =>
      prisma.family.create({ data: { name: `CFH ${stamp}`, timezone: TZ }, select: { id: true } }),
    );
    familyId = family.id;
    createdFamilies.push(familyId);

    const user = await sys('create user', () =>
      prisma.user.create({
        data: { email: `cfh.${stamp}@example.test`, passwordHash: 'x', fullName: 'CFH Parent' },
        select: { id: true },
      }),
    );
    userId = user.id;
    createdUsers.push(userId);
    await sys('create membership', () =>
      prisma.familyMember.create({ data: { familyId, userId, role: 'OWNER' } }),
    );

    const child = await sys('create child', () =>
      prisma.child.create({
        data: { familyId, firstName: 'محمد', dateOfBirth: new Date('2016-06-01T00:00:00.000Z') },
        select: { id: true },
      }),
    );
    childId = child.id;

    /**
     * SIX NOTIFICATIONS TO THE PARENT, EARLIER TODAY ON THE FAMILY'S OWN CLOCK.
     * `DEFAULT_FATIGUE_POLICY.dailyMax` is 6, so this parent is exactly at
     * their daily maximum. Spread across the morning so nothing is inside the
     * five-minute DUPLICATE window — this suite is about WHOSE day is counted,
     * and a duplicate refusal would answer a different question.
     *
     * `created_at` is WRITTEN, not defaulted: the instant under test is frozen
     * and a row stamped with the real wall clock would be a row from a
     * different day.
     */
    for (let hour = 5; hour < 11; hour += 1) {
      await sys('seed parent notification', () =>
        prisma.notification.create({
          data: {
            familyId,
            userId,
            childId,
            type: hour < 8 ? 'REWARD_GRANTED' : 'BADGE_EARNED',
            title: 'to the parent',
            body: 'to the parent',
            priority: 'NORMAL',
            createdAt: new Date(`2029-04-10T${String(hour).padStart(2, '0')}:00:00.000Z`),
            sourceEventId: `cfh:parent:${hour}:${stamp}`,
          },
        }),
      );
    }
  }, 300_000);

  afterAll(async () => {
    if (prisma) {
      for (const id of createdFamilies) {
        await sys('cleanup family', () => prisma.family.deleteMany({ where: { id } })).catch(() => undefined);
      }
      for (const id of createdUsers) {
        await sys('cleanup user', () => prisma.user.deleteMany({ where: { id } })).catch(() => undefined);
      }
    }
    await app?.close();
  }, 300_000);

  // ==========================================================================
  describe('1. THE PREMISE, AS ROWS', () => {
    it('the parent has six notifications today and the child has nothing at all', async () => {
      const parents = await parentRows();
      expect(parents).toHaveLength(DEFAULT_FATIGUE_POLICY.dailyMax);
      expect(parents.map((r) => r.type)).toEqual([
        'REWARD_GRANTED', 'REWARD_GRANTED', 'REWARD_GRANTED',
        'BADGE_EARNED', 'BADGE_EARNED', 'BADGE_EARNED',
      ]);
      // AND THEY ARE ALL INSIDE THE FAMILY'S BUSINESS DAY, so «today» is not
      // resting on the difference between a rolling window and a local day.
      const dayStart = getStartOfBusinessDay(NOW, TZ);
      for (const row of parents) expect(row.created_at.getTime()).toBeGreaterThanOrEqual(dayStart.getTime());

      expect(await childRows()).toHaveLength(0);
    }, 300_000);
  });

  // ==========================================================================
  describe('2. PRE-FIX AND POST-FIX, FROM THE SAME PERSISTED ROWS', () => {
    it('PRE-FIX: the parent\'s six rows, handed to the guard, REFUSE the child\'s message', async () => {
      // This is not a reconstruction of the old code — it IS the old code's
      // input. `fetchHistory` built exactly this array, from exactly this
      // query, for a CHILD candidate.
      const preFix = await historyAsPreFix();
      expect(preFix).toHaveLength(6);

      const decision = guard(preFix);
      expect(decision).toEqual({ allowed: false, blockedReason: 'DAILY_MAX' });
    }, 300_000);

    it('POST-FIX: the CHILD\'s own inbox, handed to the guard, ALLOWS it', async () => {
      const postFix = await historyAsPostFix();
      expect(postFix).toHaveLength(0);

      expect(guard(postFix)).toEqual({ allowed: true });
    }, 300_000);
  });

  // ==========================================================================
  describe('3. THE SERVICE, END TO END — the child is told, and the row exists', () => {
    const sourceEventId = `cfh:child:hydration:${Date.now()}`;

    it('the child\'s notification is DELIVERED while the parent is at their maximum', async () => {
      const outcome = await asFamily(() =>
        integration.notifyEvent(
          childId,
          familyId,
          {
            type: 'HYDRATION_REMINDER',
            priority: 'NORMAL',
            title: 'وقت الماء',
            body: 'مرّ وقت طويل — استراحة قصيرة وكوب ماء',
            targetAudience: 'CHILD',
            sourceEventId,
            // Already composed and already validated at the child's own band by
            // this test's own literals; the second, PARENT-facing rephrase is
            // what `preComposed` exists to skip and is not what is under test.
            preComposed: true,
          },
          NOW,
        ),
      );

      // Pre-fix this was `SUPPRESS` / `DAILY_MAX` and no row was written.
      expect(outcome).toEqual({ type: 'HYDRATION_REMINDER', targetAudience: 'CHILD', decision: 'SEND' });
    }, 300_000);

    it('THE ROW: one `child_messages` row, behind the approval gate, and NONE added to the parent', async () => {
      const children = await childRows();
      expect(children).toHaveLength(1);
      expect(children[0].category).toBe('HYDRATION_REMINDER');
      // The `:child` facet `deliverNow` appends, which is what keeps a cause
      // that notifies both audiences from colliding on one unique key.
      expect(children[0].source_event_id).toBe(`${sourceEventId}:child`);
      // B9 ADDS A CONSTRAINT, NOT AN EXEMPTION: still PENDING behind the
      // parent's approval gate. «The child is not silenced» is not «the child
      // is unsupervised».
      expect(children[0].approval_status).toBe('PENDING');

      // AND THE PARENT'S OWN SURFACE IS UNTOUCHED — still six.
      expect(await parentRows()).toHaveLength(DEFAULT_FATIGUE_POLICY.dailyMax);
    }, 300_000);

    it('AND THE CHILD\'S OWN CAP NOW APPLIES — which it never did before', async () => {
      // The fix is not «the child is exempt», it is «the child is measured».
      // Six more of the child's own messages take the child to `dailyMax`, and
      // the next one is refused — by the CHILD's inbox, with the parent's six
      // still sitting in `notifications` and now counting for nothing.
      //
      // SIX AND NOT FIVE, and the reason is worth writing down: the row §3
      // wrote through the real service carries the DATABASE's `now()` as its
      // `created_at`, not this suite's frozen instant, so it falls outside the
      // 24 hours before `NOW` and is correctly not in this history. Every row
      // the history is supposed to contain is therefore one this test stamped
      // itself.
      for (let i = 0; i < 6; i += 1) {
        await sys('seed child message', () =>
          prisma.childMessage.create({
            data: {
              familyId,
              childId,
              authorType: 'AI',
              approvalStatus: 'PENDING',
              category: 'STUDY_REMINDER',
              title: 'وقت المذاكرة',
              body: 'جاهز تبدأ؟',
              sourceEventId: `cfh:child:filler:${i}:${stamp}`,
              createdAt: new Date(`2029-04-10T${String(i + 4).padStart(2, '0')}:00:00.000Z`),
            },
          }),
        );
      }

      const history = await historyAsPostFix();
      expect(history).toHaveLength(DEFAULT_FATIGUE_POLICY.dailyMax);
      expect(guard(history)).toEqual({ allowed: false, blockedReason: 'DAILY_MAX' });

      const outcome = await asFamily(() =>
        integration.notifyEvent(
          childId,
          familyId,
          {
            type: 'EXERCISE_ENCOURAGEMENT',
            priority: 'NORMAL',
            title: 'حركة بسيطة',
            body: 'حركة بسيطة تبقي سلسلتك حية',
            targetAudience: 'CHILD',
            sourceEventId: `cfh:child:exercise:${stamp}`,
            preComposed: true,
          },
          NOW,
        ),
      );

      expect(outcome).toEqual({
        type: 'EXERCISE_ENCOURAGEMENT',
        targetAudience: 'CHILD',
        decision: 'SUPPRESS',
        reason: 'DAILY_MAX',
      });
      // Six seeded plus the one §3 delivered — and nothing new.
      expect(await childRows()).toHaveLength(7);
    }, 300_000);

    it('A PARENT-TYPED MESSAGE IS NOT A NOTIFICATION — `source_event_id IS NULL` is not counted', async () => {
      // `child_messages.source_event_id` is NULLABLE precisely because this
      // table also holds PARENT-AUTHORED messages. A parent typing «أحسنت» to
      // their child is a conversation; counting it towards a notification cap
      // would let a warm parent mute the product's own feedback loop — the same
      // class of mistake, one table over, as the one this suite closes.
      const before = (await historyAsPostFix()).length;

      await sys('seed a parent-typed message', () =>
        prisma.childMessage.create({
          data: {
            familyId,
            childId,
            fromUserId: userId,
            authorType: 'PARENT',
            approvalStatus: 'NOT_REQUIRED',
            category: 'GENERAL',
            title: 'أحسنت',
            body: 'أحسنت يا بطل',
            sourceEventId: null,
            createdAt: new Date('2029-04-10T11:30:00.000Z'),
          },
        }),
      );

      // The row is really there...
      expect(await childRows()).toHaveLength(8);
      // ...and the fatigue history did not grow by it.
      expect(await historyAsPostFix()).toHaveLength(before);
    }, 300_000);
  });
});
