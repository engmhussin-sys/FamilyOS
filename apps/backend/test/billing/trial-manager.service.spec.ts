import { Test } from '@nestjs/testing';
import { TrialManager } from '../../src/modules/billing/application/services/trial-manager.service';
import { BILLING_REPOSITORY } from '../../src/modules/billing/application/ports/billing.repository.port';

describe('TrialManager', () => {
  const repositoryMock = { findSubscriptionByFamily: jest.fn() };
  let manager: TrialManager;

  beforeEach(async () => {
    jest.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [TrialManager, { provide: BILLING_REPOSITORY, useValue: repositoryMock }],
    }).compile();
    manager = moduleRef.get(TrialManager);
  });

  it('computeTrialEndDate defaults to 14 days from now', () => {
    const start = new Date('2026-07-01T00:00:00Z');
    const end = manager.computeTrialEndDate(start);
    expect(end.toISOString()).toBe('2026-07-15T00:00:00.000Z');
  });

  it('computeTrialEndDate respects a custom trial length', () => {
    const start = new Date('2026-07-01T00:00:00Z');
    const end = manager.computeTrialEndDate(start, 30);
    expect(end.toISOString()).toBe('2026-07-31T00:00:00.000Z');
  });

  it('isInTrial is false when there is no subscription', async () => {
    repositoryMock.findSubscriptionByFamily.mockResolvedValue(null);
    await expect(manager.isInTrial('family-1')).resolves.toBe(false);
  });

  it('isInTrial is false when status is not TRIALING', async () => {
    repositoryMock.findSubscriptionByFamily.mockResolvedValue({
      status: 'ACTIVE',
      trialEndsAt: new Date(Date.now() + 100_000),
    });
    await expect(manager.isInTrial('family-1')).resolves.toBe(false);
  });

  it('isInTrial is true when TRIALING and trialEndsAt is in the future', async () => {
    repositoryMock.findSubscriptionByFamily.mockResolvedValue({
      status: 'TRIALING',
      trialEndsAt: new Date(Date.now() + 100_000),
    });
    await expect(manager.isInTrial('family-1')).resolves.toBe(true);
  });

  it('isInTrial is false when TRIALING but trialEndsAt already passed', async () => {
    repositoryMock.findSubscriptionByFamily.mockResolvedValue({
      status: 'TRIALING',
      trialEndsAt: new Date(Date.now() - 100_000),
    });
    await expect(manager.isInTrial('family-1')).resolves.toBe(false);
  });

  it('trialDaysRemaining returns 0 for no subscription', async () => {
    repositoryMock.findSubscriptionByFamily.mockResolvedValue(null);
    await expect(manager.trialDaysRemaining('family-1')).resolves.toBe(0);
  });

  it('trialDaysRemaining rounds up to whole days', async () => {
    repositoryMock.findSubscriptionByFamily.mockResolvedValue({
      trialEndsAt: new Date(Date.now() + 2.5 * 24 * 60 * 60 * 1000),
    });
    await expect(manager.trialDaysRemaining('family-1')).resolves.toBe(3);
  });
});
