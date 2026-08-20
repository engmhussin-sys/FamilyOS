import { Test } from '@nestjs/testing';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ScreenTimeService } from '../../src/modules/screen-time/application/services/screen-time.service';
import { APP_BLOCK_RULE_REPOSITORY, SCREEN_TIME_BONUS_REPOSITORY, SCREEN_TIME_POLICY_REPOSITORY } from '../../src/modules/screen-time/application/ports/screen-time.repository.port';
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
  // F4: the earned-bonus port. Defaults to "no grants", so every pre-existing
  // assertion in this file keeps measuring exactly what it measured before.
  const bonusRepositoryMock = { listActiveGrants: jest.fn().mockResolvedValue([]) };
  const childrenServiceMock = { assertChildBelongsToFamily: jest.fn() };
  const auditServiceMock = { record: jest.fn() };

  let service: ScreenTimeService;

  beforeEach(async () => {
    jest.clearAllMocks();
    bonusRepositoryMock.listActiveGrants.mockResolvedValue([]);
    const moduleRef = await Test.createTestingModule({
      providers: [
        ScreenTimeService,
        { provide: SCREEN_TIME_POLICY_REPOSITORY, useValue: policyRepositoryMock },
        { provide: APP_BLOCK_RULE_REPOSITORY, useValue: appBlockRuleRepositoryMock },
        { provide: SCREEN_TIME_BONUS_REPOSITORY, useValue: bonusRepositoryMock },
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

/**
 * F4 — `getEffectivePolicy`: the read where a SCREEN_TIME reward becomes real
 * minutes. Unit level here; the end-to-end proof (a real grant written by the
 * reward engine, then read back through this method) is in
 * `test/rewards/reward-engine.e2e.spec.ts`.
 */
describe('ScreenTimeService.getEffectivePolicy (F4)', () => {
  const policyRepositoryMock = { create: jest.fn(), findActiveByChild: jest.fn(), deactivate: jest.fn() };
  const appBlockRuleRepositoryMock = { create: jest.fn(), findById: jest.fn(), listActiveByChild: jest.fn(), deactivate: jest.fn() };
  const bonusRepositoryMock = { listActiveGrants: jest.fn() };
  const childrenServiceMock = { assertChildBelongsToFamily: jest.fn() };
  const auditServiceMock = { record: jest.fn() };

  let service: ScreenTimeService;

  beforeEach(async () => {
    jest.clearAllMocks();
    childrenServiceMock.assertChildBelongsToFamily.mockResolvedValue(undefined);
    const moduleRef = await Test.createTestingModule({
      providers: [
        ScreenTimeService,
        { provide: SCREEN_TIME_POLICY_REPOSITORY, useValue: policyRepositoryMock },
        { provide: APP_BLOCK_RULE_REPOSITORY, useValue: appBlockRuleRepositoryMock },
        { provide: SCREEN_TIME_BONUS_REPOSITORY, useValue: bonusRepositoryMock },
        { provide: ChildrenService, useValue: childrenServiceMock },
        { provide: AuditService, useValue: auditServiceMock },
      ],
    }).compile();
    service = moduleRef.get(ScreenTimeService);
  });

  it('adds active bonus minutes to the base limit WITHOUT editing the policy row', async () => {
    const policy = { id: 'p1', dailyLimitMinutes: 90 };
    policyRepositoryMock.findActiveByChild.mockResolvedValue(policy);
    bonusRepositoryMock.listActiveGrants.mockResolvedValue([
      { id: 'g1', minutes: 20, grantedAt: new Date(), expiresAt: new Date() },
      { id: 'g2', minutes: 10, grantedAt: new Date(), expiresAt: new Date() },
    ]);

    const result = await service.getEffectivePolicy('child-1', 'family-1');

    expect(result.baseDailyLimitMinutes).toBe(90);
    expect(result.bonusMinutes).toBe(30);
    expect(result.effectiveDailyLimitMinutes).toBe(120);
    // The base policy object is returned untouched — nothing wrote to it.
    expect(result.policy).toBe(policy);
    expect(policyRepositoryMock.create).not.toHaveBeenCalled();
  });

  it('is the base limit when there are no grants', async () => {
    policyRepositoryMock.findActiveByChild.mockResolvedValue({ id: 'p1', dailyLimitMinutes: 60 });
    bonusRepositoryMock.listActiveGrants.mockResolvedValue([]);

    const result = await service.getEffectivePolicy('child-1', 'family-1');
    expect(result.effectiveDailyLimitMinutes).toBe(60);
    expect(result.bonusMinutes).toBe(0);
  });

  it('stays null (unlimited) when the parent set no daily limit — a bonus does not invent a cap', async () => {
    policyRepositoryMock.findActiveByChild.mockResolvedValue({ id: 'p1', dailyLimitMinutes: null });
    bonusRepositoryMock.listActiveGrants.mockResolvedValue([
      { id: 'g1', minutes: 30, grantedAt: new Date(), expiresAt: new Date() },
    ]);

    const result = await service.getEffectivePolicy('child-1', 'family-1');
    expect(result.effectiveDailyLimitMinutes).toBeNull();
    expect(result.bonusMinutes).toBe(30);
  });

  it('answers nothing at all when the child is not in the caller family', async () => {
    childrenServiceMock.assertChildBelongsToFamily.mockRejectedValue(new ChildNotFoundException('child-x'));
    await expect(service.getEffectivePolicy('child-x', 'family-1')).rejects.toBeInstanceOf(ChildNotFoundException);
    expect(bonusRepositoryMock.listActiveGrants).not.toHaveBeenCalled();
  });

  it('passes the caller clock through, so expiry is decided at READ time', async () => {
    policyRepositoryMock.findActiveByChild.mockResolvedValue({ id: 'p1', dailyLimitMinutes: 60 });
    bonusRepositoryMock.listActiveGrants.mockResolvedValue([]);
    const now = new Date('2026-06-15T12:00:00Z');

    await service.getEffectivePolicy('child-1', 'family-1', now);
    expect(bonusRepositoryMock.listActiveGrants).toHaveBeenCalledWith('child-1', now);
  });
});
