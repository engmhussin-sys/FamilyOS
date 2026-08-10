import { Test } from '@nestjs/testing';

import { BaselineCalculatorService } from '../../src/modules/life-intelligence/application/services/baseline-calculator.service';
import { PrismaDigitalWellbeingRepository } from '../../src/modules/life-intelligence/infrastructure/repositories/prisma-digital-wellbeing.repository';

describe('BaselineCalculatorService (Sprint 14)', () => {
  const repositoryMock = { findSnapshotsInWindow: jest.fn() };
  let service: BaselineCalculatorService;

  const asOf = new Date('2026-08-10T00:00:00Z');

  beforeEach(async () => {
    jest.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [BaselineCalculatorService, { provide: PrismaDigitalWellbeingRepository, useValue: repositoryMock }],
    }).compile();
    service = moduleRef.get(BaselineCalculatorService);
  });

  function snapshot(dateStr: string, overrides: Partial<Record<string, number>> = {}) {
    return {
      usageDate: new Date(`${dateStr}T00:00:00Z`),
      totalScreenMinutes: overrides.totalScreenMinutes ?? 200,
      pickupCount: overrides.pickupCount ?? 40,
      nightUsageMinutes: overrides.nightUsageMinutes ?? 10,
      blockedAttemptCount: 0,
      sessionCount: null,
      averageSessionMinutes: null,
      longestSessionMinutes: null,
      educationMinutes: overrides.educationMinutes ?? 40,
      gamingMinutes: overrides.gamingMinutes ?? 60,
      socialMinutes: overrides.socialMinutes ?? 30,
      entertainmentMinutes: 0,
    };
  }

  it('BOUNDARY CASE (brief-required): new child with NO history returns null, never a fabricated baseline', async () => {
    repositoryMock.findSnapshotsInWindow.mockResolvedValue([]);

    const result = await service.compute('child-1', asOf);

    expect(result).toBeNull();
  });

  it('BOUNDARY CASE (brief-required): 1 day of history returns null — a single data point is not a baseline', async () => {
    repositoryMock.findSnapshotsInWindow.mockResolvedValue([snapshot('2026-08-09')]);

    const result = await service.compute('child-1', asOf);

    expect(result).toBeNull();
  });

  it('BOUNDARY CASE (brief-required): 7 days of history produces a real baseline with correct averages', async () => {
    const days = Array.from({ length: 7 }, (_, i) => snapshot(`2026-08-0${i + 1}`, { totalScreenMinutes: 200, gamingMinutes: 50 }));
    repositoryMock.findSnapshotsInWindow.mockResolvedValue(days);

    const result = await service.compute('child-1', asOf);

    expect(result).not.toBeNull();
    expect(result!.daysOfHistory).toBe(7);
    expect(result!.averageScreenMinutes).toBe(200);
    expect(result!.averageGamingMinutes).toBe(50);
  });

  it('excludes the day being evaluated itself from its own baseline', async () => {
    const history = [snapshot('2026-08-08'), snapshot('2026-08-09')];
    const today = snapshot('2026-08-10', { totalScreenMinutes: 9999 });
    repositoryMock.findSnapshotsInWindow.mockResolvedValue([...history, today]);

    const result = await service.compute('child-1', asOf);

    expect(result!.daysOfHistory).toBe(2);
    expect(result!.averageScreenMinutes).toBe(200);
  });

  it('BOUNDARY CASE: missing/null category data on old snapshots defaults to 0, never crashes', async () => {
    const legacySnapshot = {
      usageDate: new Date('2026-08-09T00:00:00Z'),
      totalScreenMinutes: 150,
      pickupCount: 30,
      nightUsageMinutes: 5,
      blockedAttemptCount: 0,
      sessionCount: null,
      averageSessionMinutes: null,
      longestSessionMinutes: null,
      educationMinutes: null,
      gamingMinutes: null,
      socialMinutes: null,
      entertainmentMinutes: null,
    };
    repositoryMock.findSnapshotsInWindow.mockResolvedValue([legacySnapshot, legacySnapshot]);

    const result = await service.compute('child-1', asOf);

    expect(result).not.toBeNull();
    expect(result!.averageGamingMinutes).toBe(0);
    expect(result!.averageEducationMinutes).toBe(0);
  });
});
