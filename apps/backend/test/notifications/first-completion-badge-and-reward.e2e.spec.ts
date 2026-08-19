/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-var-requires */
/**
 * ============================================================================
 * THE CHILD'S VERY FIRST COMPLETION, MEASURED — WHAT 0026 CHANGED, AND WHAT
 * ACTUALLY REFUSED THE SECOND MESSAGE.
 * ============================================================================
 *
 * WHY THIS FILE EXISTS. Migration `0026_badge_catalogue` made badges earnable
 * for the first time, and a badge announces itself to BOTH audiences
 * (`rewards-engine.service.ts`: «badges are the most milestone-worthy grant
 * type … a deliberate product distinction»). So a child's FIRST habit, session,
 * streak or learning goal now produces FOUR notification candidates in one
 * instant instead of two, and one of them — the child's own reward sentence —
 * stops being delivered.
 *
 * That side effect was reported with a mechanism attached: «two ACHIEVEMENT
 * causes land in the same instant and `NotificationFatigueGuard` correctly
 * delivers one». BOTH HALVES OF THAT SENTENCE ARE WRONG, and this file is the
 * execution that says so. What is right is the consequence: the child loses the
 * reward sentence on the one completion that matters most.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS ACTUALLY MEASURED HERE, against a real PostgreSQL, a real Redis and
 * the real application — real `LearningEngineService`, real `RewardsEngineService`,
 * real platform Reward Rules (0007's 50 COINS and 0026's `first_learning_goal`
 * badge), real `SmartNotificationEngineService`, real decision provider, real
 * `ChildSafetyFilterService`, real delivery pipeline. Every count and every
 * sentence is read back out of PostgreSQL with SQL.
 *
 *   ACT I    THE FOUR CANDIDATES. One completion writes four
 *            `notification_decisions` rows. Three are SENT. The fourth —
 *            `REWARD_GRANTED_CHILD` — is SUPPRESSED, and its `copy_key` is
 *            still the right one, so the DECISION is correct and only the
 *            DELIVERY is lost.
 *
 *   ACT II   WHAT REFUSED IT, NAMED. Not the fatigue guard: the guard lives
 *            behind `notifyEvent`, `SmartNotificationEngineService` returns
 *            before calling it on a SUPPRESS verdict, and the proof of that is
 *            in the row — `outcome IS NULL` means the pipeline was never
 *            reached, so `evaluateFatigue` never ran on this candidate at all.
 *            What refused it is `RuleBasedNotificationDecisionProvider`'s own
 *            arithmetic, `SCORE_BELOW_FLOOR`, and the component that took it
 *            under the floor is `FATIGUE_PENALTY` — counted over the PARENT'S
 *            stream. The two causes are not «two ACHIEVEMENT causes» either:
 *            `BADGE_EARNED` is ACHIEVEMENT and `REWARD_GRANTED_CHILD` is
 *            REWARD, which is why the per-category cap never fired.
 *
 *   ACT III  THE LOSS, PINNED WITH `it.failing`. The child's first-ever
 *            completion reaches them carrying no reward fact. This is the
 *            repository's own defect-ledger idiom (`notification-producer-chain.guard.spec.ts`):
 *            the case PASSES while the body throws and FAILS the day it stops,
 *            so the fix cannot land without deleting this entry.
 *
 *   ACT IV   REPLAY, BY REPLAYING. The identical cause driven through the
 *            engine a second time with the ledger cleared — the only way to
 *            reach the announcer twice — still leaves one badge award, one
 *            child message and four decision rows. Refused by UNIQUE INDEXES
 *            (`child_badge_awards (child_id, badge_id)`,
 *            `child_messages (family_id, source_event_id)`,
 *            `notification_decisions (family_id, source_event_id, target_audience)`),
 *            never by an `if`.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS FILE DELIBERATELY DOES NOT DO: pre-award the badges. Its two
 * siblings — `reward-cause-producers.e2e.spec.ts` and
 * `direct-path-reward-child.e2e.spec.ts` — start their households PAST the
 * first-time milestones, because they are about whether the reward's CAUSE
 * survives the notification door on the completions a child makes for the rest
 * of their life. This file is about the ONE completion those two step over, and
 * a household here therefore starts exactly as a real new household does: with
 * nothing.
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
import { hasEnumOrPlaceholderLeak } from '../../src/modules/notifications/domain/engine/notification-copy';
import { notificationCategoryOf } from '../../src/shared/notifications/notification-class';
import { findPlatformBadge } from '../../src/shared/rewards/badge-catalogue';
import { getBusinessTimeHHMM } from '../../src/common/time/family-date';
import { integrationDatabaseUrl } from '../tenancy/prisma-test-client';
import { freezeGoldenClock } from '../golden/golden-world';

const describeIfDb = integrationDatabaseUrl() ? describe : describe.skip;

const CAIRO = 'Africa/Cairo';
/** 12:00 Cairo, and in the PAST relative to any real run — the same frozen
 * midday its two sibling suites use, for the reason their headers give: the
 * notification door reads `new Date()`, so a suite that leaves the wall clock
 * alone asserts what time CI happened to run. */
const NOON = new Date('2026-01-15T10:00:00.000Z');
const QUIET_HOURS_START = '21:00';
const QUIET_HOURS_END = '07:00';

const GOAL_TITLE = 'حفظ جدول الضرب';
const ARABIC_LETTERS = /[؀-ۿ]/;
const PLACEHOLDER = /\{[a-zA-Z0-9_]+\}/;

/** The badge a first learning goal earns, from the catalogue the migration was
 * generated from — never a literal typed here. */
const FIRST_GOAL_BADGE = findPlatformBadge('first_learning_goal');

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

describeIfDb('0026 side effect — the FIRST completion, measured (real PostgreSQL)', () => {
  let app: INestApplication;
  let prisma: any;
  let learning: LearningEngineService;
  let learningRepo: PrismaLearningRepository;
  let rewards: RewardsEngineService;

  const stamp = Date.now();
  const createdFamilies: string[] = [];
  const createdUsers: string[] = [];

  const sys = (what: string, fn: () => Promise<any>): Promise<any> =>
    runAsSystemAsync('TEST_FIXTURE', `first-completion suite: ${what}`, async () => await fn());

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

  const badgeAwards = (familyId: string): Promise<any[]> =>
    raw<any[]>(
      `SELECT a."id", b."key", b."title" FROM "child_badge_awards" a
         JOIN "badge_definitions" b ON b."id" = a."badge_id"
        WHERE a."family_id" = $1::uuid ORDER BY a."id"`,
      familyId,
    );

  const decisionFor = async (familyId: string, eventType: string): Promise<any> => {
    const rows = (await decisions(familyId)).filter((d) => d.event_type === eventType);
    expect(rows).toHaveLength(1);
    return rows[0];
  };

  /** One named component out of the decision's own persisted arithmetic. */
  const componentOf = (decision: any, name: string): any => {
    const found = (decision.explanation as any[]).find((c) => c.name === name);
    expect(`${name} present:${found !== undefined}`).toBe(`${name} present:true`);
    return found;
  };

  function assertItReadsLikeASentence(text: string): void {
    expect(text).not.toMatch(PLACEHOLDER);
    expect(hasEnumOrPlaceholderLeak(text)).toBe(false);
    expect(text.trim().length).toBeGreaterThan(4);
  }

  // -- fixtures --------------------------------------------------------------

  /**
   * A BRAND-NEW HOUSEHOLD, HOLDING NOTHING. No badge is pre-awarded, which is
   * the whole subject of this file — see the header.
   */
  async function createHousehold(label: string): Promise<Household> {
    const family = await sys('create family', () =>
      prisma.family.create({ data: { name: `first-completion ${label} ${stamp}`, timezone: CAIRO }, select: { id: true } }),
    );
    createdFamilies.push(family.id);

    const user = await sys('create user', () =>
      prisma.user.create({
        data: { email: `first.${label}.${stamp}@example.test`, passwordHash: 'x', fullName: 'First Parent' },
        select: { id: true },
      }),
    );
    createdUsers.push(user.id);
    await sys('create membership', () =>
      prisma.familyMember.create({ data: { familyId: family.id, userId: user.id, role: 'OWNER' } }),
    );

    // Twelve on `NOON` — the `11-13` band every golden in this repository uses.
    const child = await sys('create child', () =>
      prisma.child.create({
        data: { familyId: family.id, firstName: 'محمد', dateOfBirth: new Date('2014-01-01T00:00:00.000Z') },
        select: { id: true },
      }),
    );

    return { familyId: family.id, childId: child.id, userId: user.id, childName: 'محمد' };
  }

  const asFamily = <T>(familyId: string, fn: () => Promise<T>): Promise<T> =>
    runWithTenant({ familyId, actorType: 'SYSTEM', actorId: 'first-completion-test' }, fn);

  /**
   * The two `LearningSession` rows are `MIN_SESSIONS_TO_COMPLETE_GOAL`, written
   * through the production repository rather than through `logSession` for the
   * reason `aCompletableGoal` states in its sibling suite: `logSession` pays an
   * `EDUCATION_TASK_COMPLETED` reward of its own, and this file would then be
   * measuring two completions instead of the first one.
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
    // BEFORE THE APP IS BUILT, so every client-side `@default(now())` this suite
    // writes carries the instant the notification door will read.
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
  // 0. THE PREMISE THIS SUITE IS WRITTEN ON
  // ==========================================================================
  it('THE CLOCK IS FROZEN AT MIDDAY, outside quiet hours — this suite must not depend on when CI runs', () => {
    expect(new Date().toISOString()).toBe(NOON.toISOString());
    const local = getBusinessTimeHHMM(new Date(), CAIRO);
    expect(local).toBe('12:00');
    expect(local > QUIET_HOURS_END && local < QUIET_HOURS_START).toBe(true);

    // The badge the platform rule pays for this cause, and its Arabic title —
    // read from the catalogue the migration was generated from, so a renamed
    // badge moves this line rather than eight assertions below it.
    expect(FIRST_GOAL_BADGE).toBeDefined();
    expect(FIRST_GOAL_BADGE?.criteria.eventType).toBe('LEARNING_GOAL_ACHIEVED');
    expect(FIRST_GOAL_BADGE?.copy.ar.title).toMatch(ARABIC_LETTERS);
  });

  // ==========================================================================
  // 1. THE FOUR CANDIDATES
  // ==========================================================================
  describe('1. one first-ever completion, four decisions, three deliveries', () => {
    let home: Household;
    let goalId = '';

    it('the badge is awarded and the child receives exactly ONE message — the badge', async () => {
      jest.setSystemTime(NOON);
      home = await createHousehold('act-one');
      goalId = await aCompletableGoal(home, GOAL_TITLE);

      // NOT VACUOUS: writing a goal down earns nothing.
      expect(await badgeAwards(home.familyId)).toHaveLength(0);
      expect(await decisions(home.familyId)).toHaveLength(0);

      const completed = await asFamily(home.familyId, () =>
        learning.completeGoal(goalId, home.childId, home.familyId),
      );
      expect(completed.status).toBe('COMPLETED');

      // ===== 0026's own effect: the badge exists, and it is the right one =====
      const awards = await badgeAwards(home.familyId);
      expect(awards).toHaveLength(1);
      expect(awards[0].key).toBe('first_learning_goal');
      expect(awards[0].title).toBe(FIRST_GOAL_BADGE?.copy.ar.title);

      // ===== FOUR candidates reached the engine, from ONE completion =====
      const rows = await decisions(home.familyId);
      expect(rows.map((r) => r.event_type).sort()).toEqual([
        'BADGE_EARNED',
        'BADGE_EARNED_PARENT',
        'REWARD_GRANTED',
        'REWARD_GRANTED_CHILD',
      ]);

      // ===== …and only THREE of them became a row a human can read =====
      expect(await notifications(home.familyId)).toHaveLength(2); // both parent halves
      const messages = await childMessages(home.familyId);
      expect(messages).toHaveLength(1);
      expect(messages[0].category).toBe('BADGE_EARNED');
      expect(messages[0].body).toContain(FIRST_GOAL_BADGE?.copy.ar.title);
      assertItReadsLikeASentence(messages[0].body);

      // THE SENTENCE THE CHILD DID NOT GET. `LEARNING_GOAL_ACHIEVED` names the
      // goal; the badge sentence names the badge. They are not substitutes.
      expect(messages[0].body).not.toContain(GOAL_TITLE);
    }, 120_000);

    it('the reward DECISION is correct — only the DELIVERY is lost', async () => {
      const childReward = await decisionFor(home.familyId, 'REWARD_GRANTED_CHILD');

      // The provider picked the RIGHT sentence for the right audience: the
      // cause reached the copy layer exactly as `F1-002` intends.
      expect(childReward.target_audience).toBe('CHILD');
      expect(childReward.copy_key).toBe('LEARNING_GOAL_ACHIEVED');
      expect(childReward.age_band).toBe('11-13');
      // And the TYPE did not move, so the scorer, the quiet-hours matrix and
      // the analytics still read what they always read.
      expect(childReward.notification_type).toBe('REWARD_GRANTED_CHILD');

      // …and then it was refused.
      expect(childReward.decision).toBe('SUPPRESS');

      // The other three were not.
      for (const type of ['BADGE_EARNED', 'BADGE_EARNED_PARENT', 'REWARD_GRANTED']) {
        const row = await decisionFor(home.familyId, type);
        expect(`${type}:${row.decision}`).toBe(`${type}:SEND`);
        expect(`${type}:${row.outcome}`).toBe(`${type}:SEND`);
      }
    }, 120_000);
  });

  // ==========================================================================
  // 2. WHAT ACTUALLY REFUSED IT
  // ==========================================================================
  describe('2. the mechanism, named out of the persisted row rather than assumed', () => {
    let home: Household;

    beforeAll(async () => {
      jest.setSystemTime(NOON);
      home = await createHousehold('act-two');
      const goalId = await aCompletableGoal(home, GOAL_TITLE);
      await asFamily(home.familyId, () => learning.completeGoal(goalId, home.childId, home.familyId));
    }, 180_000);

    /**
     * THE FATIGUE GUARD IS NOT WHAT REFUSED IT, AND THIS IS THE PROOF.
     *
     * `evaluateFatigue` lives behind `SmartNotificationIntegrationService.notifyEvent`.
     * `SmartNotificationEngineService.handleEvent` RETURNS on a SUPPRESS verdict
     * — «there is nothing to hand on» — before that call, and `recordOutcome` is
     * only ever reached afterwards. So `outcome IS NULL` on a SUPPRESS row is
     * not a detail: it is the statement that the delivery pipeline, and
     * therefore the anti-fatigue guard, never saw this candidate at all.
     */
    it('the delivery pipeline was never reached — `outcome` is NULL, so `evaluateFatigue` never ran', async () => {
      const childReward = await decisionFor(home.familyId, 'REWARD_GRANTED_CHILD');
      expect(childReward.decision).toBe('SUPPRESS');
      expect(childReward.outcome).toBeNull();
      expect(childReward.outcome_reason).toBeNull();

      // The three delivered candidates DID reach it, which is what makes the
      // NULL above mean something.
      const badge = await decisionFor(home.familyId, 'BADGE_EARNED');
      expect(badge.outcome).toBe('SEND');
    }, 120_000);

    /**
     * WHAT DID REFUSE IT: the decision provider's own arithmetic, and the
     * component that took it under the floor.
     */
    it('it was SCORE_BELOW_FLOOR, and the FATIGUE_PENALTY is what took it there', async () => {
      const childReward = await decisionFor(home.familyId, 'REWARD_GRANTED_CHILD');
      expect(childReward.reason).toBe('SCORE_BELOW_FLOOR');

      const penalty = componentOf(childReward, 'FATIGUE_PENALTY');
      expect(penalty.contribution).toBeLessThan(0);

      // Remove that one component and the candidate clears the floor: the
      // sentence was not weak, it was penalised. Derived from the stored
      // explanation rather than by re-running the scorer, so this cannot
      // disagree with the row.
      const withoutFatigue = Number(childReward.score) - Number(penalty.contribution);
      expect(Number(childReward.score)).toBeLessThan(withoutFatigue);
      const badge = await decisionFor(home.familyId, 'BADGE_EARNED');
      expect(Number(badge.score)).toBeGreaterThan(Number(childReward.score));
    }, 120_000);

    /**
     * ==========================================================================
     * AND THE HISTORY IT WAS PENALISED AGAINST IS THE **PARENT'S**.
     * ==========================================================================
     *
     * `NotificationContextAssembler` fills the recent-activity facts from
     * `INotificationRepository.findRecentForChild`, which reads the
     * `notifications` table filtered by `child_id`. Every row in that table is a
     * PARENT-audience row — the child's own messages are written to
     * `child_messages` by `deliverNow`'s other branch and are never read back
     * here. So the count that suppressed the child's message is a count of
     * things the PARENT was told.
     *
     * `notification-class.ts` already states the opposite as product policy, in
     * `REWARD_GRANTED_CHILD`'s own `why`: «the two audiences must be capped and
     * scored independently: a parent at their daily maximum must not be able to
     * silence the child's own news about their own work.»
     *
     * This case does not assert what the fix should be. It measures the number,
     * beside the two tables it could have come from, so that the sentence above
     * is a reading rather than an opinion.
     */
    it('the count that suppressed the child is a count of the PARENT stream', async () => {
      const childReward = await decisionFor(home.familyId, 'REWARD_GRANTED_CHILD');
      const penalty = componentOf(childReward, 'FATIGUE_PENALTY');

      // `today=<n>/<max> hour=<n>/<max> category=<n>/<max>` — the scorer's own note.
      const today = /today=(\d+)\//.exec(String(penalty.note));
      expect(today).not.toBeNull();
      const counted = Number((today as RegExpExecArray)[1]);

      const parentRows = await notifications(home.familyId);
      const childRows = await childMessages(home.familyId);

      // The counted history is EXACTLY the parent's table, and the child's own
      // single message is not in it.
      expect(counted).toBe(parentRows.length);
      expect(childRows).toHaveLength(1);
      expect(counted).not.toBe(childRows.length);

      // …and every one of those rows really is the PARENT's half of a cause,
      // established from the decision ledger rather than assumed from the table.
      const parentTypes = parentRows.map((r) => String(r.type)).sort();
      expect(parentTypes).toEqual(['BADGE_EARNED_PARENT', 'REWARD_GRANTED']);
      for (const type of parentTypes) {
        const row = await decisionFor(home.familyId, type);
        expect(`${type}:${row.target_audience}`).toBe(`${type}:PARENT`);
      }
    }, 120_000);

    /**
     * AND THEY ARE NOT «TWO ACHIEVEMENT CAUSES», WHICH IS WHY THE PER-CATEGORY
     * CAP NEVER FIRED. The category axis is `notification-class.ts`'s, and it
     * puts the two causes in two different families.
     */
    it('the two child-facing causes are ACHIEVEMENT and REWARD, not two ACHIEVEMENTs', () => {
      expect(notificationCategoryOf('BADGE_EARNED')).toBe('ACHIEVEMENT');
      expect(notificationCategoryOf('REWARD_GRANTED_CHILD')).toBe('REWARD');
      expect(notificationCategoryOf('BADGE_EARNED')).not.toBe(
        notificationCategoryOf('REWARD_GRANTED_CHILD'),
      );
    });
  });

  // ==========================================================================
  // 3. THE LOSS, PINNED
  // ==========================================================================
  describe('3. THE DEFECT LEDGER — one entry, and it fails the build the day it is fixed', () => {
    let home: Household;

    beforeAll(async () => {
      jest.setSystemTime(NOON);
      home = await createHousehold('act-three');
      const goalId = await aCompletableGoal(home, GOAL_TITLE);
      await asFamily(home.familyId, () => learning.completeGoal(goalId, home.childId, home.familyId));
    }, 180_000);

    /**
     * `it.failing` PASSES WHILE THE BODY THROWS AND FAILS THE DAY IT STOPS —
     * the idiom `notification-producer-chain.guard.spec.ts`'s
     * `PRODUCERLESS_DEFECT_LEDGER` already uses in this repository, for the same
     * purpose: a known defect that is RECORDED AS A DEFECT rather than asserted
     * as behaviour, and that cannot be fixed silently.
     *
     * THE PRODUCT STATEMENT BEING PINNED: a child's first-ever completion is the
     * single most important moment in this product's feedback loop, and the
     * reward they earned must reach them in it. Today the badge sentence
     * arrives, the reward sentence does not, and nothing the child can read
     * mentions what they finished.
     *
     * DELETING THIS CASE REQUIRES THE FIX, not a decision.
     */
    it.failing(
      'the child’s first-ever completion carries the reward fact as well as the badge',
      async () => {
        const messages = await childMessages(home.familyId);
        // The badge arrived.
        expect(messages.some((m) => String(m.category) === 'BADGE_EARNED')).toBe(true);
        // And the thing they actually finished should have reached them too —
        // in a second sentence or, better, in the badge's own. It does not.
        expect(messages.some((m) => String(m.body).includes(GOAL_TITLE))).toBe(true);
      },
      120_000,
    );
  });

  // ==========================================================================
  // 4. REPLAY — proved by replaying
  // ==========================================================================
  describe('4. REPLAY — the same first completion driven twice is still one of everything', () => {
    let home: Household;
    let goalId = '';

    it('the identical cause, announced a second time, is refused by the database', async () => {
      jest.setSystemTime(NOON);
      home = await createHousehold('act-four');
      goalId = await aCompletableGoal(home, GOAL_TITLE);
      await asFamily(home.familyId, () => learning.completeGoal(goalId, home.childId, home.familyId));

      const before = {
        awards: (await badgeAwards(home.familyId)).length,
        decisions: (await decisions(home.familyId)).length,
        parent: (await notifications(home.familyId)).length,
        child: (await childMessages(home.familyId)).length,
      };
      expect(before).toEqual({ awards: 1, decisions: 4, parent: 2, child: 1 });
      const firstAwardId = (await badgeAwards(home.familyId))[0].id;

      /**
       * THE ONLY WAY TO REACH THE ANNOUNCER TWICE. `rewards_ledger_entries
       * (child_id, idempotency_key)` stops the second grant before it starts, so
       * the ledger rows are deleted and the identical trigger is re-driven —
       * the same technique `direct-path-reward-child.e2e.spec.ts §3` uses, and
       * for the same reason: a guarantee expressed as control flow is a
       * guarantee that can be forgotten, and this replays past it.
       *
       * `child_badge_awards (child_id, badge_id)` is NOT deleted, because it is
       * the constraint under test: the badge must not be re-awarded even when
       * the ledger no longer remembers paying for it.
       */
      await sys('clear the ledger so the announcer can be reached again', () =>
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
      // NOT VACUOUS: the coins really were paid a second time, so the announcer
      // really was reached. The BADGE was not — `awardBadgeIfNotAlready`
      // returned false from the UNIQUE constraint, so its grant never happened
      // and the count is one rather than two.
      expect(granted).toBe(1);

      const after = {
        awards: (await badgeAwards(home.familyId)).length,
        decisions: (await decisions(home.familyId)).length,
        parent: (await notifications(home.familyId)).length,
        child: (await childMessages(home.familyId)).length,
      };
      expect(after).toEqual(before);

      // The SAME row, not a replaced one.
      expect((await badgeAwards(home.familyId))[0].id).toBe(firstAwardId);

      // And exactly one BADGE ledger row would exist again if the badge had
      // been re-paid; the replay wrote only the COINS grant.
      const badgeLedger = await raw<any[]>(
        `SELECT COUNT(*)::int AS n FROM "rewards_ledger_entries"
          WHERE "family_id" = $1::uuid AND "reward_type" = 'BADGE'`,
        home.familyId,
      );
      expect(Number(badgeLedger[0].n)).toBe(0);
    }, 180_000);
  });
});
