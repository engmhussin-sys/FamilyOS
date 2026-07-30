import { Test } from '@nestjs/testing';
import { EntitlementsService } from '../../src/modules/billing/application/services/entitlements.service';
import { BILLING_REPOSITORY } from '../../src/modules/billing/application/ports/billing.repository.port';

describe('EntitlementsService', () => {
  const repositoryMock = { findSubscriptionByFamily: jest.fn(), findPlanByTier: jest.fn() };
  let service: EntitlementsService;

  beforeEach(async () => {
    jest.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [EntitlementsService, { provide: BILLING_REPOSITORY, useValue: repositoryMock }],
    }).compile();
    service = moduleRef.get(EntitlementsService);
  });

  it('treats a family with no subscription row as FREE tier', async () => {
    repositoryMock.findSubscriptionByFamily.mockResolvedValue(null);
    repositoryMock.findPlanByTier.mockResolvedValue({ features: ['multiple_children'] });

    const result = await service.hasFeature('family-1', 'multiple_children');

    expect(repositoryMock.findPlanByTier).toHaveBeenCalledWith('FREE');
    expect(result).toBe(true);
  });

  it('grants a feature present in an ACTIVE PREMIUM plan', async () => {
    repositoryMock.findSubscriptionByFamily.mockResolvedValue({ planTier: 'PREMIUM', status: 'ACTIVE' });
    repositoryMock.findPlanByTier.mockResolvedValue({ features: ['ai_diagnostics'] });

    const result = await service.hasFeature('family-1', 'ai_diagnostics');

    expect(repositoryMock.findPlanByTier).toHaveBeenCalledWith('PREMIUM');
    expect(result).toBe(true);
  });

  it('grants features while TRIALING, same as ACTIVE', async () => {
    repositoryMock.findSubscriptionByFamily.mockResolvedValue({ planTier: 'PREMIUM', status: 'TRIALING' });
    repositoryMock.findPlanByTier.mockResolvedValue({ features: ['ai_diagnostics'] });

    const result = await service.hasFeature('family-1', 'ai_diagnostics');

    expect(result).toBe(true);
  });

  it('falls back to FREE features when the subscription is PAST_DUE', async () => {
    repositoryMock.findSubscriptionByFamily.mockResolvedValue({ planTier: 'PREMIUM', status: 'PAST_DUE' });
    repositoryMock.findPlanByTier.mockResolvedValue({ features: ['multiple_children'] });

    const result = await service.hasFeature('family-1', 'ai_diagnostics');

    expect(repositoryMock.findPlanByTier).toHaveBeenCalledWith('FREE');
    expect(result).toBe(false);
  });

  it('falls back to FREE features when the subscription is CANCELED', async () => {
    repositoryMock.findSubscriptionByFamily.mockResolvedValue({ planTier: 'FAMILY', status: 'CANCELED' });
    repositoryMock.findPlanByTier.mockResolvedValue({ features: [] });

    const result = await service.hasFeature('family-1', 'unlimited_devices_per_child');

    expect(repositoryMock.findPlanByTier).toHaveBeenCalledWith('FREE');
    expect(result).toBe(false);
  });

  it('returns false when the plan definition itself is missing (defensive default)', async () => {
    repositoryMock.findSubscriptionByFamily.mockResolvedValue(null);
    repositoryMock.findPlanByTier.mockResolvedValue(null);

    const result = await service.hasFeature('family-1', 'ai_diagnostics');

    expect(result).toBe(false);
  });
});
