import { Test } from '@nestjs/testing';

import { DigitalWellbeingEngineService } from '../../src/modules/life-intelligence/application/services/digital-wellbeing-engine.service';
import { PrismaDigitalWellbeingRepository } from '../../src/modules/life-intelligence/infrastructure/repositories/prisma-digital-wellbeing.repository';
import { ChildrenService } from '../../src/modules/children/application/services/children.service';
import { LIFE_TIMELINE_WRITER } from '../../src/modules/life-intelligence/domain/life-timeline.types';
import { RUNTIME_ALERT_REPOSITORY } from '../../src/modules/pairing/application/ports/runtime-alert.repository.port';
import { ConsentCheckService } from '../../src/modules/consent-check/application/consent-check.service';

describe('DigitalWellbeingEngineService', () => {
  const repositoryMock = {
    upsertDailySummary: jest.fn(),
    findSnapshotsInWindow: jest.fn(),
    getTopAppsToday: jest.fn(),
  };
  const childrenServiceMock = { assertChildBelongsToFamily: jest.fn() };
  const timelineMock = { record: jest.fn() };
  const runtimeAlertsMock = { createForFamilyOwner: jest.fn(), listForUser: jest.fn() };
  const consentCheckMock = { hasConsent: jest.fn() };

  let service: DigitalWellbeingEngineService;
  const childId = 'child-1';
  const familyId = 'family-1';
  const deviceId = 'device-1';

  const sampleInput = {
    usageDate: '2026-08-10',
    totalScreenMinutes: 120,
    appBreakdown: [{ packageName: 'com.example.game', minutes: 60 }],
    pickupCount: 30,
    nightUsageMinutes: 5,
    blockedAttemptCount: 1,
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    // Default: consented — matches Option C's own design intent
    // (baseline consent types are granted by default at child
    // creation). The dedicated 'consent enforcement' block below
    // overrides this per-test to verify the FALSE path explicitly.
    consentCheckMock.hasConsent.mockResolvedValue(true);
    const moduleRef = await Test.createTestingModule({
      providers: [
        DigitalWellbeingEngineService,
        { provide: PrismaDigitalWellbeingRepository, useValue: repositoryMock },
        { provide: ChildrenService, useValue: childrenServiceMock },
        { provide: LIFE_TIMELINE_WRITER, useValue: timelineMock },
        { provide: RUNTIME_ALERT_REPOSITORY, useValue: runtimeAlertsMock },
        { provide: ConsentCheckService, useValue: consentCheckMock },
      ],
    }).compile();
    service = moduleRef.get(DigitalWellbeingEngineService);
  });

  describe('recordDailySummary', () => {
    it('verifies ownership before touching anything', async () => {
      childrenServiceMock.assertChildBelongsToFamily.mockRejectedValue(new Error('not found'));
      await expect(service.recordDailySummary(childId, familyId, deviceId, sampleInput)).rejects.toThrow('not found');
      expect(repositoryMock.upsertDailySummary).not.toHaveBeenCalled();
    });

    it('writes a Timeline milestone only on the FIRST-EVER snapshot, never on every daily upload', async () => {
      repositoryMock.findSnapshotsInWindow.mockResolvedValue([]); // zero prior snapshots
      repositoryMock.upsertDailySummary.mockResolvedValue({ id: 's1', childId, deviceId, ...sampleInput, createdAt: new Date() });

      await service.recordDailySummary(childId, familyId, deviceId, sampleInput);

      expect(timelineMock.record).toHaveBeenCalledWith(
        expect.objectContaining({ eventType: 'first_wellbeing_snapshot', sourceEngine: 'digital-wellbeing' }),
      );
    });

    it('does NOT write a Timeline entry on subsequent daily uploads — avoids one entry every single day forever', async () => {
      repositoryMock.findSnapshotsInWindow.mockResolvedValue([{ totalScreenMinutes: 90, pickupCount: 20, nightUsageMinutes: 0, blockedAttemptCount: 0 }]);
      repositoryMock.upsertDailySummary.mockResolvedValue({ id: 's2', childId, deviceId, ...sampleInput, createdAt: new Date() });

      await service.recordDailySummary(childId, familyId, deviceId, sampleInput);

      expect(timelineMock.record).not.toHaveBeenCalled();
    });
  });

  describe('consent enforcement (Sprint 1, Option C)', () => {
    it('throws ForbiddenException and writes NOTHING when APP_USAGE_MONITORING consent is not granted', async () => {
      consentCheckMock.hasConsent.mockResolvedValue(false);

      await expect(service.recordDailySummary(childId, familyId, deviceId, sampleInput)).rejects.toThrow(
        'APP_USAGE_MONITORING consent has not been granted',
      );

      expect(consentCheckMock.hasConsent).toHaveBeenCalledWith(childId, 'APP_USAGE_MONITORING');
      expect(repositoryMock.upsertDailySummary).not.toHaveBeenCalled();
      expect(timelineMock.record).not.toHaveBeenCalled();
    });

    it('checks ownership BEFORE consent — a request for a child outside the caller\'s family fails on ownership, not a consent-existence leak', async () => {
      childrenServiceMock.assertChildBelongsToFamily.mockRejectedValue(new Error('not found'));

      await expect(service.recordDailySummary(childId, familyId, deviceId, sampleInput)).rejects.toThrow('not found');

      expect(consentCheckMock.hasConsent).not.toHaveBeenCalled();
    });

    it('proceeds normally when consent IS granted', async () => {
      consentCheckMock.hasConsent.mockResolvedValue(true);
      repositoryMock.findSnapshotsInWindow.mockResolvedValue([{ totalScreenMinutes: 1, pickupCount: 1, nightUsageMinutes: 0, blockedAttemptCount: 0 }]);
      repositoryMock.upsertDailySummary.mockResolvedValue({ id: 's1', childId, deviceId, ...sampleInput, createdAt: new Date() });

      await expect(service.recordDailySummary(childId, familyId, deviceId, sampleInput)).resolves.toBeDefined();
      expect(repositoryMock.upsertDailySummary).toHaveBeenCalled();
    });
  });

  describe('recordCriticalEvent', () => {
    it('reuses the EXISTING RuntimeAlert mechanism — never a duplicate notification system', async () => {
      await service.recordCriticalEvent(childId, familyId, {
        eventType: 'PROTECTION_BYPASS_ATTEMPT',
        title: 'Protection bypass detected',
        body: 'A bypass attempt was detected on the device.',
      });

      expect(runtimeAlertsMock.createForFamilyOwner).toHaveBeenCalledWith(
        expect.objectContaining({ familyId, childId, data: expect.objectContaining({ alertType: 'PROTECTION_BYPASS_ATTEMPT' }) }),
      );
    });

    it('writes security-relevant events to the Timeline', async () => {
      await service.recordCriticalEvent(childId, familyId, {
        eventType: 'POLICY_VIOLATION',
        title: 'Policy violation',
        body: 'A blocked app was opened.',
      });

      expect(timelineMock.record).toHaveBeenCalledWith(expect.objectContaining({ category: 'SAFETY', eventType: 'policy_violation' }));
    });

    it('CLOSES A REAL GAP (Master Completeness Audit): marks the 4 genuine security event types as CRITICAL priority', async () => {
      await service.recordCriticalEvent(childId, familyId, {
        eventType: 'ACCESSIBILITY_DISABLED',
        title: 'Protection turned off',
        body: 'Device protection was disabled.',
      });

      expect(runtimeAlertsMock.createForFamilyOwner).toHaveBeenCalledWith(expect.objectContaining({ priority: 'CRITICAL' }));
    });

    it('marks CHILD_REQUEST as NORMAL priority — a routine ask, not a security event', async () => {
      await service.recordCriticalEvent(childId, familyId, {
        eventType: 'CHILD_REQUEST',
        title: 'Child requested more time',
        body: 'Your child asked for extra screen time.',
      });

      expect(runtimeAlertsMock.createForFamilyOwner).toHaveBeenCalledWith(expect.objectContaining({ priority: 'NORMAL' }));
    });

    it('does NOT write CHILD_REQUEST to the Timeline — an in-the-moment ask, not a behavior-history event', async () => {
      await service.recordCriticalEvent(childId, familyId, {
        eventType: 'CHILD_REQUEST',
        title: 'Extra time requested',
        body: 'Child asked for 15 more minutes.',
      });

      expect(timelineMock.record).not.toHaveBeenCalled();
      expect(runtimeAlertsMock.createForFamilyOwner).toHaveBeenCalled(); // still alerts the parent, just skips Timeline
    });
  });

  describe('getBehavioralSnapshotSummary', () => {
    it('returns null (not a fabricated zero-average) when no data exists yet', async () => {
      repositoryMock.findSnapshotsInWindow.mockResolvedValue([]);
      const result = await service.getBehavioralSnapshotSummary(childId, familyId);
      expect(result).toBeNull();
    });

    it('computes real averages across the window', async () => {
      repositoryMock.findSnapshotsInWindow.mockResolvedValue([
        { totalScreenMinutes: 100, pickupCount: 20, nightUsageMinutes: 10, blockedAttemptCount: 2 },
        { totalScreenMinutes: 200, pickupCount: 40, nightUsageMinutes: 20, blockedAttemptCount: 4 },
      ]);

      const result = await service.getBehavioralSnapshotSummary(childId, familyId);

      expect(result).toEqual({
        windowDays: 30,
        averageDailyScreenMinutes: 150,
        averagePickups: 30,
        averageNightUsageMinutes: 15,
        totalBlockedAttempts: 6,
        daysWithData: 2,
      });
    });
  });
});
