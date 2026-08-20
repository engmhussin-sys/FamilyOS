import { Test } from '@nestjs/testing';
import { TrialManager } from '../../src/modules/billing/application/services/trial-manager.service';
import { BILLING_REPOSITORY } from '../../src/modules/billing/application/ports/billing.repository.port';

describe('TrialManager', () => {
  const repositoryMock = { findSubscriptionByFamily: jest.fn(), updateSubscriptionStatus: jest.fn() };
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

  describe('extendTrial (Sprint B4 — CLOSES A REAL GAP: TrialManager was previously read-only)', () => {
    it('throws NotFoundException when there is no subscription to extend', async () => {
      repositoryMock.findSubscriptionByFamily.mockResolvedValue(null);

      await expect(manager.extendTrial('family-1', 30)).rejects.toThrow('No subscription found');
    });

    /**
     * MID-TRIAL MEANS *STILL RUNNING*, SO THE FIXTURE MUST BE IN THE FUTURE OF
     * THE RUN, NOT OF THE AUTHOR.
     *
     * This test used to pin `2026-08-20T00:00:00Z` and expect `2026-08-30`.
     * That is not a fixture, it is a fuse: the suite passed until that instant
     * arrived, and from then on failed forever — because `extendTrial` was
     * doing exactly the right thing, rebasing a trial that had already ended
     * onto today rather than handing the family a date in the past.
     *
     * It went red on 2026-08-20 and blocked CI. Anchoring the fixture to the
     * run's own clock keeps the assertion — «extending mid-trial adds to the
     * remaining time, it does not truncate it» — and removes the fuse.
     */
    it('extends from the CURRENT trialEndsAt when still mid-trial, never shortening the real remaining time', async () => {
      const DAY_MS = 24 * 60 * 60 * 1000;
      const currentEnd = new Date(Date.now() + 3 * DAY_MS);
      repositoryMock.findSubscriptionByFamily.mockResolvedValue({ id: 'sub-1', trialEndsAt: currentEnd });

      const result = await manager.extendTrial('family-1', 10);

      // 13 days out: the 3 that remained plus the 10 granted. Asserted as an
      // exact offset from the fixture, so a service that silently rebased onto
      // `now` — the truncation this test exists to catch — reads as 10, not 13.
      expect(result.getTime()).toBe(currentEnd.getTime() + 10 * DAY_MS);
      expect(repositoryMock.updateSubscriptionStatus).toHaveBeenCalledWith('sub-1', 'TRIALING', { trialEndsAt: result });
    });

    it('extends from TODAY (not a stale past date) when the trial already ended', async () => {
      const staleEnd = new Date('2020-01-01T00:00:00Z');
      repositoryMock.findSubscriptionByFamily.mockResolvedValue({ id: 'sub-1', trialEndsAt: staleEnd });

      const result = await manager.extendTrial('family-1', 5);

      const expectedEarliest = new Date();
      expectedEarliest.setDate(expectedEarliest.getDate() + 5);
      // Within a small tolerance of "5 days from now," not "5 days from 2020."
      expect(Math.abs(result.getTime() - expectedEarliest.getTime())).toBeLessThan(5000);
    });
  });
});
