import { Test } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';

import { FaithEngineService } from '../../src/modules/life-intelligence/application/services/faith-engine.service';
import { PrismaFaithRepository } from '../../src/modules/life-intelligence/infrastructure/repositories/prisma-faith.repository';
import { ChildrenService } from '../../src/modules/children/application/services/children.service';
import { LIFE_TIMELINE_WRITER } from '../../src/modules/life-intelligence/domain/life-timeline.types';
import { REWARD_TRIGGER_WRITER } from '../../src/modules/life-intelligence/domain/reward-trigger.types';

describe('FaithEngineService', () => {
  const repositoryMock = {
    createPractice: jest.fn(),
    findPracticeById: jest.fn(),
    listActivePractices: jest.fn(),
    countActivePractices: jest.fn(),
    recordLog: jest.fn(),
    countLogsInWindow: jest.fn(),
    countPracticeLogsTotal: jest.fn(),
  };
  const childrenServiceMock = { assertChildBelongsToFamily: jest.fn() };
  const timelineMock = { record: jest.fn() };
  const rewardTriggerMock = { trigger: jest.fn() };

  let service: FaithEngineService;
  const childId = 'child-1';
  const familyId = 'family-1';
  const practice = { id: 'p1', childId, type: 'SALAH' as const, title: 'Daily Salah', config: null, isActive: true };

  beforeEach(async () => {
    jest.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [
        FaithEngineService,
        { provide: PrismaFaithRepository, useValue: repositoryMock },
        { provide: ChildrenService, useValue: childrenServiceMock },
        { provide: LIFE_TIMELINE_WRITER, useValue: timelineMock },
        { provide: REWARD_TRIGGER_WRITER, useValue: rewardTriggerMock },
      ],
    }).compile();
    service = moduleRef.get(FaithEngineService);
  });

  describe('logPractice', () => {
    it('throws NotFoundException if the practice belongs to a different child (IDOR protection)', async () => {
      repositoryMock.findPracticeById.mockResolvedValue({ ...practice, childId: 'someone-elses-child' });
      await expect(service.logPractice('p1', childId, familyId)).rejects.toThrow(NotFoundException);
      expect(repositoryMock.recordLog).not.toHaveBeenCalled();
    });

    it('throws the SAME error if the practice does not exist at all — never leaks which case it was', async () => {
      repositoryMock.findPracticeById.mockResolvedValue(null);
      await expect(service.logPractice('missing', childId, familyId)).rejects.toThrow(NotFoundException);
    });

    it('writes a Timeline event on the first-ever log for a practice', async () => {
      repositoryMock.findPracticeById.mockResolvedValue(practice);
      repositoryMock.recordLog.mockResolvedValue({ id: 'l1', practiceId: 'p1', childId, date: new Date(), progress: null, completedAt: new Date() });
      repositoryMock.countPracticeLogsTotal.mockResolvedValue(1);

      await service.logPractice('p1', childId, familyId);

      expect(timelineMock.record).toHaveBeenCalledWith(
        expect.objectContaining({ childId, sourceEngine: 'faith', category: 'FAITH', eventType: 'first_practice_log' }),
      );
    });

    it('does NOT write a Timeline event for subsequent logs of the same practice', async () => {
      repositoryMock.findPracticeById.mockResolvedValue(practice);
      repositoryMock.recordLog.mockResolvedValue({ id: 'l2', practiceId: 'p1', childId, date: new Date(), progress: null, completedAt: new Date() });
      repositoryMock.countPracticeLogsTotal.mockResolvedValue(4);

      await service.logPractice('p1', childId, familyId);

      expect(timelineMock.record).not.toHaveBeenCalled();
    });

    it('passes progress metadata through to the repository (e.g. Quran surah/ayah range)', async () => {
      repositoryMock.findPracticeById.mockResolvedValue({ ...practice, type: 'QURAN_MEMORIZATION' });
      repositoryMock.recordLog.mockResolvedValue({ id: 'l3', practiceId: 'p1', childId, date: new Date(), progress: { surah: 'Al-Fatiha' }, completedAt: new Date() });
      repositoryMock.countPracticeLogsTotal.mockResolvedValue(2);

      await service.logPractice('p1', childId, familyId, '2026-01-01', { surah: 'Al-Fatiha' });

      expect(repositoryMock.recordLog).toHaveBeenCalledWith('p1', childId, new Date('2026-01-01'), { surah: 'Al-Fatiha' });
    });
  });

  describe('getScoreBreakdown', () => {
    it('computes an explainable completion rate', async () => {
      repositoryMock.countActivePractices.mockResolvedValue(2);
      repositoryMock.countLogsInWindow.mockResolvedValue(15);

      const result = await service.getScoreBreakdown(childId, familyId);

      expect(result.activePractices).toBe(2);
      expect(result.completedLogs).toBe(15);
      expect(result.completionRate).toBeCloseTo(15 / 60);
    });

    it('returns 0, not NaN, when there are zero active practices', async () => {
      repositoryMock.countActivePractices.mockResolvedValue(0);
      repositoryMock.countLogsInWindow.mockResolvedValue(0);

      const result = await service.getScoreBreakdown(childId, familyId);

      expect(result.completionRate).toBe(0);
    });

    it('verifies ownership before computing', async () => {
      repositoryMock.countActivePractices.mockResolvedValue(0);
      repositoryMock.countLogsInWindow.mockResolvedValue(0);
      await service.getScoreBreakdown(childId, familyId);
      expect(childrenServiceMock.assertChildBelongsToFamily).toHaveBeenCalledWith(childId, familyId);
    });
  });

  describe('createPractice / listPractices', () => {
    it('verifies ownership before creating', async () => {
      repositoryMock.createPractice.mockResolvedValue(practice);
      await service.createPractice(childId, familyId, { type: 'SALAH', title: 'Daily Salah' });
      expect(childrenServiceMock.assertChildBelongsToFamily).toHaveBeenCalledWith(childId, familyId);
    });

    it('verifies ownership before listing', async () => {
      repositoryMock.listActivePractices.mockResolvedValue([practice]);
      const result = await service.listPractices(childId, familyId);
      expect(childrenServiceMock.assertChildBelongsToFamily).toHaveBeenCalledWith(childId, familyId);
      expect(result).toEqual([practice]);
    });
  });

  // --- Sprint 25: Reward Rules wiring ---
  describe('logPractice — reward trigger wiring', () => {
    it('includes practiceType and the current streak count so a real streak rule can match', async () => {
      repositoryMock.findPracticeById.mockResolvedValue(practice);
      repositoryMock.recordLog.mockResolvedValue({ id: 'l4', practiceId: 'p1', childId, date: new Date(), progress: null, completedAt: new Date() });
      repositoryMock.countPracticeLogsTotal.mockResolvedValue(7);

      await service.logPractice('p1', childId, familyId);

      expect(rewardTriggerMock.trigger).toHaveBeenCalledWith(
        childId,
        familyId,
        expect.objectContaining({ engine: 'faith', type: 'practice_logged', payload: { practiceType: 'SALAH', streakDays: 7 } }),
      );
    });

    it('a Reward Rules failure never blocks the practice log itself from succeeding', async () => {
      repositoryMock.findPracticeById.mockResolvedValue(practice);
      repositoryMock.recordLog.mockResolvedValue({ id: 'l5', practiceId: 'p1', childId, date: new Date(), progress: null, completedAt: new Date() });
      repositoryMock.countPracticeLogsTotal.mockResolvedValue(1);
      rewardTriggerMock.trigger.mockRejectedValue(new Error('simulated rewards failure'));

      await expect(service.logPractice('p1', childId, familyId)).resolves.toBeDefined();
    });
  });
});
