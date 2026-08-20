import { Test } from '@nestjs/testing';

import { HealthEngineService } from '../../src/modules/life-intelligence/application/services/health-engine.service';
import { PrismaHealthRepository } from '../../src/modules/life-intelligence/infrastructure/repositories/prisma-health.repository';
import { ChildrenService } from '../../src/modules/children/application/services/children.service';
import { LIFE_TIMELINE_WRITER } from '../../src/modules/life-intelligence/domain/life-timeline.types';
import { REWARD_TRIGGER_WRITER } from '../../src/modules/life-intelligence/domain/reward-trigger.types';
import { SmartNotificationEngineService } from '../../src/modules/notification-engine/application/services/smart-notification-engine.service';
import { computeHydrationTargetMl } from '../../src/modules/life-intelligence/application/services/health-rules';
import { familyDateProvider } from '../common/family-date.testing';
import { getBusinessDate } from '../../src/common/time/family-date';
import { composeIdempotencyKey } from '../../src/shared/events/idempotency';

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
    getDailyHydrationTotals: jest.fn(),
    createSleepLog: jest.fn(),
    findSleepLogForDate: jest.fn(),
    createActivityLog: jest.fn(),
    sumActivityMinutesOnDate: jest.fn(),
    getDailyActivityTotals: jest.fn(),
    countGroupActivitiesInWindow: jest.fn(),
    upsertHealthScore: jest.fn(),
  };
  const childrenServiceMock = {
    assertChildBelongsToFamily: jest.fn(),
    getChildOrThrow: jest.fn(),
  };
  const timelineMock = { record: jest.fn() };
  const rewardTriggerMock = { trigger: jest.fn() };
  /**
   * SPRINT F1 — THE NOTIFICATION DOOR, STUBBED AT ITS OWN BOUNDARY.
   *
   * `HealthEngineService` gained one collaborator when it became the producer of
   * `DAILY_GOAL_COMPLETED`. This is a UNIT spec — the timeline writer and the
   * reward trigger beside it are stubs for the same reason — so the door is
   * stubbed and the assertions below check only WHAT THIS CLASS DECIDES: that it
   * knocks on the crossing and stays silent otherwise, with the server-owned
   * cause and a family-local dedup key. Everything past the door — scoring, the
   * quiet-hours class, the SAFETY ENGINE, the Arabic bytes, the deep link — is
   * asserted against a real engine and a real database in
   * `test/notifications/daily-goal-completed.e2e.spec.ts`, never here and never
   * with a mocked Safety Engine.
   */
  const notificationsMock = { handleEvent: jest.fn() };

  let service: HealthEngineService;
  const childId = 'child-1';
  const familyId = 'family-1';

  beforeEach(async () => {
    jest.resetAllMocks();
    childrenServiceMock.getChildOrThrow.mockResolvedValue({ id: childId, dateOfBirth: '2016-01-01' });
    const moduleRef = await Test.createTestingModule({
      providers: [
        HealthEngineService,
        { provide: PrismaHealthRepository, useValue: repositoryMock },
        { provide: ChildrenService, useValue: childrenServiceMock },
        { provide: LIFE_TIMELINE_WRITER, useValue: timelineMock },
        { provide: REWARD_TRIGGER_WRITER, useValue: rewardTriggerMock },
        { provide: SmartNotificationEngineService, useValue: notificationsMock },
        // B2: the REAL FamilyDateService over a stub Prisma (see the helper).
        familyDateProvider()
      ],
    }).compile();
    service = moduleRef.get(HealthEngineService);
  });

  afterEach(() => {
    // FIXES A REAL ROOT CAUSE: jest.useRealTimers() at the end of an
    // individual test only runs if that test's own assertions pass —
    // a failing expect() throws BEFORE reaching that line, leaving
    // fake timers active for the NEXT test in this file. This
    // unconditional cleanup runs regardless of pass/fail/throw.
    jest.useRealTimers();
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
  describe('logHydration — reward trigger wiring (FIXED Sprint 16.3: this section was broken since Sprint 16.1 Phase 4 extended the real behavior to 3 events + a repository call this mock never had — would have thrown a runtime error if ever actually executed)', () => {
    it('triggers Reward Rules exactly when the target is crossed — hydration_event + DAILY_GOAL_COMPLETED + the contract name HYDRATION_GOAL_COMPLETED', async () => {
      repositoryMock.createHydrationLog.mockResolvedValue({ id: 'h4', childId, amountMl: 400, loggedAt: new Date() });
      repositoryMock.sumHydrationMlOnDate.mockResolvedValue(2200);
      repositoryMock.getDailyHydrationTotals.mockResolvedValue(new Map());

      await service.logHydration(childId, familyId, { amountMl: 400 });

      expect(rewardTriggerMock.trigger).toHaveBeenCalledWith(
        childId, familyId,
        expect.objectContaining({ engine: 'health', type: 'hydration_event' }),
      );
      expect(rewardTriggerMock.trigger).toHaveBeenCalledWith(
        childId, familyId,
        expect.objectContaining({ engine: 'health', type: 'DAILY_GOAL_COMPLETED', payload: expect.objectContaining({ metric: 'hydration' }) }),
      );

      /**
       * THE CONTRACT NAME, AND THE KEY THAT MAKES THE TWO DOORS ONE.
       *
       * `first_hydration_goal` is seeded against `HYDRATION_GOAL_COMPLETED`, a
       * name this method never fired — so the badge was unreachable through the
       * Child App's own button while being reachable through `POST
       * /events/batch`. The trigger below closes that.
       *
       * THE KEY IS ASSERTED AGAINST `composeIdempotencyKey`, NOT AGAINST A
       * LITERAL, and that is the point of this assertion rather than a
       * decoration: `EventIngestionService` composes the DEVICE door's key with
       * the same call, so a hand-written key here would award the badge and
       * still let the same crossing be PAID TWICE across the two doors. The
       * shared string is what lets `rewards_ledger_entries (child_id,
       * idempotency_key)` refuse the second grant.
       */
      expect(rewardTriggerMock.trigger).toHaveBeenCalledWith(
        childId, familyId,
        expect.objectContaining({
          engine: 'health',
          type: 'HYDRATION_GOAL_COMPLETED',
          payload: expect.objectContaining({ metric: 'hydration', verifiedBy: 'SELF' }),
          // `familyDateProvider()` defaults this suite's family to UTC, and the
          // day is DERIVED with the product's own function rather than written
          // as a literal — so the assertion follows the calendar rather than
          // pinning a date that goes stale tomorrow.
          idempotencyKey: composeIdempotencyKey('HYDRATION_GOAL_COMPLETED', {
            childId,
            localDate: getBusinessDate(new Date(), 'UTC'),
          }),
        }),
      );
      // SPRINT F1 — AND THE CHILD IS TOLD, on the same crossing, through the
      // engine door and nothing else. The cause is the SERVER-OWNED domain event
      // name that `notification-nouns.ts` keys the Arabic noun on — never the
      // device-supplied `metadata` the ledger entry refused.
      expect(notificationsMock.handleEvent).toHaveBeenCalledTimes(1);
      expect(notificationsMock.handleEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          familyId,
          childId,
          eventType: 'DAILY_GOAL_COMPLETED',
          cause: 'HYDRATION_GOAL_COMPLETED',
          sourceEventId: expect.any(String),
        }),
      );
    });

    it('additionally fires STREAK_ACHIEVED at a real milestone', async () => {
      jest.useFakeTimers().setSystemTime(new Date('2026-08-11T12:00:00.000Z'));
      repositoryMock.createHydrationLog.mockResolvedValue({ id: 'h4b', childId, amountMl: 400, loggedAt: new Date() });
      repositoryMock.sumHydrationMlOnDate.mockResolvedValue(2200);
      const sevenDays = new Map(Array.from({ length: 7 }, (_, i) => {
        const d = new Date('2026-08-11T12:00:00.000Z'); d.setUTCDate(d.getUTCDate() - i); // pinned to the SAME fixed clock the service itself now reads
        return [d.toISOString().slice(0, 10), 2200];
      }));
      repositoryMock.getDailyHydrationTotals.mockResolvedValue(sevenDays);

      await service.logHydration(childId, familyId, { amountMl: 400 });

      expect(rewardTriggerMock.trigger).toHaveBeenCalledWith(
        childId, familyId,
        expect.objectContaining({ type: 'STREAK_ACHIEVED', payload: expect.objectContaining({ metric: 'hydration' }) }),
      );
    });

    it('does NOT trigger Reward Rules when the target is not crossed by this log', async () => {
      repositoryMock.createHydrationLog.mockResolvedValue({ id: 'h5', childId, amountMl: 100, loggedAt: new Date() });
      repositoryMock.sumHydrationMlOnDate.mockResolvedValue(500);

      await service.logHydration(childId, familyId, { amountMl: 100 });

      expect(rewardTriggerMock.trigger).not.toHaveBeenCalled();
      // THE NEGATIVE CASE FOR THE PRODUCER: a child still short of the target is
      // told nothing. The crossing is the condition, not the log.
      expect(notificationsMock.handleEvent).not.toHaveBeenCalled();
    });

    it('a Reward Rules failure never blocks the hydration log itself from succeeding', async () => {
      repositoryMock.createHydrationLog.mockResolvedValue({ id: 'h6', childId, amountMl: 400, loggedAt: new Date() });
      repositoryMock.sumHydrationMlOnDate.mockResolvedValue(2200);
      repositoryMock.getDailyHydrationTotals.mockResolvedValue(new Map());
      rewardTriggerMock.trigger.mockRejectedValue(new Error('simulated rewards failure'));

      await expect(service.logHydration(childId, familyId, { amountMl: 400 })).resolves.toBeDefined();
    });
  });

  describe('logActivity — reward trigger wiring (Sprint 16.3 Priority 3, CLOSES A REAL GAP flagged in Sprint 16.2\'s own report: Hydration had this, Activity did not)', () => {
    it('triggers Reward Rules exactly when the daily activity target (60 min) is crossed', async () => {
      repositoryMock.createActivityLog.mockResolvedValue({ id: 'a1', childId, activityType: 'running', durationMinutes: 30, socialContext: 'SOLO', date: new Date('2026-08-10') });
      repositoryMock.sumActivityMinutesOnDate.mockResolvedValue(70); // crossed 60
      repositoryMock.getDailyActivityTotals.mockResolvedValue(new Map());
      repositoryMock.countGroupActivitiesInWindow.mockResolvedValue(0);

      await service.logActivity(childId, familyId, { date: '2026-08-10', activityType: 'running', durationMinutes: 30, socialContext: 'SOLO' });

      expect(rewardTriggerMock.trigger).toHaveBeenCalledWith(
        childId, familyId,
        expect.objectContaining({ engine: 'health', type: 'DAILY_GOAL_COMPLETED', payload: expect.objectContaining({ metric: 'activity' }) }),
      );

      /** The contract name, for the same reason and with the same shared-key
       *  discipline as `logHydration`'s — see that assertion's own comment.
       *  Without it `first_activity_goal` is unreachable through
       *  `POST /life-intelligence/self/health/activity-logs`. */
      expect(rewardTriggerMock.trigger).toHaveBeenCalledWith(
        childId, familyId,
        expect.objectContaining({
          engine: 'health',
          type: 'ACTIVITY_GOAL_COMPLETED',
          payload: expect.objectContaining({ metric: 'activity', verifiedBy: 'SELF' }),
          idempotencyKey: composeIdempotencyKey('ACTIVITY_GOAL_COMPLETED', {
            childId,
            localDate: getBusinessDate(new Date(), 'UTC'),
          }),
        }),
      );

      // The OTHER of the two crossings that have ever emitted this name, and it
      // carries the OTHER server-owned cause — so the child reads «هدف الحركة»
      // and not the hydration sentence.
      expect(notificationsMock.handleEvent).toHaveBeenCalledTimes(1);
      expect(notificationsMock.handleEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: 'DAILY_GOAL_COMPLETED',
          cause: 'ACTIVITY_GOAL_COMPLETED',
        }),
      );
    });

    it('does NOT trigger Reward Rules when the daily target is not crossed by this log', async () => {
      repositoryMock.createActivityLog.mockResolvedValue({ id: 'a2', childId, activityType: 'running', durationMinutes: 10, socialContext: 'SOLO', date: new Date('2026-08-10') });
      repositoryMock.sumActivityMinutesOnDate.mockResolvedValue(20); // still under 60
      repositoryMock.countGroupActivitiesInWindow.mockResolvedValue(0);

      await service.logActivity(childId, familyId, { date: '2026-08-10', activityType: 'running', durationMinutes: 10, socialContext: 'SOLO' });

      expect(rewardTriggerMock.trigger).not.toHaveBeenCalled();
      expect(notificationsMock.handleEvent).not.toHaveBeenCalled();
    });

    it('additionally fires STREAK_ACHIEVED for activity at a real milestone', async () => {
      repositoryMock.createActivityLog.mockResolvedValue({ id: 'a3', childId, activityType: 'running', durationMinutes: 30, socialContext: 'SOLO', date: new Date() });
      repositoryMock.sumActivityMinutesOnDate.mockResolvedValue(70);
      repositoryMock.countGroupActivitiesInWindow.mockResolvedValue(0);
      const sevenDays = new Map(Array.from({ length: 7 }, (_, i) => {
        const d = new Date(); d.setUTCDate(d.getUTCDate() - i);
        return [d.toISOString().slice(0, 10), 70];
      }));
      repositoryMock.getDailyActivityTotals.mockResolvedValue(sevenDays);

      await service.logActivity(childId, familyId, { date: new Date().toISOString().slice(0, 10), activityType: 'running', durationMinutes: 30, socialContext: 'SOLO' });

      expect(rewardTriggerMock.trigger).toHaveBeenCalledWith(
        childId, familyId,
        expect.objectContaining({ type: 'STREAK_ACHIEVED', payload: expect.objectContaining({ metric: 'activity' }) }),
      );
    });

    it('a Reward Rules failure never blocks the activity log itself from succeeding', async () => {
      repositoryMock.createActivityLog.mockResolvedValue({ id: 'a4', childId, activityType: 'running', durationMinutes: 30, socialContext: 'SOLO', date: new Date('2026-08-10') });
      repositoryMock.sumActivityMinutesOnDate.mockResolvedValue(70);
      repositoryMock.getDailyActivityTotals.mockResolvedValue(new Map());
      repositoryMock.countGroupActivitiesInWindow.mockResolvedValue(0);
      rewardTriggerMock.trigger.mockRejectedValue(new Error('simulated rewards failure'));

      await expect(
        service.logActivity(childId, familyId, { date: '2026-08-10', activityType: 'running', durationMinutes: 30, socialContext: 'SOLO' }),
      ).resolves.toBeDefined();
    });
  });
});
