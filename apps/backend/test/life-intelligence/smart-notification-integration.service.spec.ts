import { Test } from '@nestjs/testing';

import { SmartNotificationIntegrationService } from '../../src/modules/life-intelligence/application/services/smart-notification-integration.service';
import { NOTIFICATION_REPOSITORY } from '../../src/modules/notifications/application/ports/notification.repository.port';
import { RUNTIME_ALERT_REPOSITORY } from '../../src/modules/pairing/application/ports/runtime-alert.repository.port';
import { FamilyCommunicationService } from '../../src/modules/life-intelligence/application/services/family-communication.service';
import type { ISmartNotificationSignals } from '../../src/modules/life-intelligence/application/services/smart-notification-decision-engine';
import { familyDateProvider } from '../common/family-date.testing';

describe('SmartNotificationIntegrationService (Sprint 16.1 Phase 3 — CLOSES A REAL GAP: the pure decision engines had zero real caller before this)', () => {
  const notificationRepoMock = { findRecentForChild: jest.fn() };
  const runtimeAlertRepoMock = { createForFamilyOwner: jest.fn() };
  // B9 — the delivery layer now calls `draftAiMessageIfAbsent`, which returns
  // the drafted message or `null` when
  // `child_messages (family_id, source_event_id)` refused it. The mock returns
  // a truthy message by default so «delivered» stays the default in every test
  // that is not about deduplication.
  const familyCommunicationMock = { draftAiMessageIfAbsent: jest.fn() };

  let service: SmartNotificationIntegrationService;

  const childId = 'child-1';
  const familyId = 'family-1';

  const hydrationTriggerSignals: ISmartNotificationSignals = {
    currentHourOfDay: 15,
    screenMinutesLast90: 90,
    isCurrentlyInBlockedOrCriticalApp: false,
    hydration: { actualMl: 200, targetMl: 1000 },
    studyTask: null,
    exerciseStreak: null,
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    notificationRepoMock.findRecentForChild.mockResolvedValue([]);
    // B9 — `true`/a message means «a row was written». `false`/`null` now
    // means «the constraint or the window said this already exists», which the
    // service reports as SUPPRESS/ALREADY_NOTIFIED.
    runtimeAlertRepoMock.createForFamilyOwner.mockResolvedValue(true);
    familyCommunicationMock.draftAiMessageIfAbsent.mockResolvedValue({ id: 'msg-1' });

    const moduleRef = await Test.createTestingModule({
      providers: [
        SmartNotificationIntegrationService,
        { provide: NOTIFICATION_REPOSITORY, useValue: notificationRepoMock },
        { provide: RUNTIME_ALERT_REPOSITORY, useValue: runtimeAlertRepoMock },
        { provide: FamilyCommunicationService, useValue: familyCommunicationMock },
        // B2: the REAL FamilyDateService over a stub Prisma (see the helper).
        familyDateProvider()
      ],
    }).compile();
    service = moduleRef.get(SmartNotificationIntegrationService);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('BOUNDARY CASE: zero signal-worthy candidates produces zero outcomes and touches nothing', async () => {
    const noSignals: ISmartNotificationSignals = {
      currentHourOfDay: 12, screenMinutesLast90: 5, isCurrentlyInBlockedOrCriticalApp: false,
      hydration: { actualMl: 900, targetMl: 1000 }, studyTask: null, exerciseStreak: null,
    };
    const result = await service.processSignals(childId, familyId, noSignals);

    expect(result).toEqual([]);
    expect(notificationRepoMock.findRecentForChild).not.toHaveBeenCalled();
    expect(runtimeAlertRepoMock.createForFamilyOwner).not.toHaveBeenCalled();
    expect(familyCommunicationMock.draftAiMessageIfAbsent).not.toHaveBeenCalled();
  });

  describe('SEND — the happy path', () => {
    it('a CHILD-targeted candidate (hydration) routes through draftAiMessageIfAbsent (approval-gated), never direct alert', async () => {
      jest.useFakeTimers().setSystemTime(new Date('2026-08-10T15:00:00'));

      const result = await service.processSignals(childId, familyId, hydrationTriggerSignals);

      expect(result).toEqual([{ type: 'HYDRATION_REMINDER', targetAudience: 'CHILD', decision: 'SEND' }]);
      // B9 — the sixth argument is the composed causal key. `processSignals`
      // builds it itself (`signal:<child>:<type>:w<bucket>`) because its caller
      // supplies SIGNALS and cannot name notifications that do not exist yet.
      expect(familyCommunicationMock.draftAiMessageIfAbsent).toHaveBeenCalledWith(
        childId, familyId, 'HYDRATION_REMINDER', 'Water break?', expect.any(String),
        expect.stringMatching(/^signal:child-1:HYDRATION_REMINDER:w\d+:child$/),
      );
      expect(runtimeAlertRepoMock.createForFamilyOwner).not.toHaveBeenCalled();
    });
  });

  describe('SUPPRESS', () => {
    it('a candidate blocked by cooldown is SUPPRESSed with the real reason, and never delivered', async () => {
      jest.useFakeTimers().setSystemTime(new Date('2026-08-10T15:00:00'));
      notificationRepoMock.findRecentForChild.mockResolvedValue([
        { type: 'HYDRATION_REMINDER', priority: 'NORMAL', createdAt: new Date('2026-08-10T14:50:00') },
      ]);

      const result = await service.processSignals(childId, familyId, hydrationTriggerSignals);

      expect(result).toEqual([{ type: 'HYDRATION_REMINDER', targetAudience: 'CHILD', decision: 'SUPPRESS', reason: 'COOLDOWN' }]);
      expect(familyCommunicationMock.draftAiMessageIfAbsent).not.toHaveBeenCalled();
    });
  });

  describe('DEFER — the specific quiet-hours case', () => {
    it('a candidate blocked ONLY by quiet hours is DEFERred, not SUPPRESSed', async () => {
      jest.useFakeTimers().setSystemTime(new Date('2026-08-10T23:00:00')); // within default 21:00-07:00 quiet hours

      const result = await service.processSignals(childId, familyId, hydrationTriggerSignals);

      expect(result).toEqual([{ type: 'HYDRATION_REMINDER', targetAudience: 'CHILD', decision: 'DEFER', reason: 'QUIET_HOURS' }]);
      expect(familyCommunicationMock.draftAiMessageIfAbsent).not.toHaveBeenCalled();
    });
  });

  describe('Parent vs Child routing', () => {
    it('STUDY_REMINDER (also CHILD-targeted per Sprint 16 classification) consistently routes to draftAiMessageIfAbsent', async () => {
      jest.useFakeTimers().setSystemTime(new Date('2026-08-10T15:00:00'));
      const studySignals: ISmartNotificationSignals = {
        ...hydrationTriggerSignals,
        hydration: { actualMl: 900, targetMl: 1000 },
        studyTask: { isIncomplete: true, usualStudyWindowStarted: true },
      };
      await service.processSignals(childId, familyId, studySignals);

      expect(familyCommunicationMock.draftAiMessageIfAbsent).toHaveBeenCalledWith(
        childId, familyId, 'STUDY_REMINDER', expect.any(String), expect.any(String),
        expect.stringMatching(/^signal:child-1:STUDY_REMINDER:w\d+:child$/),
      );
      expect(runtimeAlertRepoMock.createForFamilyOwner).not.toHaveBeenCalled();
    });
  });

  describe('resilience and batch correctness', () => {
    it('a delivery failure for one candidate does not block delivering a different candidate in the same batch', async () => {
      jest.useFakeTimers().setSystemTime(new Date('2026-08-10T15:00:00'));
      familyCommunicationMock.draftAiMessageIfAbsent.mockRejectedValueOnce(new Error('transient failure'));
      const multiSignals: ISmartNotificationSignals = {
        ...hydrationTriggerSignals,
        studyTask: { isIncomplete: true, usualStudyWindowStarted: true },
      };

      const result = await service.processSignals(childId, familyId, multiSignals);

      expect(result.some((r) => r.type === 'STUDY_REMINDER' && r.decision === 'SEND')).toBe(true);
      // Sprint 16.2 refactor: a delivery failure now returns a real,
      // honest outcome (SUPPRESS/DELIVERY_ERROR) instead of being
      // silently dropped from the result — more debuggable than the
      // prior "just vanishes from the array" behavior.
      expect(result.some((r) => r.type === 'HYDRATION_REMINDER' && r.decision === 'SUPPRESS' && r.reason === 'DELIVERY_ERROR')).toBe(true);
    });
  });

  describe('Sprint 16.2 Phase 1 — notifyEvent (CLOSES A REAL GAP: single-event callers, e.g. Habit/Reward, previously had no entry point into this pipeline)', () => {
    it('delivers a single event-driven candidate through the exact same fatigue-guarded pipeline as processSignals', async () => {
      jest.useFakeTimers().setSystemTime(new Date('2026-08-10T15:00:00'));

      const outcome = await service.notifyEvent(childId, familyId, {
        type: 'STREAK_ACHIEVED',
        priority: 'NORMAL',
        title: '7-day streak!',
        body: 'Amazing consistency!',
        targetAudience: 'CHILD',
        // B9 — the causal key is now a REQUIRED part of a deliverable
        // candidate. The `:child` facet below is appended by the delivery
        // layer, not by the caller.
        sourceEventId: 'evt:11111111-1111-4111-8111-111111111111',
      });

      expect(outcome).toEqual({ type: 'STREAK_ACHIEVED', targetAudience: 'CHILD', decision: 'SEND' });
      expect(familyCommunicationMock.draftAiMessageIfAbsent).toHaveBeenCalledWith(
        childId,
        familyId,
        'STREAK_ACHIEVED',
        '7-day streak!',
        'Amazing consistency!',
        'evt:11111111-1111-4111-8111-111111111111:child',
      );
    });

    it('a PARENT-targeted event candidate routes through createForFamilyOwner', async () => {
      jest.useFakeTimers().setSystemTime(new Date('2026-08-10T15:00:00'));

      await service.notifyEvent(childId, familyId, {
        type: 'BADGE_EARNED',
        priority: 'NORMAL',
        title: 'New badge!',
        body: 'Your child earned a badge.',
        targetAudience: 'PARENT',
        sourceEventId: 'badge:child-1:badge-1',
      });

      expect(runtimeAlertRepoMock.createForFamilyOwner).toHaveBeenCalledWith(
        expect.objectContaining({
          childId,
          familyId,
          type: 'BADGE_EARNED',
          title: 'New badge!',
          // B9 — the key reaches the single writer of `notifications`
          // unchanged. If it did not, the unique index would have nothing to
          // work with and the KNOWN LIMIT would still be a limit.
          sourceEventId: 'badge:child-1:badge-1',
        }),
      );
    });

    it('respects fatigue guard for event-driven candidates too — a real duplicate is suppressed, not delivered', async () => {
      jest.useFakeTimers().setSystemTime(new Date('2026-08-10T15:00:00'));
      notificationRepoMock.findRecentForChild.mockResolvedValue([
        { type: 'BADGE_EARNED', priority: 'NORMAL', createdAt: new Date('2026-08-10T14:58:00') }, // 2 min ago -> DUPLICATE window
      ]);

      const outcome = await service.notifyEvent(childId, familyId, {
        type: 'BADGE_EARNED', priority: 'NORMAL', title: 't', body: 'b', targetAudience: 'PARENT',
        sourceEventId: 'badge:child-1:badge-2',
      });

      expect(outcome).toEqual({ type: 'BADGE_EARNED', targetAudience: 'PARENT', decision: 'SUPPRESS', reason: 'DUPLICATE' });
      expect(runtimeAlertRepoMock.createForFamilyOwner).not.toHaveBeenCalled();
    });
  });
});
