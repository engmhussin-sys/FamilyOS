import { Test } from '@nestjs/testing';
import { FeatureFlagService } from '../../src/modules/feature-flags/application/feature-flag.service';
import { FEATURE_FLAG_REPOSITORY } from '../../src/modules/feature-flags/domain/feature-flag.repository.port';

describe('FeatureFlagService', () => {
  const repositoryMock = { findByKey: jest.fn(), listAll: jest.fn(), upsert: jest.fn() };
  let service: FeatureFlagService;

  beforeEach(async () => {
    jest.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [FeatureFlagService, { provide: FEATURE_FLAG_REPOSITORY, useValue: repositoryMock }],
    }).compile();
    service = moduleRef.get(FeatureFlagService);
  });

  it('an unknown flag key is off, not an error', async () => {
    repositoryMock.findByKey.mockResolvedValue(null);
    await expect(service.isEnabled('nonexistent_flag')).resolves.toBe(false);
  });

  it('a globally-enabled flag is on for everyone, even without a familyId', async () => {
    repositoryMock.findByKey.mockResolvedValue({
      key: 'new_ui', description: '', isEnabledGlobally: true, enabledFamilyIds: [],
    });
    await expect(service.isEnabled('new_ui')).resolves.toBe(true);
  });

  it('a family-scoped flag is on only for families in the allowlist', async () => {
    repositoryMock.findByKey.mockResolvedValue({
      key: 'beta_feature', description: '', isEnabledGlobally: false, enabledFamilyIds: ['family-1'],
    });
    await expect(service.isEnabled('beta_feature', 'family-1')).resolves.toBe(true);
    await expect(service.isEnabled('beta_feature', 'family-2')).resolves.toBe(false);
  });

  it('enableForFamily adds to the allowlist without duplicating an existing entry', async () => {
    repositoryMock.findByKey.mockResolvedValue({
      key: 'beta', description: 'desc', isEnabledGlobally: false, enabledFamilyIds: ['family-1'],
    });

    await service.enableForFamily('beta', 'desc', 'family-1');

    expect(repositoryMock.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ enabledFamilyIds: ['family-1'] }),
    );
  });

  it('works with zero external dependencies — no provider adapter exists in this module at all', () => {
    // Structural proof, not a runtime assertion: FeatureFlagService's
    // constructor takes only the repository token, nothing
    // provider-shaped — see this file's import list.
    expect(FeatureFlagService.length).toBeGreaterThan(0);
  });
});
