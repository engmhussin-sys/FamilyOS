import { Test } from '@nestjs/testing';
import { BadRequestException, NotFoundException } from '@nestjs/common';

import { FamilyCommunicationService } from '../../src/modules/life-intelligence/application/services/family-communication.service';
import { PrismaCommunicationRepository } from '../../src/modules/life-intelligence/infrastructure/repositories/prisma-communication.repository';
import { ChildrenService } from '../../src/modules/children/application/services/children.service';
import { PairingOrchestratorService } from '../../src/modules/pairing/application/services/pairing-orchestrator.service';
import { SafetyEngineService } from '../../src/modules/ai-core/application/services/safety-engine.service';
import { ChildSafetyFilterService } from '../../src/modules/ai-core/application/services/child-safety-filter.service';
import { AI_PROVIDER } from '../../src/modules/ai-core/domain/ai-provider.port';
import { FamilyDateService } from '../../src/common/time/family-date.service';

/**
 * `PG-001` — A DATE OF BIRTH, BECAUSE THE CHILD SAFETY BAND IS A FUNCTION OF ONE.
 *
 * Expressed relative to the run rather than as a literal year, so this file does
 * not drift into a different age band every January. Twelve puts the child in
 * band `12-14` (15 words / 150 chars) — the band the product's copy is written
 * for, and wide enough that every pre-existing fixture below keeps asserting the
 * thing it was written to assert rather than being reworded to fit a new gate.
 */
const TWELVE_YEARS_AGO = new Date(Date.now() - 12 * 365.25 * 24 * 60 * 60 * 1000)
  .toISOString()
  .slice(0, 10);

describe('FamilyCommunicationService', () => {
  // B9 — `draftAiMessage` now delegates to `draftAiMessageIfAbsent`, which
  // calls `createIfAbsent` so a duplicate refused by
  // `child_messages (family_id, source_event_id)` is reported rather than
  // thrown. The real repository implements it by delegating to `create`, so
  // the mock does the same and every existing assertion on `create` below
  // keeps asserting the real thing.
  const repositoryMock = { create: jest.fn(), createIfAbsent: jest.fn(), findById: jest.fn(), approveAndDeliver: jest.fn(), reject: jest.fn(), listDeliveredForChild: jest.fn(), acknowledge: jest.fn(), listPendingForFamily: jest.fn() };
  // `PG-001` — `getChildOrThrow`, because the CHILD safety band is derived from
  // the row this service now reads instead of discarding. It is the SAME query
  // `assertChildBelongsToFamily` always made; both are kept because both are
  // still called (`approve`, `reject`, `sendParentMessage` need only ownership).
  const childrenServiceMock = { assertChildBelongsToFamily: jest.fn(), getChildOrThrow: jest.fn() };
  const pairingOrchestratorMock = { getChildIdForDevice: jest.fn() };
  const safetyEngineMock = { validate: jest.fn() };
  const aiProviderMock = { complete: jest.fn() };
  const familyDateMock = { timeZoneOf: jest.fn() };

  let service: FamilyCommunicationService;
  const childId = 'child-1';
  const familyId = 'family-1';

  beforeEach(async () => {
    jest.clearAllMocks();
    safetyEngineMock.validate.mockReturnValue({ isSafe: true, rejectionReason: null });
    childrenServiceMock.getChildOrThrow.mockResolvedValue({
      id: childId,
      familyId,
      firstName: 'محمد',
      dateOfBirth: TWELVE_YEARS_AGO,
    });
    familyDateMock.timeZoneOf.mockResolvedValue('Africa/Cairo');
    // B9 — mirror the real `PrismaCommunicationRepository.createIfAbsent`,
    // which is a thin P2002-catching wrapper around `create`. Wiring it this
    // way keeps every existing `expect(repositoryMock.create)` assertion in
    // this file asserting the SAME call it always did, rather than being
    // rewritten to point at a new method and quietly losing its meaning.
    repositoryMock.createIfAbsent.mockImplementation((...args: unknown[]) =>
      (repositoryMock.create as jest.Mock)(...args),
    );
    const moduleRef = await Test.createTestingModule({
      providers: [
        FamilyCommunicationService,
        { provide: PrismaCommunicationRepository, useValue: repositoryMock },
        { provide: ChildrenService, useValue: childrenServiceMock },
        { provide: PairingOrchestratorService, useValue: pairingOrchestratorMock },
        { provide: SafetyEngineService, useValue: safetyEngineMock },
        { provide: AI_PROVIDER, useValue: aiProviderMock },
        // `PG-001` — THE REAL CHILD FILTER, IN EVERY BLOCK INCLUDING THE MOCKED
        // ONES. Mocking `SafetyEngineService` to «always safe» is exactly how
        // `PE-N-001` survived four audit phases; a mocked CHILD filter would be
        // the same mistake with higher stakes, since this is the filter that
        // knows about shaming. It is a pure function with no dependencies, so
        // there is nothing to gain by faking it.
        ChildSafetyFilterService,
        { provide: FamilyDateService, useValue: familyDateMock },
      ],
    }).compile();
    service = moduleRef.get(FamilyCommunicationService);
  });

  describe('sendParentMessage', () => {
    it('is delivered immediately with NOT_REQUIRED approval status — no gate for a parent\u2019s own words, and no AI/Safety involvement at all', async () => {
      repositoryMock.create.mockResolvedValue({ id: 'm1' });
      await service.sendParentMessage(childId, familyId, 'user1', 'encouragement', 'Great job!', 'Keep it up!');
      expect(repositoryMock.create).toHaveBeenCalledWith(
        expect.objectContaining({ authorType: 'PARENT' }),
        'NOT_REQUIRED',
        expect.any(Date),
      );
      expect(safetyEngineMock.validate).not.toHaveBeenCalled();
      expect(aiProviderMock.complete).not.toHaveBeenCalled();
    });
  });

  describe('draftAiMessage — Sprint 28 real AI Provider wiring', () => {
    it('rejects the deterministic seed outright if it fails Safety BEFORE ever calling the AI Provider', async () => {
      safetyEngineMock.validate.mockReturnValue({ isSafe: false, rejectionReason: 'contains unsafe content' });

      await expect(
        service.draftAiMessage(childId, familyId, 'encouragement', 'bad title', 'bad body'),
      ).rejects.toThrow(BadRequestException);

      expect(aiProviderMock.complete).not.toHaveBeenCalled();
      expect(repositoryMock.create).not.toHaveBeenCalled();
    });

    it('uses the AI-rephrased body when the provider succeeds and the result passes Safety again', async () => {
      aiProviderMock.complete.mockResolvedValue('A warmer version of the message!');
      repositoryMock.create.mockResolvedValue({ id: 'm2' });

      await service.draftAiMessage(childId, familyId, 'encouragement', 'Good job', 'You did well today');

      expect(repositoryMock.create).toHaveBeenCalledWith(
        expect.objectContaining({ authorType: 'AI', title: 'Good job', body: 'A warmer version of the message!' }),
        'PENDING',
        null,
      );
    });

    it('is created PENDING with a null delivery date — THE core requirement this engine exists to enforce', async () => {
      aiProviderMock.complete.mockResolvedValue('rephrased');
      repositoryMock.create.mockResolvedValue({ id: 'm3' });

      await service.draftAiMessage(childId, familyId, 'encouragement', 'title', 'body');

      expect(repositoryMock.create).toHaveBeenCalledWith(expect.anything(), 'PENDING', null);
    });

    it('falls back to the deterministic seed when the AI Provider throws — never fails the draft outright just because phrasing was unavailable', async () => {
      aiProviderMock.complete.mockRejectedValue(new Error('provider unavailable'));
      repositoryMock.create.mockResolvedValue({ id: 'm4' });

      await service.draftAiMessage(childId, familyId, 'encouragement', 'Good job', 'You did well today');

      expect(repositoryMock.create).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'Good job', body: 'You did well today' }),
        'PENDING',
        null,
      );
    });

    it('falls back to the deterministic seed when the AI response is implausibly long (more than 3x the seed body)', async () => {
      aiProviderMock.complete.mockResolvedValue('x'.repeat(1000));
      repositoryMock.create.mockResolvedValue({ id: 'm5' });

      await service.draftAiMessage(childId, familyId, 'encouragement', 'Good job', 'short');

      expect(repositoryMock.create).toHaveBeenCalledWith(
        expect.objectContaining({ body: 'short' }),
        'PENDING',
        null,
      );
    });

    it('falls back to the deterministic seed when the AI response is empty/whitespace-only', async () => {
      aiProviderMock.complete.mockResolvedValue('   ');
      repositoryMock.create.mockResolvedValue({ id: 'm6' });

      await service.draftAiMessage(childId, familyId, 'encouragement', 'Good job', 'You did well');

      expect(repositoryMock.create).toHaveBeenCalledWith(
        expect.objectContaining({ body: 'You did well' }),
        'PENDING',
        null,
      );
    });

    it('re-validates the AI-REPHRASED text with Safety, not just the deterministic seed — the deliberate strengthening beyond the ai-core reference pattern', async () => {
      aiProviderMock.complete.mockResolvedValue('a rephrased version');
      safetyEngineMock.validate
        .mockReturnValueOnce({ isSafe: true, rejectionReason: null })
        .mockReturnValueOnce({ isSafe: false, rejectionReason: 'rephrasing introduced something unsafe' });
      repositoryMock.create.mockResolvedValue({ id: 'm7' });

      await service.draftAiMessage(childId, familyId, 'encouragement', 'Good job', 'You did well');

      expect(safetyEngineMock.validate).toHaveBeenCalledTimes(2);
      expect(repositoryMock.create).toHaveBeenCalledWith(
        expect.objectContaining({ body: 'You did well' }),
        'PENDING',
        null,
      );
    });

    it('verifies ownership before touching Safety or the AI Provider at all', async () => {
      // `PG-001` — the ownership read is now `getChildOrThrow`, the same query
      // under its other name; it still happens FIRST and still refuses first.
      childrenServiceMock.getChildOrThrow.mockRejectedValueOnce(new Error('not found'));

      await expect(
        service.draftAiMessage(childId, familyId, 'encouragement', 'title', 'body'),
      ).rejects.toThrow('not found');

      expect(safetyEngineMock.validate).not.toHaveBeenCalled();
      expect(aiProviderMock.complete).not.toHaveBeenCalled();
    });
  });

  describe('approve', () => {
    it('rejects approving a message that is not AI-authored and PENDING', async () => {
      repositoryMock.findById.mockResolvedValue({ id: 'm1', childId, authorType: 'PARENT', approvalStatus: 'NOT_REQUIRED' });
      await expect(service.approve('m1', childId, familyId)).rejects.toThrow(NotFoundException);
      expect(repositoryMock.approveAndDeliver).not.toHaveBeenCalled();
    });

    it('approves a genuinely PENDING AI message', async () => {
      repositoryMock.findById.mockResolvedValue({ id: 'm1', childId, authorType: 'AI', approvalStatus: 'PENDING' });
      await service.approve('m1', childId, familyId);
      expect(repositoryMock.approveAndDeliver).toHaveBeenCalledWith('m1');
    });

    it('throws NotFoundException for a message belonging to a different child (IDOR protection)', async () => {
      repositoryMock.findById.mockResolvedValue({ id: 'm1', childId: 'other-child', authorType: 'AI', approvalStatus: 'PENDING' });
      await expect(service.approve('m1', childId, familyId)).rejects.toThrow(NotFoundException);
    });
  });

  describe('getChildInbox', () => {
    it('SECURITY REGRESSION TEST: throws when the device requests a childId that is NOT its own paired child', async () => {
      pairingOrchestratorMock.getChildIdForDevice.mockResolvedValue('the-devices-real-child');
      await expect(service.getChildInbox('device-1', 'a-different-child')).rejects.toThrow();
      expect(repositoryMock.listDeliveredForChild).not.toHaveBeenCalled();
    });

    it('returns the inbox when the requested childId matches the device\u2019s real paired child', async () => {
      pairingOrchestratorMock.getChildIdForDevice.mockResolvedValue(childId);
      repositoryMock.listDeliveredForChild.mockResolvedValue([]);
      await service.getChildInbox('device-1', childId);
      expect(repositoryMock.listDeliveredForChild).toHaveBeenCalledWith(childId);
    });
  });

  describe('getPendingMessages (CRITICAL FIX: closes the gap that made every child-targeted Smart Notification structurally unreachable — approve()/reject() existed but nothing surfaced what needed approving)', () => {
    it('returns whatever the repository reports, scoped by the CALLING family (never a caller-suppliable childId)', async () => {
      const pending = [{ id: 'm1', childId: 'c1', childName: 'Alice', title: 't', body: 'b', category: 'HABIT_COMPLETED', approvalStatus: 'PENDING' }];
      repositoryMock.listPendingForFamily.mockResolvedValue(pending);

      const result = await service.getPendingMessages(familyId);

      expect(repositoryMock.listPendingForFamily).toHaveBeenCalledWith(familyId);
      expect(result).toEqual(pending);
    });

    it('BOUNDARY CASE: an empty result (nothing pending) is returned as an empty array, never an error', async () => {
      repositoryMock.listPendingForFamily.mockResolvedValue([]);
      const result = await service.getPendingMessages(familyId);
      expect(result).toEqual([]);
    });
  });

  describe('acknowledgeMessage (FIXES A REAL IDOR VULNERABILITY: this method previously had ZERO ownership check — any device could mark any child\u2019s message, across any family, as read)', () => {
    it('SECURITY REGRESSION TEST: throws when the message belongs to a DIFFERENT child than the caller', async () => {
      repositoryMock.findById.mockResolvedValue({ id: 'm1', childId: 'a-different-child', approvalStatus: 'APPROVED' });

      await expect(service.acknowledgeMessage('m1', childId)).rejects.toThrow(NotFoundException);
      expect(repositoryMock.acknowledge).not.toHaveBeenCalled();
    });

    it('SECURITY REGRESSION TEST: throws (not silently no-ops) when the message does not exist at all', async () => {
      repositoryMock.findById.mockResolvedValue(null);

      await expect(service.acknowledgeMessage('nonexistent', childId)).rejects.toThrow(NotFoundException);
      expect(repositoryMock.acknowledge).not.toHaveBeenCalled();
    });

    it('succeeds when the message genuinely belongs to the calling child', async () => {
      repositoryMock.findById.mockResolvedValue({ id: 'm1', childId, approvalStatus: 'APPROVED' });

      await service.acknowledgeMessage('m1', childId);

      expect(repositoryMock.acknowledge).toHaveBeenCalledWith('m1');
    });
  });

  /**
   * PHASE E (`PE-N-001`) — AGAINST THE **REAL** SAFETY ENGINE.
   *
   * Every test above mocks `SafetyEngineService`, and that is exactly why this
   * defect survived four audit phases: the mock said `isSafe: true` for any
   * argument, so no test in this file ever exercised the whitelist the real
   * engine applies. The real one refuses any `recommendationType` outside a
   * six-member list of PARENT-facing AI recommendation types — a vocabulary
   * that shares not one member with the notification types the child half of
   * the notification surface passes in.
   *
   * Result, measured: every CHILD-audience notification ever produced
   * (`BADGE_EARNED`, `LEVEL_UP`, `HYDRATION_REMINDER`, `STUDY_REMINDER`,
   * `EXERCISE_ENCOURAGEMENT`) was rejected with «Unknown recommendation type»
   * and reported by `SmartNotificationIntegrationService` as
   * `SUPPRESS / DELIVERY_ERROR`. So this block wires the real engine.
   */
  describe('PHASE E (`PE-N-001`) — the SafetyEngine vocabulary, unmocked', () => {
    let real: FamilyCommunicationService;

    beforeEach(async () => {
      const moduleRef = await Test.createTestingModule({
        providers: [
          FamilyCommunicationService,
          { provide: PrismaCommunicationRepository, useValue: repositoryMock },
          { provide: ChildrenService, useValue: childrenServiceMock },
          { provide: PairingOrchestratorService, useValue: pairingOrchestratorMock },
          SafetyEngineService, // THE REAL ONE.
          { provide: AI_PROVIDER, useValue: aiProviderMock },
          ChildSafetyFilterService, // AND THE REAL CHILD ONE (`PG-001`).
          { provide: FamilyDateService, useValue: familyDateMock },
        ],
      }).compile();
      real = moduleRef.get(FamilyCommunicationService);
      aiProviderMock.complete.mockRejectedValue(new Error('no provider in this test'));
      repositoryMock.create.mockImplementation((data: any) => ({ id: 'm-real', ...data }));
    });

    it('a notification type reaches the child instead of dying on a recommendation whitelist', async () => {
      await expect(
        real.draftAiMessageIfAbsent(
          childId,
          familyId,
          'BADGE_EARNED',
          'You earned a badge!',
          'You earned the "Reader" badge — awesome work!',
          'evt:pe-n-001:child',
          'CHILD_MESSAGE',
        ),
      ).resolves.not.toBeNull();

      expect(repositoryMock.create).toHaveBeenCalledWith(
        expect.objectContaining({ category: 'BADGE_EARNED', authorType: 'AI' }),
        'PENDING',
        null,
      );
    });

    it('and the unsafe-pattern scan — the half that actually protects a child — still refuses covert-monitoring text', async () => {
      await expect(
        real.draftAiMessageIfAbsent(
          childId,
          familyId,
          'BADGE_EARNED',
          'A tip',
          'You can spy on their messages without them knowing.',
          'evt:pe-n-001:unsafe',
          'CHILD_MESSAGE',
        ),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(repositoryMock.create).not.toHaveBeenCalled();
    });

    it('the PARENT-authored draft route keeps its whitelist — the narrowing is scoped to the notification path', async () => {
      // Default vocabulary is AI_RECOMMENDATION, so an arbitrary category from
      // a parent request body is still refused. This is the control that keeps
      // the fix from being «delete the check».
      await expect(
        real.draftAiMessage(childId, familyId, 'ARBITRARY_CATEGORY', 'title', 'body'),
      ).rejects.toBeInstanceOf(BadRequestException);

      // ...and a genuine recommendation type still passes.
      await expect(
        real.draftAiMessage(childId, familyId, 'SET_SCREEN_TIME_POLICY', 'title', 'body'),
      ).resolves.toBeDefined();
    });

    it('the AI rephrasing re-check no longer rejects every rephrasing it is given', async () => {
      // Before the fix this path called `validate('ai_conversation', ...)`,
      // which is also outside the whitelist, so the rephrased text was ALWAYS
      // discarded and the AI rewording feature had never once taken effect.
      aiProviderMock.complete.mockResolvedValue('Great work today — keep it going!');

      await real.draftAiMessageIfAbsent(
        childId,
        familyId,
        'BADGE_EARNED',
        'You earned a badge!',
        'You earned the "Reader" badge — awesome work and well done!',
        'evt:pe-n-001:rephrase',
        'CHILD_MESSAGE',
      );

      expect(repositoryMock.create).toHaveBeenCalledWith(
        expect.objectContaining({ body: 'Great work today — keep it going!' }),
        'PENDING',
        null,
      );
    });
  });
});
