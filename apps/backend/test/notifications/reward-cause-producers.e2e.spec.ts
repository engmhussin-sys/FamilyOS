/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-var-requires */
/**
 * ============================================================================
 * SPRINT F1 (`F1-002`) — THE CAUSE SURVIVES THE DOOR, AGAINST A REAL POSTGRESQL.
 * ============================================================================
 *
 * WHAT WAS MEASURED. `STREAK_ACHIEVED`, `DAILY_GOAL_COMPLETED`,
 * `LEARNING_GOAL_ACHIEVED` and `ACHIEVEMENT_VERIFIED` are reward-trigger /
 * domain types. Every one of them is paid by the same Rewards Engine and every
 * one of them arrived at the notification door as the single word
 * `REWARD_GRANTED`, so a child who kept a seven-day streak and a child whose
 * parent confirmed «الآيات ١–٥ من سورة الملك» read the identical sentence, and
 * four copy variants — each written in four tone bands, in two languages, each
 * with a quiet-hours class, two scoring rows and a deep-link destination — could
 * not be selected by anything in `src/`.
 *
 * `ACHIEVEMENT_REJECTED` was the opposite defect: production said it had no
 * consumer «deliberately» while the catalogue carried a child-facing sentence
 * for it. Resolved in favour of ANSWERING the child — the argument is at the
 * rejection branch in `achievement.service.ts` — and executed here.
 *
 * WHAT THIS SUITE EXECUTES. The real chain, end to end, with no test double
 * anywhere in it: a real domain event through the real `OutboxRelay`, the real
 * `RewardsCompletionConsumer` against real platform Reward Rules, the real
 * `NotificationRewardConsumer`, the real `SmartNotificationEngineService`, the
 * real decision provider, the REAL `ChildSafetyFilterService` and the real
 * delivery pipeline. EVERY COUNT AND EVERY SENTENCE BELOW IS READ BACK OUT OF
 * POSTGRESQL WITH SQL, never from a returned object — the defect class this
 * file exists for is the one where a return value said the right thing and the
 * row said something else.
 *
 *   1  STREAK          positive, negative (a habit; a streak with no day
 *                      count), replay.
 *   2  ACHIEVEMENT     positive (a parent confirmed), negative (the server
 *                      confirmed — «أهلك أكدوا» would be false), replay, AND
 *                      the one-grant/one-timeline/one-parent/one-child
 *                      regression that `e2e-01` and `e2e-13` pin.
 *   3  REJECTION       positive, negative (a goal with no nameable target),
 *                      replay, and no parent notification.
 *
 * SCOPED TO ITS OWN COHORT. Every assertion is `WHERE family_id = <a family
 * this file created>`; the shared database holds hundreds of families from
 * other suites and a count another suite could satisfy proves nothing.
 */
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';

import { AppModule } from '../../src/app.module';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { createTenantExtension } from '../../src/common/tenancy/tenant.extension';
import { runAsSystemAsync } from '../../src/common/tenancy/system-context';
import { runWithTenant } from '../../src/common/tenancy/tenant-context';
import { OutboxRelay } from '../../src/modules/events/application/outbox.relay';
import { OutboxWriter } from '../../src/modules/events/application/outbox.writer';
import { AchievementService } from '../../src/modules/rewards-engine/application/services/achievement.service';
import { RewardProgramService } from '../../src/modules/rewards-engine/application/services/reward-program.service';
import {
  hasEnumOrPlaceholderLeak,
  renderNotificationCopy,
} from '../../src/modules/notifications/domain/engine/notification-copy';
import { integrationDatabaseUrl } from '../tenancy/prisma-test-client';

const describeIfDb = integrationDatabaseUrl() ? describe : describe.skip;

const CAIRO = 'Africa/Cairo';

/** Midday, so nothing in this file is a deferral test by accident. */
const NOON = new Date('2026-01-15T10:00:00.000Z'); // 12:00 Cairo

/** An unresolved `{placeholder}`, which must never reach a human. */
const PLACEHOLDER = /\{[a-zA-Z0-9_]+\}/;
/** `PF-E-002` — Arabic prose with Latin numerals reads as a translation. */
const WESTERN_DIGITS = /[0-9]/;
const ARABIC_LETTERS = /[؀-ۿ]/;
/** CONTEXT §3 principle 7. The same list `e2e-06` and `e2e-10` screen with. */
const PUNITIVE = ['فشل', 'خطأ', 'رفض', 'مرفوض', 'عقاب', 'تحذير', 'مخالفة', 'تجاوز', 'سيئ'];

/** The same offline client every other integration suite in this repo builds. */
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

interface Household {
  readonly familyId: string;
  readonly childId: string;
  readonly userId: string;
  readonly childName: string;
}

describeIfDb('F1-002 — the reward CAUSE reaches the copy layer (real PostgreSQL)', () => {
  let app: INestApplication;
  let prisma: any;
  let relay: OutboxRelay;
  let outbox: OutboxWriter;
  let programs: RewardProgramService;
  let achievements: AchievementService;

  const stamp = Date.now();
  const createdFamilies: string[] = [];
  const createdUsers: string[] = [];

  const sys = (what: string, fn: () => Promise<any>): Promise<any> =>
    runAsSystemAsync('TEST_FIXTURE', `F1-002 cause suite: ${what}`, async () => await fn());

  const raw = <T>(sql: string, ...params: unknown[]): Promise<T> =>
    sys('raw sql', () => prisma.$queryRawUnsafe(sql, ...params)) as Promise<T>;

  /** THE RELAY, run to quiescence. Consumers emit further events, so one tick
   * is not the chain — `RewardsCompletionConsumer` writes `REWARD_GRANTED`,
   * which the next pass hands to `NotificationRewardConsumer`. */
  async function drain(maxPasses = 12): Promise<{ published: number; failed: number }> {
    let published = 0;
    let failed = 0;
    for (let pass = 0; pass < maxPasses; pass += 1) {
      const tick = await relay.tick();
      published += tick.published;
      failed += tick.failed;
      if (tick.claimed === 0) break;
    }
    return { published, failed };
  }

  const decisions = (familyId: string): Promise<any[]> =>
    raw<any[]>(
      `SELECT * FROM "notification_decisions" WHERE "family_id" = $1::uuid ORDER BY "created_at", "id"`,
      familyId,
    );

  const notifications = (familyId: string): Promise<any[]> =>
    raw<any[]>(
      `SELECT * FROM "notifications" WHERE "family_id" = $1::uuid ORDER BY "created_at", "id"`,
      familyId,
    );

  const childMessages = (familyId: string): Promise<any[]> =>
    raw<any[]>(
      `SELECT * FROM "child_messages" WHERE "family_id" = $1::uuid ORDER BY "created_at", "id"`,
      familyId,
    );

  const countOf = async (table: string, familyId: string): Promise<number> =>
    Number(
      (await raw<any[]>(`SELECT COUNT(*)::int AS n FROM "${table}" WHERE "family_id" = $1::uuid`, familyId))[0].n,
    );

  /**
   * THE FOUR NUMBERS THE PRODUCT'S CORE INVARIANT IS MADE OF — the same four
   * `e2e-01` and `e2e-13` pin: one business event, one reward, one timeline
   * entry, one parent notification, one child notification.
   */
  const countTheLoop = async (familyId: string) => ({
    ledger: Number(
      (
        await raw<any[]>(
          `SELECT COUNT(*)::int AS n FROM "rewards_ledger_entries" WHERE "family_id" = $1::uuid`,
          familyId,
        )
      )[0].n,
    ),
    timeline: Number(
      (
        await raw<any[]>(
          `SELECT COUNT(*)::int AS n FROM "life_timeline_events" e
             JOIN "children" c ON c."id" = e."child_id"
            WHERE c."family_id" = $1::uuid AND e."event_type" = 'reward_granted'`,
          familyId,
        )
      )[0].n,
    ),
    parentNotifications: await countOf('notifications', familyId),
    childMessages: await countOf('child_messages', familyId),
  });

  /** The decision row for one event type, of which there is exactly one. */
  async function theDecisionFor(familyId: string, eventType: string): Promise<any> {
    const rows = (await decisions(familyId)).filter((d) => d.event_type === eventType);
    expect(rows).toHaveLength(1);
    return rows[0];
  }

  /**
   * THE PROVENANCE CHECK, once. A stored sentence is only «from the catalogue»
   * if rendering the key the decision row NAMES, at the band and locale it
   * names, reproduces it byte for byte. Without this a template whose variable
   * a producer forgot degrades silently to `GENERIC` — still Arabic, still
   * leak-free, and still wrong.
   */
  function assertRenderedFromCatalogue(
    row: { title: string; body: string },
    decision: any,
    variables: Readonly<Record<string, string | number>>,
  ): void {
    const rendered = renderNotificationCopy({
      key: decision.copy_key,
      audience: decision.target_audience,
      toneBand: decision.age_band,
      locale: decision.locale,
      variables,
    });
    expect(row.body).toBe(rendered.body);
    expect(row.title).toBe(rendered.title);
    expect(rendered.resolvedKey).toBe(decision.copy_key);
  }

  /** No `{placeholder}`, no raw enum, and something a human would say. */
  function assertItReadsLikeASentence(text: string): void {
    expect(text).not.toMatch(PLACEHOLDER);
    expect(hasEnumOrPlaceholderLeak(text)).toBe(false);
    expect(text.trim().length).toBeGreaterThan(4);
  }

  // -- fixtures --------------------------------------------------------------

  async function createHousehold(label: string): Promise<Household> {
    const family = await sys('create family', () =>
      prisma.family.create({ data: { name: `F1-002 ${label} ${stamp}`, timezone: CAIRO }, select: { id: true } }),
    );
    createdFamilies.push(family.id);

    const user = await sys('create user', () =>
      prisma.user.create({
        data: { email: `f1002.${label}.${stamp}@example.test`, passwordHash: 'x', fullName: 'F1-002 Parent' },
        select: { id: true },
      }),
    );
    createdUsers.push(user.id);
    await sys('create membership', () =>
      prisma.familyMember.create({ data: { familyId: family.id, userId: user.id, role: 'OWNER' } }),
    );

    // Twelve years old on `NOON`, which is the `11-13` tone band — the band the
    // product's child copy is calibrated for and the one the goldens use.
    const child = await sys('create child', () =>
      prisma.child.create({
        data: { familyId: family.id, firstName: 'محمد', dateOfBirth: new Date('2014-01-01T00:00:00.000Z') },
        select: { id: true },
      }),
    );

    return { familyId: family.id, childId: child.id, userId: user.id, childName: 'محمد' };
  }

  const asFamily = <T>(familyId: string, fn: () => Promise<T>): Promise<T> =>
    runWithTenant({ familyId, actorType: 'SYSTEM', actorId: 'f1-002-test' }, fn);

  /**
   * A COMPLETION, written the way a real producer writes one: a domain event
   * with a `CompletionEvent` payload, through `OutboxWriter`, in the family's
   * own tenant scope. Nothing here reaches into the Rewards Engine — the relay
   * does, exactly as it does in production.
   */
  function writeCompletion(
    h: Household,
    type: string,
    completion: Record<string, unknown>,
    idempotencyKey: string,
  ): Promise<any> {
    return asFamily(h.familyId, () =>
      outbox.write({
        type: type as any,
        aggregateType: 'StreakMilestone',
        aggregateId: h.childId,
        childId: h.childId,
        deviceId: null,
        idempotencyKey,
        clientEventId: null,
        occurredAt: NOON,
        traceId: null,
        payload: {
          schemaVersion: 1,
          childId: h.childId,
          deviceId: null,
          localDate: '2026-01-15',
          occurredAt: NOON.toISOString(),
          idempotencyKey,
          pointsHint: null,
          ...completion,
        },
      }),
    );
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue(offlinePrismaService())
      .compile();

    app = moduleRef.createNestApplication();
    await app.init();

    prisma = app.get(PrismaService);
    relay = app.get(OutboxRelay);
    outbox = app.get(OutboxWriter);
    programs = app.get(RewardProgramService);
    achievements = app.get(AchievementService);
  }, 180_000);

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
  }, 180_000);

  // ==========================================================================
  // 1. STREAK_ACHIEVED — «حافظت على سلسلتك ٧ أيام»
  // ==========================================================================

  describe('1. STREAK_ACHIEVED — the child hears about the STREAK, not about «a reward»', () => {
    let home: Household;

    it('POSITIVE — a paid streak milestone selects STREAK_ACHIEVED for the child and states the real day count', async () => {
      home = await createHousehold('streak');
      expect(await countTheLoop(home.familyId)).toEqual({
        ledger: 0,
        timeline: 0,
        parentNotifications: 0,
        childMessages: 0,
      });

      // The event `StreakDetectionConsumer` emits, field for field: a
      // `CompletionEvent` of kind STREAK whose metadata carries the length
      // `computeCurrentStreak` derived from the child's real completion rows.
      await writeCompletion(
        home,
        'STREAK_ACHIEVED',
        {
          completionKind: 'STREAK',
          sourceType: 'StreakMilestone',
          sourceId: home.childId,
          verifiedBy: 'SYSTEM',
          metadata: { streakType: 'habits', streakDays: 7 },
        },
        `f1002:streak:${home.childId}:7`,
      );
      const drained = await drain();
      expect(drained.failed).toBe(0);

      // THE PAYMENT HAPPENED. Platform rule `default:habit:streak` pays coins
      // for `STREAK_ACHIEVED` on the `habit-builder` engine; without a grant
      // there is no `REWARD_GRANTED` and this whole section would be vacuous.
      const loop = await countTheLoop(home.familyId);
      expect(loop.ledger).toBeGreaterThan(0);
      expect(loop.parentNotifications).toBe(1);
      expect(loop.childMessages).toBe(1);

      // ===== THE ASSERTION THIS SECTION EXISTS FOR =====
      const childDecision = await theDecisionFor(home.familyId, 'REWARD_GRANTED_CHILD');
      expect(childDecision.target_audience).toBe('CHILD');
      expect(childDecision.copy_key).toBe('STREAK_ACHIEVED');
      // THE TYPE DID NOT MOVE. The scorer, the quiet-hours matrix and the
      // analytics read `type`; only the COPY KEY varies.
      const [childRow] = await childMessages(home.familyId);
      // THE TYPE IS UNCHANGED, on the row AND in the ledger. `child_messages`
      // stores the notification TYPE in its `category` column (the delivery
      // pipeline writes `candidate.type` there), and `notification_decisions`
      // stores it twice — so a change of `type` made to fix a SENTENCE would be
      // visible in three places, and none of them moved.
      expect(childRow.category).toBe('REWARD_GRANTED_CHILD');
      expect(childDecision.notification_type).toBe('REWARD_GRANTED_CHILD');
      expect(childDecision.event_type).toBe('REWARD_GRANTED_CHILD');

      // THE NUMBER IS THE STREAK'S, in the product's first language.
      expect(childRow.body).toContain('٧');
      expect(childRow.body).toMatch(ARABIC_LETTERS);
      expect(childRow.body).not.toMatch(WESTERN_DIGITS);
      assertItReadsLikeASentence(childRow.body);
      assertItReadsLikeASentence(childRow.title);
      assertRenderedFromCatalogue(childRow, childDecision, { days: 7 });

      // NON-PUNITIVE, still — CONTEXT §3 principle 7.
      for (const word of PUNITIVE) expect(childRow.body).not.toContain(word);

      // ===== AND THE TWO AUDIENCES ARE STILL TWO SENTENCES =====
      const [parentRow] = await notifications(home.familyId);
      const parentDecision = await theDecisionFor(home.familyId, 'REWARD_GRANTED');
      expect(parentDecision.target_audience).toBe('PARENT');
      // The parent's cause is a streak, which is not a parent-authored goal, so
      // the honest parent sentence is the one that names no goal.
      expect(parentDecision.copy_key).toBe('REWARD_GRANTED');
      expect(parentRow.body).not.toBe(childRow.body);
      expect(parentRow.body).toContain(home.childName);
      // A parent is addressed in the third person about their child; the child
      // is addressed in the second person and never by their own name.
      expect(childRow.body).not.toContain(home.childName);
      assertItReadsLikeASentence(parentRow.body);
    }, 120_000);

    it('NEGATIVE — a completion that is NOT a streak leaves the generic child sentence in place', async () => {
      const other = await createHousehold('habit');
      await writeCompletion(
        other,
        'HABIT_COMPLETED',
        {
          completionKind: 'HABIT',
          sourceType: 'HabitOccurrence',
          sourceId: other.childId,
          verifiedBy: 'SELF',
          metadata: {},
        },
        `f1002:habit:${other.childId}:2026-01-15`,
      );
      expect((await drain()).failed).toBe(0);

      const childDecision = await theDecisionFor(other.familyId, 'REWARD_GRANTED_CHILD');
      expect(childDecision.copy_key).toBe('REWARD_GRANTED_CHILD');
      const [childRow] = await childMessages(other.familyId);
      expect(childRow.body).not.toContain('سلسلتك');
      assertItReadsLikeASentence(childRow.body);
      assertRenderedFromCatalogue(childRow, childDecision, {});
    }, 120_000);

    it('NEGATIVE — a streak whose day count did not survive falls back to a WHOLE sentence, never a placeholder', async () => {
      const nameless = await createHousehold('streak-no-days');
      await writeCompletion(
        nameless,
        'STREAK_ACHIEVED',
        {
          completionKind: 'STREAK',
          sourceType: 'StreakMilestone',
          sourceId: nameless.childId,
          verifiedBy: 'SYSTEM',
          // The metadata a malformed or older producer would leave: the cause is
          // a streak and the LENGTH is missing.
          metadata: { streakType: 'habits' },
        },
        `f1002:streak-nodays:${nameless.childId}:7`,
      );
      expect((await drain()).failed).toBe(0);

      const childDecision = await theDecisionFor(nameless.familyId, 'REWARD_GRANTED_CHILD');
      // NOT `STREAK_ACHIEVED`: «سلسلتك وصلت {days} أيام» with no day count would
      // be refused by the renderer and degrade to `GENERIC`, which is worse than
      // the complete generic reward sentence.
      expect(childDecision.copy_key).toBe('REWARD_GRANTED_CHILD');
      const [childRow] = await childMessages(nameless.familyId);
      assertItReadsLikeASentence(childRow.body);
      expect(childRow.body).not.toContain('days');
    }, 120_000);

    it('IDEMPOTENCY AND REPLAY — the same completion delivered again moves nothing, read back out of PostgreSQL', async () => {
      const before = await countTheLoop(home.familyId);
      const beforeDecisions = (await decisions(home.familyId)).length;

      // THE SAME KEY, which is what an at-least-once outbox really redelivers.
      // `domain_events (family_id, idempotency_key)` refuses the second row, so
      // `OutboxWriter.write` reports `created: false` and nothing is queued.
      const again = await writeCompletion(
        home,
        'STREAK_ACHIEVED',
        {
          completionKind: 'STREAK',
          sourceType: 'StreakMilestone',
          sourceId: home.childId,
          verifiedBy: 'SYSTEM',
          metadata: { streakType: 'habits', streakDays: 7 },
        },
        `f1002:streak:${home.childId}:7`,
      );
      expect(again.created).toBe(false);
      expect((await drain()).failed).toBe(0);

      // AND THE REDELIVERY THE MARKER CANNOT ABSORB. `consumed_messages` is an
      // OPTIMISATION by its own docstring — delete the markers and the handlers
      // run again — so the guarantee has to be a database constraint. This is
      // the case `reward-engine.e2e.spec.ts` proved was NOT covered by the
      // five-minute fatigue window.
      await sys('delete consumer markers', () =>
        prisma.$executeRawUnsafe(
          `DELETE FROM "consumed_messages" WHERE "family_id" = $1::uuid`,
          home.familyId,
        ),
      );
      await sys('requeue the reward announcement', () =>
        prisma.$executeRawUnsafe(
          `UPDATE "outbox_messages"
              SET "status" = 'PENDING', "attempt_count" = 0, "next_attempt_at" = NOW(),
                  "locked_by" = NULL, "locked_at" = NULL, "published_at" = NULL
            WHERE "family_id" = $1::uuid`,
          home.familyId,
        ),
      );
      const replay = await drain();
      expect(replay.failed).toBe(0);
      // NOT VACUOUS. The messages really were re-published and the consumers
      // really did run again — a requeue that silently claimed nothing would
      // make every «still one» assertion below prove nothing at all.
      expect(replay.published).toBeGreaterThan(0);

      expect(await countTheLoop(home.familyId)).toEqual(before);
      expect((await decisions(home.familyId)).length).toBe(beforeDecisions);

      // AND THE SENTENCE IS STILL THE STREAK'S — a replay that had re-decided
      // with the cause lost would have rewritten the row to the generic key.
      const childDecision = await theDecisionFor(home.familyId, 'REWARD_GRANTED_CHILD');
      expect(childDecision.copy_key).toBe('STREAK_ACHIEVED');
    }, 180_000);
  });

  // ==========================================================================
  // 2. ACHIEVEMENT_VERIFIED — «تم تأكيد إنجازك في … من أهلك»
  // ==========================================================================

  describe('2. ACHIEVEMENT_VERIFIED — a child who WAITED for a human is told a human answered', () => {
    let home: Household;
    let goalTitle = '';

    /** The flagship program, created through the real service so the companion
     * `RewardRule` rows that pay it are materialised the way production does. */
    async function aQuranGoal(h: Household, verificationLevel: string): Promise<string> {
      const created = await asFamily(h.familyId, () =>
        programs.create(h.familyId, h.userId, {
          childId: h.childId,
          category: 'QURAN',
          activity: 'QURAN_MEMORIZE_AYAH_RANGE',
          targetSpec: { surahNumber: 67, fromAyah: 1, toAyah: 5 },
          durationMinutes: 20,
          verificationLevel,
          rewardSpec: { type: 'POINTS', amount: 20 },
          frequency: 'DAILY',
          maxPerDay: 1,
          maxPerWeek: 7,
        } as any),
      );
      return created.id;
    }

    it('POSITIVE — a parent confirms, and the child reads WHICH goal was confirmed', async () => {
      home = await createHousehold('achv-parent');
      const programId = await aQuranGoal(home, 'PARENT_CONFIRMATION');

      const started = await asFamily(home.familyId, () => achievements.start(home.childId, programId, NOON));
      // PARENT_CONFIRMATION escalates: the server's honest answer is «ask a
      // human», and it grants nothing.
      const submitted = await asFamily(home.familyId, () =>
        achievements.submit(home.childId, started.id, { selfConfirmed: true } as any, NOON),
      );
      expect(submitted.status).toBe('PENDING_PARENT');
      expect(await countTheLoop(home.familyId)).toEqual({
        ledger: 0,
        timeline: 0,
        parentNotifications: 0,
        childMessages: 0,
      });

      const decided = await asFamily(home.familyId, () =>
        achievements.decide(home.userId, started.id, true, undefined, NOON),
      );
      expect(decided.status).toBe('VERIFIED');
      goalTitle = decided.programId ? 'الآيات 1–5 من سورة الملك' : '';
      expect((await drain()).failed).toBe(0);

      // ===== THE INVARIANT `e2e-01` AND `e2e-13` PIN, UNCHANGED =====
      // One business event -> one reward -> one timeline entry -> one parent
      // notification -> one child notification. Making the cause specific must
      // not be able to make any of these two.
      expect(await countTheLoop(home.familyId)).toEqual({
        ledger: 1,
        timeline: 1,
        parentNotifications: 1,
        childMessages: 1,
      });

      // ===== THE CHILD'S SENTENCE IS ABOUT THE CONFIRMATION =====
      const childDecision = await theDecisionFor(home.familyId, 'REWARD_GRANTED_CHILD');
      expect(childDecision.copy_key).toBe('ACHIEVEMENT_VERIFIED');
      expect(childDecision.target_audience).toBe('CHILD');
      expect(childDecision.age_band).toBe('11-13');
      const [childRow] = await childMessages(home.familyId);
      // THE TYPE DID NOT MOVE — only the copy key did.
      expect(childRow.category).toBe('REWARD_GRANTED_CHILD');
      expect(childDecision.notification_type).toBe('REWARD_GRANTED_CHILD');
      expect(childRow.body).toContain('إنجازك');
      // THE GOAL, BY NAME — and in Arabic-Indic numerals, because a child's
      // Arabic sentence with Latin numerals is `PF-E-002`.
      expect(childRow.body).toContain('سورة الملك');
      expect(childRow.body).not.toMatch(WESTERN_DIGITS);
      expect(childRow.body).not.toContain(home.childName);
      assertItReadsLikeASentence(childRow.body);
      assertRenderedFromCatalogue(childRow, childDecision, { goalTitle });
      for (const word of PUNITIVE) expect(childRow.body).not.toContain(word);

      // ===== AND THE PARENT'S IS A DIFFERENT SENTENCE, TO A DIFFERENT PERSON =====
      const parentDecision = await theDecisionFor(home.familyId, 'REWARD_GRANTED');
      expect(parentDecision.copy_key).toBe('REWARD_GRANTED_WITH_GOAL');
      const [parentRow] = await notifications(home.familyId);
      expect(parentRow.body).not.toBe(childRow.body);
      expect(parentRow.body).toContain(home.childName);
      // The parent is told the NUMBER; the child is not, because the child's own
      // app already shows their balance.
      expect(parentRow.body).toContain('نقطة');
      expect(childRow.body).not.toContain('نقطة');
      assertItReadsLikeASentence(parentRow.body);
    }, 180_000);

    it('NEGATIVE — when the SERVER verified it, the child is not told their family confirmed anything', async () => {
      const selfChecked = await createHousehold('achv-system');
      // HOUSEWORK, because `SELF_CHECK` on a Quran program is refused by the
      // low-trust gate — which is itself the reason this negative case exists in
      // the product at all.
      const created = await asFamily(selfChecked.familyId, () =>
        programs.create(selfChecked.familyId, selfChecked.userId, {
          childId: selfChecked.childId,
          category: 'HOUSEWORK',
          activity: 'CHORE',
          targetSpec: { quantity: 1, unit: 'مهمة' },
          durationMinutes: 10,
          verificationLevel: 'SELF_CHECK',
          rewardSpec: { type: 'POINTS', amount: 10 },
        } as any),
      );
      const started = await asFamily(selfChecked.familyId, () =>
        achievements.start(selfChecked.childId, created.id, NOON),
      );
      const submitted = await asFamily(selfChecked.familyId, () =>
        achievements.submit(selfChecked.childId, started.id, { selfConfirmed: true } as any, NOON),
      );
      expect(submitted.status).toBe('VERIFIED');
      expect((await drain()).failed).toBe(0);

      const childDecision = await theDecisionFor(selfChecked.familyId, 'REWARD_GRANTED_CHILD');
      // «أهلك أكدوا» about something no human looked at would be a flattering
      // lie, so the honest generic sentence is what ships.
      expect(childDecision.copy_key).toBe('REWARD_GRANTED_CHILD');
      const [childRow] = await childMessages(selfChecked.familyId);
      expect(childRow.body).not.toContain('أهلك');
      expect(childRow.body).not.toContain('تأكيد');
      assertItReadsLikeASentence(childRow.body);
      assertRenderedFromCatalogue(childRow, childDecision, {});
    }, 180_000);

    it('IDEMPOTENCY AND REPLAY — the whole loop delivered again is still one of everything', async () => {
      const before = await countTheLoop(home.familyId);
      expect(before).toEqual({ ledger: 1, timeline: 1, parentNotifications: 1, childMessages: 1 });

      await sys('delete consumer markers', () =>
        prisma.$executeRawUnsafe(
          `DELETE FROM "consumed_messages" WHERE "family_id" = $1::uuid`,
          home.familyId,
        ),
      );
      await sys('requeue every message', () =>
        prisma.$executeRawUnsafe(
          `UPDATE "outbox_messages"
              SET "status" = 'PENDING', "attempt_count" = 0, "next_attempt_at" = NOW(),
                  "locked_by" = NULL, "locked_at" = NULL, "published_at" = NULL
            WHERE "family_id" = $1::uuid`,
          home.familyId,
        ),
      );
      const replay = await drain();
      expect(replay.failed).toBe(0);
      // NOT VACUOUS — the chain really re-ran; see section 1's replay.
      expect(replay.published).toBeGreaterThan(0);

      // READ BACK OUT OF THE TABLES, not from a return value.
      expect(await countTheLoop(home.familyId)).toEqual(before);
      const childDecision = await theDecisionFor(home.familyId, 'REWARD_GRANTED_CHILD');
      expect(childDecision.copy_key).toBe('ACHIEVEMENT_VERIFIED');
      const [childRow] = await childMessages(home.familyId);
      expect(childRow.body).toContain('سورة الملك');
    }, 180_000);
  });

  // ==========================================================================
  // 3. ACHIEVEMENT_REJECTED — the key production said must have no producer
  // ==========================================================================

  describe('3. ACHIEVEMENT_REJECTED — the child is answered, and never blamed', () => {
    let home: Household;
    let achievementId = '';

    it('POSITIVE — a parent declines, and the child is told WHICH goal to look at with them', async () => {
      home = await createHousehold('rejected');
      const created = await asFamily(home.familyId, () =>
        programs.create(home.familyId, home.userId, {
          childId: home.childId,
          category: 'QURAN',
          activity: 'QURAN_MEMORIZE_AYAH_RANGE',
          targetSpec: { surahNumber: 67, fromAyah: 1, toAyah: 5 },
          durationMinutes: 20,
          verificationLevel: 'PARENT_CONFIRMATION',
          rewardSpec: { type: 'POINTS', amount: 20 },
        } as any),
      );
      const started = await asFamily(home.familyId, () => achievements.start(home.childId, created.id, NOON));
      achievementId = started.id;
      await asFamily(home.familyId, () =>
        achievements.submit(home.childId, started.id, { selfConfirmed: true } as any, NOON),
      );

      // The parent declines, WITH a note. The note is the thing that must not
      // travel: it is free text one human wrote about another human's work.
      const decided = await asFamily(home.familyId, () =>
        achievements.decide(home.userId, started.id, false, 'لم أسمع التسميع كاملًا', NOON),
      );
      expect(decided.status).toBe('REJECTED');
      expect((await drain()).failed).toBe(0);

      // EXACTLY ONE MESSAGE, AND IT IS THE CHILD'S. A rejection grants nothing,
      // so there is no `REWARD_GRANTED` and no parent notification on this path.
      expect(await countOf('child_messages', home.familyId)).toBe(1);
      expect(await countOf('notifications', home.familyId)).toBe(0);
      expect(await countOf('rewards_ledger_entries', home.familyId)).toBe(0);

      const decision = await theDecisionFor(home.familyId, 'ACHIEVEMENT_REJECTED');
      expect(decision.target_audience).toBe('CHILD');
      expect(decision.copy_key).toBe('ACHIEVEMENT_REJECTED');
      const [row] = await childMessages(home.familyId);
      expect(row.category).toBe('ACHIEVEMENT_REJECTED');

      // ===== NON-PUNITIVE, AND THE REASON NEVER TRAVELLED =====
      for (const word of PUNITIVE) expect(row.body).not.toContain(word);
      expect(row.body).not.toContain('لم أسمع');
      expect(row.body).not.toContain(home.childName);
      // It names the goal and points at a conversation.
      expect(row.body).toContain('سورة الملك');
      expect(row.body).toContain('أهلك');
      expect(row.body).toMatch(ARABIC_LETTERS);
      expect(row.body).not.toMatch(WESTERN_DIGITS);
      assertItReadsLikeASentence(row.body);
      assertItReadsLikeASentence(row.title);
      assertRenderedFromCatalogue(row, decision, { goalTitle: 'الآيات 1–5 من سورة الملك' });
    }, 180_000);

    it('NEGATIVE — a rejection this product cannot NAME is one it does not announce', async () => {
      const unnameable = await createHousehold('rejected-unnameable');
      const created = await asFamily(unnameable.familyId, () =>
        programs.create(unnameable.familyId, unnameable.userId, {
          childId: unnameable.childId,
          category: 'QURAN',
          activity: 'QURAN_MEMORIZE_AYAH_RANGE',
          targetSpec: { surahNumber: 67, fromAyah: 1, toAyah: 5 },
          durationMinutes: 20,
          verificationLevel: 'PARENT_CONFIRMATION',
          rewardSpec: { type: 'POINTS', amount: 20 },
        } as any),
      );
      // `describeTargetSpec`'s own last line returns the raw ACTIVITY CODE for a
      // spec it cannot describe, and that value is persisted on the program like
      // any other. It is a perfectly good machine value and it is exactly what
      // «no raw enum may reach a user» forbids.
      await sys('blank the derived summary', () =>
        prisma.$executeRawUnsafe(
          `UPDATE "reward_programs" SET "target_summary_ar" = 'QURAN_MEMORIZE_AYAH_RANGE' WHERE "id" = $1::uuid`,
          created.id,
        ),
      );
      const started = await asFamily(unnameable.familyId, () =>
        achievements.start(unnameable.childId, created.id, NOON),
      );
      await asFamily(unnameable.familyId, () =>
        achievements.submit(unnameable.childId, started.id, { selfConfirmed: true } as any, NOON),
      );
      await asFamily(unnameable.familyId, () =>
        achievements.decide(unnameable.userId, started.id, false, undefined, NOON),
      );
      expect((await drain()).failed).toBe(0);

      // SILENT, and deliberately: `GENERIC` — «لديك جديد في التطبيق ✨» — pushed
      // at a child after a declined submission makes them open the app to find
      // bad news with no context, which is worse than the silence.
      expect(await countOf('child_messages', unnameable.familyId)).toBe(0);
      expect(await countOf('notifications', unnameable.familyId)).toBe(0);
    }, 180_000);

    it('IDEMPOTENCY AND REPLAY — the rejection delivered again is still one row', async () => {
      const before = await countOf('child_messages', home.familyId);
      expect(before).toBe(1);

      await sys('delete consumer markers', () =>
        prisma.$executeRawUnsafe(
          `DELETE FROM "consumed_messages" WHERE "family_id" = $1::uuid`,
          home.familyId,
        ),
      );
      await sys('requeue every message', () =>
        prisma.$executeRawUnsafe(
          `UPDATE "outbox_messages"
              SET "status" = 'PENDING', "attempt_count" = 0, "next_attempt_at" = NOW(),
                  "locked_by" = NULL, "locked_at" = NULL, "published_at" = NULL
            WHERE "family_id" = $1::uuid`,
          home.familyId,
        ),
      );
      const replay = await drain();
      expect(replay.failed).toBe(0);
      expect(replay.published).toBeGreaterThan(0);

      // Refused by `child_messages (family_id, source_event_id)` — a database
      // constraint on the CAUSE, not by the marker this test just deleted.
      expect(await countOf('child_messages', home.familyId)).toBe(1);
      expect((await decisions(home.familyId)).filter((d) => d.event_type === 'ACHIEVEMENT_REJECTED')).toHaveLength(1);
    }, 180_000);
  });
});
