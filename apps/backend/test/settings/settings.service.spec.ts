import { NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { SettingsService } from '../../src/modules/settings/application/settings.service';
import { SETTINGS_REPOSITORY } from '../../src/modules/settings/domain/settings.types';
import { familyDateProvider } from '../common/family-date.testing';
import { countryCatalogueProvider } from '../common/country-catalogue.testing';

describe('SettingsService', () => {
  const repositoryMock = { findByFamilyId: jest.fn(), update: jest.fn() };
  let service: SettingsService;

  beforeEach(async () => {
    jest.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [
        SettingsService,
        { provide: SETTINGS_REPOSITORY, useValue: repositoryMock },
        // B2: SettingsService now invalidates the timezone cache on write.
        familyDateProvider(),
        // F1: SettingsService now checks the country against the catalogue and
        // reconciles it with the timezone. The REAL service over a fake
        // two-row catalogue — see `country-catalogue.testing.ts`.
        countryCatalogueProvider(),
      ],
    }).compile();
    service = moduleRef.get(SettingsService);
  });

  it('throws NotFoundException when the family does not exist', async () => {
    repositoryMock.findByFamilyId.mockResolvedValue(null);
    await expect(service.getSettings('family-1')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('returns settings when found', async () => {
    repositoryMock.findByFamilyId.mockResolvedValue({ id: 'family-1', name: 'The Smiths' });
    await expect(service.getSettings('family-1')).resolves.toEqual({ id: 'family-1', name: 'The Smiths' });
  });

  it('updateSettings delegates to the repository', async () => {
    repositoryMock.update.mockResolvedValue({ id: 'family-1', name: 'New Name' });
    await service.updateSettings('family-1', { name: 'New Name' });
    expect(repositoryMock.update).toHaveBeenCalledWith('family-1', { name: 'New Name' });
  });
});
