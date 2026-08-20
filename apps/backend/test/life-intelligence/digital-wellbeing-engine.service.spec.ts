import { Test } from '@nestjs/testing';

import { DigitalWellbeingEngineService } from '../../src/modules/life-intelligence/application/services/digital-wellbeing-engine.service';
import { PrismaDigitalWellbeingRepository } from '../../src/modules/life-intelligence/infrastructure/repositories/prisma-digital-wellbeing.repository';
import { ChildrenService } from '../../src/modules/children/application/services/children.service';
import { LIFE_TIMELINE_WRITER } from '../../src/modules/life-intelligence/domain/life-timeline.types';
import { SmartNotificationEngineService } from '../../src/modules/notification-engine/application/services/smart-notification-engine.service';
import { quietHoursClassOf } from '../../src/shared/notifications/notification-class';
import { ConsentCheckService } from '../../src/modules/consent-check/application/consent-check.service';
import { BaselineCalculatorService } from '../../src/modules/life-intelligence/application/services/baseline-calculator.service';
import { PatternDetectionService } from '../../src/modules/life-intelligence/application/services/pattern-detection.service';
import { AnomalyDetectionService } from '../../src/modules/life-intelligence/application/services/anomaly-detection.service';
import { ChildSignalService } from '../../src/modules/life-intelligence/application/services/child-signal.service';
import { EMPTY_CHILD_SIGNAL_REPORT } from '../../src/modules/life-intelligence/domain/child-signal.types';
import { familyDateProvider } from '../common/family-date.testing';

describe('DigitalWellbeingEngineService', () => {
  const repositoryMock = {
    upsertDailySummary: jest.fn(),
    findSnapshotsInWindow: jest.fn(),
    getTopAppsToday: jest.fn(),
    updateDetectionResults: jest.fn(),
    findRecentPatterns: jest.fn(),
  };
  const childrenServiceMock = { assertChildBelongsToFamily: jest.fn() };
  const timelineMock = { record: jest.fn() };
  /**
   * PHASE E (`PD-N-004`). This used to be a `RUNTIME_ALERT_REPOSITORY` mock,
   * because `recordCriticalEvent` wrote to that repository DIRECTLY and
   * therefore never met the quiet-hours classification Phase D built.
   *
   * It is not that the old assertions were wrong — the mechanism they assert
   * («reuses the existing RuntimeAlert path, never a second notification
   * system») is still exactly what happens, one call deeper:
   * `notifyEvent` -> `deliverNow` -> `createForFamilyOwner`. What changed is
   * that the producer now reaches it THROUGH the gate, so this is where the
   * outgoing notification is now observable from a unit test. Every property
   * the old assertions checked is re-checked below, on the candidate handed to
   * the gate.
   *
   * PHASE F (`F6-003`, closing `PF-E-001`) — AND IT MOVES ONE CALL OUTWARD
   * AGAIN, for the same reason it moved the first time. The producer now hands
   * a CAUSE to `SmartNotificationEngineService`, which scores it, records the
   * decision in `notification_decisions`, renders the sentence from
   * `COPY_CATALOGUE` and then calls the very same `notifyEvent` -> `deliverNow`
   * -> `createForFamilyOwner` chain. One shared delivery path, still no second
   * engine; what is observable from a unit test is now the cause rather than
   * the candidate.
   */
  const notificationEngineMock = { handleEvent: jest.fn() };
  const consentCheckMock = { hasConsent: jest.fn() };
  const baselineCalculatorMock = { compute: jest.fn() };
  const patternDetectionMock = { detect: jest.fn() };
  const anomalyDetectionMock = { detectRecurrence: jest.fn() };
  /**
   * SPRINT F1 — the CHILD-facing signal sweep this method now also runs.
   *
   * A COLLABORATOR STUB, not a weakened assertion: this file's subject is the
   * wellbeing pipeline (ownership, consent, timeline, pattern detection), and
   * `ChildSignalService` is proven end to end against a real PostgreSQL — real
   * engine, real safety filter, real unique indexes — in
   * `test/life-intelligence/child-signal-producer.e2e.spec.ts`. What IS asserted
   * here is the wiring this file owns: that the sweep is invoked, with the
   * family's own screen figure, and only when the check-in is about today.
   */
  const childSignalsMock = { sweepChild: jest.fn() };

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
    jest.resetAllMocks(); // FIXES A REAL ROOT CAUSE: clearAllMocks() only resets call history, not configured mockResolvedValue/mockRejectedValue implementations -- resetAllMocks() resets both.
    // Default: consented — matches Option C's own design intent
    // (baseline consent types are granted by default at child
    // creation). The dedicated 'consent enforcement' block below
    // overrides this per-test to verify the FALSE path explicitly.
    consentCheckMock.hasConsent.mockResolvedValue(true);
    // Sensible, honest defaults for Sprint 14's Behavioral Intelligence
    // pipeline — "nothing notable detected" is the correct default for
    // most tests in this file, which focus on ownership/consent/Timeline
    // behavior, not pattern-detection specifics (covered by their own
    // dedicated pattern-detection.service.spec.ts).
    baselineCalculatorMock.compute.mockResolvedValue(null);
    patternDetectionMock.detect.mockReturnValue([]);
    anomalyDetectionMock.detectRecurrence.mockReturnValue([]);
    repositoryMock.updateDetectionResults.mockResolvedValue(undefined);
    repositoryMock.findRecentPatterns.mockResolvedValue([]);
    childSignalsMock.sweepChild.mockResolvedValue(EMPTY_CHILD_SIGNAL_REPORT);
    const moduleRef = await Test.createTestingModule({
      providers: [
        DigitalWellbeingEngineService,
        { provide: PrismaDigitalWellbeingRepository, useValue: repositoryMock },
        { provide: ChildrenService, useValue: childrenServiceMock },
        { provide: LIFE_TIMELINE_WRITER, useValue: timelineMock },
        { provide: SmartNotificationEngineService, useValue: notificationEngineMock },
        { provide: ConsentCheckService, useValue: consentCheckMock },
        { provide: BaselineCalculatorService, useValue: baselineCalculatorMock },
        { provide: PatternDetectionService, useValue: patternDetectionMock },
        { provide: AnomalyDetectionService, useValue: anomalyDetectionMock },
        { provide: ChildSignalService, useValue: childSignalsMock },
        // B2: the REAL FamilyDateService over a stub Prisma (see the helper).
        familyDateProvider()
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

    /**
     * SPRINT F1 — THE WIRING THIS FILE OWNS.
     *
     * `HYDRATION_REMINDER`, `STUDY_REMINDER`, `EXERCISE_ENCOURAGEMENT` and
     * `STREAK_AT_RISK` had copy, scoring and a destination and no producer,
     * because the only entry point that could reach them (`processSignals`) has
     * zero callers in `src/`. This method is now that caller — so the three
     * assertions below are «is it actually invoked», «with the family's own
     * figure» and «and never on the strength of yesterday's total».
     */
    describe('the CHILD signal sweep (SPRINT F1)', () => {
      const priorSnapshot = [{ totalScreenMinutes: 90, pickupCount: 20, nightUsageMinutes: 0, blockedAttemptCount: 0 }];
      // The stub family is UTC (`familyDateProvider`), so a check-in dated
      // 2026-08-10 is «today» for an instant on 2026-08-10.
      const onThatDay = new Date('2026-08-10T14:00:00.000Z');

      it('is invoked with the screen figure the device just uploaded', async () => {
        repositoryMock.findSnapshotsInWindow.mockResolvedValue(priorSnapshot);
        repositoryMock.upsertDailySummary.mockResolvedValue({ id: 's3', childId, deviceId, ...sampleInput, createdAt: new Date() });

        await service.recordDailySummary(childId, familyId, deviceId, sampleInput, onThatDay);

        expect(childSignalsMock.sweepChild).toHaveBeenCalledWith({
          familyId,
          childId,
          now: onThatDay,
          screenMinutesToday: sampleInput.totalScreenMinutes,
          // The device is talking to this server right now, which is the fact
          // `RELEVANCE` is scored on.
          isEngagedNow: true,
        });
      });

      it('withholds the figure when the DEVICE day is not the FAMILY day', async () => {
        repositoryMock.findSnapshotsInWindow.mockResolvedValue(priorSnapshot);
        repositoryMock.upsertDailySummary.mockResolvedValue({ id: 's4', childId, deviceId, ...sampleInput, createdAt: new Date() });

        // A queued upload drained a day late: `usageDate` is 2026-08-10 and the
        // family's day is the 11th. «You have been on screen a long time TODAY»
        // must not be said on the strength of yesterday's total.
        await service.recordDailySummary(
          childId,
          familyId,
          deviceId,
          sampleInput,
          new Date('2026-08-11T09:00:00.000Z'),
        );

        expect(childSignalsMock.sweepChild).toHaveBeenCalledWith(
          expect.objectContaining({ screenMinutesToday: null }),
        );
      });

      it('runs on the FIRST-EVER snapshot too — a child with no baseline can still be behind on water', async () => {
        repositoryMock.findSnapshotsInWindow.mockResolvedValue([]);
        repositoryMock.upsertDailySummary.mockResolvedValue({ id: 's5', childId, deviceId, ...sampleInput, createdAt: new Date() });

        await service.recordDailySummary(childId, familyId, deviceId, sampleInput, onThatDay);

        // The DETECTION pipeline is correctly skipped on day one (no baseline);
        // the signal sweep needs none and is not.
        expect(patternDetectionMock.detect).not.toHaveBeenCalled();
        expect(childSignalsMock.sweepChild).toHaveBeenCalledTimes(1);
      });
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
    it('reuses the EXISTING notification path — never a duplicate notification system', async () => {
      await service.recordCriticalEvent(childId, familyId, {
        eventType: 'PROTECTION_BYPASS_ATTEMPT',
        title: 'Protection bypass detected',
        body: 'A bypass attempt was detected on the device.',
      });

      // PHASE E (`PD-N-004`): the assertion moved one call outward, from the
      // repository to the gate that reaches it. The property asserted is
      // unchanged — one shared delivery path, no second engine.
      expect(notificationEngineMock.handleEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          childId,
          familyId,
          data: expect.objectContaining({ alertType: 'PROTECTION_BYPASS_ATTEMPT' }),
        }),
      );
    });

    /**
     * PHASE E (`PD-N-004`) — THE DEFECT THIS ROUTE CLOSES, at unit level.
     *
     * The producer passed NO `type`, so every wellbeing alert was written as
     * the generic `RUNTIME_ALERT` and the real event type survived only inside
     * `data.alertType`. Since the quiet-hours matrix keys on type, all five
     * event types were indistinguishable to it — as were the per-type dedup
     * window, the cooldown and the category cap.
     */
    it('sends the REAL event type, not the generic RUNTIME_ALERT the old path stored', async () => {
      await service.recordCriticalEvent(childId, familyId, {
        eventType: 'SCREEN_TIME_EXCEEDED',
        title: 'Screen time limit reached',
        body: 'The daily limit was passed.',
      });

      expect(notificationEngineMock.handleEvent).toHaveBeenCalledWith(
        expect.objectContaining({ childId, familyId, eventType: 'SCREEN_TIME_EXCEEDED', trigger: 'SAFETY_SIGNAL' }),
      );

      // PHASE F (`F6-003`) — AND THE DEVICE'S OWN TEXT NO LONGER REACHES THE
      // PARENT. `title` and `body` above arrive on a DTO posted by a paired
      // device; they were written verbatim into a parent's notification. The
      // producer now passes neither, and the sentence comes from
      // `COPY_CATALOGUE.SCREEN_TIME_EXCEEDED` — written in this repository,
      // naming the child, which the device could not do.
      const sent = notificationEngineMock.handleEvent.mock.calls[0][0];
      expect(sent.title).toBeUndefined();
      expect(sent.body).toBeUndefined();
    });

    it('evaluates at the instant it is given, so a deferral decision is provable without faking the machine clock', async () => {
      const at = new Date('2026-01-15T22:30:00.000Z');

      await service.recordCriticalEvent(
        childId,
        familyId,
        { eventType: 'CHILD_REQUEST', title: 't', body: 'b' },
        at,
      );

      expect(notificationEngineMock.handleEvent).toHaveBeenCalledWith(expect.objectContaining({ now: at }));
    });

    it('writes security-relevant events to the Timeline', async () => {
      await service.recordCriticalEvent(childId, familyId, {
        eventType: 'POLICY_VIOLATION',
        title: 'Policy violation',
        body: 'A blocked app was opened.',
      });

      expect(timelineMock.record).toHaveBeenCalledWith(expect.objectContaining({ category: 'SAFETY', eventType: 'policy_violation' }));
    });

    /**
     * PHASE F (`F6-003`) — THE SAME GUARANTEE, ASSERTED WHERE IT NOW LIVES.
     *
     * These two tests used to read `expect(…).objectContaining({ priority:
     * 'CRITICAL' })` and `{ priority: 'NORMAL' }`, pinning a ternary in the
     * producer: `eventType === 'CHILD_REQUEST' ? 'NORMAL' : 'CRITICAL'`. That
     * ternary was the PRE-PHASE-D IMPLICIT RULE — «CRITICAL bypasses quiet
     * hours» — which `notification-class.ts` was written to replace, and which
     * it has already overridden for all five of this producer's types by name.
     * The producer's string could not change any outcome; it only looked as if
     * it could, which is worse.
     *
     * So the ternary is gone and the assertion is restated against the thing
     * that actually decides: the matrix. That is STRONGER, not weaker — a table
     * entry carries a written justification and `notification-class.spec.ts`
     * fails if the DELIVER list grows, whereas a string on a candidate carried
     * neither. The producer is still asserted to route every one of the five
     * through the engine.
     */
    it('the SAFETY bypass is a property of the matrix, not of a priority string this producer picks', async () => {
      await service.recordCriticalEvent(childId, familyId, {
        eventType: 'ACCESSIBILITY_DISABLED',
        title: 'Protection turned off',
        body: 'Device protection was disabled.',
      });

      expect(notificationEngineMock.handleEvent).toHaveBeenCalledWith(
        expect.objectContaining({ eventType: 'ACCESSIBILITY_DISABLED' }),
      );
      // The alert that says the whole enforcement surface is off bypasses quiet
      // hours — decided by the type, at 02:00 as at 14:00.
      expect(quietHoursClassOf('ACCESSIBILITY_DISABLED')).toBe('DELIVER');
      expect(quietHoursClassOf('PROTECTION_BYPASS_ATTEMPT')).toBe('DELIVER');
    });

    it('a routine ask is DEFERred and not a bypass — CHILD_REQUEST is not a security event', async () => {
      await service.recordCriticalEvent(childId, familyId, {
        eventType: 'CHILD_REQUEST',
        title: 'Child requested more time',
        body: 'Your child asked for extra screen time.',
      });

      expect(notificationEngineMock.handleEvent).toHaveBeenCalledWith(
        expect.objectContaining({ eventType: 'CHILD_REQUEST' }),
      );
      expect(quietHoursClassOf('CHILD_REQUEST')).toBe('DEFER');
      // …and so are the other two the old ternary called CRITICAL. This is the
      // distinction the matrix exists to make and the ternary could not.
      expect(quietHoursClassOf('SCREEN_TIME_EXCEEDED')).toBe('DEFER');
      expect(quietHoursClassOf('POLICY_VIOLATION')).toBe('DEFER');
    });

    it('does NOT write CHILD_REQUEST to the Timeline — an in-the-moment ask, not a behavior-history event', async () => {
      await service.recordCriticalEvent(childId, familyId, {
        eventType: 'CHILD_REQUEST',
        title: 'Extra time requested',
        body: 'Child asked for 15 more minutes.',
      });

      expect(timelineMock.record).not.toHaveBeenCalled();
      expect(notificationEngineMock.handleEvent).toHaveBeenCalled(); // still alerts the parent, just skips Timeline
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
