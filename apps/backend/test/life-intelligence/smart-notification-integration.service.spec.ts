import { Test } from '@nestjs/testing';

import { SmartNotificationIntegrationService } from '../../src/modules/life-intelligence/application/services/smart-notification-integration.service';
import { NOTIFICATION_REPOSITORY } from '../../src/modules/notifications/application/ports/notification.repository.port';
import { RUNTIME_ALERT_REPOSITORY } from '../../src/modules/pairing/application/ports/runtime-alert.repository.port';
import { FamilyCommunicationService } from '../../src/modules/life-intelligence/application/services/family-communication.service';
import type { ISmartNotificationSignals } from '../../src/modules/life-intelligence/application/services/smart-notification-decision-engine';

describe('SmartNotificationIntegrationService (Sprint 16.1 Phase 3 — CLOSES A REAL GAP: the pure decision engines had zero real caller before this)', () => {
  const notificationRepoMock = { findRecentForChild: jest.fn() };
  const runtimeAlertRepoMock = { createForFamilyOwner: jest.fn() };
  const familyCommunicationMock = { draftAiMessage: jest.fn() };

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

    const moduleRef = await Test.createTestingModule({
      providers: [
        SmartNotificationIntegrationService,
        { provide: NOTIFICATION_REPOSITORY, useValue: notificationRepoMock },
        { provide: RUNTIME_ALERT_REPOSITORY, useValue: runtimeAlertRepoMock },
        { provide: FamilyCommunicationService, useValue: familyCommunicationMock },
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
    expect(familyCommunicationMock.draftAiMessage).not.toHaveBeenCalled();
  });

  describe('SEND — the happy path', () => {
    it('a CHILD-targeted candidate (hydration) routes through draftAiMessage (approval-gated), never direct alert', async () => {
      jest.useFakeTimers().setSystemTime(new Date('2026-08-10T15:00:00'));

      const result = await service.processSignals(childId, familyId, hydrationTriggerSignals);

      expect(result).toEqual([{ type: 'HYDRATION_REMINDER', targetAudience: 'CHILD', decision: 'SEND' }]);
      expect(familyCommunicationMock.draftAiMessage).toHaveBeenCalledWith(childId, familyId, 'HYDRATION_REMINDER', 'Water break?', expect.any(String));
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
      expect(familyCommunicationMock.draftAiMessage).not.toHaveBeenCalled();
    });
  });

  describe('DEFER — the specific quiet-hours case', () => {
    it('a candidate blocked ONLY by quiet hours is DEFERred, not SUPPRESSed', async () => {
      jest.useFakeTimers().setSystemTime(new Date('2026-08-10T23:00:00')); // within default 21:00-07:00 quiet hours

      const result = await service.processSignals(childId, familyId, hydrationTriggerSignals);

      expect(result).toEqual([{ type: 'HYDRATION_REMINDER', targetAudience: 'CHILD', decision: 'DEFER', reason: 'QUIET_HOURS' }]);
      expect(familyCommunicationMock.draftAiMessage).not.toHaveBeenCalled();
    });
  });

  describe('Parent vs Child routing', () => {
    it('STUDY_REMINDER (also CHILD-targeted per Sprint 16 classification) consistently routes to draftAiMessage', async () => {
      jest.useFakeTimers().setSystemTime(new Date('2026-08-10T15:00:00'));
      const studySignals: ISmartNotificationSignals = {
        ...hydrationTriggerSignals,
        hydration: { actualMl: 900, targetMl: 1000 },
        studyTask: { isIncomplete: true, usualStudyWindowStarted: true },
      };
      await service.processSignals(childId, familyId, studySignals);

      expect(familyCommunicationMock.draftAiMessage).toHaveBeenCalledWith(childId, familyId, 'STUDY_REMINDER', expect.any(String), expect.any(String));
      expect(runtimeAlertRepoMock.createForFamilyOwner).not.toHaveBeenCalled();
    });
  });

  describe('resilience and batch correctness', () => {
    it('a delivery failure for one candidate does not block delivering a different candidate in the same batch', async () => {
      jest.useFakeTimers().setSystemTime(new Date('2026-08-10T15:00:00'));
      familyCommunicationMock.draftAiMessage.mockRejectedValueOnce(new Error('transient failure'));
      const multiSignals: ISmartNotificationSignals = {
        ...hydrationTriggerSignals,
        studyTask: { isIncomplete: true, usualStudyWindowStarted: true },
      };

      const result = await service.processSignals(childId, familyId, multiSignals);

      expect(result.some((r) => r.type === 'STUDY_REMINDER' && r.decision === 'SEND')).toBe(true);
      expect(result.some((r) => r.type === 'HYDRATION_REMINDER')).toBe(false); // failed delivery -> no outcome recorded, logged not thrown
    });
  });
});
