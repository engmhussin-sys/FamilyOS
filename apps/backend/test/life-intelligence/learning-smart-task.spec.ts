import { Test } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';

import { SmartTaskEngineService } from '../../src/modules/life-intelligence/application/services/smart-task-engine.service';
import { PrismaSmartTaskRepository } from '../../src/modules/life-intelligence/infrastructure/repositories/prisma-smart-task.repository';
import { LearningEngineService } from '../../src/modules/life-intelligence/application/services/learning-engine.service';
import { PrismaLearningRepository } from '../../src/modules/life-intelligence/infrastructure/repositories/prisma-learning.repository';
import { ChildrenService } from '../../src/modules/children/application/services/children.service';

describe('SmartTaskEngineService', () => {
  const repositoryMock = { createMany: jest.fn(), listForChildOnDate: jest.fn(), findById: jest.fn(), updateStatus: jest.fn() };
  const childrenServiceMock = { assertChildBelongsToFamily: jest.fn() };
  let service: SmartTaskEngineService;
  const childId = 'child-1';
  const familyId = 'family-1';

  beforeEach(async () => {
    jest.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [
        SmartTaskEngineService,
        { provide: PrismaSmartTaskRepository, useValue: repositoryMock },
        { provide: ChildrenService, useValue: childrenServiceMock },
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
  };
  const childrenServiceMock = { assertChildBelongsToFamily: jest.fn() };
  let service: LearningEngineService;
  const childId = 'child-1';
  const familyId = 'family-1';

  beforeEach(async () => {
    jest.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [
        LearningEngineService,
        { provide: PrismaLearningRepository, useValue: repositoryMock },
        { provide: ChildrenService, useValue: childrenServiceMock },
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
