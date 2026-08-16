import { Test } from '@nestjs/testing';
import { BadRequestException, NotFoundException } from '@nestjs/common';

import { RewardsEngineService } from '../../src/modules/life-intelligence/application/services/rewards-engine.service';
import { PrismaRewardsRepository } from '../../src/modules/life-intelligence/infrastructure/repositories/prisma-rewards.repository';
import { ChildrenService } from '../../src/modules/children/application/services/children.service';
import { LIFE_TIMELINE_WRITER } from '../../src/modules/life-intelligence/domain/life-timeline.types';
import { SmartNotificationIntegrationService } from '../../src/modules/life-intelligence/application/services/smart-notification-integration.service';
import { FamilyDateService } from '../../src/common/time/family-date.service';
import { GrowthEventEmitter } from '../../src/modules/analytics/application/growth-event-emitter.service';

describe('RewardsEngineService', () => {
  const repositoryMock = {
    getOrCreateAccount: jest.fn(),
    applyEarn: jest.fn(),
    findBadgeByKey: jest.fn(),
    awardBadgeIfNotAlready: jest.fn(),
    listActiveRewardRules: jest.fn(),
    listActiveCatalogItems: jest.fn(),
    findCatalogItemById: jest.fn(),
    createRedemption: jest.fn(),
    findRedemptionById: jest.fn(),
    approveRedemption: jest.fn(),
    denyRedemption: jest.fn(),
  };
  const childrenServiceMock = { assertChildBelongsToFamily: jest.fn() };
  const timelineMock = { record: jest.fn() };
  const notificationIntegrationMock = { notifyEvent: jest.fn() };
  // B4: rule caps are counted on the FAMILY's business day, so the engine now
  // depends on B1+B2's single date authority. No rule in this suite declares a
  // cap, so nothing here is ever called.
  const familyDateMock = { getBusinessDate: jest.fn().mockResolvedValue('2026-08-14') };
  let service: RewardsEngineService;
  const childId = 'child-1';
  const familyId = 'family-1';

  beforeEach(async () => {
    jest.clearAllMocks();
    notificationIntegrationMock.notifyEvent.mockResolvedValue({ type: 'x', targetAudience: 'CHILD', decision: 'SEND' });
    const moduleRef = await Test.createTestingModule({
      providers: [
        RewardsEngineService,
        { provide: PrismaRewardsRepository, useValue: repositoryMock },
        { provide: ChildrenService, useValue: childrenServiceMock },
        { provide: LIFE_TIMELINE_WRITER, useValue: timelineMock },
        { provide: SmartNotificationIntegrationService, useValue: notificationIntegrationMock },
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

  describe('processTriggerEvent', () => {
    it('SECURITY REGRESSION TEST: verifies ownership before touching any reward rule — previously this method had zero ownership check, letting an authenticated parent grant rewards to a child outside their own family', async () => {
      childrenServiceMock.assertChildBelongsToFamily.mockRejectedValue(new Error('not found'));

      await expect(
        service.processTriggerEvent(childId, familyId, { engine: 'faith', type: 't', payload: {} }),
      ).rejects.toThrow('not found');

      expect(repositoryMock.listActiveRewardRules).not.toHaveBeenCalled();
    });

    it('proceeds normally once ownership is verified', async () => {
      childrenServiceMock.assertChildBelongsToFamily.mockResolvedValue(undefined);
      repositoryMock.listActiveRewardRules.mockResolvedValue([]);

      const count = await service.processTriggerEvent(childId, familyId, { engine: 'faith', type: 't', payload: {} });

      expect(childrenServiceMock.assertChildBelongsToFamily).toHaveBeenCalledWith(childId, familyId);
      expect(count).toBe(0);
    });
  });

  describe('processTriggerEvent', () => {
    it('awards a badge exactly once even if triggered twice (award idempotency respected)', async () => {
      repositoryMock.listActiveRewardRules.mockResolvedValue([
        { id: 'r1', familyId: null, triggerEngine: 'faith', triggerCondition: { x: 1 }, rewardType: 'BADGE', rewardAmountOrBadgeId: 'badge-key', isActive: true },
      ]);
      repositoryMock.findBadgeByKey.mockResolvedValue({ id: 'b1', key: 'badge-key', title: 'Test Badge', description: '', criteria: {}, isGroupAchievement: false });
      repositoryMock.awardBadgeIfNotAlready.mockResolvedValue(false);

      await service.processTriggerEvent(childId, familyId, { engine: 'faith', type: 't', payload: { x: 1 } });

      expect(repositoryMock.applyEarn).not.toHaveBeenCalled();
      expect(timelineMock.record).not.toHaveBeenCalled();
    });

    it('grants and writes a Timeline event when a badge is newly awarded', async () => {
      repositoryMock.listActiveRewardRules.mockResolvedValue([
        { id: 'r1', familyId: null, triggerEngine: 'faith', triggerCondition: { x: 1 }, rewardType: 'BADGE', rewardAmountOrBadgeId: 'badge-key', isActive: true },
      ]);
      repositoryMock.findBadgeByKey.mockResolvedValue({ id: 'b1', key: 'badge-key', title: 'Test Badge', description: '', criteria: {}, isGroupAchievement: false });
      repositoryMock.awardBadgeIfNotAlready.mockResolvedValue(true);
      repositoryMock.applyEarn.mockResolvedValue(true);

      await service.processTriggerEvent(childId, familyId, { engine: 'faith', type: 't', payload: { x: 1 } });

      // B4: the trailing `undefined` is the CAP argument — this rule declares no maxPerDay/maxPerWeek.
      expect(repositoryMock.applyEarn).toHaveBeenCalledWith(childId, 'BADGE', 1, undefined, 'reward_rule:r1', undefined, undefined, '2026-08-14');
      expect(timelineMock.record).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'badge_awarded' }));
    });

    it('skips a rule referencing a badge key that no longer exists, without crashing', async () => {
      repositoryMock.listActiveRewardRules.mockResolvedValue([
        { id: 'r1', familyId: null, triggerEngine: 'faith', triggerCondition: {}, rewardType: 'BADGE', rewardAmountOrBadgeId: 'deleted-badge', isActive: true },
      ]);
      repositoryMock.findBadgeByKey.mockResolvedValue(null);

      await expect(service.processTriggerEvent(childId, familyId, { engine: 'faith', type: 't', payload: {} })).resolves.toBe(0);
      expect(repositoryMock.applyEarn).not.toHaveBeenCalled();
    });

    it('writes a level-up Timeline event only when XP crosses a threshold', async () => {
      repositoryMock.listActiveRewardRules.mockResolvedValue([
        { id: 'r2', familyId: null, triggerEngine: 'health', triggerCondition: {}, rewardType: 'XP', rewardAmountOrBadgeId: '100', isActive: true },
      ]);
      repositoryMock.getOrCreateAccount.mockResolvedValue({ id: 'a1', childId, xp: 50, coins: 0, stars: 0, level: 1 });
      repositoryMock.applyEarn.mockResolvedValue(true);

      await service.processTriggerEvent(childId, familyId, { engine: 'health', type: 't', payload: {} });

      expect(timelineMock.record).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'level_up', title: 'Reached Level 2' }));
    });
  });

  describe('approveRedemption', () => {
    it('throws BadRequestException if the redemption is not in REQUESTED status', async () => {
      repositoryMock.findRedemptionById.mockResolvedValue({ id: 'red1', childId, rewardCatalogItemId: 'item1', status: 'APPROVED' });
      await expect(service.approveRedemption('red1', familyId, 'user1')).rejects.toThrow(BadRequestException);
    });

    it('throws BadRequestException if the child no longer has enough coins', async () => {
      repositoryMock.findRedemptionById.mockResolvedValue({ id: 'red1', childId, rewardCatalogItemId: 'item1', status: 'REQUESTED' });
      repositoryMock.findCatalogItemById.mockResolvedValue({ id: 'item1', familyId, title: 'Toy', costCoins: 500, isActive: true });
      repositoryMock.getOrCreateAccount.mockResolvedValue({ id: 'a1', childId, xp: 0, coins: 100, stars: 0, level: 1 });

      await expect(service.approveRedemption('red1', familyId, 'user1')).rejects.toThrow(BadRequestException);
      expect(repositoryMock.approveRedemption).not.toHaveBeenCalled();
    });

    it('approves atomically when the balance is sufficient', async () => {
      repositoryMock.findRedemptionById.mockResolvedValue({ id: 'red1', childId, rewardCatalogItemId: 'item1', status: 'REQUESTED' });
      repositoryMock.findCatalogItemById.mockResolvedValue({ id: 'item1', familyId, title: 'Toy', costCoins: 500, isActive: true });
      repositoryMock.getOrCreateAccount.mockResolvedValue({ id: 'a1', childId, xp: 0, coins: 600, stars: 0, level: 1 });

      await service.approveRedemption('red1', familyId, 'user1');

      expect(repositoryMock.approveRedemption).toHaveBeenCalledWith('red1', childId, 500, 'user1');
    });

    it('throws NotFoundException for a redemption that does not exist', async () => {
      repositoryMock.findRedemptionById.mockResolvedValue(null);
      await expect(service.approveRedemption('missing', familyId, 'user1')).rejects.toThrow(NotFoundException);
    });
  });
});
