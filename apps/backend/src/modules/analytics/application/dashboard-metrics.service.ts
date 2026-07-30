import { Injectable } from '@nestjs/common';

import { PrismaService } from '../../../common/prisma/prisma.service';
import type { IDashboardMetrics } from '../domain/analytics.types';

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Sprint 8's Dashboard Metrics + a first-pass Retention/Funnel Engine.
 * Every number here is computed from tables that already exist
 * (Family/Device/Subscription) \u2014 no synthetic/placeholder metrics.
 * "Active" is defined as `Device.lastSeenAt` within 7 days (the same
 * heartbeat data Runtime Telemetry already populates), not a new
 * signal invented for this module.
 */
@Injectable()
export class DashboardMetricsService {
  constructor(private readonly prisma: PrismaService) {}

  async getMetrics(): Promise<IDashboardMetrics> {
    const sevenDaysAgo = new Date(Date.now() - SEVEN_DAYS_MS);

    const [totalFamilies, totalDevices, activeDevices, trialCount, activeCount] = await Promise.all([
      this.prisma.family.count({ where: { deletedAt: null } }),
      this.prisma.device.count({ where: { deletedAt: null } }),
      this.prisma.device.count({ where: { deletedAt: null, lastSeenAt: { gte: sevenDaysAgo } } }),
      this.prisma.subscription.count({ where: { status: 'TRIALING' } }),
      this.prisma.subscription.count({ where: { status: 'ACTIVE' } }),
    ]);

    const activeFamilyIds = await this.prisma.device.findMany({
      where: { deletedAt: null, lastSeenAt: { gte: sevenDaysAgo } },
      distinct: ['familyId'],
      select: { familyId: true },
    });

    // Funnel Engine, first pass: trial -> paid conversion. Denominator
    // is (trials that ever existed) = TRIALING + ACTIVE + CANCELED +
    // EXPIRED that started as a trial \u2014 simplified here to
    // trial+active as a reasonable first metric, not the full funnel
    // (which would need a subscription-history table this project
    // doesn't have yet \u2014 a real, flagged simplification).
    const everTrialedOrActive = trialCount + activeCount;
    const trialConversionRate = everTrialedOrActive === 0 ? 0 : activeCount / everTrialedOrActive;

    return {
      totalFamilies,
      activeFamiliesLast7Days: activeFamilyIds.length,
      totalDevices,
      activeDevicesLast7Days: activeDevices,
      trialConversionRate: Math.round(trialConversionRate * 1000) / 1000,
    };
  }
}
