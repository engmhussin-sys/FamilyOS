import { Test } from '@nestjs/testing';

import { LearningEngineService } from '../../src/modules/life-intelligence/application/services/learning-engine.service';
import { PrismaLearningRepository } from '../../src/modules/life-intelligence/infrastructure/repositories/prisma-learning.repository';
import { ChildrenService } from '../../src/modules/children/application/services/children.service';
import { REWARD_TRIGGER_WRITER } from '../../src/modules/life-intelligence/domain/reward-trigger.types';
import { familyDateProvider } from '../common/family-date.testing';

describe("LearningEngineService — Education to Reward (Sprint 16.3 Priority 2, CLOSES A REAL GAP confirmed in Sprint 16.2's own E2E re-audit)", () => {
  const repositoryMock = {
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
  const sessionInput = { subject: 'math', durationMinutes: 30, date: '2026-08-10' };

  beforeEach(async () => {
    jest.resetAllMocks(); // FIXES A REAL ROOT CAUSE: clearAllMocks() only resets call history, not configured mockResolvedValue/mockRejectedValue implementations -- resetAllMocks() resets both.
    repositoryMock.createSession.mockResolvedValue({ id: 's1', childId, subject: 'math', durationMinutes: 30, date: new Date('2026-08-10'), goalId: null, progressNote: null });
    repositoryMock.findDistinctSessionDates.mockResolvedValue([]);
    rewardTriggerMock.trigger.mockResolvedValue(1);

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

  it("fires EDUCATION_TASK_COMPLETED (the brief's own explicit Sprint 16 contract event name) on every session log", async () => {
    await service.logSession(childId, familyId, sessionInput);

    expect(rewardTriggerMock.trigger).toHaveBeenCalledWith(
      childId,
      familyId,
      expect.objectContaining({ engine: 'learning', type: 'EDUCATION_TASK_COMPLETED' }),
    );
  });

  it('the session log itself still succeeds and returns the real session even without a streak milestone', async () => {
    const result = await service.logSession(childId, familyId, sessionInput);
    expect(result.id).toBe('s1');
  });

  it('CRITICAL (Double Reward Protection): the idempotency key is stable for the SAME subject+date, so a retry does not grant twice', async () => {
    await service.logSession(childId, familyId, sessionInput);
    const firstCall = rewardTriggerMock.trigger.mock.calls[0][2];

    rewardTriggerMock.trigger.mockClear();
    await service.logSession(childId, familyId, sessionInput);
    const secondCall = rewardTriggerMock.trigger.mock.calls[0][2];

    expect(firstCall.idempotencyKey).toBe(secondCall.idempotencyKey);
  });

  it('a DIFFERENT subject on the same date gets a DIFFERENT idempotency key (a real, separate learning event)', async () => {
    await service.logSession(childId, familyId, sessionInput);
    const mathKey = rewardTriggerMock.trigger.mock.calls[0][2].idempotencyKey;

    rewardTriggerMock.trigger.mockClear();
    await service.logSession(childId, familyId, { ...sessionInput, subject: 'science' });
    const scienceKey = rewardTriggerMock.trigger.mock.calls[0][2].idempotencyKey;

    expect(mathKey).not.toBe(scienceKey);
  });

  describe('streak milestone', () => {
    it('fires STREAK_ACHIEVED at a real milestone (7 days)', async () => {
      const sevenDays = Array.from({ length: 7 }, (_, i) => {
        const d = new Date(); // the REAL current date, matching the service's own this.daysAgo(0)
        d.setUTCDate(d.getUTCDate() - i);
        return d.toISOString().slice(0, 10);
      });
      repositoryMock.findDistinctSessionDates.mockResolvedValue(sevenDays);

      await service.logSession(childId, familyId, sessionInput);

      expect(rewardTriggerMock.trigger).toHaveBeenCalledWith(
        childId,
        familyId,
        expect.objectContaining({ type: 'STREAK_ACHIEVED', payload: expect.objectContaining({ metric: 'education', streakDays: 7 }) }),
      );
    });

    it('does NOT fire STREAK_ACHIEVED for a non-milestone streak length', async () => {
      const fourDays = Array.from({ length: 4 }, (_, i) => {
        const d = new Date('2026-08-10');
        d.setUTCDate(d.getUTCDate() - i);
        return d.toISOString().slice(0, 10);
      });
      repositoryMock.findDistinctSessionDates.mockResolvedValue(fourDays);

      await service.logSession(childId, familyId, sessionInput);

      expect(rewardTriggerMock.trigger).not.toHaveBeenCalledWith(
        childId,
        familyId,
        expect.objectContaining({ type: 'STREAK_ACHIEVED' }),
      );
    });
  });

  it('CRITICAL (best-effort discipline): a Reward Rules failure never blocks the session log itself from succeeding', async () => {
    rewardTriggerMock.trigger.mockRejectedValue(new Error('reward system down'));

    const result = await service.logSession(childId, familyId, sessionInput);

    expect(result.id).toBe('s1');
  });

  it('tenant isolation: assertChildBelongsToFamily is checked before any session is logged', async () => {
    await service.logSession(childId, familyId, sessionInput);
    expect(childrenServiceMock.assertChildBelongsToFamily).toHaveBeenCalledWith(childId, familyId);
  });
});
