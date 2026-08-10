import { Test } from '@nestjs/testing';
import { ForbiddenException } from '@nestjs/common';
import { ChildrenService } from '../../src/modules/children/application/services/children.service';
import { CHILD_REPOSITORY } from '../../src/modules/children/application/ports/child.repository.port';
import { ChildNotFoundException } from '../../src/modules/children/domain/child.errors';
import { EntitlementsService } from '../../src/modules/billing/application/services/entitlements.service';

describe('ChildrenService', () => {
  const childRepositoryMock = {
    create: jest.fn(),
    findManyByFamily: jest.fn(),
    findOneScopedToFamily: jest.fn(),
    update: jest.fn(),
    softDelete: jest.fn(),
  };
  const entitlementsMock = { hasFeature: jest.fn() };

  let service: ChildrenService;

  beforeEach(async () => {
    jest.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [
        ChildrenService,
        { provide: CHILD_REPOSITORY, useValue: childRepositoryMock },
        { provide: EntitlementsService, useValue: entitlementsMock },
      ],
    }).compile();
    service = moduleRef.get(ChildrenService);
  });

  describe('createChild (proactive business/code audit — multiple_children enforcement)', () => {
    it('allows creating the FIRST child on any tier, without even checking entitlements', async () => {
      childRepositoryMock.findManyByFamily.mockResolvedValue([]);
      childRepositoryMock.create.mockResolvedValue({ id: 'child-1' });

      const result = await service.createChild('family-1', { firstName: 'Ahmed', dateOfBirth: '2015-01-01' });

      expect(result).toEqual({ id: 'child-1' });
      expect(entitlementsMock.hasFeature).not.toHaveBeenCalled();
    });

    it('blocks a SECOND child when multiple_children is not entitled', async () => {
      childRepositoryMock.findManyByFamily.mockResolvedValue([{ id: 'child-1' }]);
      entitlementsMock.hasFeature.mockResolvedValue(false);

      await expect(
        service.createChild('family-1', { firstName: 'Sara', dateOfBirth: '2017-01-01' }),
      ).rejects.toThrow(ForbiddenException);

      expect(entitlementsMock.hasFeature).toHaveBeenCalledWith('family-1', 'multiple_children');
      expect(childRepositoryMock.create).not.toHaveBeenCalled();
    });

    it('allows a SECOND child when multiple_children IS entitled', async () => {
      childRepositoryMock.findManyByFamily.mockResolvedValue([{ id: 'child-1' }]);
      entitlementsMock.hasFeature.mockResolvedValue(true);
      childRepositoryMock.create.mockResolvedValue({ id: 'child-2' });

      const result = await service.createChild('family-1', { firstName: 'Sara', dateOfBirth: '2017-01-01' });

      expect(result).toEqual({ id: 'child-2' });
    });
  });

  describe('getChildOrThrow', () => {
    it('returns the child when it belongs to the given family', async () => {
      childRepositoryMock.findOneScopedToFamily.mockResolvedValue({ id: 'child-1' });

      const result = await service.getChildOrThrow('child-1', 'family-1');

      expect(result).toEqual({ id: 'child-1' });
      expect(childRepositoryMock.findOneScopedToFamily).toHaveBeenCalledWith('child-1', 'family-1');
    });

    it('throws ChildNotFoundException when the repository returns null (wrong family or missing)', async () => {
      childRepositoryMock.findOneScopedToFamily.mockResolvedValue(null);

      await expect(service.getChildOrThrow('child-1', 'family-1')).rejects.toBeInstanceOf(
        ChildNotFoundException,
      );
    });
  });

  describe('assertChildBelongsToFamily', () => {
    it('resolves silently for a valid child/family pair', async () => {
      childRepositoryMock.findOneScopedToFamily.mockResolvedValue({ id: 'child-1' });
      await expect(
        service.assertChildBelongsToFamily('child-1', 'family-1'),
      ).resolves.toBeUndefined();
    });

    it('rejects for a child belonging to a different family — this is what PairingService relies on', async () => {
      childRepositoryMock.findOneScopedToFamily.mockResolvedValue(null);
      await expect(
        service.assertChildBelongsToFamily('child-1', 'someone-elses-family'),
      ).rejects.toBeInstanceOf(ChildNotFoundException);
    });
  });

  describe('updateChild / deleteChild', () => {
    it('verifies ownership before updating, not after', async () => {
      childRepositoryMock.findOneScopedToFamily.mockResolvedValue(null);

      await expect(
        service.updateChild('child-1', 'family-1', { firstName: 'New Name' }),
      ).rejects.toBeInstanceOf(ChildNotFoundException);

      expect(childRepositoryMock.update).not.toHaveBeenCalled();
    });

    it('verifies ownership before soft-deleting', async () => {
      childRepositoryMock.findOneScopedToFamily.mockResolvedValue(null);

      await expect(service.deleteChild('child-1', 'family-1')).rejects.toBeInstanceOf(
        ChildNotFoundException,
      );

      expect(childRepositoryMock.softDelete).not.toHaveBeenCalled();
    });

    it('proceeds to soft-delete once ownership is confirmed', async () => {
      childRepositoryMock.findOneScopedToFamily.mockResolvedValue({ id: 'child-1' });

      await service.deleteChild('child-1', 'family-1');

      expect(childRepositoryMock.softDelete).toHaveBeenCalledWith('child-1');
    });
  });
});
