import { NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { SettingsService } from '../../src/modules/settings/application/settings.service';
import { SETTINGS_REPOSITORY } from '../../src/modules/settings/domain/settings.types';

describe('SettingsService', () => {
  const repositoryMock = { findByFamilyId: jest.fn(), update: jest.fn() };
  let service: SettingsService;

  beforeEach(async () => {
    jest.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [SettingsService, { provide: SETTINGS_REPOSITORY, useValue: repositoryMock }],
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
