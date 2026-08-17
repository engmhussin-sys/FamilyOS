import { Test } from '@nestjs/testing';

import { RewardsEngineService } from '../../src/modules/life-intelligence/application/services/rewards-engine.service';
import { PrismaRewardsRepository } from '../../src/modules/life-intelligence/infrastructure/repositories/prisma-rewards.repository';
import { ChildrenService } from '../../src/modules/children/application/services/children.service';
import { LIFE_TIMELINE_WRITER } from '../../src/modules/life-intelligence/domain/life-timeline.types';
import { SmartNotificationEngineService } from '../../src/modules/notification-engine/application/services/smart-notification-engine.service';
import { FamilyDateService } from '../../src/common/time/family-date.service';
import { GrowthEventEmitter } from '../../src/modules/analytics/application/growth-event-emitter.service';

/** The family's calendar day, fixed so the assertions can name it. */
const BUSINESS_DAY = '2026-08-14';

describe('RewardsEngineService — Double Reward Protection (Sprint 16.1 Phase 4, CLOSES A REAL GAP: zero idempotency existed before this)', () => {
  const repositoryMock = {
    listActiveRewardRules: jest.fn(),
    findBadgeByKey: jest.fn(),
    awardBadgeIfNotAlready: jest.fn(),
    applyEarn: jest.fn(),
    getOrCreateAccount: jest.fn(),
  };
  const childrenServiceMock = { assertChildBelongsToFamily: jest.fn() };
  const timelineMock = { record: jest.fn() };
  /**
   * PHASE F (`F6-003`) — the double is now the DECISION LAYER, not the delivery
   * pipeline. `RewardsEngineService` no longer knows how a notification is
   * worded or who it is for; it names a cause and hands over a key. What this
   * suite asserts about that has NOT been weakened — every «notifies», «does
   * not notify» and «not twice» expectation below is intact, restated against
   * `handleEvent` and, where it used to check a hardcoded Arabic title, it now
   * checks the STRONGER property: that the producer supplies NO copy at all.
   */
  const notificationEngineMock = { handleEvent: jest.fn() };
  // B4: the engine now counts maxPerDay/maxPerWeek on the FAMILY's business
  // day, so it depends on the single date authority B1+B2 introduced. Every
  // rule in this suite is uncapped, so none of these is ever called — which is
  // itself the assertion that an uncapped rule costs no extra query and no
  // advisory lock, leaving the pre-B4 hot path exactly as it was.
  const familyDateMock = {
    // Resolved ONCE per trigger and stamped onto every ledger row this trigger
    // writes, so the day a grant belongs to and the day a cap counts are the
    // same value rather than two derivations.
    getBusinessDate: jest.fn().mockResolvedValue(BUSINESS_DAY),
  };

  let service: RewardsEngineService;

  const childId = 'child-1';
  const familyId = 'family-1';

  const xpRule = {
    id: 'rule-1',
    familyId: null,
    triggerEngine: 'habit-builder',
    triggerCondition: {},
    rewardType: 'XP' as const,
    rewardAmountOrBadgeId: '50',
    isActive: true,
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    notificationEngineMock.handleEvent.mockResolvedValue({
      decision: { verdict: 'SEND', targetAudience: 'CHILD', score: 40, reason: 'SCORE_IN_DEFER_BAND' },
      decisionId: 'decision-1',
      outcome: { type: 'x', targetAudience: 'CHILD', decision: 'SEND' },
      title: 'x',
      body: 'y',
      aiRewritten: false,
      aiFailed: false,
    });
    repositoryMock.listActiveRewardRules.mockResolvedValue([xpRule]);
    repositoryMock.getOrCreateAccount.mockResolvedValue({ childId, xp: 0, coins: 0, stars: 0, level: 1 });

    const moduleRef = await Test.createTestingModule({
      providers: [
        RewardsEngineService,
        { provide: PrismaRewardsRepository, useValue: repositoryMock },
        { provide: ChildrenService, useValue: childrenServiceMock },
        { provide: LIFE_TIMELINE_WRITER, useValue: timelineMock },
        { provide: SmartNotificationEngineService, useValue: notificationEngineMock },
        { provide: FamilyDateService, useValue: familyDateMock },
        // PHASE D (GROWTH). `GrowthEventEmitter.emit` never throws by contract
        // (see its class docstring: analytics must never be able to fail a
        // reward, a habit or an AI answer), so a resolving double is a faithful
        // stand-in and these suites stay about the business path.
        { provide: GrowthEventEmitter, useValue: { emit: jest.fn().mockResolvedValue(undefined) } },
      ],
    }).compile();
    service = moduleRef.get(RewardsEngineService);
  });

  describe('successful reward (no idempotency key — existing behavior unchanged)', () => {
    it('grants normally when no idempotencyKey is provided', async () => {
      repositoryMock.applyEarn.mockResolvedValue(true);

      const count = await service.processTriggerEvent(childId, familyId, { engine: 'habit-builder', type: 'x', payload: {} });

      expect(count).toBe(1);
      // B4: the trailing `undefined` is the CAP argument. This rule declares no
      // maxPerDay/maxPerWeek, so no cap is built and no advisory lock is taken —
      // asserting it explicitly keeps the pre-B4 hot path pinned.
      expect(repositoryMock.applyEarn).toHaveBeenCalledWith(childId, 'XP', 50, undefined, 'reward_rule:rule-1', undefined, undefined, BUSINESS_DAY);
    });
  });

  describe('duplicate event (CRITICAL: the exact scenario this Phase exists to prevent)', () => {
    it('grants ONCE for a fresh idempotencyKey, and the SAME key a second time correctly grants ZERO', async () => {
      repositoryMock.applyEarn.mockResolvedValueOnce(true);
      const first = await service.processTriggerEvent(childId, familyId, {
        engine: 'habit-builder',
        type: 'HABIT_COMPLETED',
        payload: {},
        idempotencyKey: 'habit-completion:habit-1:2026-08-10',
      });
      expect(first).toBe(1);

      repositoryMock.applyEarn.mockResolvedValueOnce(false);
      const second = await service.processTriggerEvent(childId, familyId, {
        engine: 'habit-builder',
        type: 'HABIT_COMPLETED',
        payload: {},
        idempotencyKey: 'habit-completion:habit-1:2026-08-10',
      });

      expect(second).toBe(0);
    });

    it('CRITICAL: a duplicate (applyEarn returns false) does NOT write a Timeline entry either — no partial duplicate side effects', async () => {
      const levelUpRule = { ...xpRule, rewardAmountOrBadgeId: '10000' };
      repositoryMock.listActiveRewardRules.mockResolvedValue([levelUpRule]);
      repositoryMock.applyEarn.mockResolvedValue(false);

      await service.processTriggerEvent(childId, familyId, {
        engine: 'habit-builder',
        type: 'x',
        payload: {},
        idempotencyKey: 'dup-key',
      });

      expect(timelineMock.record).not.toHaveBeenCalled();
    });
  });

  describe('retry (the SAME request sent again after a client-side timeout)', () => {
    it('the second (retried) attempt with the same idempotencyKey grants zero additional reward', async () => {
      repositoryMock.applyEarn.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

      const attempt1 = await service.processTriggerEvent(childId, familyId, {
        engine: 'habit-builder', type: 'x', payload: {}, idempotencyKey: 'retry-key',
      });
      const attempt2 = await service.processTriggerEvent(childId, familyId, {
        engine: 'habit-builder', type: 'x', payload: {}, idempotencyKey: 'retry-key',
      });

      expect(attempt1).toBe(1);
      expect(attempt2).toBe(0);
    });
  });

  describe('concurrent execution (simulated — two calls in flight before either resolves)', () => {
    it('only ONE of two concurrent requests with the same idempotencyKey results in a real grant', async () => {
      let grantIssued = false;
      repositoryMock.applyEarn.mockImplementation(async () => {
        if (grantIssued) return false;
        grantIssued = true;
        return true;
      });

      const event = { engine: 'habit-builder', type: 'x', payload: {}, idempotencyKey: 'concurrent-key' };
      const [resultA, resultB] = await Promise.all([
        service.processTriggerEvent(childId, familyId, event),
        service.processTriggerEvent(childId, familyId, event),
      ]);

      const totalGrants = resultA + resultB;
      expect(totalGrants).toBe(1);
    });
  });

  describe('failed reward then retry (a real failure is NOT the same as a duplicate)', () => {
    it('a genuine error propagates and does NOT count as a duplicate — the retry after a real failure must still succeed', async () => {
      repositoryMock.applyEarn.mockRejectedValueOnce(new Error('transient DB error'));

      await expect(
        service.processTriggerEvent(childId, familyId, { engine: 'habit-builder', type: 'x', payload: {}, idempotencyKey: 'fail-then-retry' }),
      ).rejects.toThrow('transient DB error');

      repositoryMock.applyEarn.mockResolvedValueOnce(true);
      const retryResult = await service.processTriggerEvent(childId, familyId, {
        engine: 'habit-builder', type: 'x', payload: {}, idempotencyKey: 'fail-then-retry',
      });
      expect(retryResult).toBe(1);
    });
  });

  describe('multiple distinct grants from one event', () => {
    it('a single trigger event matching MULTIPLE rules builds a distinct idempotency key per grant', async () => {
      const coinsRule = { ...xpRule, id: 'rule-2', rewardType: 'COINS' as const, rewardAmountOrBadgeId: '20' };
      repositoryMock.listActiveRewardRules.mockResolvedValue([xpRule, coinsRule]);
      repositoryMock.applyEarn.mockResolvedValueOnce(false).mockResolvedValueOnce(true);

      const count = await service.processTriggerEvent(childId, familyId, {
        engine: 'habit-builder', type: 'x', payload: {}, idempotencyKey: 'multi-grant-key',
      });

      expect(count).toBe(1);
      expect(repositoryMock.applyEarn).toHaveBeenNthCalledWith(1, childId, 'XP', 50, undefined, 'reward_rule:rule-1', 'multi-grant-key:XP:reward_rule:rule-1', undefined, BUSINESS_DAY);
      expect(repositoryMock.applyEarn).toHaveBeenNthCalledWith(2, childId, 'COINS', 20, undefined, 'reward_rule:rule-2', 'multi-grant-key:COINS:reward_rule:rule-2', undefined, BUSINESS_DAY);
    });
  });

  describe('Sprint 16.2 Phase 2 — Reward -> Notification (CLOSES A REAL GAP: reward grants never triggered any notification before this)', () => {
    it('a real BADGE grant notifies BOTH the child and the parent', async () => {
      const badgeRule = { ...xpRule, rewardType: 'BADGE' as const, rewardAmountOrBadgeId: 'first-habit' };
      repositoryMock.listActiveRewardRules.mockResolvedValue([badgeRule]);
      repositoryMock.findBadgeByKey.mockResolvedValue({ id: 'badge-1', title: 'First Habit' });
      repositoryMock.awardBadgeIfNotAlready.mockResolvedValue(true);
      repositoryMock.applyEarn.mockResolvedValue(true);

      await service.processTriggerEvent(childId, familyId, { engine: 'habit-builder', type: 'x', payload: {} });

      // PHASE F (`F6-003`) — TWO TYPES, ONE CAUSE. The audience used to be a
      // positional argument beside a single `BADGE_EARNED` type, which is how
      // one name came to mean two different messages to two different people.
      // The catalogue entry declares the audience now, so the parent's badge
      // sentence has its own key — and the SHARED `sourceEventId` is what keeps
      // «one cause» true across the split.
      expect(notificationEngineMock.handleEvent).toHaveBeenCalledWith(
        expect.objectContaining({ childId, familyId, eventType: 'BADGE_EARNED' }),
      );
      expect(notificationEngineMock.handleEvent).toHaveBeenCalledWith(
        expect.objectContaining({ childId, familyId, eventType: 'BADGE_EARNED_PARENT' }),
      );
      const [childCall, parentCall] = notificationEngineMock.handleEvent.mock.calls.map((c) => c[0]);
      expect(childCall.sourceEventId).toBe(parentCall.sourceEventId);
      // The badge's own title reaches the SENTENCE as a variable, not as a
      // pre-written string: «كسبت وسام First Habit 🏅» for a young child and a
      // different register for a teenager, both from one catalogue key.
      expect(childCall.variables).toEqual({ badgeTitle: 'First Habit' });
    });

    it('a level-up notifies the CHILD', async () => {
      const bigXpRule = { ...xpRule, rewardAmountOrBadgeId: '10000' };
      repositoryMock.listActiveRewardRules.mockResolvedValue([bigXpRule]);
      repositoryMock.applyEarn.mockResolvedValue(true);

      await service.processTriggerEvent(childId, familyId, { engine: 'habit-builder', type: 'x', payload: {} });

      expect(notificationEngineMock.handleEvent).toHaveBeenCalledWith(
        expect.objectContaining({ childId, familyId, eventType: 'LEVEL_UP', variables: { level: expect.any(Number) } }),
      );
    });

    /**
     * B4 CHANGED THIS RULE DELIBERATELY, and the change is the point.
     *
     * Sprint 16.2 decided a routine XP grant notifies nobody, on the reasoning
     * that a notification per small grant is spam. That reasoning was sound and
     * its consequence was not: the DIRECT path (`/self/habits/:id/complete` and
     * siblings — the only routes any real client calls, PA-M-034) writes no
     * outbox message, so `REWARD_GRANTED` is never emitted, so
     * `NotificationRewardConsumer` never runs. A child earning a reward on the
     * path the product actually uses notified NOBODY. That is the 🔴 Phase A
     * recorded against the Notification stage of six chains.
     *
     * Meanwhile the OUTBOX path already notified on EVERY grant, routine or
     * not. So the old rule was not "don't spam" — it was "notify on one path
     * and not the other", which is an asymmetry, not a policy.
     *
     * B4's rule: ONE REAL GRANT -> ONE PARENT NOTIFICATION, on both paths,
     * routed through the SAME `NotificationFatigueGuard` (cooldown, duplicate
     * window, quiet hours, daily max, category max) that exists precisely to
     * decide what is too much. Volume control belongs to the guard, not to a
     * branch that skipped a whole delivery path.
     */
    it('a routine XP grant on the DIRECT path notifies the parent exactly once', async () => {
      repositoryMock.applyEarn.mockResolvedValue(true); // small xpRule amount (50), no level threshold crossed

      await service.processTriggerEvent(childId, familyId, { engine: 'habit-builder', type: 'x', payload: {} });

      expect(notificationEngineMock.handleEvent).toHaveBeenCalledTimes(1);
      expect(notificationEngineMock.handleEvent).toHaveBeenCalledWith(
        expect.objectContaining({ childId, familyId, eventType: 'REWARD_GRANTED', trigger: 'DOMAIN_EVENT' }),
      );
      // PHASE F (`F6-003`) — THE STRONGER ASSERTION THAT REPLACED
      // `expect(sent.title).toBe('مكافأة جديدة')`.
      //
      // That line pinned a literal this file used to own. Owning it was the
      // defect: the same sentence was written out a second time in
      // `notification-reward.consumer.ts`, kept in sync by a comment, and
      // neither copy could name the child because neither producer knew it.
      // The producer now supplies NO user-facing text whatsoever — asserted
      // here, so a future edit that re-introduces a literal fails loudly rather
      // than quietly re-forking the product's copy.
      const sent = notificationEngineMock.handleEvent.mock.calls[0][0];
      expect(sent.title).toBeUndefined();
      expect(sent.body).toBeUndefined();
      expect(sent.targetAudience).toBeUndefined();
      expect(sent.sourceEventId).toBeTruthy();
    });

    /**
     * THE OTHER HALF OF THE SAME RULE, and the reason `announcedViaOutbox`
     * exists. A grant made by `RewardsCompletionConsumer` is announced by the
     * `REWARD_GRANTED` outbox message it writes, which
     * `NotificationRewardConsumer` turns into one notification. If the engine
     * also notified, one completion through `/events/batch` would produce TWO —
     * which is PA-B-011's shape, reintroduced by the fix for PA-B-015.
     */
    it('a grant announced through the OUTBOX does not notify from the engine — the consumer owns it', async () => {
      repositoryMock.applyEarn.mockResolvedValue(true);

      await service.processTriggerEvent(childId, familyId, {
        engine: 'habit-builder',
        type: 'x',
        payload: {},
        idempotencyKey: 'batch-key',
        announcedViaOutbox: true,
      });

      expect(notificationEngineMock.handleEvent).not.toHaveBeenCalled();
      // The TIMELINE entry is still written on both paths — it is the half the
      // outbox path never had.
      expect(timelineMock.record).toHaveBeenCalledWith(
        expect.objectContaining({ category: 'REWARDS', eventType: 'reward_granted' }),
      );
    });

    it('CRITICAL: a duplicate/idempotency-rejected grant (granted === false) does NOT notify', async () => {
      const bigXpRule = { ...xpRule, rewardAmountOrBadgeId: '10000' };
      repositoryMock.listActiveRewardRules.mockResolvedValue([bigXpRule]);
      repositoryMock.applyEarn.mockResolvedValue(false); // simulated duplicate — the exact P2002 case

      await service.processTriggerEvent(childId, familyId, { engine: 'habit-builder', type: 'x', payload: {}, idempotencyKey: 'dup-key' });

      expect(notificationEngineMock.handleEvent).not.toHaveBeenCalled();
    });

    it('CRITICAL: a retry (same idempotencyKey, second call) does NOT notify a second time', async () => {
      const bigXpRule = { ...xpRule, rewardAmountOrBadgeId: '10000' };
      repositoryMock.listActiveRewardRules.mockResolvedValue([bigXpRule]);

      repositoryMock.applyEarn.mockResolvedValueOnce(true);
      await service.processTriggerEvent(childId, familyId, { engine: 'habit-builder', type: 'x', payload: {}, idempotencyKey: 'retry-key' });
      // TWO, because this 10,000 XP grant crosses a level threshold: the
      // milestone LEVEL_UP notification to the child, and B4's single
      // REWARD_GRANTED notification to the parent. The NUMBER is not the
      // property under test — the property is that the RETRY below adds none.
      expect(notificationEngineMock.handleEvent).toHaveBeenCalledTimes(2);

      repositoryMock.applyEarn.mockResolvedValueOnce(false); // the retry — correctly rejected as a duplicate
      await service.processTriggerEvent(childId, familyId, { engine: 'habit-builder', type: 'x', payload: {}, idempotencyKey: 'retry-key' });
      expect(notificationEngineMock.handleEvent).toHaveBeenCalledTimes(2); // still 2, not 4
    });

    it('CRITICAL: a FAILED reward (real error, not a duplicate) does NOT notify — the error propagates before notification code is ever reached', async () => {
      repositoryMock.applyEarn.mockRejectedValueOnce(new Error('transient DB error'));

      await expect(
        service.processTriggerEvent(childId, familyId, { engine: 'habit-builder', type: 'x', payload: {} }),
      ).rejects.toThrow('transient DB error');

      expect(notificationEngineMock.handleEvent).not.toHaveBeenCalled();
    });

    it('a notification delivery failure never blocks the reward grant itself — best-effort, matching every other side-effect in this file', async () => {
      const bigXpRule = { ...xpRule, rewardAmountOrBadgeId: '10000' };
      repositoryMock.listActiveRewardRules.mockResolvedValue([bigXpRule]);
      repositoryMock.applyEarn.mockResolvedValue(true);
      notificationEngineMock.handleEvent.mockRejectedValueOnce(new Error('notification service down'));

      const count = await service.processTriggerEvent(childId, familyId, { engine: 'habit-builder', type: 'x', payload: {} });

      expect(count).toBe(1); // the grant itself still succeeded and was counted
    });
  });
});
