import { Test } from '@nestjs/testing';
import { BadRequestException, NotFoundException } from '@nestjs/common';

import { FamilyCommunicationService } from '../../src/modules/life-intelligence/application/services/family-communication.service';
import { PrismaCommunicationRepository } from '../../src/modules/life-intelligence/infrastructure/repositories/prisma-communication.repository';
import { ChildrenService } from '../../src/modules/children/application/services/children.service';
import { PairingOrchestratorService } from '../../src/modules/pairing/application/services/pairing-orchestrator.service';
import { SafetyEngineService } from '../../src/modules/ai-core/application/services/safety-engine.service';
import { AI_PROVIDER } from '../../src/modules/ai-core/domain/ai-provider.port';

describe('FamilyCommunicationService', () => {
  const repositoryMock = { create: jest.fn(), findById: jest.fn(), approveAndDeliver: jest.fn(), reject: jest.fn(), listDeliveredForChild: jest.fn(), acknowledge: jest.fn(), listPendingForFamily: jest.fn() };
  const childrenServiceMock = { assertChildBelongsToFamily: jest.fn() };
  const pairingOrchestratorMock = { getChildIdForDevice: jest.fn() };
  const safetyEngineMock = { validate: jest.fn() };
  const aiProviderMock = { complete: jest.fn() };

  let service: FamilyCommunicationService;
  const childId = 'child-1';
  const familyId = 'family-1';

  beforeEach(async () => {
    jest.clearAllMocks();
    safetyEngineMock.validate.mockReturnValue({ isSafe: true, rejectionReason: null });
    const moduleRef = await Test.createTestingModule({
      providers: [
        FamilyCommunicationService,
        { provide: PrismaCommunicationRepository, useValue: repositoryMock },
        { provide: ChildrenService, useValue: childrenServiceMock },
        { provide: PairingOrchestratorService, useValue: pairingOrchestratorMock },
        { provide: SafetyEngineService, useValue: safetyEngineMock },
        { provide: AI_PROVIDER, useValue: aiProviderMock },
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
      childrenServiceMock.assertChildBelongsToFamily.mockRejectedValueOnce(new Error('not found'));

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
});
