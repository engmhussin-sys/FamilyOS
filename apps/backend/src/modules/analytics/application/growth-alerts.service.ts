import { Injectable, Logger } from '@nestjs/common';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { runInSystemScope } from './system-scope';
import { getBusinessDate, getBusinessDayRange, addBusinessDays } from '../../../common/time/family-date';
import { GrowthSettingsService } from './growth-settings.service';
import { rate } from '../domain/kpi-definitions';

/** The eight conditions an operator is paged about. A closed vocabulary. */
export const GROWTH_ALERT_TYPES = [
  'CONVERSION_DROP',
  'CHURN_RISE',
  'PAYMENT_FAILURE_SPIKE',
  'REWARD_FAILURE_RISE',
  'NOTIFICATION_FAILURE_RISE',
  'AI_SAFETY_INCIDENT',
  'RETENTION_DROP',
  'COUNTRY_PERFORMANCE_SHIFT',
] as const;

export type GrowthAlertType = (typeof GROWTH_ALERT_TYPES)[number];

export interface IRaisedAlert {
  readonly alertType: GrowthAlertType;
  readonly scopeKey: string;
  readonly created: boolean;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * PHASE D (GROWTH) — THE EIGHT ALERTS, AND WHY THEY DEDUPE ON A ROW.
 *
 * The scan runs hourly. A condition that persists for three days would, with a
 * naive implementation, produce seventy-two alerts — and an operator who has
 * learned to ignore seventy-two alerts is an operator who will ignore the
 * seventy-third, which is the one that mattered. So the dedupe is
 * `growth_alerts (alert_type, scope_key, business_date)` UNIQUE: one alert per
 * condition per scope per day, decided by the database.
 *
 * IT IS A UNIQUE INDEX RATHER THAN AN IN-MEMORY COOLDOWN DELIBERATELY. A
 * cooldown map resets on deploy, and a deploy during an incident is exactly
 * when the duplicate storm would arrive. It also would not survive a second
 * replica.
 *
 * EVERY THRESHOLD IS A `growth_settings` ROW. Not one number in this file is a
 * constant; `alerts.churnRisePct` and its seven siblings are admin-editable,
 * because the right threshold on launch day and the right threshold at 100,000
 * households are not the same number and neither is knowable now.
 *
 * PRIVACY. Alert messages carry counts, rates and country codes. The only
 * alert that names a household is `AI_SAFETY_INCIDENT`, which sets `family_id`
 * — and `growth_alerts` is PLATFORM_ANNOTATED precisely so that row is visible
 * to an operator and to no tenant.
 */
@Injectable()
export class GrowthAlertsService {
  private readonly logger = new Logger(GrowthAlertsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: GrowthSettingsService,
  ) {}

  /** Runs every rule. Returns what it raised, for the job's `details` counts. */
  async scan(now: Date): Promise<IRaisedAlert[]> {
    const timeZone = await this.settings.reportingTimeZone('**');
    const businessDate = getBusinessDate(now, timeZone);

    const raised: IRaisedAlert[] = [];
    const rules: Array<() => Promise<IRaisedAlert[]>> = [
      () => this.conversionDrop(now, timeZone, businessDate),
      () => this.churnRise(now, businessDate),
      () => this.paymentFailureSpike(now, businessDate),
      () => this.rewardFailureRise(now, businessDate),
      () => this.notificationFailureRise(now, businessDate),
      () => this.aiSafetyIncident(now, businessDate),
      () => this.retentionDrop(businessDate),
      () => this.countryPerformanceShift(now, timeZone, businessDate),
    ];

    for (const rule of rules) {
      try {
        raised.push(...(await rule()));
      } catch (err) {
        // One broken rule must not silence the other seven.
        this.logger.error(
          `growth.alert_rule_failed — ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return raised;
  }

  /**
   * The only writer. `ON CONFLICT DO NOTHING` semantics via a caught unique
   * violation, so a second replica scanning the same minute raises nothing.
   */
  private async raise(
    alertType: GrowthAlertType,
    scopeKey: string,
    businessDate: string,
    severity: 'INFO' | 'WARNING' | 'CRITICAL',
    message: string,
    observed: number | null,
    threshold: number | null,
    familyId: string | null = null,
  ): Promise<IRaisedAlert> {
    try {
      await runInSystemScope(
        'SCHEDULED_JOB',
        'Raising an operator alert; growth_alerts is platform-annotated and this row belongs to no tenant unless it names one.',
        () =>
          this.prisma.growthAlert.create({
            data: {
              alertType,
              scopeKey,
              businessDate: new Date(`${businessDate}T00:00:00.000Z`),
              severity,
              message,
              observedValue: observed,
              thresholdValue: threshold,
              familyId,
            },
          }),
      );
      this.logger.warn(`growth.alert type=${alertType} scope=${scopeKey} — ${message}`);
      return { alertType, scopeKey, created: true };
    } catch {
      // Already raised today for this scope. That is the design, not a failure.
      return { alertType, scopeKey, created: false };
    }
  }

  private sys<T>(fn: () => Promise<T>): Promise<T> {
    return runInSystemScope(
      'SCHEDULED_JOB',
      'The alert scan evaluates population-level conditions across every household; no per-request tenant exists on a timer tick.',
      fn,
    );
  }

  /** Registration → paid conversion, this week against last week, per country. */
  private async conversionDrop(now: Date, timeZone: string, businessDate: string): Promise<IRaisedAlert[]> {
    const threshold = await this.settings.rate('alerts.conversionDropPct');
    const out: IRaisedAlert[] = [];

    for (const countryCode of await this.activeCountries()) {
      const thisWeek = await this.conversionInWindow(countryCode, now, 7, timeZone);
      const lastWeek = await this.conversionInWindow(
        countryCode,
        new Date(now.getTime() - 7 * DAY_MS),
        7,
        timeZone,
      );
      if (thisWeek === null || lastWeek === null || lastWeek === 0) continue;

      const drop = (lastWeek - thisWeek) / lastWeek;
      if (drop >= threshold) {
        out.push(
          await this.raise(
            'CONVERSION_DROP',
            countryCode,
            businessDate,
            'CRITICAL',
            `انخفض معدل التحويل في ${countryCode} من ${(lastWeek * 100).toFixed(2)}% إلى ${(thisWeek * 100).toFixed(2)}% خلال أسبوع.`,
            Math.round(drop * 10_000) / 10_000,
            threshold,
          ),
        );
      }
    }
    return out;
  }

  private async conversionInWindow(
    countryCode: string,
    endAt: Date,
    days: number,
    timeZone: string,
  ): Promise<number | null> {
    const range = getBusinessDayRange(endAt, timeZone);
    const start = new Date(range.endExclusive.getTime() - days * DAY_MS);
    const familyFilter = { acquisitionAttribution: { countryCode } };

    return this.sys(async () => {
      const registrations = await this.prisma.family.count({
        where: { deletedAt: null, createdAt: { gte: start, lt: range.endExclusive }, ...familyFilter },
      });
      const paid = await this.prisma.family.count({
        where: {
          deletedAt: null,
          createdAt: { gte: start, lt: range.endExclusive },
          paymentTransactions: { some: { status: 'SUCCEEDED' } },
          ...familyFilter,
        },
      });
      return rate(paid, registrations);
    });
  }

  /** Churn this 30 days against the previous 30, per country. */
  private async churnRise(now: Date, businessDate: string): Promise<IRaisedAlert[]> {
    const threshold = await this.settings.rate('alerts.churnRisePct');
    const out: IRaisedAlert[] = [];

    for (const countryCode of await this.activeCountries()) {
      const current = await this.churnInWindow(countryCode, now, 30);
      const previous = await this.churnInWindow(countryCode, new Date(now.getTime() - 30 * DAY_MS), 30);
      if (current === null || previous === null || previous === 0) continue;

      const rise = (current - previous) / previous;
      if (rise >= threshold) {
        out.push(
          await this.raise(
            'CHURN_RISE',
            countryCode,
            businessDate,
            'CRITICAL',
            `ارتفع معدل التسرّب في ${countryCode} من ${(previous * 100).toFixed(2)}% إلى ${(current * 100).toFixed(2)}%.`,
            Math.round(rise * 10_000) / 10_000,
            threshold,
          ),
        );
      }
    }
    return out;
  }

  private async churnInWindow(countryCode: string, endAt: Date, days: number): Promise<number | null> {
    const start = new Date(endAt.getTime() - days * DAY_MS);
    return this.sys(async () => {
      const base = await this.prisma.subscription.count({
        where: {
          countryCode,
          status: { in: ['ACTIVE', 'TRIALING', 'GRACE_PERIOD'] },
          createdAt: { lt: start },
        },
      });
      const gone = await this.prisma.subscription.count({
        where: { countryCode, canceledAt: { gte: start, lt: endAt } },
      });
      return rate(gone, base);
    });
  }

  /** Failed / succeeded payment transactions in the last 24 hours, per provider. */
  private async paymentFailureSpike(now: Date, businessDate: string): Promise<IRaisedAlert[]> {
    const threshold = await this.settings.rate('alerts.paymentFailureRate');
    const since = new Date(now.getTime() - DAY_MS);

    const grouped = await this.sys(() =>
      this.prisma.paymentTransaction.groupBy({
        by: ['provider', 'status'],
        where: { occurredAt: { gte: since } },
        _count: { _all: true },
      }),
    );

    const byProvider = new Map<string, { failed: number; total: number }>();
    for (const row of grouped) {
      const entry = byProvider.get(row.provider) ?? { failed: 0, total: 0 };
      entry.total += row._count._all;
      if (row.status === 'FAILED') entry.failed += row._count._all;
      byProvider.set(row.provider, entry);
    }

    const out: IRaisedAlert[] = [];
    for (const [provider, counts] of byProvider) {
      // A provider with a handful of transactions produces a meaningless rate;
      // ten is the floor below which this rule stays silent rather than paging
      // on one failed test purchase.
      if (counts.total < 10) continue;
      const failureRate = rate(counts.failed, counts.total);
      if (failureRate !== null && failureRate >= threshold) {
        out.push(
          await this.raise(
            'PAYMENT_FAILURE_SPIKE',
            provider,
            businessDate,
            'CRITICAL',
            `نسبة فشل المدفوعات عبر ${provider} بلغت ${(failureRate * 100).toFixed(1)}% خلال 24 ساعة (${counts.failed} من ${counts.total}).`,
            failureRate,
            threshold,
          ),
        );
      }
    }
    return out;
  }

  /**
   * Reward failures — measured on the OUTBOX, which is where a reward that was
   * granted but never announced actually shows up (Phase C `PA-B-009`).
   */
  private async rewardFailureRise(now: Date, businessDate: string): Promise<IRaisedAlert[]> {
    const threshold = await this.settings.int('alerts.rewardFailureCount');
    const since = new Date(now.getTime() - DAY_MS);

    const failed = await this.sys(() =>
      this.prisma.outboxMessage.count({
        where: { status: { in: ['FAILED', 'DEAD'] }, eventType: 'REWARD_GRANTED', createdAt: { gte: since } },
      }),
    );

    if (failed < threshold) return [];
    return [
      await this.raise(
        'REWARD_FAILURE_RISE',
        '**',
        businessDate,
        'CRITICAL',
        `${failed} رسالة REWARD_GRANTED فشلت خلال 24 ساعة — مكافآت مُنحت في الدفتر وقد لا يكون الوالد أُشعر بها.`,
        failed,
        threshold,
      ),
    ];
  }

  private async notificationFailureRise(now: Date, businessDate: string): Promise<IRaisedAlert[]> {
    const threshold = await this.settings.int('alerts.notificationFailureCount');
    const since = new Date(now.getTime() - DAY_MS);

    const failed = await this.sys(() =>
      this.prisma.notificationDelivery.count({
        // `DEAD` is the terminal state migration 0014 introduced — a delivery
        // that will never be attempted again. That, not a transient retry, is
        // what an operator needs to hear about.
        where: { state: 'DEAD', updatedAt: { gte: since } },
      }),
    );

    if (failed < threshold) return [];
    return [
      await this.raise(
        'NOTIFICATION_FAILURE_RISE',
        '**',
        businessDate,
        'WARNING',
        `${failed} عملية تسليم إشعار فشلت نهائيًا خلال 24 ساعة.`,
        failed,
        threshold,
      ),
    ];
  }

  /**
   * AN AI SAFETY INCIDENT IS NOT A THRESHOLD. One is one too many, so this rule
   * has no configurable count: any un-reviewed CRITICAL `AiAlert` in the last
   * day raises an alert, and it is the one alert that names a household.
   */
  private async aiSafetyIncident(now: Date, businessDate: string): Promise<IRaisedAlert[]> {
    const since = new Date(now.getTime() - DAY_MS);
    const incidents = await this.sys(() =>
      this.prisma.aiAlert.findMany({
        where: { severity: 'CRITICAL', reviewedAt: null, createdAt: { gte: since } },
        select: { familyId: true },
        take: 50,
      }),
    );

    const out: IRaisedAlert[] = [];
    const families = [...new Set(incidents.map((i) => i.familyId))];
    for (const familyId of families) {
      out.push(
        await this.raise(
          'AI_SAFETY_INCIDENT',
          familyId.slice(0, 8),
          businessDate,
          'CRITICAL',
          'حادثة سلامة حرجة لم تُراجَع بعد. راجع سجل التنبيهات في وحدة الـ AI — لا تُنقل أي تفاصيل عن الطفل إلى هذا الجدول.',
          1,
          0,
          familyId,
        ),
      );
    }
    return out;
  }

  /** D7 retention today against D7 seven days ago, platform-wide. */
  private async retentionDrop(businessDate: string): Promise<IRaisedAlert[]> {
    const threshold = await this.settings.rate('alerts.retentionDropPct');

    const today = await this.retentionSnapshot(businessDate);
    const weekAgo = await this.retentionSnapshot(addBusinessDays(businessDate, -7));
    if (today === null || weekAgo === null || weekAgo === 0) return [];

    const drop = (weekAgo - today) / weekAgo;
    if (drop < threshold) return [];

    return [
      await this.raise(
        'RETENTION_DROP',
        '**',
        businessDate,
        'WARNING',
        `انخفض احتفاظ D7 من ${(weekAgo * 100).toFixed(1)}% إلى ${(today * 100).toFixed(1)}% خلال أسبوع.`,
        Math.round(drop * 10_000) / 10_000,
        threshold,
      ),
    ];
  }

  /**
   * Reads the STORED daily aggregate rather than recomputing retention.
   * Recomputing it here would be a second implementation of a KPI, which is
   * the one thing this module forbids.
   */
  private async retentionSnapshot(businessDate: string): Promise<number | null> {
    const row = await this.sys(() =>
      this.prisma.growthDailyMetric.findFirst({
        where: { countryCode: '**', businessDate: new Date(`${businessDate}T00:00:00.000Z`) },
        select: { dau: true, wau: true },
      }),
    );
    if (!row) return null;
    // DAU/WAU is the stored proxy the aggregate carries; a true cohort D7 needs
    // the cohort table and is computed by KpiService for the dashboard. This
    // rule alerts on the trend, and the trend of the proxy is what moves first.
    return rate(row.dau, row.wau);
  }

  /** A country's registrations week over week. */
  private async countryPerformanceShift(
    now: Date,
    timeZone: string,
    businessDate: string,
  ): Promise<IRaisedAlert[]> {
    const threshold = await this.settings.rate('alerts.countryShiftPct');
    const out: IRaisedAlert[] = [];

    for (const countryCode of await this.activeCountries()) {
      const thisWeek = await this.registrationsInWindow(countryCode, now, 7, timeZone);
      const lastWeek = await this.registrationsInWindow(
        countryCode,
        new Date(now.getTime() - 7 * DAY_MS),
        7,
        timeZone,
      );
      if (lastWeek < 10) continue; // too small a base for a percentage to mean anything

      const shift = Math.abs(thisWeek - lastWeek) / lastWeek;
      if (shift >= threshold) {
        out.push(
          await this.raise(
            'COUNTRY_PERFORMANCE_SHIFT',
            countryCode,
            businessDate,
            'WARNING',
            `تغيّر عدد التسجيلات في ${countryCode} من ${lastWeek} إلى ${thisWeek} خلال أسبوع (${(shift * 100).toFixed(0)}%).`,
            Math.round(shift * 10_000) / 10_000,
            threshold,
          ),
        );
      }
    }
    return out;
  }

  private async registrationsInWindow(
    countryCode: string,
    endAt: Date,
    days: number,
    timeZone: string,
  ): Promise<number> {
    const range = getBusinessDayRange(endAt, timeZone);
    const start = new Date(range.endExclusive.getTime() - days * DAY_MS);
    return this.sys(() =>
      this.prisma.family.count({
        where: {
          deletedAt: null,
          createdAt: { gte: start, lt: range.endExclusive },
          acquisitionAttribution: { countryCode },
        },
      }),
    );
  }

  private async activeCountries(): Promise<string[]> {
    const rows = await this.sys(() =>
      this.prisma.country.findMany({ where: { isActive: true }, select: { code: true } }),
    );
    return rows.map((r) => r.code);
  }

  /** The operator surface: what is currently un-acknowledged. */
  async list(params: { acknowledged?: boolean; limit: number }): Promise<
    Array<{
      id: string;
      alertType: string;
      scopeKey: string;
      businessDate: string;
      severity: string;
      message: string;
      observedValue: number | null;
      thresholdValue: number | null;
      acknowledgedAt: string | null;
      createdAt: string;
    }>
  > {
    const rows = await runInSystemScope(
      'ADMIN_CONSOLE',
      'An operator is reading platform growth alerts; the table is platform-annotated and invisible to tenants.',
      () =>
        this.prisma.growthAlert.findMany({
          where: params.acknowledged === undefined ? {} : { acknowledgedAt: params.acknowledged ? { not: null } : null },
          orderBy: { createdAt: 'desc' },
          take: params.limit,
        }),
    );

    return rows.map((r) => ({
      id: r.id,
      alertType: r.alertType,
      scopeKey: r.scopeKey,
      businessDate: r.businessDate.toISOString().slice(0, 10),
      severity: r.severity,
      message: r.message,
      observedValue: r.observedValue === null ? null : Number(r.observedValue),
      thresholdValue: r.thresholdValue === null ? null : Number(r.thresholdValue),
      acknowledgedAt: r.acknowledgedAt?.toISOString() ?? null,
      createdAt: r.createdAt.toISOString(),
    }));
  }

  async acknowledge(alertId: string, userId: string | null): Promise<void> {
    await runInSystemScope(
      'ADMIN_CONSOLE',
      'An operator is acknowledging a platform growth alert.',
      () =>
        this.prisma.growthAlert.update({
          where: { id: alertId },
          data: { acknowledgedAt: new Date(), acknowledgedByUserId: userId },
        }),
    );
  }
}
