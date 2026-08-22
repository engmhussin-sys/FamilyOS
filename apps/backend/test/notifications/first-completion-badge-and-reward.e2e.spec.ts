/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-var-requires */
/**
 * ============================================================================
 * THE CHILD'S VERY FIRST COMPLETION, MEASURED — AND THE STREAM THE CHILD IS
 * NOW SCORED AGAINST.
 * ============================================================================
 *
 * WHY THIS FILE EXISTS. Migration `0026_badge_catalogue` made badges earnable
 * for the first time, and a badge announces itself to BOTH audiences
 * (`rewards-engine.service.ts`: «badges are the most milestone-worthy grant
 * type … a deliberate product distinction»). So a child's FIRST habit, session,
 * streak or learning goal produces FOUR notification candidates in one instant
 * instead of two — and one of them, the child's own reward sentence, used to
 * stop being delivered.
 *
 * That side effect was first reported with a mechanism attached: «two
 * ACHIEVEMENT causes land in the same instant and `NotificationFatigueGuard`
 * correctly delivers one». BOTH HALVES OF THAT SENTENCE WERE WRONG, and this
 * file is the execution that said so. What was right was the consequence: the
 * child lost the reward sentence on the one completion that matters most.
 *
 * WHAT IT ACTUALLY WAS, measured out of the persisted row rather than reasoned
 * about:
 *
 *     REWARD_GRANTED_CHILD  aud=CHILD  copy=LEARNING_GOAL_ACHIEVED
 *       decision=SUPPRESS reason=SCORE_BELOW_FLOOR score=21 (floor 25)
 *       FATIGUE_PENALTY=-16.67  note="today=2/6 hour=2/3 category=1/2"
 *
 * The `2` was `notifications` — THE PARENT'S INBOX. The child's own inbox held
 * one row. `NotificationContextAssembler` filled `recentNotifications` from
 * `findRecentForChild` for every candidate, so a child-audience notification was
 * penalised in proportion to how busy the PARENT'S day had been — which
 * `notification-class.ts` forbids in words on `REWARD_GRANTED_CHILD`'s own
 * `why`: «a parent at their daily maximum must not be able to silence the
 * child's own news about their own work.»
 *
 * The assembler now reads the audience's own inbox — `notifications` for a
 * PARENT candidate, `child_messages` for a CHILD one — and this file measures
 * that from the ledger rows rather than from the fix's own description of
 * itself.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS MEASURED HERE, against a real PostgreSQL, a real Redis and the real
 * application — real `LearningEngineService`, real `RewardsEngineService`, real
 * platform Reward Rules (0007's 50 COINS and 0026's `first_learning_goal`
 * badge), real `SmartNotificationEngineService`, real decision provider, real
 * `ChildSafetyFilterService`, real delivery pipeline. Every count and every
 * sentence is read back out of PostgreSQL with SQL.
 *
 *   ACT I    THE FOUR CANDIDATES, AND FOUR DELIVERIES. One completion writes
 *            four `notification_decisions` rows: two PARENT rows that become
 *            `notifications`, and two CHILD rows that become `child_messages`.
 *            `REWARD_GRANTED_CHILD` carries `copy_key = LEARNING_GOAL_ACHIEVED`
 *            — it always did; what changed is that it now arrives.
 *
 *   ACT II   THE STREAM IT IS SCORED AGAINST, NAMED. The `FATIGUE_PENALTY`
 *            note's `today=` count is the CHILD's own inbox and is NOT the
 *            parent's, established by reading both tables beside the number.
 *            The two causes are not «two ACHIEVEMENT causes» either:
 *            `BADGE_EARNED` is ACHIEVEMENT and `REWARD_GRANTED_CHILD` is
 *            REWARD, which is why the per-category axis reads zero.
 *
 *   ACT III  THE PRODUCT STATEMENT. A child's first-ever completion reaches
 *            them carrying BOTH facts — the badge they were given and the goal
 *            they finished. Two sentences, because they are two facts and this
 *            product has no producer that supplies every slot of a combined
 *            one; `notification-producer-chain.guard.spec.ts` is what keeps
 *            that from being invented.
 *
 *   ACT IV   REPLAY, BY REPLAYING. The identical cause driven through the
 *            engine a second time with the ledger cleared — the only way to
 *            reach the announcer twice — still leaves one badge award, two
 *            child messages and four decision rows. Refused by UNIQUE INDEXES
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
  describe('1. one first-ever completion, four decisions, four deliveries', () => {
    let home: Household;
    let goalId = '';

    it('the badge is awarded and the child receives BOTH messages — the badge and the goal', async () => {
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

      // ===== …and ALL FOUR became a row a human can read =====
      //
      // TWO PER AUDIENCE, IN TWO TABLES, because `deliverNow` routes on the
      // audience: a PARENT candidate becomes a `notifications` row and a CHILD
      // candidate becomes an approval-gated `child_messages` row. Counting them
      // separately is the same statement the fix is about — these are two
      // streams, not one.
      expect(await notifications(home.familyId)).toHaveLength(2); // both parent halves
      const messages = await childMessages(home.familyId);
      expect(messages).toHaveLength(2);
      expect(messages.map((m) => String(m.category)).sort()).toEqual([
        'BADGE_EARNED',
        'REWARD_GRANTED_CHILD',
      ]);

      const badgeMessage = messages.find((m) => String(m.category) === 'BADGE_EARNED');
      const rewardMessage = messages.find((m) => String(m.category) === 'REWARD_GRANTED_CHILD');
      expect(badgeMessage.body).toContain(FIRST_GOAL_BADGE?.copy.ar.title);
      assertItReadsLikeASentence(badgeMessage.body);

      // TWO SENTENCES BECAUSE THEY ARE TWO FACTS. `LEARNING_GOAL_ACHIEVED` names
      // the goal; the badge sentence names the badge. They are not substitutes,
      // and neither one contains the other's fact.
      expect(badgeMessage.body).not.toContain(GOAL_TITLE);
      expect(rewardMessage.body).toContain(GOAL_TITLE);
      assertItReadsLikeASentence(rewardMessage.body);
      expect(rewardMessage.body).not.toContain(FIRST_GOAL_BADGE?.copy.ar.title);
    }, 120_000);

    it('the reward decision is correct AND delivered — the sentence and the outcome agree', async () => {
      const childReward = await decisionFor(home.familyId, 'REWARD_GRANTED_CHILD');

      // The provider picked the RIGHT sentence for the right audience: the
      // cause reached the copy layer exactly as `F1-002` intends.
      expect(childReward.target_audience).toBe('CHILD');
      expect(childReward.copy_key).toBe('LEARNING_GOAL_ACHIEVED');
      expect(childReward.age_band).toBe('11-13');
      // And the TYPE did not move, so the scorer, the quiet-hours matrix and
      // the analytics still read what they always read.
      expect(childReward.notification_type).toBe('REWARD_GRANTED_CHILD');

      // ALL FOUR reached the pipeline and all four came back SEND. `outcome` is
      // the PIPELINE's own verdict, written after `notifyEvent` returns, so a
      // non-null `SEND` on this row is the statement that the delivery path —
      // approval gate, safety filter, unique index — accepted it.
      for (const type of [
        'BADGE_EARNED',
        'BADGE_EARNED_PARENT',
        'REWARD_GRANTED',
        'REWARD_GRANTED_CHILD',
      ]) {
        const row = await decisionFor(home.familyId, type);
        expect(`${type}:${row.decision}`).toBe(`${type}:SEND`);
        expect(`${type}:${row.outcome}`).toBe(`${type}:SEND`);
      }
    }, 120_000);
  });

  // ==========================================================================
  // 2. THE STREAM THE CHILD IS SCORED AGAINST
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
     * THE DELIVERY PIPELINE IS REACHED, AND THE ROW IS WHERE THAT IS VISIBLE.
     *
     * `SmartNotificationEngineService.handleEvent` RETURNS on a SUPPRESS verdict
     * — «there is nothing to hand on» — BEFORE calling `notifyEvent`, and
     * `recordOutcome` is only ever reached afterwards. So `outcome` is the one
     * column that distinguishes «the engine decided not to» from «the engine
     * decided to and the pipeline agreed», and on this row it is `SEND`.
     *
     * That distinction is not decoration: while this candidate was suppressed,
     * `outcome IS NULL` proved that `evaluateFatigue` — the anti-fatigue GUARD,
     * which several readers assumed was the refuser — had never seen it at all.
     * The refuser was the decision provider's own arithmetic, one layer up.
     */
    it('the delivery pipeline was reached — `outcome` is SEND, so the engine and the pipeline agree', async () => {
      const childReward = await decisionFor(home.familyId, 'REWARD_GRANTED_CHILD');
      expect(childReward.decision).toBe('SEND');
      expect(childReward.outcome).toBe('SEND');
      expect(childReward.outcome_reason).toBeNull();

      // The other three reach it too, which is what makes the value above mean
      // something rather than being the only row anyone looked at.
      const badge = await decisionFor(home.familyId, 'BADGE_EARNED');
      expect(badge.outcome).toBe('SEND');
    }, 120_000);

    /**
     * IT CLEARS THE FLOOR, AND THE MARGIN IS THE FATIGUE PENALTY'S TO GIVE.
     *
     * The score is still penalised — the child really has had one message
     * already this instant — but it is penalised by the child's OWN one row
     * instead of by the parent's two, and the difference is the difference
     * between 21 and 30 against a floor of 25.
     */
    it('it is above the floor, and FATIGUE_PENALTY is the term that decides the margin', async () => {
      const childReward = await decisionFor(home.familyId, 'REWARD_GRANTED_CHILD');
      expect(childReward.reason).not.toBe('SCORE_BELOW_FLOOR');

      const penalty = componentOf(childReward, 'FATIGUE_PENALTY');
      expect(penalty.contribution).toBeLessThan(0);

      // The candidate carries a penalty AND still clears the floor. Derived from
      // the stored explanation rather than by re-running the scorer, so this
      // cannot disagree with the row.
      const withoutFatigue = Number(childReward.score) - Number(penalty.contribution);
      expect(Number(childReward.score)).toBeLessThan(withoutFatigue);
      const badge = await decisionFor(home.familyId, 'BADGE_EARNED');
      expect(Number(badge.score)).toBeGreaterThan(Number(childReward.score));
    }, 120_000);

    /**
     * ==========================================================================
     * AND THE HISTORY IT IS PENALISED AGAINST IS THE **CHILD'S**.
     * ==========================================================================
     *
     * THE DEFECT THIS CASE WAS WRITTEN FOR. `NotificationContextAssembler` used
     * to fill `recentNotifications` from `INotificationRepository.findRecentForChild`
     * for every candidate — the `notifications` table filtered by `child_id`.
     * Every row in that table is a PARENT-audience row; the child's own messages
     * are written to `child_messages` by `deliverNow`'s other branch and were
     * never read back. So the count that suppressed the child's message was a
     * count of things the PARENT was told, and the measured note read
     * `today=2/6` against a child inbox holding one.
     *
     * `notification-class.ts` states the rule in `REWARD_GRANTED_CHILD`'s own
     * `why`: «the two audiences must be capped and scored independently: a
     * parent at their daily maximum must not be able to silence the child's own
     * news about their own work.»
     *
     * THIS CASE MEASURES THE NUMBER BESIDE BOTH TABLES IT COULD HAVE COME FROM,
     * so «it is the child's stream» is a reading rather than an opinion. It is
     * deliberately NOT written as «counted === 1»: a literal would pass again on
     * the day the two streams re-merge at any household where the counts happen
     * to coincide.
     */
    it('the count the child is scored against is a count of the CHILD stream, not the parent’s', async () => {
      const childReward = await decisionFor(home.familyId, 'REWARD_GRANTED_CHILD');
      const penalty = componentOf(childReward, 'FATIGUE_PENALTY');

      // `today=<n>/<max> hour=<n>/<max> category=<n>/<max>` — the scorer's own note.
      const today = /today=(\d+)\//.exec(String(penalty.note));
      expect(today).not.toBeNull();
      const counted = Number((today as RegExpExecArray)[1]);

      const parentRows = await notifications(home.familyId);
      const childRows = await childMessages(home.familyId);

      // THE SETUP IS NOT VACUOUS: the two tables hold DIFFERENT numbers of rows
      // at the instant this candidate was scored, so «which one was counted» has
      // an answer that a coincidence cannot supply. Two parent rows exist by the
      // end; the child had exactly one — the badge — when the reward was scored,
      // and gained the second by being delivered.
      expect(parentRows).toHaveLength(2);
      expect(childRows).toHaveLength(2);
      expect(counted).toBe(childRows.length - 1);
      expect(counted).not.toBe(parentRows.length);

      // …and every one of the parent rows really is the PARENT's half of a
      // cause, established from the decision ledger rather than assumed from the
      // table — so «not the parent's count» names a real, non-empty stream.
      const parentTypes = parentRows.map((r) => String(r.type)).sort();
      expect(parentTypes).toEqual(['BADGE_EARNED_PARENT', 'REWARD_GRANTED']);
      for (const type of parentTypes) {
        const row = await decisionFor(home.familyId, type);
        expect(`${type}:${row.target_audience}`).toBe(`${type}:PARENT`);
      }

      // AND THE PARENT'S OWN HALF IS UNCHANGED BY ANY OF IT: `REWARD_GRANTED` is
      // scored over `notifications`, which is where the parent's rows are, and
      // its note counts the ONE parent row that preceded it.
      const parentReward = await decisionFor(home.familyId, 'REWARD_GRANTED');
      const parentPenalty = componentOf(parentReward, 'FATIGUE_PENALTY');
      const parentToday = /today=(\d+)\//.exec(String(parentPenalty.note));
      expect(Number((parentToday as RegExpExecArray)[1])).toBe(1);
    }, 120_000);

    /**
     * AND THEY ARE NOT «TWO ACHIEVEMENT CAUSES», WHICH IS WHY THE PER-CATEGORY
     * AXIS READS ZERO. The category axis is `notification-class.ts`'s, and it
     * puts the two causes in two different families — so the child's badge does
     * not spend the child's REWARD budget, in either direction.
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
  // 3. THE PRODUCT STATEMENT
  // ==========================================================================
  describe('3. the child’s first-ever completion carries BOTH facts', () => {
    let home: Household;

    beforeAll(async () => {
      jest.setSystemTime(NOON);
      home = await createHousehold('act-three');
      const goalId = await aCompletableGoal(home, GOAL_TITLE);
      await asFamily(home.familyId, () => learning.completeGoal(goalId, home.childId, home.familyId));
    }, 180_000);

    /**
     * THIS CASE WAS AN `it.failing` DEFECT-LEDGER ENTRY — the idiom
     * `notification-producer-chain.guard.spec.ts`'s `PRODUCERLESS_DEFECT_LEDGER`
     * uses, where the body throws, the case passes, and the build breaks the day
     * the defect is fixed. It broke. So the framing is deleted rather than
     * carried: a ledger entry that outlives its defect is a scoreboard.
     *
     * THE PRODUCT STATEMENT IT PINNED, now asserted as behaviour: a child's
     * first-ever completion is the single most important moment in this
     * product's feedback loop, and the reward they earned must reach them in it.
     *
     * TWO SENTENCES, NOT ONE, AND THAT IS THE RIGHT ANSWER RATHER THAN A
     * COMPROMISE. A combined «you finished X and earned a badge» copy key would
     * need a producer that supplies the goal title AND the badge title AND the
     * points in one payload, and no producer in this codebase does: the badge is
     * announced by `RewardsEngineService`'s badge branch and the goal by its
     * grant branch, from two different facts, through two different causal keys.
     * Inventing the key anyway would put a slot in the catalogue that nothing
     * fills, which is exactly what `PRODUCERLESS_DEFECT_LEDGER` exists to keep
     * empty. Two true sentences beat one that leaks a placeholder.
     */
    it('both the badge and the goal reach the child, as two separate messages', async () => {
      const messages = await childMessages(home.familyId);
      expect(messages).toHaveLength(2);

      // The badge arrived — it always did.
      expect(messages.some((m) => String(m.category) === 'BADGE_EARNED')).toBe(true);
      // And so did the thing they actually finished, named in the sentence.
      expect(messages.some((m) => String(m.body).includes(GOAL_TITLE))).toBe(true);

      // TWO MESSAGES, TWO CAUSAL KEYS. The `:child` facet is on both, and they
      // differ — so these are two rows the database would keep apart, not one
      // row counted twice.
      const keys = messages.map((m) => String(m.source_event_id));
      expect(new Set(keys).size).toBe(2);
      for (const key of keys) expect(key.endsWith(':child')).toBe(true);

      // AND EVERY ONE OF THEM READS LIKE A SENTENCE — Arabic, no placeholder, no
      // leaked enum. A second message that arrives broken is not an improvement
      // on a second message that never arrives.
      for (const m of messages) {
        expect(String(m.body)).toMatch(ARABIC_LETTERS);
        assertItReadsLikeASentence(String(m.body));
      }
    }, 120_000);
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
      expect(before).toEqual({ awards: 1, decisions: 4, parent: 2, child: 2 });
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
