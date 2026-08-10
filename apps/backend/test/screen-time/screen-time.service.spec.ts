import { Test } from '@nestjs/testing';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ScreenTimeService } from '../../src/modules/screen-time/application/services/screen-time.service';
import { APP_BLOCK_RULE_REPOSITORY, SCREEN_TIME_POLICY_REPOSITORY } from '../../src/modules/screen-time/application/ports/screen-time.repository.port';
import { ChildrenService } from '../../src/modules/children/application/services/children.service';
import { ChildNotFoundException } from '../../src/modules/children/domain/child.errors';
import { AuditService } from '../../src/modules/audit/application/audit.service';

describe('ScreenTimeService', () => {
  const policyRepositoryMock = {
    create: jest.fn(),
    findActiveByChild: jest.fn(),
    deactivate: jest.fn(),
  };
  const appBlockRuleRepositoryMock = {
    create: jest.fn(),
    findById: jest.fn(),
    listActiveByChild: jest.fn(),
    deactivate: jest.fn(),
  };
  const childrenServiceMock = { assertChildBelongsToFamily: jest.fn() };
  const auditServiceMock = { record: jest.fn() };

  let service: ScreenTimeService;

  beforeEach(async () => {
    jest.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [
        ScreenTimeService,
        { provide: SCREEN_TIME_POLICY_REPOSITORY, useValue: policyRepositoryMock },
        { provide: APP_BLOCK_RULE_REPOSITORY, useValue: appBlockRuleRepositoryMock },
        { provide: ChildrenService, useValue: childrenServiceMock },
        { provide: AuditService, useValue: auditServiceMock },
      ],
    }).compile();
    service = moduleRef.get(ScreenTimeService);
  });


  describe('getPolicy', () => {
    it('rejects before querying the repository when the child is not in the caller\'s family', async () => {
      childrenServiceMock.assertChildBelongsToFamily.mockRejectedValue(
        new ChildNotFoundException('child-1'),
      );

      await expect(service.getPolicy('child-1', 'family-1')).rejects.toBeInstanceOf(
        ChildNotFoundException,
      );
      expect(policyRepositoryMock.findActiveByChild).not.toHaveBeenCalled();
    });

    it('returns null when the child has no active policy yet', async () => {
      childrenServiceMock.assertChildBelongsToFamily.mockResolvedValue(undefined);
      policyRepositoryMock.findActiveByChild.mockResolvedValue(null);

      const result = await service.getPolicy('child-1', 'family-1');
      expect(result).toBeNull();
    });
  });

  describe('setPolicy', () => {
    it('creates a first policy without attempting to deactivate anything', async () => {
      childrenServiceMock.assertChildBelongsToFamily.mockResolvedValue(undefined);
      policyRepositoryMock.findActiveByChild.mockResolvedValue(null);
      policyRepositoryMock.create.mockResolvedValue({ id: 'policy-1' });

      const result = await service.setPolicy('child-1', 'family-1', 'user-1', {
        dailyLimitMinutes: 120,
      });

      expect(policyRepositoryMock.deactivate).not.toHaveBeenCalled();
      expect(policyRepositoryMock.create).toHaveBeenCalledWith('child-1', 'user-1', {
        dailyLimitMinutes: 120,
      });
      expect(result).toEqual({ id: 'policy-1' });
    });

    it('deactivates the previous active policy before creating the new one (versioning)', async () => {
      childrenServiceMock.assertChildBelongsToFamily.mockResolvedValue(undefined);
      policyRepositoryMock.findActiveByChild.mockResolvedValue({ id: 'old-policy' });
      policyRepositoryMock.create.mockResolvedValue({ id: 'new-policy' });

      await service.setPolicy('child-1', 'family-1', 'user-1', { dailyLimitMinutes: 90 });

      expect(policyRepositoryMock.deactivate).toHaveBeenCalledWith('old-policy');
      expect(policyRepositoryMock.create).toHaveBeenCalled();
    });

    it('rejects before touching the repository when the child is not in the caller\'s family', async () => {
      childrenServiceMock.assertChildBelongsToFamily.mockRejectedValue(
        new ChildNotFoundException('child-1'),
      );

      await expect(
        service.setPolicy('child-1', 'someone-elses-family', 'user-1', {}),
      ).rejects.toBeInstanceOf(ChildNotFoundException);

      expect(policyRepositoryMock.findActiveByChild).not.toHaveBeenCalled();
      expect(policyRepositoryMock.create).not.toHaveBeenCalled();
    });
  });

  // --- AppBlockRule: closes the gap PairingOrchestratorService's own
  // docstring previously flagged ("blockedPackages is always [] today") ---

  describe('createAppBlockRule', () => {
    beforeEach(() => {
      // FIXING A REAL TEST-ISOLATION BUG (found while adding these
      // tests): jest.clearAllMocks() in the outer beforeEach only
      // clears call history, not implementations set via
      // mockRejectedValue — an earlier test in this file leaves
      // assertChildBelongsToFamily permanently rejecting otherwise.
      childrenServiceMock.assertChildBelongsToFamily.mockResolvedValue(undefined);
    });

    it('throws BadRequestException when BOTH packageName and category are set — ambiguous, which one wins at enforcement?', async () => {
      await expect(
        service.createAppBlockRule('child-1', 'family-1', 'user-1', {
          packageName: 'com.example.app',
          category: 'games',
          ruleType: 'BLOCK',
        }),
      ).rejects.toThrow(BadRequestException);
      expect(appBlockRuleRepositoryMock.create).not.toHaveBeenCalled();
    });

    it('throws BadRequestException when NEITHER packageName nor category is set — a rule that blocks nothing is not a rule', async () => {
      await expect(
        service.createAppBlockRule('child-1', 'family-1', 'user-1', { ruleType: 'BLOCK' }),
      ).rejects.toThrow(BadRequestException);
    });

    it('throws BadRequestException for TIME_LIMIT without limitMinutes', async () => {
      await expect(
        service.createAppBlockRule('child-1', 'family-1', 'user-1', {
          packageName: 'com.example.app',
          ruleType: 'TIME_LIMIT',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('creates a valid packageName-only BLOCK rule and audit-logs it', async () => {
      appBlockRuleRepositoryMock.create.mockResolvedValue({
        id: 'rule-1', childId: 'child-1', packageName: 'com.example.app', category: null,
        ruleType: 'BLOCK', limitMinutes: null, schedule: null, isActive: true,
      });

      await service.createAppBlockRule('child-1', 'family-1', 'user-1', {
        packageName: 'com.example.app',
        ruleType: 'BLOCK',
      });

      expect(childrenServiceMock.assertChildBelongsToFamily).toHaveBeenCalledWith('child-1', 'family-1');
      expect(auditServiceMock.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'screenTime.appBlockRule.created' }),
      );
    });

    it('creates a valid category-only TIME_LIMIT rule', async () => {
      appBlockRuleRepositoryMock.create.mockResolvedValue({
        id: 'rule-2', childId: 'child-1', packageName: null, category: 'games',
        ruleType: 'TIME_LIMIT', limitMinutes: 60, schedule: null, isActive: true,
      });

      const result = await service.createAppBlockRule('child-1', 'family-1', 'user-1', {
        category: 'games',
        ruleType: 'TIME_LIMIT',
        limitMinutes: 60,
      });

      expect(result.category).toBe('games');
    });
  });

  describe('deactivateAppBlockRule', () => {
    beforeEach(() => {
      childrenServiceMock.assertChildBelongsToFamily.mockResolvedValue(undefined);
    });

    it('throws NotFoundException for a rule belonging to a different child (IDOR protection)', async () => {
      appBlockRuleRepositoryMock.findById.mockResolvedValue({ id: 'rule-1', childId: 'someone-elses-child' });
      await expect(
        service.deactivateAppBlockRule('rule-1', 'child-1', 'family-1', 'user-1'),
      ).rejects.toThrow(NotFoundException);
      expect(appBlockRuleRepositoryMock.deactivate).not.toHaveBeenCalled();
    });

    it('throws the SAME error when the rule does not exist at all — never leaks which case it was', async () => {
      appBlockRuleRepositoryMock.findById.mockResolvedValue(null);
      await expect(
        service.deactivateAppBlockRule('missing', 'child-1', 'family-1', 'user-1'),
      ).rejects.toThrow(NotFoundException);
    });

    it('deactivates and audit-logs when ownership checks out', async () => {
      appBlockRuleRepositoryMock.findById.mockResolvedValue({ id: 'rule-1', childId: 'child-1' });

      await service.deactivateAppBlockRule('rule-1', 'child-1', 'family-1', 'user-1');

      expect(appBlockRuleRepositoryMock.deactivate).toHaveBeenCalledWith('rule-1');
      expect(auditServiceMock.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'screenTime.appBlockRule.deactivated' }),
      );
    });
  });

  describe('getBlockedPackageNames', () => {
    it('returns only BLOCK-type rules that have a packageName — category rules are resolved on-device, not here', async () => {
      appBlockRuleRepositoryMock.listActiveByChild.mockResolvedValue([
        { id: '1', childId: 'c1', packageName: 'com.tiktok', category: null, ruleType: 'BLOCK', limitMinutes: null, schedule: null, isActive: true },
        { id: '2', childId: 'c1', packageName: null, category: 'games', ruleType: 'BLOCK', limitMinutes: null, schedule: null, isActive: true },
        { id: '3', childId: 'c1', packageName: 'com.example', category: null, ruleType: 'TIME_LIMIT', limitMinutes: 30, schedule: null, isActive: true },
      ]);

      const result = await service.getBlockedPackageNames('child-1');

      expect(result).toEqual(['com.tiktok']);
    });

    it('returns an empty array, not null or an error, when no rules exist', async () => {
      appBlockRuleRepositoryMock.listActiveByChild.mockResolvedValue([]);
      const result = await service.getBlockedPackageNames('child-1');
      expect(result).toEqual([]);
    });
  });
});
