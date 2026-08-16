import { Test } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';

import { HabitEngineService } from '../../src/modules/life-intelligence/application/services/habit-engine.service';
import { PrismaHabitRepository } from '../../src/modules/life-intelligence/infrastructure/repositories/prisma-habit.repository';
import { ChildrenService } from '../../src/modules/children/application/services/children.service';
import { LIFE_TIMELINE_WRITER } from '../../src/modules/life-intelligence/domain/life-timeline.types';
import { REWARD_TRIGGER_WRITER } from '../../src/modules/life-intelligence/domain/reward-trigger.types';
import { familyDateProvider } from '../common/family-date.testing';
import { addBusinessDays, getBusinessDate } from '../../src/common/time/family-date';
import { GrowthEventEmitter } from '../../src/modules/analytics/application/growth-event-emitter.service';

describe('HabitEngineService', () => {
  const habitRepositoryMock = {
    create: jest.fn(),
    findById: jest.fn(),
    listActiveForChild: jest.fn(),
    recordCompletion: jest.fn(),
    countCompletionsInWindow: jest.fn(),
    countActiveHabits: jest.fn(),
    findDistinctCompletionDates: jest.fn(),
  };
  const childrenServiceMock = { assertChildBelongsToFamily: jest.fn() };
  const timelineMock = { record: jest.fn() };
  const rewardTriggerMock = { trigger: jest.fn() };

  let service: HabitEngineService;

  const childId = 'child-1';
  const familyId = 'family-1';
  const habit = { id: 'habit-1', childId, title: 'Drink water', category: 'health', isCustom: true, isShared: false, isActive: true, createdAt: new Date() };

  beforeEach(async () => {
    jest.resetAllMocks(); // FIXES A REAL ROOT CAUSE: clearAllMocks() only resets call history, not configured mockResolvedValue/mockRejectedValue implementations -- resetAllMocks() resets both.
    habitRepositoryMock.findDistinctCompletionDates.mockResolvedValue([]);
    const moduleRef = await Test.createTestingModule({
      providers: [
        HabitEngineService,
        { provide: PrismaHabitRepository, useValue: habitRepositoryMock },
        { provide: ChildrenService, useValue: childrenServiceMock },
        { provide: LIFE_TIMELINE_WRITER, useValue: timelineMock },
        { provide: REWARD_TRIGGER_WRITER, useValue: rewardTriggerMock },
        // B2: the REAL FamilyDateService over a stub Prisma (see the helper).
        familyDateProvider(),
        // PHASE D (GROWTH). `GrowthEventEmitter.emit` never throws by contract
        // (see its class docstring: analytics must never be able to fail a
        // reward, a habit or an AI answer), so a resolving double is a faithful
        // stand-in and these suites stay about the business path.
        { provide: GrowthEventEmitter, useValue: { emit: jest.fn().mockResolvedValue(undefined) } },
      ],
    }).compile();
    service = moduleRef.get(HabitEngineService);
  });

  describe('createHabit', () => {
    it('verifies ownership before creating', async () => {
      habitRepositoryMock.create.mockResolvedValue(habit);
      await service.createHabit(childId, familyId, { title: 'Drink water', category: 'health', createdByUserId: 'user-1' });
      expect(childrenServiceMock.assertChildBelongsToFamily).toHaveBeenCalledWith(childId, familyId);
      expect(habitRepositoryMock.create).toHaveBeenCalledWith(
        expect.objectContaining({ childId, title: 'Drink water' }),
      );
    });

    it('propagates the ownership error and never reaches the repository', async () => {
      childrenServiceMock.assertChildBelongsToFamily.mockRejectedValue(new NotFoundException());
      await expect(
        service.createHabit(childId, familyId, { title: 'x', category: 'y', createdByUserId: 'user-1' }),
      ).rejects.toThrow(NotFoundException);
      expect(habitRepositoryMock.create).not.toHaveBeenCalled();
    });
  });

  describe('completeHabit', () => {
    it('throws NotFoundException if the habit does not belong to this child (IDOR protection)', async () => {
      habitRepositoryMock.findById.mockResolvedValue({ ...habit, childId: 'someone-elses-child' });
      await expect(service.completeHabit('habit-1', childId, familyId)).rejects.toThrow(NotFoundException);
      expect(habitRepositoryMock.recordCompletion).not.toHaveBeenCalled();
    });

    it('throws NotFoundException if the habit does not exist at all — same error as ownership mismatch, never leaking which case it was', async () => {
      habitRepositoryMock.findById.mockResolvedValue(null);
      await expect(service.completeHabit('missing-habit', childId, familyId)).rejects.toThrow(NotFoundException);
    });

    it('records the completion and writes a Timeline event on the FIRST completion', async () => {
      habitRepositoryMock.findById.mockResolvedValue(habit);
      habitRepositoryMock.recordCompletion.mockResolvedValue({ id: 'c1', habitId: 'habit-1', childId, date: new Date(), completedAt: new Date() });
      habitRepositoryMock.countCompletionsInWindow.mockResolvedValue(1);

      await service.completeHabit('habit-1', childId, familyId);

      expect(timelineMock.record).toHaveBeenCalledWith(
        expect.objectContaining({ childId, sourceEngine: 'habit-builder', category: 'HABITS', eventType: 'first_habit_completion' }),
      );
    });

    it('does NOT write a Timeline event on subsequent completions — every checkbox tick is not a milestone', async () => {
      habitRepositoryMock.findById.mockResolvedValue(habit);
      habitRepositoryMock.recordCompletion.mockResolvedValue({ id: 'c2', habitId: 'habit-1', childId, date: new Date(), completedAt: new Date() });
      habitRepositoryMock.countCompletionsInWindow.mockResolvedValue(5);

      await service.completeHabit('habit-1', childId, familyId);

      expect(timelineMock.record).not.toHaveBeenCalled();
    });

    /**
     * CHANGED IN B1 (PA-B-004). The original passed `'2026-01-01'` with no
     * actor and asserted the string reached the repository verbatim. That was
     * the defect: `/self/habits/:id/complete` is a DEVICE route, and the date it
     * supplied composed the reward idempotency key
     * (`habit-completion:{habitId}:{date}`). The test's original PURPOSE —
     * "two completions for the same day hit the repository twice with the same
     * date, and the unique constraint, not this service, is what deduplicates"
     * — is preserved exactly; only the SOURCE of the date changed.
     */
    it('passes the same date through to the repository, twice, for the same-day case (idempotency is the repository unique-constraint\u2019s job, verified separately)', async () => {
      habitRepositoryMock.findById.mockResolvedValue(habit);
      habitRepositoryMock.recordCompletion.mockResolvedValue({ id: 'c1', habitId: 'habit-1', childId, date: new Date(), completedAt: new Date() });
      habitRepositoryMock.countCompletionsInWindow.mockResolvedValue(1);

      // A DEVICE caller — the date is DERIVED, and the one it sent is ignored.
      await service.completeHabit('habit-1', childId, familyId, '2026-01-01', 'DEVICE');
      await service.completeHabit('habit-1', childId, familyId, '2026-01-01', 'DEVICE');

      const today = new Date(`${getBusinessDate(new Date(), 'UTC')}T00:00:00.000Z`);
      expect(habitRepositoryMock.recordCompletion).toHaveBeenCalledTimes(2);
      expect(habitRepositoryMock.recordCompletion).toHaveBeenNthCalledWith(1, 'habit-1', childId, today, 'COMPLETED');
      expect(habitRepositoryMock.recordCompletion).toHaveBeenNthCalledWith(2, 'habit-1', childId, today, 'COMPLETED');
    });

    it('B1 (PA-B-004): a DEVICE cannot choose the completion day — 200 different dates collapse to ONE key', async () => {
      habitRepositoryMock.findById.mockResolvedValue(habit);
      habitRepositoryMock.recordCompletion.mockResolvedValue({ id: 'c1', habitId: 'habit-1', childId, date: new Date(), completedAt: new Date() });
      habitRepositoryMock.countCompletionsInWindow.mockResolvedValue(1);

      for (let i = 0; i < 200; i++) {
        const forged = `2026-${String((i % 12) + 1).padStart(2, '0')}-${String((i % 28) + 1).padStart(2, '0')}`;
        await service.completeHabit('habit-1', childId, familyId, forged, 'DEVICE');
      }

      // Every reward trigger carried the SAME key, so the ledger's unique
      // constraint has one row to collide on rather than 200 to fill.
      const keys = new Set(
        rewardTriggerMock.trigger.mock.calls
          .map((c: unknown[]) => (c[2] as { idempotencyKey?: string }).idempotencyKey)
          .filter((k: string | undefined): k is string => typeof k === 'string' && k.startsWith('habit-completion:')),
      );
      expect(keys.size).toBe(1);
      expect([...keys][0]).toBe(`habit-completion:habit-1:${getBusinessDate(new Date(), 'UTC')}`);
    });

    it('B1 (PA-B-004): a PARENT may back-date, but never into the future and never past the window', async () => {
      habitRepositoryMock.findById.mockResolvedValue(habit);
      habitRepositoryMock.recordCompletion.mockResolvedValue({ id: 'c1', habitId: 'habit-1', childId, date: new Date(), completedAt: new Date() });
      habitRepositoryMock.countCompletionsInWindow.mockResolvedValue(1);

      const today = getBusinessDate(new Date(), 'UTC');
      const yesterday = addBusinessDays(today, -1);

      await service.completeHabit('habit-1', childId, familyId, yesterday, 'PARENT');
      expect(habitRepositoryMock.recordCompletion).toHaveBeenLastCalledWith(
        'habit-1', childId, new Date(`${yesterday}T00:00:00.000Z`), 'COMPLETED',
      );

      // The future is clamped to today.
      await service.completeHabit('habit-1', childId, familyId, addBusinessDays(today, 5), 'PARENT');
      expect(habitRepositoryMock.recordCompletion).toHaveBeenLastCalledWith(
        'habit-1', childId, new Date(`${today}T00:00:00.000Z`), 'COMPLETED',
      );

      // Beyond the 30-day scoring window is clamped to its edge.
      await service.completeHabit('habit-1', childId, familyId, addBusinessDays(today, -400), 'PARENT');
      expect(habitRepositoryMock.recordCompletion).toHaveBeenLastCalledWith(
        'habit-1', childId, new Date(`${addBusinessDays(today, -30)}T00:00:00.000Z`), 'COMPLETED',
      );
    });
  });

  describe('getScoreBreakdown', () => {
    it('computes an explainable completion rate, never a hidden/opaque number', async () => {
      habitRepositoryMock.countActiveHabits.mockImplementation((_childId: string, sharedOnly?: boolean) =>
        Promise.resolve(sharedOnly ? 1 : 2),
      );
      habitRepositoryMock.countCompletionsInWindow.mockImplementation((_childId: string, _since: Date, sharedOnly?: boolean) =>
        Promise.resolve(sharedOnly ? 10 : 20),
      );

      const result = await service.getScoreBreakdown(childId, familyId);

      expect(result.childId).toBe(childId);
      expect(result.windowDays).toBe(30);
      expect(result.totalHabitDays).toBe(60);
      expect(result.completedHabitDays).toBe(20);
      expect(result.completionRate).toBeCloseTo(20 / 60);
      expect(result.sharedTaskCompletionRate).toBeCloseTo(10 / 30);
    });

    it('CLOSES A REAL GAP: computes a real streakDays via computeCurrentStreak, not a hardcoded/missing value', async () => {
      habitRepositoryMock.countActiveHabits.mockResolvedValue(1);
      habitRepositoryMock.countCompletionsInWindow.mockResolvedValue(1);
      const todayStr = new Date().toISOString().slice(0, 10);
      const yesterday = new Date();
      yesterday.setUTCDate(yesterday.getUTCDate() - 1);
      habitRepositoryMock.findDistinctCompletionDates.mockResolvedValue([todayStr, yesterday.toISOString().slice(0, 10)]);

      const result = await service.getScoreBreakdown(childId, familyId);

      expect(result.streakDays).toBe(2);
    });

    it('BOUNDARY CASE: zero completion dates produces a real streakDays of 0, never undefined', async () => {
      habitRepositoryMock.countActiveHabits.mockResolvedValue(0);
      habitRepositoryMock.countCompletionsInWindow.mockResolvedValue(0);

      const result = await service.getScoreBreakdown(childId, familyId);

      expect(result.streakDays).toBe(0);
    });

    it('returns 0 rates (not NaN or a crash) when the child has zero active habits', async () => {
      habitRepositoryMock.countActiveHabits.mockResolvedValue(0);
      habitRepositoryMock.countCompletionsInWindow.mockResolvedValue(0);

      const result = await service.getScoreBreakdown(childId, familyId);

      expect(result.completionRate).toBe(0);
      expect(result.sharedTaskCompletionRate).toBe(0);
    });

    it('verifies ownership before computing anything', async () => {
      habitRepositoryMock.countActiveHabits.mockResolvedValue(0);
      habitRepositoryMock.countCompletionsInWindow.mockResolvedValue(0);
      await service.getScoreBreakdown(childId, familyId);
      expect(childrenServiceMock.assertChildBelongsToFamily).toHaveBeenCalledWith(childId, familyId);
    });
  });

  describe('listHabits', () => {
    it('verifies ownership then delegates to the repository', async () => {
      habitRepositoryMock.listActiveForChild.mockResolvedValue([habit]);
      const result = await service.listHabits(childId, familyId);
      expect(childrenServiceMock.assertChildBelongsToFamily).toHaveBeenCalledWith(childId, familyId);
      expect(result).toEqual([habit]);
    });
  });

  // --- Sprint 25: Reward Rules wiring ---
  describe('completeHabit — reward trigger wiring', () => {
    it('triggers a Reward Rules check on EVERY completion, not just the first — a streak rule needs every occurrence counted', async () => {
      habitRepositoryMock.findById.mockResolvedValue(habit);
      habitRepositoryMock.recordCompletion.mockResolvedValue({ id: 'c3', habitId: 'habit-1', childId, date: new Date(), completedAt: new Date() });
      habitRepositoryMock.countCompletionsInWindow.mockResolvedValue(5);

      await service.completeHabit('habit-1', childId, familyId);

      expect(rewardTriggerMock.trigger).toHaveBeenCalledWith(
        childId,
        familyId,
        expect.objectContaining({ engine: 'habit-builder', type: 'habit_completed' }),
      );
    });

    it('a Reward Rules failure never blocks the habit completion itself from succeeding — best-effort', async () => {
      habitRepositoryMock.findById.mockResolvedValue(habit);
      habitRepositoryMock.recordCompletion.mockResolvedValue({ id: 'c4', habitId: 'habit-1', childId, date: new Date(), completedAt: new Date() });
      habitRepositoryMock.countCompletionsInWindow.mockResolvedValue(1);
      rewardTriggerMock.trigger.mockRejectedValue(new Error('simulated rewards failure'));

      await expect(service.completeHabit('habit-1', childId, familyId)).resolves.toBeDefined();
    });
  });
});
