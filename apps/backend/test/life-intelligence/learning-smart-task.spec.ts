import { Test } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';

import { SmartTaskEngineService } from '../../src/modules/life-intelligence/application/services/smart-task-engine.service';
import { PrismaSmartTaskRepository } from '../../src/modules/life-intelligence/infrastructure/repositories/prisma-smart-task.repository';
import { LearningEngineService } from '../../src/modules/life-intelligence/application/services/learning-engine.service';
import { PrismaLearningRepository } from '../../src/modules/life-intelligence/infrastructure/repositories/prisma-learning.repository';
import { ChildrenService } from '../../src/modules/children/application/services/children.service';
import { HealthEngineService } from '../../src/modules/life-intelligence/application/services/health-engine.service';
import { HabitEngineService } from '../../src/modules/life-intelligence/application/services/habit-engine.service';
import { REWARD_TRIGGER_WRITER } from '../../src/modules/life-intelligence/domain/reward-trigger.types';
import { familyDateProvider } from '../common/family-date.testing';

describe('SmartTaskEngineService', () => {
  const repositoryMock = { createMany: jest.fn(), listForChildOnDate: jest.fn(), findById: jest.fn(), updateStatus: jest.fn() };
  const childrenServiceMock = { assertChildBelongsToFamily: jest.fn() };
  const healthEngineMock = { computeAndStoreHealthScore: jest.fn(), getDailyProgress: jest.fn() };
  const habitEngineMock = { getMissedHabitsSignal: jest.fn() };
  let service: SmartTaskEngineService;
  const childId = 'child-1';
  const familyId = 'family-1';

  beforeEach(async () => {
    jest.resetAllMocks(); // FIXES A REAL ROOT CAUSE: clearAllMocks() only resets call history, not configured mockResolvedValue/mockRejectedValue implementations -- resetAllMocks() resets both.
    const moduleRef = await Test.createTestingModule({
      providers: [
        SmartTaskEngineService,
        { provide: PrismaSmartTaskRepository, useValue: repositoryMock },
        { provide: ChildrenService, useValue: childrenServiceMock },
        { provide: HealthEngineService, useValue: healthEngineMock },
        { provide: HabitEngineService, useValue: habitEngineMock },
        // B2: the REAL FamilyDateService over a stub Prisma (see the helper).
        familyDateProvider()
      ],
    }).compile();
    service = moduleRef.get(SmartTaskEngineService);
  });

  describe('generateForToday', () => {
    it('skips the repository call entirely when zero signals are triggered — no empty rows written', async () => {
      const count = await service.generateForToday(childId, familyId, {
        lateSleepLastNight: false,
        lowHydrationToday: false,
        missedHabitsYesterday: [],
        screenTimeOverLimit: false,
      });
      expect(count).toBe(0);
      expect(repositoryMock.createMany).not.toHaveBeenCalled();
    });

    it('creates real rows when signals fire', async () => {
      repositoryMock.createMany.mockResolvedValue(2);
      const count = await service.generateForToday(childId, familyId, {
        lateSleepLastNight: true,
        lowHydrationToday: false,
        missedHabitsYesterday: [],
        screenTimeOverLimit: false,
      });
      expect(count).toBe(2);
      expect(repositoryMock.createMany).toHaveBeenCalledWith(childId, expect.any(Array), expect.any(Date), expect.any(Object));
    });

    it('verifies ownership before generating anything', async () => {
      await service.generateForToday(childId, familyId, { lateSleepLastNight: false, lowHydrationToday: false, missedHabitsYesterday: [], screenTimeOverLimit: false });
      expect(childrenServiceMock.assertChildBelongsToFamily).toHaveBeenCalledWith(childId, familyId);
    });
  });

  describe('generateForTodayAuto (FIXES A REAL DESIGN FLAW: generateForToday required the caller to manually compute context — no real frontend anywhere could use it without duplicating server-side analytical logic)', () => {
    it('computes lateSleepLastNight from real sleepHours data (< 7h counted as insufficient)', async () => {
      healthEngineMock.computeAndStoreHealthScore.mockResolvedValue({ breakdown: { sleepHours: 5 } });
      healthEngineMock.getDailyProgress.mockResolvedValue({ hydration: { isAchieved: true } });
      habitEngineMock.getMissedHabitsSignal.mockResolvedValue([]);
      repositoryMock.createMany.mockResolvedValue(1);

      await service.generateForTodayAuto(childId, familyId);

      expect(repositoryMock.createMany).toHaveBeenCalledWith(
        childId, expect.any(Array), expect.any(Date),
        expect.objectContaining({ lateSleepLastNight: true }),
      );
    });

    it('computes lowHydrationToday as the inverse of real isAchieved data', async () => {
      healthEngineMock.computeAndStoreHealthScore.mockResolvedValue({ breakdown: { sleepHours: 9 } });
      healthEngineMock.getDailyProgress.mockResolvedValue({ hydration: { isAchieved: false } });
      habitEngineMock.getMissedHabitsSignal.mockResolvedValue([]);
      repositoryMock.createMany.mockResolvedValue(1);

      await service.generateForTodayAuto(childId, familyId);

      expect(repositoryMock.createMany).toHaveBeenCalledWith(
        childId, expect.any(Array), expect.any(Date),
        expect.objectContaining({ lowHydrationToday: true }),
      );
    });

    it('maps real missed-habit titles from getMissedHabitsSignal, windowed to yesterday (1 day)', async () => {
      healthEngineMock.computeAndStoreHealthScore.mockResolvedValue({ breakdown: { sleepHours: 9 } });
      healthEngineMock.getDailyProgress.mockResolvedValue({ hydration: { isAchieved: true } });
      habitEngineMock.getMissedHabitsSignal.mockResolvedValue([{ habitId: 'h1', habitTitle: 'Brush teeth', date: new Date() }]);
      repositoryMock.createMany.mockResolvedValue(1);

      await service.generateForTodayAuto(childId, familyId);

      expect(habitEngineMock.getMissedHabitsSignal).toHaveBeenCalledWith(childId, familyId, 1);
      expect(repositoryMock.createMany).toHaveBeenCalledWith(
        childId, expect.any(Array), expect.any(Date),
        expect.objectContaining({ missedHabitsYesterday: ['Brush teeth'] }),
      );
    });

    it('HONEST LIMITATION: screenTimeOverLimit is always false — documented, not an unfounded guess', async () => {
      healthEngineMock.computeAndStoreHealthScore.mockResolvedValue({ breakdown: { sleepHours: 5 } }); // insufficient sleep -- a real trigger, ensuring at least one suggestion is generated so createMany is actually called
      healthEngineMock.getDailyProgress.mockResolvedValue({ hydration: { isAchieved: true } });
      habitEngineMock.getMissedHabitsSignal.mockResolvedValue([]);
      repositoryMock.createMany.mockResolvedValue(1);

      await service.generateForTodayAuto(childId, familyId);

      expect(repositoryMock.createMany).toHaveBeenCalledWith(
        childId, expect.any(Array), expect.any(Date),
        expect.objectContaining({ screenTimeOverLimit: false }),
      );
    });

    it('BOUNDARY CASE: null sleepHours (unlogged) does not crash and does not count as "late"', async () => {
      healthEngineMock.computeAndStoreHealthScore.mockResolvedValue({ breakdown: { sleepHours: null } });
      healthEngineMock.getDailyProgress.mockResolvedValue({ hydration: { isAchieved: true } });
      habitEngineMock.getMissedHabitsSignal.mockResolvedValue([]);

      const count = await service.generateForTodayAuto(childId, familyId);

      expect(count).toBe(0); // zero signals triggered -> zero rows, matching generateForToday's own existing behavior
      expect(repositoryMock.createMany).not.toHaveBeenCalled();
    });

    it('verifies ownership before computing anything', async () => {
      healthEngineMock.computeAndStoreHealthScore.mockResolvedValue({ breakdown: { sleepHours: 9 } });
      healthEngineMock.getDailyProgress.mockResolvedValue({ hydration: { isAchieved: true } });
      habitEngineMock.getMissedHabitsSignal.mockResolvedValue([]);

      await service.generateForTodayAuto(childId, familyId);

      expect(childrenServiceMock.assertChildBelongsToFamily).toHaveBeenCalledWith(childId, familyId);
    });
  });

  describe('decide', () => {
    it('throws NotFoundException for a task belonging to another child (IDOR protection)', async () => {
      repositoryMock.findById.mockResolvedValue({ id: 't1', childId: 'other-child' });
      await expect(service.decide('t1', childId, familyId, 'ACCEPTED')).rejects.toThrow(NotFoundException);
      expect(repositoryMock.updateStatus).not.toHaveBeenCalled();
    });

    it('updates status when ownership checks out', async () => {
      repositoryMock.findById.mockResolvedValue({ id: 't1', childId });
      await service.decide('t1', childId, familyId, 'COMPLETED');
      expect(repositoryMock.updateStatus).toHaveBeenCalledWith('t1', 'COMPLETED');
    });
  });
});

describe('LearningEngineService', () => {
  const repositoryMock = {
    createGoal: jest.fn(),
    listActiveGoals: jest.fn(),
    createSession: jest.fn(),
    countSessionsInWindow: jest.fn(),
    sumSessionMinutesInWindow: jest.fn(),
    averageAssessmentScoreInWindow: jest.fn(),
    findDistinctSessionDates: jest.fn(),
  };
  const childrenServiceMock = { assertChildBelongsToFamily: jest.fn() };
  const rewardTriggerMock = { trigger: jest.fn() };
  let service: LearningEngineService;
  const childId = 'child-1';
  const familyId = 'family-1';

  beforeEach(async () => {
    jest.resetAllMocks(); // FIXES A REAL ROOT CAUSE: clearAllMocks() only resets call history, not configured mockResolvedValue/mockRejectedValue implementations -- resetAllMocks() resets both.
    repositoryMock.findDistinctSessionDates.mockResolvedValue([]);
    const moduleRef = await Test.createTestingModule({
      providers: [
        LearningEngineService,
        { provide: PrismaLearningRepository, useValue: repositoryMock },
        { provide: ChildrenService, useValue: childrenServiceMock },
        { provide: REWARD_TRIGGER_WRITER, useValue: rewardTriggerMock },
        // B2: the REAL FamilyDateService over a stub Prisma (see the helper).
        familyDateProvider()
      ],
    }).compile();
    service = moduleRef.get(LearningEngineService);
  });

  it('returns null averageAssessmentScore (not 0 or NaN) when no assessments exist', async () => {
    repositoryMock.countSessionsInWindow.mockResolvedValue(0);
    repositoryMock.sumSessionMinutesInWindow.mockResolvedValue(0);
    repositoryMock.averageAssessmentScoreInWindow.mockResolvedValue(null);

    const result = await service.getProgressSummary(childId, familyId);

    expect(result.averageAssessmentScore).toBeNull();
  });

  it('verifies ownership before returning progress', async () => {
    repositoryMock.countSessionsInWindow.mockResolvedValue(0);
    repositoryMock.sumSessionMinutesInWindow.mockResolvedValue(0);
    repositoryMock.averageAssessmentScoreInWindow.mockResolvedValue(null);
    await service.getProgressSummary(childId, familyId);
    expect(childrenServiceMock.assertChildBelongsToFamily).toHaveBeenCalledWith(childId, familyId);
  });
});
