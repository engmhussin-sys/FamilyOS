import { Injectable } from '@nestjs/common';

import { PrismaService } from '../../../common/prisma/prisma.service';
import type { IDashboardMetrics } from '../domain/analytics.types';
import { trialConversionRate } from '../domain/kpi-definitions';

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

    const [totalFamilies, totalDevices, activeDevices, resolvedTrials, convertedTrials, supportRequestCountLast7Days] = await Promise.all([
      this.prisma.family.count({ where: { deletedAt: null } }),
      this.prisma.device.count({ where: { deletedAt: null } }),
      this.prisma.device.count({ where: { deletedAt: null, lastSeenAt: { gte: sevenDaysAgo } } }),
      // PHASE D: the denominator is RESOLVED trials (`ends_at` in the past),
      // and the numerator is trials that actually converted. Both come from
      // the Phase D `trials` table, which records the lifetime fact.
      this.prisma.trial.count({ where: { endsAt: { lt: new Date() } } }),
      this.prisma.trial.count({ where: { endsAt: { lt: new Date() }, convertedAt: { not: null } } }),
      this.prisma.supportRequest.count({ where: { createdAt: { gte: sevenDaysAgo } } }),
    ]);

    const activeFamilyIds = await this.prisma.device.findMany({
      where: { deletedAt: null, lastSeenAt: { gte: sevenDaysAgo } },
      distinct: ['familyId'],
      select: { familyId: true },
    });

    /**
     * PHASE D (GROWTH) — THE LINE THIS WHOLE MODULE EXISTS BECAUSE OF.
     *
     * What was here: `activeCount / (trialCount + activeCount)`, with a comment
     * calling it "a reasonable first metric". It was reasonable and it was a
     * SECOND definition: its denominator is «trials still running plus paid
     * subscriptions», while `TRIAL_CONVERSION_RATE` divides by trials that have
     * RESOLVED. The two disagree by exactly the trial length, every day, and
     * nothing in the system could have told you they disagreed.
     *
     * It now calls the single implementation, with the correct denominator:
     * `trials` is a Phase D table with `ends_at` and `converted_at`, so
     * "resolved" is a real query rather than a simplification. The KPI is
     * `null` when no trial has ended yet; this surface renders that as 0 for
     * backward compatibility with its own `IDashboardMetrics` contract, and
     * says so rather than pretending the null never existed.
     */
    const conversion = trialConversionRate(convertedTrials, resolvedTrials);

    return {
      totalFamilies,
      activeFamiliesLast7Days: activeFamilyIds.length,
      totalDevices,
      activeDevicesLast7Days: activeDevices,
      trialConversionRate: conversion === null ? 0 : Math.round(conversion * 1000) / 1000,
      supportRequestCountLast7Days,
    };
  }
}
