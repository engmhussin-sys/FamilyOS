import { Test } from '@nestjs/testing';
import { ConsentService } from '../../src/modules/compliance/application/services/consent.service';
import { CONSENT_REPOSITORY } from '../../src/modules/compliance/application/ports/consent.repository.port';
import { ChildrenService } from '../../src/modules/children/application/services/children.service';
import { ChildNotFoundException } from '../../src/modules/children/domain/child.errors';

describe('ConsentService', () => {
  const consentRepositoryMock = { findManyByChild: jest.fn(), upsert: jest.fn() };
  const childrenServiceMock = { assertChildBelongsToFamily: jest.fn() };

  let service: ConsentService;

  beforeEach(async () => {
    jest.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [
        ConsentService,
        { provide: CONSENT_REPOSITORY, useValue: consentRepositoryMock },
        { provide: ChildrenService, useValue: childrenServiceMock },
      ],
    }).compile();
    service = moduleRef.get(ConsentService);
  });

  describe('listConsents', () => {
    it('rejects before querying the repository when ownership fails', async () => {
      childrenServiceMock.assertChildBelongsToFamily.mockRejectedValue(
        new ChildNotFoundException('child-1'),
      );

      await expect(service.listConsents('child-1', 'family-1')).rejects.toBeInstanceOf(
        ChildNotFoundException,
      );
      expect(consentRepositoryMock.findManyByChild).not.toHaveBeenCalled();
    });

    it('returns the repository result once ownership is confirmed', async () => {
      childrenServiceMock.assertChildBelongsToFamily.mockResolvedValue(undefined);
      consentRepositoryMock.findManyByChild.mockResolvedValue([{ consentType: 'HEALTH_DATA' }]);

      const result = await service.listConsents('child-1', 'family-1');
      expect(result).toEqual([{ consentType: 'HEALTH_DATA' }]);
    });
  });

  describe('setConsent', () => {
    it('rejects before touching the repository when ownership fails', async () => {
      childrenServiceMock.assertChildBelongsToFamily.mockRejectedValue(
        new ChildNotFoundException('child-1'),
      );

      await expect(
        service.setConsent('child-1', 'someone-elses-family', 'user-1', 'HEALTH_DATA', true),
      ).rejects.toBeInstanceOf(ChildNotFoundException);

      expect(consentRepositoryMock.upsert).not.toHaveBeenCalled();
    });

    it('upserts the consent with the granting user recorded, once ownership is confirmed', async () => {
      childrenServiceMock.assertChildBelongsToFamily.mockResolvedValue(undefined);
      consentRepositoryMock.upsert.mockResolvedValue({ consentType: 'LOCATION_TRACKING', granted: true });

      const result = await service.setConsent(
        'child-1',
        'family-1',
        'user-1',
        'LOCATION_TRACKING',
        true,
      );

      expect(consentRepositoryMock.upsert).toHaveBeenCalledWith(
        'child-1',
        'LOCATION_TRACKING',
        true,
        'user-1',
      );
      expect(result).toEqual({ consentType: 'LOCATION_TRACKING', granted: true });
    });
  });
});
