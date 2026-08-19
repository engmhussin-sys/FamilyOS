import { Test } from '@nestjs/testing';

import { SmartNotificationIntegrationService } from '../../src/modules/life-intelligence/application/services/smart-notification-integration.service';
import { NOTIFICATION_REPOSITORY } from '../../src/modules/notifications/application/ports/notification.repository.port';
import { NOTIFICATION_DELIVERY_REPOSITORY } from '../../src/modules/notifications/application/ports/notification-delivery.repository.port';
import { RUNTIME_ALERT_REPOSITORY } from '../../src/modules/pairing/application/ports/runtime-alert.repository.port';
import { FamilyCommunicationService } from '../../src/modules/life-intelligence/application/services/family-communication.service';
import { PrismaCommunicationRepository } from '../../src/modules/life-intelligence/infrastructure/repositories/prisma-communication.repository';
import type { ISmartNotificationSignals } from '../../src/modules/life-intelligence/application/services/smart-notification-decision-engine';
import { familyDateProvider } from '../common/family-date.testing';

describe('SmartNotificationIntegrationService (Sprint 16.1 Phase 3 — CLOSES A REAL GAP: the pure decision engines had zero real caller before this)', () => {
  const notificationRepoMock = { findRecentForChild: jest.fn() };
  /**
   * THE CHILD'S OWN INBOX — the read `fetchHistory` now makes for a
   * CHILD-audience candidate, and the reason this mock exists at all.
   *
   * Before the fix there was ONE history read for every candidate and it was
   * `findRecentForChild`, i.e. the PARENT's `notifications`. A child's messages
   * are `child_messages` rows and are not in `notifications` in any form, so
   * the caps meant to protect the child were counting the parent's day and the
   * child's own day was never counted at all. Two mocks, because there are two
   * inboxes and the whole defect was that there was one.
   */
  const childMessagesRepoMock = { findRecentNotificationsForChild: jest.fn() };
  const runtimeAlertRepoMock = { createForFamilyOwner: jest.fn() };
  // B9 — the delivery layer now calls `draftAiMessageIfAbsent`, which returns
  // the drafted message or `null` when
  // `child_messages (family_id, source_event_id)` refused it. The mock returns
  // a truthy message by default so «delivered» stays the default in every test
  // that is not about deduplication.
  const familyCommunicationMock = { draftAiMessageIfAbsent: jest.fn() };
  // PHASE D (PC-D-005) — the deferral queue. `DEFER` used to be a string this
  // service returned and nothing more; it now writes a row, so the service has
  // a dependency it did not have and this mock is where a test observes it.
  const deferralRepoMock = { enqueue: jest.fn() };

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
    childMessagesRepoMock.findRecentNotificationsForChild.mockResolvedValue([]);
    // B9 — `true`/a message means «a row was written». `false`/`null` now
    // means «the constraint or the window said this already exists», which the
    // service reports as SUPPRESS/ALREADY_NOTIFIED.
    runtimeAlertRepoMock.createForFamilyOwner.mockResolvedValue(true);
    familyCommunicationMock.draftAiMessageIfAbsent.mockResolvedValue({ id: 'msg-1' });
    // A truthy id means «a deferred row was written by this call»; `null` means
    // `(family_id, source_event_id)` already had one.
    deferralRepoMock.enqueue.mockResolvedValue('deferred-1');

    const moduleRef = await Test.createTestingModule({
      providers: [
        SmartNotificationIntegrationService,
        { provide: NOTIFICATION_REPOSITORY, useValue: notificationRepoMock },
        { provide: NOTIFICATION_DELIVERY_REPOSITORY, useValue: deferralRepoMock },
        { provide: RUNTIME_ALERT_REPOSITORY, useValue: runtimeAlertRepoMock },
        { provide: FamilyCommunicationService, useValue: familyCommunicationMock },
        { provide: PrismaCommunicationRepository, useValue: childMessagesRepoMock },
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
    // AND NEITHER INBOX IS READ. The history read is lazy and per audience:
    // no candidate means no audience, which means no query of either table.
    expect(childMessagesRepoMock.findRecentNotificationsForChild).not.toHaveBeenCalled();
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
      //
      // PHASE E (`PE-N-001`) — AND THE SEVENTH IS ASSERTED, NOT WILDCARDED.
      // `'CHILD_MESSAGE'` is what tells `FamilyCommunicationService` that the
      // third argument is a NOTIFICATION TYPE and not an AI RECOMMENDATION
      // TYPE. Without it the Safety Engine's six-member recommendation
      // whitelist rejected every candidate on this branch, which is how the
      // whole child half of the surface was dead. Asserting the literal here
      // means dropping it is a red test rather than a silent regression to
      // that state.
      expect(familyCommunicationMock.draftAiMessageIfAbsent).toHaveBeenCalledWith(
        childId, familyId, 'HYDRATION_REMINDER', 'Water break?', expect.any(String),
        expect.stringMatching(/^signal:child-1:HYDRATION_REMINDER:w\d+:child$/),
        'CHILD_MESSAGE',
        // PHASE F (`F6-005`) — `skipAiRephrase`, and it is FALSE here.
        //
        // This assertion is the point of adding it to the expected argument
        // list rather than loosening the matcher: the flag exists so that
        // `SmartNotificationEngineService`, which has ALREADY rephrased and
        // ALREADY validated against the child's own age band, does not go
        // through a second rephrase whose only safety gate is the PARENT-facing
        // `SafetyEngineService`. Every producer that predates F6 — including
        // this one — must still get the old two-rephrase behaviour, and `false`
        // is that fact asserted rather than assumed.
        false,
        // PHASE F1 — `data`, the CHILD-READABLE PAYLOAD, and it is `null` here.
        //
        // Asserted as a literal for the same reason `false` above is: this
        // producer reaches `deliverNow` with no `data` at all, so
        // `childSafeNotificationPayload` has no link to forward and the column
        // is left SQL NULL. `null` is a REAL answer — «this row has no
        // destination» — and the child app renders such a row non-tappable. A
        // wildcard here would let a future edit start writing a producer's own
        // payload into a child-readable row without turning a test red.
        null,
      );
      expect(runtimeAlertRepoMock.createForFamilyOwner).not.toHaveBeenCalled();
    });
  });

  describe('SUPPRESS', () => {
    it('a candidate blocked by cooldown is SUPPRESSed with the real reason, and never delivered', async () => {
      jest.useFakeTimers().setSystemTime(new Date('2026-08-10T15:00:00'));
      // TEN MINUTES AGO, IN THE CHILD'S OWN INBOX. `HYDRATION_REMINDER` is a
      // CHILD-audience type, so its 120-minute cooldown is a statement about
      // what THIS CHILD has already been told — and this row is where that is
      // recorded. Seeded here rather than on `findRecentForChild`, which is the
      // parent's inbox and, for this candidate, the wrong table.
      childMessagesRepoMock.findRecentNotificationsForChild.mockResolvedValue([
        { type: 'HYDRATION_REMINDER', createdAt: new Date('2026-08-10T14:50:00') },
      ]);

      const result = await service.processSignals(childId, familyId, hydrationTriggerSignals);

      expect(result).toEqual([{ type: 'HYDRATION_REMINDER', targetAudience: 'CHILD', decision: 'SUPPRESS', reason: 'COOLDOWN' }]);
      expect(familyCommunicationMock.draftAiMessageIfAbsent).not.toHaveBeenCalled();
    });
  });

  /**
   * THE AUDIENCE'S OWN INBOX — the defect, in the smallest terms that can hold
   * it.
   *
   * `fetchHistory` read `notifications` for EVERY candidate, so a CHILD's
   * message was counted, capped and cooled down against THE PARENT'S DAY.
   * `notification-class.ts` forbids it on `REWARD_GRANTED_CHILD`'s own `why`:
   * «a parent at their daily maximum must not be able to silence the child's
   * own news about their own work». These four cases are that sentence as
   * assertions, and each one FAILS against the pre-fix code:
   *
   *   1  the parent's stream does not silence the child
   *   2  the child's own stream still does
   *   3  the parent's own cap is untouched
   *   4  each audience is asked for its own table, and only its own
   */
  describe('THE AUDIENCE OWNS ITS OWN HISTORY — a parent at their cap cannot silence the child', () => {
    /**
     * SIX NOTIFICATIONS EARLIER TODAY — `dailyMax` is 6, so this recipient is
     * exactly at their daily maximum.
     *
     * Deliberately spread across the afternoon and all more than five minutes
     * before the instant under test, so the guard reaches the CAP rather than
     * short-circuiting on `DUPLICATE`: this block is about WHOSE day is being
     * counted, and a duplicate refusal would answer a different question.
     */
    const sixToday = [
      { type: 'REWARD_GRANTED', priority: 'NORMAL' as const, createdAt: new Date('2026-08-10T09:00:00') },
      { type: 'REWARD_GRANTED', priority: 'NORMAL' as const, createdAt: new Date('2026-08-10T10:00:00') },
      { type: 'BADGE_EARNED', priority: 'NORMAL' as const, createdAt: new Date('2026-08-10T11:00:00') },
      { type: 'BADGE_EARNED', priority: 'NORMAL' as const, createdAt: new Date('2026-08-10T12:00:00') },
      { type: 'LEVEL_UP', priority: 'NORMAL' as const, createdAt: new Date('2026-08-10T13:00:00') },
      { type: 'LEVEL_UP', priority: 'NORMAL' as const, createdAt: new Date('2026-08-10T14:00:00') },
    ];

    it('THE DEFECT: a parent at their daily maximum does NOT silence the child', async () => {
      jest.useFakeTimers().setSystemTime(new Date('2026-08-10T15:00:00'));
      notificationRepoMock.findRecentForChild.mockResolvedValue(sixToday);
      // The child has been told nothing today.
      childMessagesRepoMock.findRecentNotificationsForChild.mockResolvedValue([]);

      const result = await service.processSignals(childId, familyId, hydrationTriggerSignals);

      // Pre-fix this was `SUPPRESS` / `DAILY_MAX`: six rows in the PARENT's
      // inbox, counted against a message addressed to the CHILD.
      expect(result).toEqual([
        { type: 'HYDRATION_REMINDER', targetAudience: 'CHILD', decision: 'SEND' },
      ]);
      expect(familyCommunicationMock.draftAiMessageIfAbsent).toHaveBeenCalledTimes(1);
    });

    it('AND THE CHILD IS STILL CAPPED — by the child\'s own inbox', async () => {
      jest.useFakeTimers().setSystemTime(new Date('2026-08-10T15:00:00'));
      // The parent has had nothing at all...
      notificationRepoMock.findRecentForChild.mockResolvedValue([]);
      // ...and the CHILD is at `dailyMax`. The fix is not «the child is
      // exempt», it is «the child is measured».
      childMessagesRepoMock.findRecentNotificationsForChild.mockResolvedValue(
        sixToday.map((n) => ({ type: n.type, createdAt: n.createdAt })),
      );

      const result = await service.processSignals(childId, familyId, hydrationTriggerSignals);

      expect(result).toEqual([
        {
          type: 'HYDRATION_REMINDER',
          targetAudience: 'CHILD',
          decision: 'SUPPRESS',
          reason: 'DAILY_MAX',
        },
      ]);
      expect(familyCommunicationMock.draftAiMessageIfAbsent).not.toHaveBeenCalled();
    });

    it('THE PARENT BRANCH IS UNCHANGED — a parent at their cap is still capped', async () => {
      jest.useFakeTimers().setSystemTime(new Date('2026-08-10T15:00:00'));
      notificationRepoMock.findRecentForChild.mockResolvedValue(sixToday);
      childMessagesRepoMock.findRecentNotificationsForChild.mockResolvedValue([]);

      const outcome = await service.notifyEvent(childId, familyId, {
        type: 'BADGE_EARNED',
        priority: 'NORMAL',
        title: 't',
        body: 'b',
        targetAudience: 'PARENT',
        sourceEventId: 'badge:child-1:badge-9',
      });

      // No cap constant moved: `dailyMax = 6` still means what it meant when it
      // was calibrated, on the stream it was calibrated against.
      expect(outcome).toEqual({
        type: 'BADGE_EARNED',
        targetAudience: 'PARENT',
        decision: 'SUPPRESS',
        reason: 'DAILY_MAX',
      });
      expect(runtimeAlertRepoMock.createForFamilyOwner).not.toHaveBeenCalled();
    });

    it('EACH AUDIENCE IS ASKED FOR ITS OWN TABLE, AND ONLY ITS OWN', async () => {
      jest.useFakeTimers().setSystemTime(new Date('2026-08-10T15:00:00'));

      // A CHILD candidate reads the child's inbox and does not touch the
      // parent's — the read is lazy per audience, so a single-audience batch
      // still costs exactly one query, as it did before the fix.
      await service.processSignals(childId, familyId, hydrationTriggerSignals);
      expect(childMessagesRepoMock.findRecentNotificationsForChild).toHaveBeenCalledTimes(1);
      expect(notificationRepoMock.findRecentForChild).not.toHaveBeenCalled();

      jest.clearAllMocks();
      notificationRepoMock.findRecentForChild.mockResolvedValue([]);
      childMessagesRepoMock.findRecentNotificationsForChild.mockResolvedValue([]);
      familyCommunicationMock.draftAiMessageIfAbsent.mockResolvedValue({ id: 'msg-1' });
      runtimeAlertRepoMock.createForFamilyOwner.mockResolvedValue(true);

      // And a PARENT candidate the other way round.
      await service.notifyEvent(childId, familyId, {
        type: 'BADGE_EARNED',
        priority: 'NORMAL',
        title: 't',
        body: 'b',
        targetAudience: 'PARENT',
        sourceEventId: 'badge:child-1:badge-10',
      });
      expect(notificationRepoMock.findRecentForChild).toHaveBeenCalledTimes(1);
      expect(childMessagesRepoMock.findRecentNotificationsForChild).not.toHaveBeenCalled();
    });
  });

  /**
   * PHASE D (`PC-D-005`) — WHAT THIS BLOCK USED TO ASSERT, AND WHY IT CHANGED.
   *
   * It asserted that a `HYDRATION_REMINDER` inside quiet hours came back
   * `decision: 'DEFER'`. That assertion was TRUE and the behaviour behind it was
   * the defect: `DEFER` was a string this service returned, with no row, no
   * queue and no redelivery underneath it. The test passed for the entire life
   * of the bug.
   *
   * Phase D makes «what happens at 23:00» a per-type decision
   * (`shared/notifications/notification-class.ts`), so the block now asserts BOTH
   * halves of that decision rather than one:
   *
   *   HYDRATION_REMINDER is SUPPRESS — its premise («you have been on your
   *   device 90 minutes and are behind on water») is false by 07:00, so
   *   deferring it would deliver a lie. Dropped, WITH A REASON.
   *   REWARD_GRANTED is DEFER — and now really is: a row is written with a
   *   scheduled delivery instant, which is the assertion that was impossible
   *   to make before.
   */
  describe('PHASE D — the three quiet-hours behaviours, at the one gate', () => {
    it('SUPPRESS class: a reminder whose premise expires overnight is dropped WITH A RECORDED REASON, and never enqueued', async () => {
      jest.useFakeTimers().setSystemTime(new Date('2026-08-10T23:00:00')); // within default 21:00-07:00 quiet hours

      const result = await service.processSignals(childId, familyId, hydrationTriggerSignals);

      expect(result).toEqual([
        {
          type: 'HYDRATION_REMINDER',
          targetAudience: 'CHILD',
          decision: 'SUPPRESS',
          reason: 'QUIET_HOURS_EXPIRES_OVERNIGHT',
        },
      ]);
      expect(familyCommunicationMock.draftAiMessageIfAbsent).not.toHaveBeenCalled();
      // The point of the class: it is NOT held, so it cannot arrive stale.
      expect(deferralRepoMock.enqueue).not.toHaveBeenCalled();
    });

    it('DEFER class: a reward blocked ONLY by quiet hours is ENQUEUED with a scheduled instant — not merely labelled', async () => {
      jest.useFakeTimers().setSystemTime(new Date('2026-08-10T23:00:00'));

      const result = await service.notifyEvent(childId, familyId, {
        type: 'REWARD_GRANTED',
        priority: 'NORMAL',
        title: 'مكافأة جديدة',
        body: 'حصل طفلك على مكافأة جديدة اليوم.',
        targetAudience: 'PARENT',
        sourceEventId: 'evt:phase-d-defer-1',
      });

      expect(result).toEqual({
        type: 'REWARD_GRANTED',
        targetAudience: 'PARENT',
        decision: 'DEFER',
        reason: 'QUIET_HOURS',
      });
      expect(runtimeAlertRepoMock.createForFamilyOwner).not.toHaveBeenCalled();

      // THE ASSERTION THAT COULD NOT BE WRITTEN BEFORE PHASE D.
      expect(deferralRepoMock.enqueue).toHaveBeenCalledTimes(1);
      const enqueued = deferralRepoMock.enqueue.mock.calls[0][0];
      expect(enqueued.sourceEventId).toBe('evt:phase-d-defer-1'); // carried UNCHANGED
      expect(enqueued.deferReason).toBe('QUIET_HOURS');
      expect(enqueued.category).toBe('REWARD');
      expect(enqueued.scheduledFor).toBeInstanceOf(Date);
      expect(enqueued.scheduledFor.getTime()).toBeGreaterThan(Date.now());
    });

    it('DELIVER class: a safety-critical type goes out DURING quiet hours rather than being held', async () => {
      jest.useFakeTimers().setSystemTime(new Date('2026-08-10T23:00:00'));

      const result = await service.notifyEvent(childId, familyId, {
        type: 'ACCESSIBILITY_DISABLED',
        // NORMAL on purpose: the bypass must come from the TYPE's
        // classification, not from the old implicit `priority === 'CRITICAL'`
        // rule, or the matrix would be decorative.
        priority: 'NORMAL',
        title: 'Protection turned off',
        body: 'Device protection was disabled.',
        targetAudience: 'PARENT',
        sourceEventId: 'runtime:phase-d-deliver-1',
      });

      expect(result.decision).toBe('SEND');
      expect(runtimeAlertRepoMock.createForFamilyOwner).toHaveBeenCalledTimes(1);
      expect(deferralRepoMock.enqueue).not.toHaveBeenCalled();
    });

    it('a redelivered cause finds its own deferred row already waiting and reports ALREADY_DEFERRED, not a second enqueue', async () => {
      jest.useFakeTimers().setSystemTime(new Date('2026-08-10T23:00:00'));
      // `null` is what `ON CONFLICT (family_id, source_event_id) DO NOTHING`
      // returns — the row exists, this call wrote nothing.
      deferralRepoMock.enqueue.mockResolvedValue(null);

      const result = await service.notifyEvent(childId, familyId, {
        type: 'REWARD_GRANTED',
        priority: 'NORMAL',
        title: 'مكافأة جديدة',
        body: 'حصل طفلك على مكافأة جديدة اليوم.',
        targetAudience: 'PARENT',
        sourceEventId: 'evt:phase-d-defer-1',
      });

      expect(result).toEqual({
        type: 'REWARD_GRANTED',
        targetAudience: 'PARENT',
        decision: 'DEFER',
        reason: 'ALREADY_DEFERRED',
      });
    });

    it('an enqueue failure degrades to a REPORTED suppression rather than throwing at the reward path that caused it', async () => {
      jest.useFakeTimers().setSystemTime(new Date('2026-08-10T23:00:00'));
      deferralRepoMock.enqueue.mockRejectedValue(new Error('connection reset'));

      const result = await service.notifyEvent(childId, familyId, {
        type: 'REWARD_GRANTED',
        priority: 'NORMAL',
        title: 'مكافأة جديدة',
        body: 'حصل طفلك على مكافأة جديدة اليوم.',
        targetAudience: 'PARENT',
        sourceEventId: 'evt:phase-d-defer-2',
      });

      expect(result.decision).toBe('SUPPRESS');
      expect(result.reason).toBe('DEFER_ENQUEUE_FAILED');
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
        // PHASE E (`PE-N-001`) — see the hydration case above.
        'CHILD_MESSAGE',
        // PHASE F (`F6-005`) — `skipAiRephrase`, and it is FALSE here.
        //
        // This assertion is the point of adding it to the expected argument
        // list rather than loosening the matcher: the flag exists so that
        // `SmartNotificationEngineService`, which has ALREADY rephrased and
        // ALREADY validated against the child's own age band, does not go
        // through a second rephrase whose only safety gate is the PARENT-facing
        // `SafetyEngineService`. Every producer that predates F6 — including
        // this one — must still get the old two-rephrase behaviour, and `false`
        // is that fact asserted rather than assumed.
        false,
        // PHASE F1 — `data`, the CHILD-READABLE PAYLOAD, and it is `null` here.
        //
        // Asserted as a literal for the same reason `false` above is: this
        // producer reaches `deliverNow` with no `data` at all, so
        // `childSafeNotificationPayload` has no link to forward and the column
        // is left SQL NULL. `null` is a REAL answer — «this row has no
        // destination» — and the child app renders such a row non-tappable. A
        // wildcard here would let a future edit start writing a producer's own
        // payload into a child-readable row without turning a test red.
        null,
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
        // PHASE E (`PE-N-001`) — see the hydration case above.
        'CHILD_MESSAGE',
        // PHASE F (`F6-005`) — `skipAiRephrase`, and it is FALSE here.
        //
        // This assertion is the point of adding it to the expected argument
        // list rather than loosening the matcher: the flag exists so that
        // `SmartNotificationEngineService`, which has ALREADY rephrased and
        // ALREADY validated against the child's own age band, does not go
        // through a second rephrase whose only safety gate is the PARENT-facing
        // `SafetyEngineService`. Every producer that predates F6 — including
        // this one — must still get the old two-rephrase behaviour, and `false`
        // is that fact asserted rather than assumed.
        false,
        // PHASE F1 — `data`, the CHILD-READABLE PAYLOAD, and it is `null` here.
        //
        // Asserted as a literal for the same reason `false` above is: this
        // producer reaches `deliverNow` with no `data` at all, so
        // `childSafeNotificationPayload` has no link to forward and the column
        // is left SQL NULL. `null` is a REAL answer — «this row has no
        // destination» — and the child app renders such a row non-tappable. A
        // wildcard here would let a future edit start writing a producer's own
        // payload into a child-readable row without turning a test red.
        null,
      );
    });

    /**
     * ========================================================================
     * PHASE F1 — THE SEAM WHERE A CHILD-READABLE ROW COULD HAVE LEARNED A
     * TENANT IDENTIFIER, AND THE ASSERTION THAT SAYS IT CANNOT.
     * ========================================================================
     *
     * The PARENT branch writes `candidate.data` VERBATIM to
     * `notifications.data` — correct there, and pinned identifier-free by
     * `e2e-13 STEP 14` against the payloads the producers actually send. The
     * CHILD branch may NOT do the same thing, because `child_messages` is
     * served to a CHILD DEVICE by `GET /life-intelligence/self/messages` and
     * `candidate.data` is an OPEN-ENDED producer object:
     * `DigitalWellbeingEngineService` spreads a DEVICE-SUPPLIED `metadata` map
     * into it, and `NotificationRewardConsumer` puts the goal's own title and
     * the points on it.
     *
     * So the fixture below is deliberately hostile — every identifier this
     * product has, a device-chosen destination, and the producer's own detail —
     * and the assertion is EXACT rather than `objectContaining`: the ninth
     * argument is `{ deepLink }` and NOTHING ELSE. A whitelist is what makes
     * this a property of ONE FUNCTION instead of a promise made by every
     * producer that will ever write to `data`.
     */
    it('the CHILD branch narrows the payload to the destination alone — no identifier, no producer detail, no device-chosen screen', async () => {
      jest.useFakeTimers().setSystemTime(new Date('2026-08-10T15:00:00'));

      await service.notifyEvent(childId, familyId, {
        type: 'STREAK_ACHIEVED',
        priority: 'NORMAL',
        title: '7-day streak!',
        body: 'Amazing consistency!',
        targetAudience: 'CHILD',
        sourceEventId: 'evt:22222222-2222-4222-8222-222222222222',
        data: {
          // THE SERVER'S OWN ANSWER. `SmartNotificationEngineService` spreads
          // it on LAST, which is what makes it the one that survives.
          deepLink: 'abny://progress',
          // EVERYTHING A CHILD-READABLE ROW MUST NEVER CARRY.
          familyId,
          childId,
          deviceId: 'device-9',
          userId: 'user-9',
          token: 'a-token',
          // AND THE PRODUCER'S OWN DETAIL, which `e2e-13` asserts the child is
          // deliberately NOT told: «the parent gained the detail and the CHILD
          // did not» is an assertion about the SENTENCE, and a verbatim `data`
          // copy would have handed it over anyway, one field at a time.
          goalTitle: 'سورة الملك',
          points: 20,
          metadata: { packageName: 'com.example.game', deviceId: 'device-9' },
        },
      });

      const args = familyCommunicationMock.draftAiMessageIfAbsent.mock.calls[0];
      expect(args[8]).toEqual({ deepLink: 'abny://progress' });
      expect(Object.keys(args[8] as Record<string, unknown>)).toEqual(['deepLink']);
      // Said again over the SERIALISED payload, because that is the form the
      // row is stored in and the form the child's device receives.
      const serialised = JSON.stringify(args[8]);
      for (const secret of [familyId, childId, 'device-9', 'user-9', 'a-token', 'سورة الملك']) {
        expect(serialised).not.toContain(secret);
      }
    });

    /**
     * THE LINK IS RE-VALIDATED AT THE GATE rather than trusted from the layer
     * above. `resolveNotificationDestination` already guarantees a canonical
     * `abny://` string, so nothing should ever arrive here malformed — but a
     * PRODUCER'S payload reaches this same object, and «the caller already
     * checked» is how a gate stops being one. A link this server would not have
     * written is DROPPED rather than escaped, and the row keeps no destination
     * at all: the child app renders it non-tappable, and a card that is not
     * tappable beats a tap that opens the wrong screen.
     */
    it('a destination this server would not have written is dropped, and the row keeps none', async () => {
      jest.useFakeTimers().setSystemTime(new Date('2026-08-10T15:00:00'));

      await service.notifyEvent(childId, familyId, {
        type: 'STREAK_ACHIEVED',
        priority: 'NORMAL',
        title: '7-day streak!',
        body: 'Amazing consistency!',
        targetAudience: 'CHILD',
        sourceEventId: 'evt:33333333-3333-4333-8333-333333333333',
        data: { deepLink: 'https://evil.example/reset-password' },
      });

      expect(familyCommunicationMock.draftAiMessageIfAbsent.mock.calls[0][8]).toBeNull();
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
