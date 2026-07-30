import { Test } from '@nestjs/testing';
import { ScreenTimeService } from '../../src/modules/screen-time/application/services/screen-time.service';
import { SCREEN_TIME_POLICY_REPOSITORY } from '../../src/modules/screen-time/application/ports/screen-time.repository.port';
import { ChildrenService } from '../../src/modules/children/application/services/children.service';
import { ChildNotFoundException } from '../../src/modules/children/domain/child.errors';
import { AuditService } from '../../src/modules/audit/application/audit.service';

describe('ScreenTimeService', () => {
  const policyRepositoryMock = {
    create: jest.fn(),
    findActiveByChild: jest.fn(),
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
});
