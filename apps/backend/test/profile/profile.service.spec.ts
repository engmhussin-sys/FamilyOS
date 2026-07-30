import { NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ProfileService } from '../../src/modules/profile/application/profile.service';
import { PROFILE_REPOSITORY } from '../../src/modules/profile/domain/profile.types';

describe('ProfileService', () => {
  const repositoryMock = { findById: jest.fn(), update: jest.fn() };
  let service: ProfileService;

  beforeEach(async () => {
    jest.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [ProfileService, { provide: PROFILE_REPOSITORY, useValue: repositoryMock }],
    }).compile();
    service = moduleRef.get(ProfileService);
  });

  it('throws NotFoundException when the user does not exist', async () => {
    repositoryMock.findById.mockResolvedValue(null);
    await expect(service.getProfile('user-1')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('returns the profile when found', async () => {
    repositoryMock.findById.mockResolvedValue({ id: 'user-1', fullName: 'Yusuf' });
    await expect(service.getProfile('user-1')).resolves.toEqual({ id: 'user-1', fullName: 'Yusuf' });
  });

  it('updateProfile delegates to the repository', async () => {
    repositoryMock.update.mockResolvedValue({ id: 'user-1', fullName: 'New Name' });
    await service.updateProfile('user-1', { fullName: 'New Name' });
    expect(repositoryMock.update).toHaveBeenCalledWith('user-1', { fullName: 'New Name' });
  });
});
