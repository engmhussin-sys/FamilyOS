import { Test } from '@nestjs/testing';

import { RewardsEngineService } from '../../src/modules/life-intelligence/application/services/rewards-engine.service';
import { PrismaRewardsRepository } from '../../src/modules/life-intelligence/infrastructure/repositories/prisma-rewards.repository';
import { ChildrenService } from '../../src/modules/children/application/services/children.service';
import { LIFE_TIMELINE_WRITER } from '../../src/modules/life-intelligence/domain/life-timeline.types';

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
    repositoryMock.listActiveRewardRules.mockResolvedValue([xpRule]);
    repositoryMock.getOrCreateAccount.mockResolvedValue({ childId, xp: 0, coins: 0, stars: 0, level: 1 });

    const moduleRef = await Test.createTestingModule({
      providers: [
        RewardsEngineService,
        { provide: PrismaRewardsRepository, useValue: repositoryMock },
        { provide: ChildrenService, useValue: childrenServiceMock },
        { provide: LIFE_TIMELINE_WRITER, useValue: timelineMock },
      ],
    }).compile();
    service = moduleRef.get(RewardsEngineService);
  });

  describe('successful reward (no idempotency key — existing behavior unchanged)', () => {
    it('grants normally when no idempotencyKey is provided', async () => {
      repositoryMock.applyEarn.mockResolvedValue(true);

      const count = await service.processTriggerEvent(childId, familyId, { engine: 'habit-builder', type: 'x', payload: {} });

      expect(count).toBe(1);
      expect(repositoryMock.applyEarn).toHaveBeenCalledWith(childId, 'XP', 50, undefined, 'reward_rule:rule-1', undefined);
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
      expect(repositoryMock.applyEarn).toHaveBeenNthCalledWith(1, childId, 'XP', 50, undefined, 'reward_rule:rule-1', 'multi-grant-key:XP:reward_rule:rule-1');
      expect(repositoryMock.applyEarn).toHaveBeenNthCalledWith(2, childId, 'COINS', 20, undefined, 'reward_rule:rule-2', 'multi-grant-key:COINS:reward_rule:rule-2');
    });
  });
});
