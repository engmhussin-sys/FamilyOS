import { Test } from '@nestjs/testing';

import { HealthEngineService } from '../../src/modules/life-intelligence/application/services/health-engine.service';
import { PrismaHealthRepository } from '../../src/modules/life-intelligence/infrastructure/repositories/prisma-health.repository';
import { ChildrenService } from '../../src/modules/children/application/services/children.service';
import { LIFE_TIMELINE_WRITER } from '../../src/modules/life-intelligence/domain/life-timeline.types';
import { REWARD_TRIGGER_WRITER } from '../../src/modules/life-intelligence/domain/reward-trigger.types';
import { computeHydrationTargetMl } from '../../src/modules/life-intelligence/application/services/health-rules';

describe('computeHydrationTargetMl (pure rule component)', () => {
  it('returns the correct band for a range of ages, including boundary values', () => {
    expect(computeHydrationTargetMl(2)).toBe(1300);
    expect(computeHydrationTargetMl(3)).toBe(1300);
    expect(computeHydrationTargetMl(4)).toBe(1700);
    expect(computeHydrationTargetMl(8)).toBe(1700);
    expect(computeHydrationTargetMl(9)).toBe(2100);
    expect(computeHydrationTargetMl(13)).toBe(2100);
    expect(computeHydrationTargetMl(14)).toBe(2500);
    expect(computeHydrationTargetMl(18)).toBe(2500);
    expect(computeHydrationTargetMl(19)).toBe(2700);
    expect(computeHydrationTargetMl(99)).toBe(2700);
  });
});

describe('HealthEngineService', () => {
  const repositoryMock = {
    createNutritionLog: jest.fn(),
    countNutritionLogsOnDate: jest.fn(),
    createHydrationLog: jest.fn(),
    sumHydrationMlOnDate: jest.fn(),
    createSleepLog: jest.fn(),
    findSleepLogForDate: jest.fn(),
    createActivityLog: jest.fn(),
    sumActivityMinutesOnDate: jest.fn(),
    countGroupActivitiesInWindow: jest.fn(),
    upsertHealthScore: jest.fn(),
  };
  const childrenServiceMock = {
    assertChildBelongsToFamily: jest.fn(),
    getChildOrThrow: jest.fn(),
  };
  const timelineMock = { record: jest.fn() };
  const rewardTriggerMock = { trigger: jest.fn() };

  let service: HealthEngineService;
  const childId = 'child-1';
  const familyId = 'family-1';

  beforeEach(async () => {
    jest.clearAllMocks();
    childrenServiceMock.getChildOrThrow.mockResolvedValue({ id: childId, dateOfBirth: '2016-01-01' });
    const moduleRef = await Test.createTestingModule({
      providers: [
        HealthEngineService,
        { provide: PrismaHealthRepository, useValue: repositoryMock },
        { provide: ChildrenService, useValue: childrenServiceMock },
        { provide: LIFE_TIMELINE_WRITER, useValue: timelineMock },
        { provide: REWARD_TRIGGER_WRITER, useValue: rewardTriggerMock },
      ],
    }).compile();
    service = moduleRef.get(HealthEngineService);
  });

  describe('logNutrition', () => {
    it('writes a Timeline event only for the FIRST log of the day', async () => {
      repositoryMock.countNutritionLogsOnDate.mockResolvedValue(0);
      repositoryMock.createNutritionLog.mockResolvedValue({ id: 'n1' });
      await service.logNutrition(childId, familyId, { date: '2026-01-01', mealType: 'breakfast', items: {} });
      expect(timelineMock.record).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'first_nutrition_log_today' }));
    });

    it('does NOT write a Timeline event for the second log of the same day', async () => {
      repositoryMock.countNutritionLogsOnDate.mockResolvedValue(1);
      repositoryMock.createNutritionLog.mockResolvedValue({ id: 'n2' });
      await service.logNutrition(childId, familyId, { date: '2026-01-01', mealType: 'lunch', items: {} });
      expect(timelineMock.record).not.toHaveBeenCalled();
    });
  });

  describe('logHydration', () => {
    it('writes a Timeline event exactly when the daily target is crossed by THIS log', async () => {
      repositoryMock.createHydrationLog.mockResolvedValue({ id: 'h1', childId, amountMl: 400, loggedAt: new Date() });
      repositoryMock.sumHydrationMlOnDate.mockResolvedValue(2200);

      await service.logHydration(childId, familyId, { amountMl: 400 });

      expect(timelineMock.record).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'hydration_target_reached' }));
    });

    it('does NOT re-fire the milestone once already past the target before this log', async () => {
      repositoryMock.createHydrationLog.mockResolvedValue({ id: 'h2', childId, amountMl: 50, loggedAt: new Date() });
      repositoryMock.sumHydrationMlOnDate.mockResolvedValue(2200);

      await service.logHydration(childId, familyId, { amountMl: 50 });

      expect(timelineMock.record).not.toHaveBeenCalled();
    });

    it('does not fire the milestone if still under target after this log', async () => {
      repositoryMock.createHydrationLog.mockResolvedValue({ id: 'h3', childId, amountMl: 200, loggedAt: new Date() });
      repositoryMock.sumHydrationMlOnDate.mockResolvedValue(500);

      await service.logHydration(childId, familyId, { amountMl: 200 });

      expect(timelineMock.record).not.toHaveBeenCalled();
    });
  });

  describe('logActivity', () => {
    it('writes a Timeline event on the FIRST group/team activity in the scoring window', async () => {
      repositoryMock.createActivityLog.mockResolvedValue({ id: 'a1' });
      repositoryMock.countGroupActivitiesInWindow.mockResolvedValue(1);

      await service.logActivity(childId, familyId, { date: '2026-01-01', activityType: 'football', durationMinutes: 60, socialContext: 'TEAM' });

      expect(timelineMock.record).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'first_group_activity' }));
    });

    it('does NOT write a Timeline event for a SOLO activity', async () => {
      repositoryMock.createActivityLog.mockResolvedValue({ id: 'a2' });

      await service.logActivity(childId, familyId, { date: '2026-01-01', activityType: 'jogging', durationMinutes: 20, socialContext: 'SOLO' });

      expect(timelineMock.record).not.toHaveBeenCalled();
      expect(repositoryMock.countGroupActivitiesInWindow).not.toHaveBeenCalled();
    });
  });

  describe('computeAndStoreHealthScore', () => {
    it('produces a 0-100 score with a fully explainable breakdown, never a hidden number', async () => {
      repositoryMock.sumHydrationMlOnDate.mockResolvedValue(2100);
      repositoryMock.sumActivityMinutesOnDate.mockImplementation((_c: string, _d: Date, groupOnly?: boolean) =>
        Promise.resolve(groupOnly ? 0 : 60),
      );
      repositoryMock.findSleepLogForDate.mockResolvedValue({
        id: 's1',
        childId,
        date: new Date('2026-01-01'),
        sleepStart: new Date('2026-01-01T21:00:00Z'),
        sleepEnd: new Date('2026-01-02T06:00:00Z'),
        quality: 4,
      });
      repositoryMock.countNutritionLogsOnDate.mockResolvedValue(3);

      const result = await service.computeAndStoreHealthScore(childId, familyId, '2026-01-01');

      expect(result.score).toBe(100);
      expect(result.breakdown.hydration.ratio).toBe(1);
      expect(result.breakdown.sleepHours).toBe(9);
      expect(repositoryMock.upsertHealthScore).toHaveBeenCalledWith(childId, expect.any(Date), 100, expect.any(Object));
    });

    it('uses a neutral (not zero) sleep ratio when no sleep was logged — absence of data is not penalized as badly as a bad night', async () => {
      repositoryMock.sumHydrationMlOnDate.mockResolvedValue(0);
      repositoryMock.sumActivityMinutesOnDate.mockResolvedValue(0);
      repositoryMock.findSleepLogForDate.mockResolvedValue(null);
      repositoryMock.countNutritionLogsOnDate.mockResolvedValue(0);

      const result = await service.computeAndStoreHealthScore(childId, familyId, '2026-01-01');

      expect(result.breakdown.sleepHours).toBeNull();
      expect(result.score).toBe(13);
    });

    it('verifies ownership before computing anything', async () => {
      repositoryMock.sumHydrationMlOnDate.mockResolvedValue(0);
      repositoryMock.sumActivityMinutesOnDate.mockResolvedValue(0);
      repositoryMock.findSleepLogForDate.mockResolvedValue(null);
      repositoryMock.countNutritionLogsOnDate.mockResolvedValue(0);

      await service.computeAndStoreHealthScore(childId, familyId);

      expect(childrenServiceMock.assertChildBelongsToFamily).toHaveBeenCalledWith(childId, familyId);
    });
  });

  // --- Sprint 25: Reward Rules wiring ---
  describe('logHydration — reward trigger wiring', () => {
    it('triggers Reward Rules exactly when the target is crossed, with the payload shape a real rule can match', async () => {
      repositoryMock.createHydrationLog.mockResolvedValue({ id: 'h4', childId, amountMl: 400, loggedAt: new Date() });
      repositoryMock.sumHydrationMlOnDate.mockResolvedValue(2200);

      await service.logHydration(childId, familyId, { amountMl: 400 });

      expect(rewardTriggerMock.trigger).toHaveBeenCalledWith(
        childId,
        familyId,
        { engine: 'health', type: 'hydration_event', payload: { metric: 'hydration_target_reached' } },
      );
    });

    it('does NOT trigger Reward Rules when the target is not crossed by this log', async () => {
      repositoryMock.createHydrationLog.mockResolvedValue({ id: 'h5', childId, amountMl: 100, loggedAt: new Date() });
      repositoryMock.sumHydrationMlOnDate.mockResolvedValue(500);

      await service.logHydration(childId, familyId, { amountMl: 100 });

      expect(rewardTriggerMock.trigger).not.toHaveBeenCalled();
    });

    it('a Reward Rules failure never blocks the hydration log itself from succeeding', async () => {
      repositoryMock.createHydrationLog.mockResolvedValue({ id: 'h6', childId, amountMl: 400, loggedAt: new Date() });
      repositoryMock.sumHydrationMlOnDate.mockResolvedValue(2200);
      rewardTriggerMock.trigger.mockRejectedValue(new Error('simulated rewards failure'));

      await expect(service.logHydration(childId, familyId, { amountMl: 400 })).resolves.toBeDefined();
    });
  });
});
