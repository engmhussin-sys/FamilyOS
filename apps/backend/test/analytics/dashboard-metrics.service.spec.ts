import { Test } from '@nestjs/testing';

import { DashboardMetricsService } from '../../src/modules/analytics/application/dashboard-metrics.service';
import { PrismaService } from '../../src/common/prisma/prisma.service';

describe('DashboardMetricsService', () => {
  const prismaMock = {
    family: { count: jest.fn() },
    device: { count: jest.fn() },
    /**
     * PHASE D (GROWTH). The denominator moved from `subscriptions` to
     * `trials`, and that is the POINT of the change rather than a detail of
     * it: «trials still running plus paid subscriptions» disagrees with
     * «trials that have resolved» by exactly the trial length, every day.
     * `TRIAL_CONVERSION_RATE` in the definitions module owns the answer now.
     */
    trial: { count: jest.fn() },
    supportRequest: { count: jest.fn() },
  };

  let service: DashboardMetricsService;

  beforeEach(async () => {
    jest.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [DashboardMetricsService, { provide: PrismaService, useValue: prismaMock }],
    }).compile();
    service = moduleRef.get(DashboardMetricsService);
  });

  it('computes all metrics from real counts, including the new support queue depth (proactive business review)', async () => {
    // 100 registered families; 2 of them had a device heartbeat in the window.
    // The second `family.count` IS the active-family number now — it used to be
    // `device.findMany({ distinct }).length` de-duplicated in JavaScript.
    prismaMock.family.count.mockResolvedValueOnce(100).mockResolvedValueOnce(2);
    prismaMock.device.count.mockResolvedValueOnce(150).mockResolvedValueOnce(80);
    // 50 trials have ENDED; 30 of them converted.
    prismaMock.trial.count.mockResolvedValueOnce(50).mockResolvedValueOnce(30);
    prismaMock.supportRequest.count.mockResolvedValue(7);

    const result = await service.getMetrics();

    expect(result).toEqual({
      totalFamilies: 100,
      activeFamiliesLast7Days: 2,
      totalDevices: 150,
      activeDevicesLast7Days: 80,
      trialConversionRate: 0.6, // 30 converted / 50 resolved — the KPI definition
      supportRequestCountLast7Days: 7,
    });
  });

  it('scopes the support request count to the last 7 days, using the same cutoff as the device-activity query', async () => {
    prismaMock.family.count.mockResolvedValue(0);
    prismaMock.device.count.mockResolvedValue(0);
    prismaMock.trial.count.mockResolvedValue(0);
    prismaMock.supportRequest.count.mockResolvedValue(3);

    await service.getMetrics();

    expect(prismaMock.supportRequest.count).toHaveBeenCalledWith({
      where: { createdAt: { gte: expect.any(Date) } },
    });
  });

  it('returns 0 trial conversion rate (not NaN) when NO trial has resolved yet — the definitions module returns null and this surface renders it as 0 for its own back-compatible contract', async () => {
    prismaMock.family.count.mockResolvedValue(0);
    prismaMock.device.count.mockResolvedValue(0);
    prismaMock.trial.count.mockResolvedValue(0);
    prismaMock.supportRequest.count.mockResolvedValue(0);

    const result = await service.getMetrics();

    expect(result.trialConversionRate).toBe(0);
    expect(Number.isNaN(result.trialConversionRate)).toBe(false);
  });
});
