/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-var-requires */
/**
 * ============================================================================
 * SPRINT F1 (DECISION 1) — THE CHILD IS TOLD ON THE DIRECT PATH TOO.
 * ============================================================================
 *
 * WHAT WAS MEASURED. A reward is announced by exactly two things in this
 * product, and they had drifted:
 *
 *   THE OUTBOX ANNOUNCER (`NotificationRewardConsumer`) has made TWO
 *     `handleEvent` calls since `F6-006` — one PARENT, one CHILD — and has
 *     carried the domain CAUSE since `F1-002`.
 *   THE DIRECT ANNOUNCER (`RewardsEngineService.announceGrant`) made ONE, to
 *     `REWARD_GRANTED`, with no cause and no CHILD branch at all.
 *
 * The direct announcer is the one reached by the `/self/*` and parent routes
 * the apps actually call (PA-M-034). So a child who finished a whole learning
 * goal earned fifty coins and heard NOTHING, while a child whose streak was
 * paid through `/events/batch` heard something specific. That asymmetry is the
 * defect, and `LEARNING_GOAL_ACHIEVED` — four tone bands, two languages, a
 * quiet-hours class, two scoring rows and a deep-link destination — was
 * unreachable by any production path because of it.
 *
 * WHY `LEARNING_GOAL_ACHIEVED` IS THE CLEAN CASE FOR THE «NO SECOND CHILD
 * NOTIFICATION» PROOF, and it is a structural argument rather than a count:
 * `reward-rule-catalogue.ts` lists it among the «keyed engine-internal names
 * emitted by the direct `IRewardTriggerWriter` seam», and it is NOT in
 * `COMPLETION_EVENT_TYPES`. `RewardsCompletionConsumer` subscribes to
 * `COMPLETION_EVENT_TYPES` and to nothing else, so this cause CANNOT reach the
 * outbox announcer. And the two announcers are mutually exclusive anyway:
 * `announceGrant` returns before notifying whenever `announcedViaOutbox` is
 * set, and `RewardsCompletionConsumer` is the only caller that sets it — on
 * every call. There is no input to this product that reaches both.
 *
 * WHAT THIS SUITE EXECUTES. The real chain with no test double in it: the real
 * `LearningEngineService.completeGoal`, the real `RewardsEngineService`, the
 * real platform Reward Rule (`learning` / `LEARNING_GOAL_ACHIEVED`, 50 COINS),
 * the real `SmartNotificationEngineService`, the real decision provider, the
 * REAL `ChildSafetyFilterService` and the real delivery pipeline. EVERY COUNT
 * AND EVERY SENTENCE IS READ BACK OUT OF POSTGRESQL WITH SQL, never from a
 * returned object.
 *
 *   1  POSITIVE      one goal completed -> one ledger row, one parent
 *                    notification, one child message, and the child's sentence
 *                    names the goal.
 *   2  NEGATIVE      a cause with no goal title, and a title unfit to be read,
 *                    both fall back to a WHOLE sentence rather than to a
 *                    placeholder or to GENERIC.
 *   3  REPLAY        the same cause announced twice produces ONE row on each
 *                    table, refused by a UNIQUE INDEX rather than by an `if`.
 *   4  QUIET HOURS   both audiences are queued, under DIFFERENT keys — the
 *                    `notification_deliveries (family_id, source_event_id)`
 *                    trap that silenced the child for ten hours a night.
 *   5  TIMEZONE      ONE instant, two households, two different answers,
 *                    because `Africa/Cairo` and `Asia/Riyadh` are different
 *                    calendars and neither of them is UTC.
 *
 * SCOPED TO ITS OWN COHORT. Every assertion is `WHERE family_id = <a family
 * this file created>`.
 */
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';

import { AppModule } from '../../src/app.module';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { createTenantExtension } from '../../src/common/tenancy/tenant.extension';
import { runAsSystemAsync } from '../../src/common/tenancy/system-context';
import { runWithTenant } from '../../src/common/tenancy/tenant-context';
import { LearningEngineService } from '../../src/modules/life-intelligence/application/services/learning-engine.service';
import { RewardsEngineService } from '../../src/modules/life-intelligence/application/services/rewards-engine.service';
import { PrismaLearningRepository } from '../../src/modules/life-intelligence/infrastructure/repositories/prisma-learning.repository';
import {
  hasEnumOrPlaceholderLeak,
  renderNotificationCopy,
} from '../../src/modules/notifications/domain/engine/notification-copy';
import { getBusinessTimeHHMM } from '../../src/common/time/family-date';
import { PLATFORM_BADGES } from '../../src/shared/rewards/badge-catalogue';
import { integrationDatabaseUrl } from '../tenancy/prisma-test-client';
import { freezeGoldenClock } from '../golden/golden-world';

const describeIfDb = integrationDatabaseUrl() ? describe : describe.skip;

const CAIRO = 'Africa/Cairo';
const RIYADH = 'Asia/Riyadh';

/**
 * MIDDAY IN BOTH LAUNCH MARKETS, and frozen — the lesson `F1-002` paid for.
 * The notification door reads `new Date()`, never the business event's own
 * timestamp (deliberately: «is it safe to wake this household» is a question
 * about NOW), so a suite that leaves the wall clock alone is a suite that
 * asserts what time CI happened to run. 2026-01-15 is in the PAST relative to
 * any real run, which is the safe direction for client-side `@default(now())`.
 */
const NOON = new Date('2026-01-15T10:00:00.000Z'); // 12:00 Cairo, 13:00 Riyadh

/** 22:00 Cairo — inside the default 21:00–07:00 window, on the family's clock. */
const CAIRO_NIGHT = new Date('2026-01-15T20:00:00.000Z');

/**
 * THE ONE INSTANT THAT SPLITS THE TWO MARKETS. In January Cairo is UTC+02:00
 * and Riyadh is UTC+03:00, so at 18:30 UTC a Cairo household's wall clock reads
 * 20:30 — awake — and a Riyadh household's reads 21:30 — asleep. Same instant,
 * same event, two different correct answers. A server that asked UTC would give
 * one answer to both and be wrong for one of them.
 */
const SPLIT_INSTANT = new Date('2026-01-15T18:30:00.000Z');

const QUIET_HOURS_START = '21:00';
const QUIET_HOURS_END = '07:00';

/** An unresolved `{placeholder}`, which must never reach a human. */
const PLACEHOLDER = /\{[a-zA-Z0-9_]+\}/;
const ARABIC_LETTERS = /[؀-ۿ]/;
/** CONTEXT §3 principle 7. The same list `e2e-06` and `F1-002` screen with. */
const PUNITIVE = ['فشل', 'خطأ', 'رفض', 'مرفوض', 'عقاب', 'تحذير', 'مخالفة', 'تجاوز', 'سيئ'];

/** The Arabic goal title the parent typed. Deliberately free of Latin digits:
 * an Arabic sentence with Western numerals is `PF-E-002`. */
const GOAL_TITLE = 'حفظ جدول الضرب';

/** The same offline client every other integration suite in this repo builds. */
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

interface Household {
  readonly familyId: string;
  readonly childId: string;
  readonly userId: string;
  readonly childName: string;
  readonly timeZone: string;
}

describeIfDb('F1 DECISION 1 — the DIRECT reward path tells the child too (real PostgreSQL)', () => {
  let app: INestApplication;
  let prisma: any;
  let learning: LearningEngineService;
  let learningRepo: PrismaLearningRepository;
  let rewards: RewardsEngineService;

  const stamp = Date.now();
  const createdFamilies: string[] = [];
  const createdUsers: string[] = [];

  const sys = (what: string, fn: () => Promise<any>): Promise<any> =>
    runAsSystemAsync('TEST_FIXTURE', `F1 decision-1 suite: ${what}`, async () => await fn());

  const raw = <T>(sql: string, ...params: unknown[]): Promise<T> =>
    sys('raw sql', () => prisma.$queryRawUnsafe(sql, ...params)) as Promise<T>;

  const decisions = (familyId: string): Promise<any[]> =>
    raw<any[]>(
      `SELECT * FROM "notification_decisions" WHERE "family_id" = $1::uuid ORDER BY "created_at", "id"`,
      familyId,
    );

  const notifications = (familyId: string): Promise<any[]> =>
    raw<any[]>(`SELECT * FROM "notifications" WHERE "family_id" = $1::uuid ORDER BY "created_at", "id"`, familyId);

  const childMessages = (familyId: string): Promise<any[]> =>
    raw<any[]>(`SELECT * FROM "child_messages" WHERE "family_id" = $1::uuid ORDER BY "created_at", "id"`, familyId);

  const deliveries = (familyId: string): Promise<any[]> =>
    raw<any[]>(
      `SELECT * FROM "notification_deliveries" WHERE "family_id" = $1::uuid ORDER BY "created_at", "id"`,
      familyId,
    );

  const countOf = async (table: string, familyId: string): Promise<number> =>
    Number((await raw<any[]>(`SELECT COUNT(*)::int AS n FROM "${table}" WHERE "family_id" = $1::uuid`, familyId))[0].n);

  /**
   * THE FOUR NUMBERS CONTEXT §5's CHAIN ENDS IN — the same four `e2e-01` and
   * `e2e-13` pin, counted on the DIRECT path this time.
   */
  const countTheLoop = async (familyId: string) => ({
    ledger: await countOf('rewards_ledger_entries', familyId),
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

  async function theDecisionFor(familyId: string, eventType: string): Promise<any> {
    const rows = (await decisions(familyId)).filter((d) => d.event_type === eventType);
    expect(rows).toHaveLength(1);
    return rows[0];
  }

  /**
   * THE PROVENANCE CHECK. A stored sentence is «from the catalogue» only if
   * rendering the key the decision row NAMES, at the band and locale it names,
   * reproduces it byte for byte. Without this, a template whose variable the
   * producer forgot degrades silently to `GENERIC` — still Arabic, still
   * leak-free, and still the wrong sentence.
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

  function assertItReadsLikeASentence(text: string): void {
    expect(text).not.toMatch(PLACEHOLDER);
    expect(hasEnumOrPlaceholderLeak(text)).toBe(false);
    expect(text.trim().length).toBeGreaterThan(4);
  }

  // -- fixtures --------------------------------------------------------------

  async function createHousehold(label: string, timeZone: string = CAIRO): Promise<Household> {
    const family = await sys('create family', () =>
      prisma.family.create({ data: { name: `F1-D1 ${label} ${stamp}`, timezone: timeZone }, select: { id: true } }),
    );
    createdFamilies.push(family.id);

    const user = await sys('create user', () =>
      prisma.user.create({
        data: { email: `f1d1.${label}.${stamp}@example.test`, passwordHash: 'x', fullName: 'F1-D1 Parent' },
        select: { id: true },
      }),
    );
    createdUsers.push(user.id);
    await sys('create membership', () =>
      prisma.familyMember.create({ data: { familyId: family.id, userId: user.id, role: 'OWNER' } }),
    );

    // Twelve years old on `NOON` — the `11-13` tone band the product's child
    // copy is calibrated for and the one every golden uses.
    const child = await sys('create child', () =>
      prisma.child.create({
        data: { familyId: family.id, firstName: 'محمد', dateOfBirth: new Date('2014-01-01T00:00:00.000Z') },
        select: { id: true },
      }),
    );

    /**
     * ===================================================================
     * THE CHILD IS PAST THEIR FIRST-TIME MILESTONES — the same reasoning as
     * `aCompletableGoal` below, applied to a cause that did not exist when
     * that comment was written.
     * ===================================================================
     *
     * Migration 0026 seeded the badge catalogue and the platform BADGE rules
     * that ask for it, so a child's FIRST study session or learning goal now
     * awards a once-ever badge ALONGSIDE the XP or coins — a second CAUSE,
     * with `BADGE_EARNED` for the child and `BADGE_EARNED_PARENT` for the
     * parent, announced in the same instant. On a brand-new child the badge is
     * then the only thing the child receives, and the reward sentence this file
     * is about does not arrive at all.
     *
     * THE MECHANISM, CORRECTED. This comment first said «`NotificationFatigueGuard`
     * correctly delivers ONE child-facing ACHIEVEMENT message rather than two».
     * `first-completion-badge-and-reward.e2e.spec.ts` measured that against the
     * real rows and it is false in both halves: the guard NEVER RUNS —
     * `SmartNotificationEngineService` returns on a SUPPRESS verdict before it
     * calls `notifyEvent`, and `outcome IS NULL` on the row is the proof — and
     * the two causes are ACHIEVEMENT and REWARD, not two ACHIEVEMENTs, which is
     * why the per-category cap never fired. What refuses the child's reward is
     * the DECISION PROVIDER's own `SCORE_BELOW_FLOOR`, whose `FATIGUE_PENALTY`
     * is counted over the PARENT's `notifications` rows.
     *
     * NONE OF THAT CHANGES WHAT THIS FIXTURE IS FOR. This file is about whether
     * the reward's CAUSE survives the notification door on the completions a
     * child makes AFTER their first, which is all of them, so the household
     * starts holding its badges and every assertion below is the one this
     * suite always made, unchanged. `child_badge_awards (child_id, badge_id)`
     * is UNIQUE and the engine only pays a badge when that insert succeeded,
     * so this is the row the engine itself would have written, written first.
     */
    const badges = await sys('badge catalogue', () =>
      prisma.badgeDefinition.findMany({ where: { key: { in: PLATFORM_BADGES.map((b) => b.key) } } }),
    );
    expect(badges).toHaveLength(PLATFORM_BADGES.length);
    await sys('pre-award badges', () =>
      prisma.childBadgeAward.createMany({
        data: badges.map((b: any) => ({ familyId: family.id, childId: child.id, badgeId: b.id })),
      }),
    );

    return { familyId: family.id, childId: child.id, userId: user.id, childName: 'محمد', timeZone };
  }

  const asFamily = <T>(familyId: string, fn: () => Promise<T>): Promise<T> =>
    runWithTenant({ familyId, actorType: 'SYSTEM', actorId: 'f1-d1-test' }, fn);

  /**
   * A LEARNING GOAL WITH REAL WORK ATTACHED TO IT.
   *
   * The two `LearningSession` rows are the PRECONDITION `completeGoal` refuses
   * to grant without (`MIN_SESSIONS_TO_COMPLETE_GOAL`), and they are written
   * through the production repository rather than through `logSession` ON
   * PURPOSE: `logSession` itself pays an `EDUCATION_TASK_COMPLETED` reward, so
   * routing the fixture through it would put two more reward announcements on
   * the same household seconds apart, where `NotificationFatigueGuard`'s
   * five-minute DUPLICATE window would correctly suppress them and this file
   * would be measuring the fatigue guard instead of the producer. The sessions
   * are the setup; the goal completion is the subject.
   */
  async function aCompletableGoal(h: Household, title: string): Promise<string> {
    const goal = await asFamily(h.familyId, () =>
      learning.createGoal(h.childId, h.familyId, { subject: 'school', title }),
    );
    for (const day of ['2026-01-13', '2026-01-14']) {
      await asFamily(h.familyId, () =>
        learningRepo.createSession({
          childId: h.childId,
          goalId: goal.id,
          subject: 'school',
          durationMinutes: 30,
          date: day,
        }),
      );
    }
    return goal.id;
  }

  beforeAll(async () => {
    // BEFORE THE APP IS BUILT, so that every client-side `@default(now())` this
    // suite writes carries the same instant the notification door will read.
    freezeGoldenClock(NOON);

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue(offlinePrismaService())
      .compile();

    app = moduleRef.createNestApplication();
    await app.init();

    prisma = app.get(PrismaService);
    learning = app.get(LearningEngineService);
    learningRepo = app.get(PrismaLearningRepository);
    rewards = app.get(RewardsEngineService);
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
    jest.useRealTimers();
  }, 180_000);

  // ==========================================================================
  // 0. THE GUARD ON THE CLOCK ITSELF
  // ==========================================================================
  /**
   * A SUITE THAT PASSES IN THE MORNING AND FAILS AT NIGHT IS WORSE THAN ONE
   * THAT ALWAYS FAILS. This asserts the PREMISE the tests below are written on
   * — that the wall clock the engine will read is `NOON`, and that `NOON` is
   * outside quiet hours in BOTH launch markets — rather than anything about the
   * product. It is derived through the same `getBusinessTimeHHMM` production
   * uses, so moving the default window moves this line rather than eight
   * downstream assertions.
   */
  it('THE CLOCK IS FROZEN AT MIDDAY, in both markets — this suite must not depend on when CI runs', () => {
    expect(new Date().toISOString()).toBe(NOON.toISOString());
    expect(Date.now()).toBe(NOON.getTime());

    expect(getBusinessTimeHHMM(new Date(), CAIRO)).toBe('12:00');
    expect(getBusinessTimeHHMM(new Date(), RIYADH)).toBe('13:00');
    for (const zone of [CAIRO, RIYADH]) {
      const local = getBusinessTimeHHMM(new Date(), zone);
      expect(`${zone}:${local > QUIET_HOURS_END && local < QUIET_HOURS_START}`).toBe(`${zone}:true`);
    }
  });

  // ==========================================================================
  // 1. POSITIVE — «أنهيت هدف حفظ جدول الضرب بالكامل 🎉»
  // ==========================================================================

  describe('1. POSITIVE — a learning goal completed on the DIRECT path reaches BOTH audiences', () => {
    let home: Household;
    let goalId = '';

    it('one completion produces one ledger row, one parent notification and one CHILD message', async () => {
      jest.setSystemTime(NOON);
      home = await createHousehold('positive');
      goalId = await aCompletableGoal(home, GOAL_TITLE);

      // NOT VACUOUS: nothing has been earned by writing the goal down.
      expect(await countTheLoop(home.familyId)).toEqual({
        ledger: 0,
        timeline: 0,
        parentNotifications: 0,
        childMessages: 0,
      });

      const completed = await asFamily(home.familyId, () => learning.completeGoal(goalId, home.childId, home.familyId));
      expect(completed.status).toBe('COMPLETED');

      // THE PAYMENT HAPPENED. Platform rule `learning` / `LEARNING_GOAL_ACHIEVED`
      // pays 50 COINS; without a grant `announceGrant` is never reached and this
      // whole section would be vacuous.
      const loop = await countTheLoop(home.familyId);
      expect(loop.ledger).toBe(1);
      expect(loop.timeline).toBe(1);
      expect(loop.parentNotifications).toBe(1);
      // ===== THE ROW THAT DID NOT EXIST BEFORE THIS DECISION =====
      expect(loop.childMessages).toBe(1);

      // ===== THE CHILD'S SENTENCE IS ABOUT THE GOAL, NOT ABOUT «A REWARD» =====
      const childDecision = await theDecisionFor(home.familyId, 'REWARD_GRANTED_CHILD');
      expect(childDecision.target_audience).toBe('CHILD');
      expect(childDecision.copy_key).toBe('LEARNING_GOAL_ACHIEVED');
      expect(childDecision.age_band).toBe('11-13');
      // THE TYPE DID NOT MOVE. `notifications.type` is what the scorer, the
      // quiet-hours matrix and the analytics read; only the COPY KEY varies.
      expect(childDecision.notification_type).toBe('REWARD_GRANTED_CHILD');
      expect(childDecision.event_type).toBe('REWARD_GRANTED_CHILD');

      const [childRow] = await childMessages(home.familyId);
      expect(childRow.category).toBe('REWARD_GRANTED_CHILD');
      expect(childRow.body).toContain(GOAL_TITLE);
      expect(childRow.body).toMatch(ARABIC_LETTERS);
      // A child is addressed in the second person and never by their own name.
      expect(childRow.body).not.toContain(home.childName);
      assertItReadsLikeASentence(childRow.body);
      assertItReadsLikeASentence(childRow.title);
      assertRenderedFromCatalogue(childRow, childDecision, { goalTitle: GOAL_TITLE });
      for (const word of PUNITIVE) expect(childRow.body).not.toContain(word);

      // ===== AND THE PARENT'S IS A DIFFERENT SENTENCE, TO A DIFFERENT PERSON =====
      const parentDecision = await theDecisionFor(home.familyId, 'REWARD_GRANTED');
      expect(parentDecision.target_audience).toBe('PARENT');
      const [parentRow] = await notifications(home.familyId);
      expect(parentRow.body).not.toBe(childRow.body);
      expect(parentRow.body).toContain(home.childName);
      assertItReadsLikeASentence(parentRow.body);
    }, 120_000);

    /**
     * ONE CAUSE, ONE KEY, TWO ROWS — and the audience facet is what keeps them
     * apart. `notifications` holds the parent's row under the bare key;
     * `child_messages` holds the child's under `<key>:child`. Neither
     * deduplicates the other, and neither producer invented a second key.
     */
    it('the two rows share ONE cause and are separated by the audience facet, read out of PostgreSQL', async () => {
      const [parentRow] = await notifications(home.familyId);
      const [childRow] = await childMessages(home.familyId);

      expect(String(parentRow.source_event_id).startsWith('reward:')).toBe(true);
      expect(childRow.source_event_id).toBe(`${parentRow.source_event_id}:child`);
      // The key is the one that protects the LEDGER ROW this notification
      // announces — `learning-goal:<goalId>` — so the notification is exactly as
      // replay-proof as the grant it describes.
      expect(String(parentRow.source_event_id)).toContain(`learning-goal_${goalId}`);

      // The ledger separates the two decisions on `target_audience`, and there
      // are exactly two of them for one completion.
      const rows = await decisions(home.familyId);
      expect(rows).toHaveLength(2);
      expect(rows.map((r) => r.target_audience).sort()).toEqual(['CHILD', 'PARENT']);
      expect(new Set(rows.map((r) => r.source_event_id)).size).toBe(1);
    }, 120_000);
  });

  // ==========================================================================
  // 2. NEGATIVE — a missing or unusable fact NEVER degrades the sentence
  // ==========================================================================

  describe('2. NEGATIVE — no goal title means a WHOLE sentence, never a placeholder', () => {
    it('a DIRECT cause that carries no goal title keeps the generic child sentence', async () => {
      jest.setSystemTime(NOON);
      const other = await createHousehold('no-title');

      // `EDUCATION_TASK_COMPLETED` is paid by the same engine on the same direct
      // seam and carries no goal title at all — the shape every habit tick,
      // hydration target and faith practice has.
      await asFamily(other.familyId, () =>
        rewards.trigger(other.childId, other.familyId, {
          engine: 'learning',
          type: 'EDUCATION_TASK_COMPLETED',
          payload: { subject: 'school', durationMinutes: 30, verifiedBy: 'SELF' },
          idempotencyKey: `f1d1:session:${other.childId}:2026-01-15`,
        }),
      );

      expect(await countOf('child_messages', other.familyId)).toBe(1);
      const childDecision = await theDecisionFor(other.familyId, 'REWARD_GRANTED_CHILD');
      // NOT `LEARNING_GOAL_ACHIEVED`: «أنهيت هدف {goalTitle}» with no title would
      // be refused by the renderer and degrade to `GENERIC`, which is worse than
      // the complete generic reward sentence.
      expect(childDecision.copy_key).toBe('REWARD_GRANTED_CHILD');
      const [childRow] = await childMessages(other.familyId);
      assertItReadsLikeASentence(childRow.body);
      expect(childRow.body).not.toContain('هدف');
      assertRenderedFromCatalogue(childRow, childDecision, {});
    }, 120_000);

    it('a goal title too long to be a title is treated as ABSENT, not truncated into a notification', async () => {
      jest.setSystemTime(NOON);
      const wordy = await createHousehold('long-title');
      // 121 Arabic characters — one past `MAX_GOAL_TITLE_CHARS`. A push body is
      // 500 characters wide and a title that fills a quarter of it is a
      // paragraph somebody pasted, not a goal name.
      const paragraph = 'م'.repeat(121);
      const goalId = await aCompletableGoal(wordy, paragraph);

      await asFamily(wordy.familyId, () => learning.completeGoal(goalId, wordy.childId, wordy.familyId));

      const childDecision = await theDecisionFor(wordy.familyId, 'REWARD_GRANTED_CHILD');
      expect(childDecision.copy_key).toBe('REWARD_GRANTED_CHILD');
      const [childRow] = await childMessages(wordy.familyId);
      expect(childRow.body).not.toContain(paragraph);
      assertItReadsLikeASentence(childRow.body);
      assertRenderedFromCatalogue(childRow, childDecision, {});
    }, 120_000);
  });

  // ==========================================================================
  // 3. IDEMPOTENCY AND REPLAY — a UNIQUE INDEX, not an `if`
  // ==========================================================================

  describe('3. REPLAY — the same cause announced twice writes ONE row on every table', () => {
    let home: Household;
    let goalId = '';

    it('the completion is announced once, and a repeated completion is refused by the goal state machine', async () => {
      jest.setSystemTime(NOON);
      home = await createHousehold('replay');
      goalId = await aCompletableGoal(home, GOAL_TITLE);
      await asFamily(home.familyId, () => learning.completeGoal(goalId, home.childId, home.familyId));

      expect(await countTheLoop(home.familyId)).toEqual({
        ledger: 1,
        timeline: 1,
        parentNotifications: 1,
        childMessages: 1,
      });

      // `markGoalCompletedIfActive` is a conditional UPDATE, so the second
      // completion never reaches the reward trigger at all.
      await expect(
        asFamily(home.familyId, () => learning.completeGoal(goalId, home.childId, home.familyId)),
      ).rejects.toThrow();

      expect(await countTheLoop(home.familyId)).toEqual({
        ledger: 1,
        timeline: 1,
        parentNotifications: 1,
        childMessages: 1,
      });
    }, 120_000);

    /**
     * AND THE LAYER UNDERNEATH IT, which is the one that actually has to hold.
     *
     * The state machine above and `rewards_ledger_entries (child_id,
     * idempotency_key)` both stop a second announcement before it starts — but
     * B9's whole argument is that a guarantee expressed as control flow is a
     * guarantee that can be forgotten. So this test DELETES the ledger row and
     * re-runs the identical trigger, which is the only way to reach
     * `announceGrant` a second time for one cause. The composed
     * `sourceEventId` is byte-identical, and the second parent notification and
     * the second child message are refused by
     * `notifications (family_id, source_event_id, user_id)` and
     * `child_messages (family_id, source_event_id)` — by PostgreSQL, with no
     * application check involved.
     */
    it('a SECOND announcement of the same cause is refused by the database, not by control flow', async () => {
      jest.setSystemTime(NOON);
      const before = await countTheLoop(home.familyId);
      const beforeDecisions = (await decisions(home.familyId)).length;
      expect(beforeDecisions).toBe(2);

      await sys('delete the ledger rows so the announcer can be reached again', () =>
        prisma.$executeRawUnsafe(
          `DELETE FROM "rewards_ledger_entries" WHERE "family_id" = $1::uuid`,
          home.familyId,
        ),
      );

      const granted = await asFamily(home.familyId, () =>
        rewards.trigger(home.childId, home.familyId, {
          engine: 'learning',
          type: 'LEARNING_GOAL_ACHIEVED',
          payload: { goalId, goalTitle: GOAL_TITLE, subject: 'school', verifiedBy: 'PARENT' },
          idempotencyKey: `learning-goal:${goalId}`,
        }),
      );
      // NOT VACUOUS. The announcer really was reached a second time — a replay
      // that granted nothing would make every «still one» below prove nothing.
      expect(granted).toBe(1);

      expect(await countTheLoop(home.familyId)).toEqual({ ...before, ledger: 1 });
      expect((await decisions(home.familyId)).length).toBe(beforeDecisions);

      // AND THE SENTENCE IS STILL THE GOAL'S — a replay that had re-decided with
      // the cause lost would have rewritten the row to the generic key.
      const childDecision = await theDecisionFor(home.familyId, 'REWARD_GRANTED_CHILD');
      expect(childDecision.copy_key).toBe('LEARNING_GOAL_ACHIEVED');
    }, 120_000);
  });

  // ==========================================================================
  // 4. QUIET HOURS — BOTH audiences are queued, under DIFFERENT keys
  // ==========================================================================

  /**
   * THE REGRESSION THIS SECTION EXISTS FOR IS TEN HOURS WIDE.
   *
   * `notification_deliveries (family_id, source_event_id)` is UNIQUE and has NO
   * audience column. A cause that notifies both audiences under ONE producer
   * key therefore enqueued the parent's row and had the child's refused by
   * `ON CONFLICT DO NOTHING`, reported as the reasonable-looking
   * `ALREADY_DEFERRED`. `forAudience` closed it for the outbox announcer; this
   * proves the DIRECT announcer — a brand new both-audiences producer, the
   * exact shape that re-opens it — lands on the fixed side of that seam.
   */
  it('4. QUIET HOURS — a goal completed at 22:00 Cairo queues TWO rows, one per audience', async () => {
    jest.setSystemTime(NOON);
    const night = await createHousehold('quiet');
    const goalId = await aCompletableGoal(night, GOAL_TITLE);

    // THE PREMISE, ASSERTED RATHER THAN ASSUMED.
    jest.setSystemTime(CAIRO_NIGHT);
    expect(getBusinessTimeHHMM(new Date(), CAIRO)).toBe('22:00');
    expect(getBusinessTimeHHMM(new Date(), CAIRO) > QUIET_HOURS_START).toBe(true);

    await asFamily(night.familyId, () => learning.completeGoal(goalId, night.childId, night.familyId));

    // NOTHING WAS DELIVERED — and nothing was DROPPED either. A reward is a fact
    // about a day already lived; `notification-class.ts` defers it rather than
    // suppressing it, and the queue is where it waits.
    expect(await countOf('notifications', night.familyId)).toBe(0);
    expect(await countOf('child_messages', night.familyId)).toBe(0);
    expect(await countOf('rewards_ledger_entries', night.familyId)).toBe(1);

    const queued = await deliveries(night.familyId);
    expect(queued).toHaveLength(2);
    expect(queued.map((r) => r.target_audience).sort()).toEqual(['CHILD', 'PARENT']);
    for (const row of queued) {
      expect(row.state).toBe('PENDING');
      expect(row.defer_reason).toBe('QUIET_HOURS');
      // The end of THIS family's quiet hours on THIS family's clock: 07:00
      // Cairo the next morning is 05:00 UTC in January.
      expect(new Date(row.scheduled_for).toISOString()).toBe('2026-01-16T05:00:00.000Z');
    }

    // THE KEYS DIFFER BY THE AUDIENCE FACET AND BY NOTHING ELSE.
    const parentQueued = queued.find((r) => r.target_audience === 'PARENT');
    const childQueued = queued.find((r) => r.target_audience === 'CHILD');
    expect(childQueued.source_event_id).toBe(`${parentQueued.source_event_id}:child`);

    // AND BOTH DECISIONS WERE RECORDED, with the deferral on each — the
    // engine's own verdict AND the pipeline's outcome, which is the pair the
    // ledger exists to let a support engineer compare.
    const rows = await decisions(night.familyId);
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.decision).toBe('DEFER');
      expect(row.reason).toBe('QUIET_HOURS_ACTIVE');
      expect(row.outcome).toBe('DEFER');
    }

    jest.setSystemTime(NOON);
  }, 120_000);

  // ==========================================================================
  // 5. TIMEZONE — one instant, two calendars, two correct answers
  // ==========================================================================

  it('5. TIMEZONE — the SAME instant delivers in Africa/Cairo and defers in Asia/Riyadh', async () => {
    jest.setSystemTime(NOON);
    const cairo = await createHousehold('tz-cairo', CAIRO);
    const riyadh = await createHousehold('tz-riyadh', RIYADH);
    const cairoGoal = await aCompletableGoal(cairo, GOAL_TITLE);
    const riyadhGoal = await aCompletableGoal(riyadh, GOAL_TITLE);

    // THE PREMISE. One instant; two wall clocks; one of them is asleep. If the
    // default window ever moves, this line says so instead of the four
    // assertions below saying something else.
    jest.setSystemTime(SPLIT_INSTANT);
    expect(getBusinessTimeHHMM(new Date(), CAIRO)).toBe('20:30');
    expect(getBusinessTimeHHMM(new Date(), RIYADH)).toBe('21:30');

    await asFamily(cairo.familyId, () => learning.completeGoal(cairoGoal, cairo.childId, cairo.familyId));
    await asFamily(riyadh.familyId, () => learning.completeGoal(riyadhGoal, riyadh.childId, riyadh.familyId));

    // CAIRO IS AWAKE: both rows land immediately, and the child's sentence is
    // still the goal's.
    expect(await countOf('notifications', cairo.familyId)).toBe(1);
    expect(await countOf('child_messages', cairo.familyId)).toBe(1);
    expect(await countOf('notification_deliveries', cairo.familyId)).toBe(0);
    expect((await theDecisionFor(cairo.familyId, 'REWARD_GRANTED_CHILD')).copy_key).toBe('LEARNING_GOAL_ACHIEVED');

    // RIYADH IS ASLEEP: both rows are queued until 07:00 on ITS calendar, which
    // is 04:00 UTC — an hour before Cairo's, because the zones differ.
    expect(await countOf('notifications', riyadh.familyId)).toBe(0);
    expect(await countOf('child_messages', riyadh.familyId)).toBe(0);
    const queued = await deliveries(riyadh.familyId);
    expect(queued).toHaveLength(2);
    expect(queued.map((r) => r.target_audience).sort()).toEqual(['CHILD', 'PARENT']);
    for (const row of queued) {
      expect(new Date(row.scheduled_for).toISOString()).toBe('2026-01-16T04:00:00.000Z');
    }
    // The deferred CHILD row still carries the goal's own sentence: the copy is
    // decided before the queue, not after it.
    expect((await theDecisionFor(riyadh.familyId, 'REWARD_GRANTED_CHILD')).copy_key).toBe('LEARNING_GOAL_ACHIEVED');
    const childQueued = queued.find((r) => r.target_audience === 'CHILD');
    expect(childQueued.body).toContain(GOAL_TITLE);

    jest.setSystemTime(NOON);
  }, 180_000);
});
