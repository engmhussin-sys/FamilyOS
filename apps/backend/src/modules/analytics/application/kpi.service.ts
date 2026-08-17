import { Injectable } from '@nestjs/common';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { runInSystemScope } from './system-scope';
import { getBusinessDate, getBusinessDayRange, addBusinessDays } from '../../../common/time/family-date';
import { GrowthSettingsService } from './growth-settings.service';
import {
  KPI_DEFINITIONS,
  activationRate,
  arpu,
  arppu,
  arr,
  cac,
  churnRate,
  conversionRate,
  kpiValue,
  ltv,
  ltvToCac,
  medianHours,
  mrr,
  paybackMonths,
  retention,
  stickiness,
  trialConversionRate,
  type KpiValue,
  type MoneyKpi,
  type RetentionDay,
} from '../domain/kpi-definitions';
import { PLATFORM_SCOPE, familyCountryWhere } from '../domain/country-attribution';

/**
 * The platform-wide sentinel used by `growth_daily_metrics.country_code`.
 *
 * F1: it now LIVES in `domain/country-attribution.ts`, beside the predicate
 * that interprets it, and is RE-EXPORTED here so every existing importer
 * (`funnel.service.ts`, `growth-aggregation.service.ts`, the admin controller,
 * the e2e suite) keeps reading one constant rather than two.
 */
export { PLATFORM_SCOPE };

export interface IKpiQuery {
  /** ISO-3166 alpha-2, or `**` for the whole platform. */
  readonly countryCode: string;
  /** The reporting instant. Day boundaries are taken on the country's calendar. */
  readonly asOf: Date;
}

export interface IKpiSnapshot {
  readonly countryCode: string;
  readonly currencyCode: string | null;
  readonly businessDate: string;
  readonly reportingTimeZone: string;
  readonly values: readonly KpiValue[];
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * PHASE D (GROWTH) — THE ONLY SERVICE THAT PRODUCES KPI NUMBERS.
 *
 * Read what this class does and does NOT do, because the distinction is the
 * whole design:
 *
 *   IT QUERIES. Counts, sums, distinct-counts, all scoped to a country and to a
 *   day range computed on that country's reporting calendar.
 *
 *   IT DOES NOT COMPUTE. Not one division, not one ratio, not one rounding
 *   decision lives here. Every number is handed to a function in
 *   `domain/kpi-definitions.ts`, which is the single implementation of every
 *   KPI in this codebase. `test/analytics/kpi-single-source.spec.ts` scans
 *   `src/` and fails the build if that stops being true — including if it stops
 *   being true in THIS file.
 *
 * WHY THAT SEPARATION IS WORTH THE INDIRECTION: the alternative is a service
 * that computes `activeCount / (trialCount + activeCount)` inline, which is
 * exactly what `DashboardMetricsService` did before Phase D — a correct-looking
 * expression that used a different denominator from the one the deck used, and
 * nothing in the system could tell you they disagreed.
 *
 * TENANCY. Every read is cross-tenant BY DEFINITION — a DAU is a count over
 * households — so the whole surface runs under `ADMIN_CONSOLE` behind
 * `InternalAdminGuard`, and nothing here is reachable by a parent. There is no
 * family-scoped variant of these endpoints and there is not going to be one:
 * "how many families converted" is not a question a tenant may ask.
 *
 * DAY BOUNDARIES. Every window below comes from `getBusinessDayRange` /
 * `addBusinessDays` in `family-date.ts` with the COUNTRY's configured reporting
 * timezone. There is no `new Date().toISOString().slice(0,10)` and no
 * `- 7 * 86400000` masquerading as "a week" in this file.
 */
@Injectable()
export class KpiService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: GrowthSettingsService,
  ) {}

  /** The currency a country's money KPIs are denominated in. `null` = platform scope. */
  private async currencyFor(countryCode: string): Promise<string | null> {
    if (countryCode === PLATFORM_SCOPE) return null;
    const country = await this.prisma.country.findUnique({
      where: { code: countryCode },
      select: { currencyCode: true },
    });
    return country?.currencyCode ?? null;
  }

  /**
   * `where` fragment restricting families to a market.
   *
   * F1 — THIS METHOD NO LONGER DECIDES ANYTHING; it delegates to
   * `domain/country-attribution.ts`, which is now the single definition of "a
   * family belongs to this market" for the KPIs, the daily aggregate, the alerts
   * and the funnel. Before F1 this class ORed the marketing label with the
   * subscription's country and `GrowthAlertsService` used the label alone, so
   * two surfaces answered "families in SA" with two different sets.
   *
   * WHAT CHANGED IN THE ANSWER: `families.country_code` — the server's own,
   * foreign-key-backed record — now takes precedence, and the marketing label is
   * consulted only for households that have none. Read that file for what
   * happens to a family with no country anywhere (short version: excluded from
   * every country, included in the platform total, never silently folded into
   * EG).
   */
  private familyCountryFilter(countryCode: string): Record<string, unknown> {
    return familyCountryWhere(countryCode);
  }

  async snapshot(query: IKpiQuery): Promise<IKpiSnapshot> {
    const timeZone = await this.settings.reportingTimeZone(query.countryCode);
    const businessDate = getBusinessDate(query.asOf, timeZone);
    const currencyCode = await this.currencyFor(query.countryCode);

    return runInSystemScope(
      'ADMIN_CONSOLE',
      'Growth KPIs are counts and sums OVER households; the aggregation is the feature and the surface is behind InternalAdminGuard.',
      async () => {
        const values: KpiValue[] = [];
        const countryFilter = this.familyCountryFilter(query.countryCode);

        // ---- active users -------------------------------------------------
        const dayRange = getBusinessDayRange(query.asOf, timeZone);
        const [dau, wau, mau] = await Promise.all([
          this.activeFamilies(dayRange.start, dayRange.endExclusive, countryFilter),
          this.activeFamilies(new Date(dayRange.endExclusive.getTime() - 7 * DAY_MS), dayRange.endExclusive, countryFilter),
          this.activeFamilies(new Date(dayRange.endExclusive.getTime() - 30 * DAY_MS), dayRange.endExclusive, countryFilter),
        ]);

        values.push(kpiValue('DAU', 'ACTUAL', dau));
        values.push(kpiValue('WAU', 'ACTUAL', wau));
        values.push(kpiValue('MAU', 'ACTUAL', mau));
        values.push(kpiValue('STICKINESS', 'ACTUAL', stickiness({ dau, wau, mau })));

        // ---- activation ---------------------------------------------------
        // The cohort is families registered in the 30 days ENDING 30 days ago,
        // so every member has had a full month to activate. Using "the last 30
        // days" would count a family that registered this morning as a failure.
        const cohortEnd = new Date(dayRange.endExclusive.getTime() - 30 * DAY_MS);
        const cohortStart = new Date(cohortEnd.getTime() - 30 * DAY_MS);
        const [cohortSize, activated] = await Promise.all([
          this.prisma.family.count({
            where: { deletedAt: null, createdAt: { gte: cohortStart, lt: cohortEnd }, ...countryFilter },
          }),
          this.prisma.family.count({
            where: {
              deletedAt: null,
              createdAt: { gte: cohortStart, lt: cohortEnd },
              activation: { isNot: null },
              ...countryFilter,
            },
          }),
        ]);
        values.push(kpiValue('ACTIVATION_RATE', 'ACTUAL', activationRate(activated, cohortSize)));

        const ttvRows = await this.prisma.familyActivation.findMany({
          where: {
            occurredAt: { gte: new Date(dayRange.endExclusive.getTime() - 90 * DAY_MS) },
            ...(query.countryCode === PLATFORM_SCOPE ? {} : { countryCode: query.countryCode }),
          },
          select: { timeToValueMinutes: true },
        });
        values.push(
          kpiValue('TIME_TO_VALUE_HOURS', 'ACTUAL', medianHours(ttvRows.map((r) => r.timeToValueMinutes))),
        );

        // ---- retention ----------------------------------------------------
        for (const day of [1, 7, 30, 90] as RetentionDay[]) {
          const { retained, size } = await this.retentionCohort(day, businessDate, timeZone, countryFilter);
          values.push(
            kpiValue(
              day === 1 ? 'RETENTION_D1' : day === 7 ? 'RETENTION_D7' : day === 30 ? 'RETENTION_D30' : 'RETENTION_D90',
              'ACTUAL',
              retention(retained, size),
            ),
          );
        }

        // ---- churn --------------------------------------------------------
        const periodStart = new Date(dayRange.endExclusive.getTime() - 30 * DAY_MS);
        const [paidAtStart, churnedInPeriod] = await Promise.all([
          this.prisma.subscription.count({
            where: {
              status: { in: ['ACTIVE', 'TRIALING', 'GRACE_PERIOD'] },
              createdAt: { lt: periodStart },
              ...(query.countryCode === PLATFORM_SCOPE ? {} : { countryCode: query.countryCode }),
            },
          }),
          this.prisma.subscription.count({
            where: {
              status: { in: ['CANCELED', 'EXPIRED'] },
              canceledAt: { gte: periodStart, lt: dayRange.endExclusive },
              ...(query.countryCode === PLATFORM_SCOPE ? {} : { countryCode: query.countryCode }),
            },
          }),
        ]);
        const churn = churnRate(churnedInPeriod, paidAtStart);
        values.push(kpiValue('CHURN_RATE', 'ACTUAL', churn));

        // ---- conversion ---------------------------------------------------
        const [everPaid, conversionCohort] = await Promise.all([
          this.prisma.family.count({
            where: {
              deletedAt: null,
              createdAt: { gte: cohortStart, lt: cohortEnd },
              paymentTransactions: { some: { status: 'SUCCEEDED' } },
              ...countryFilter,
            },
          }),
          Promise.resolve(cohortSize),
        ]);
        values.push(kpiValue('CONVERSION_RATE', 'ACTUAL', conversionRate(everPaid, conversionCohort)));

        const [resolvedTrials, convertedTrials] = await Promise.all([
          this.prisma.trial.count({ where: { endsAt: { lt: dayRange.endExclusive } } }),
          this.prisma.trial.count({
            where: { endsAt: { lt: dayRange.endExclusive }, convertedAt: { not: null } },
          }),
        ]);
        values.push(
          kpiValue('TRIAL_CONVERSION_RATE', 'ACTUAL', trialConversionRate(convertedTrials, resolvedTrials)),
        );

        // ---- money --------------------------------------------------------
        // EVERY money KPI is null at platform scope, deliberately: a
        // platform-wide ARPU would have to add EGP to SAR, and this module
        // refuses to do that without an FX rate it does not have.
        let arppuValue: MoneyKpi | null = null;
        let cacValue: MoneyKpi | null = null;

        if (currencyCode) {
          const revenueWindowStart = periodStart;
          const revenue = await this.prisma.paymentTransaction.aggregate({
            where: {
              status: 'SUCCEEDED',
              currency: currencyCode,
              countryCode: query.countryCode,
              occurredAt: { gte: revenueWindowStart, lt: dayRange.endExclusive },
            },
            _sum: { netAmountMinor: true },
          });
          const netRevenueMinor = revenue._sum.netAmountMinor ?? 0;

          const payingFamilies = (
            await this.prisma.paymentTransaction.findMany({
              where: {
                status: 'SUCCEEDED',
                currency: currencyCode,
                countryCode: query.countryCode,
                occurredAt: { gte: revenueWindowStart, lt: dayRange.endExclusive },
              },
              distinct: ['familyId'],
              select: { familyId: true },
            })
          ).length;

          values.push(kpiValue('ARPU', 'ACTUAL', arpu(netRevenueMinor, mau, currencyCode)));
          arppuValue = arppu(netRevenueMinor, payingFamilies, currencyCode);
          values.push(kpiValue('ARPPU', 'ACTUAL', arppuValue));

          const mrrValue = await this.monthlyRecurring(query.countryCode, currencyCode);
          values.push(kpiValue('MRR', 'ACTUAL', mrrValue));
          values.push(kpiValue('ARR', 'ACTUAL', arr(mrrValue)));

          const spend = await this.prisma.campaignDailySpend.aggregate({
            where: {
              campaign: { countryCode: query.countryCode, currencyCode },
              businessDate: { gte: new Date(`${addBusinessDays(businessDate, -30)}T00:00:00.000Z`) },
            },
            _sum: { spendMinor: true },
          });
          const newPaid = await this.prisma.family.count({
            where: {
              createdAt: { gte: periodStart, lt: dayRange.endExclusive },
              paymentTransactions: { some: { status: 'SUCCEEDED' } },
              ...countryFilter,
            },
          });
          cacValue = cac(spend._sum.spendMinor ?? 0, newPaid, currencyCode);
          values.push(kpiValue('CAC', 'ACTUAL', cacValue));

          // LTV IS TAGGED FORECAST, ALWAYS. It multiplies a measured ARPPU by
          // an ASSUMED gross margin and an inferred lifetime; presenting it as
          // ACTUAL would be exactly the failure `KpiProvenance` exists for.
          const marginKey = `economics.grossMarginRate.${query.countryCode}`;
          const margin = await this.settings
            .get(marginKey)
            .then((v) => (typeof v === 'number' ? v : null))
            .catch(() => null);

          const ltvValue = arppuValue && margin !== null && churn !== null ? ltv(arppuValue, margin, churn) : null;
          values.push(kpiValue('LTV', 'FORECAST', ltvValue));
          values.push(
            kpiValue('LTV_CAC_RATIO', 'FORECAST', ltvValue && cacValue ? ltvToCac(ltvValue, cacValue) : null),
          );
          values.push(
            kpiValue(
              'PAYBACK_MONTHS',
              'FORECAST',
              cacValue && arppuValue && margin !== null ? paybackMonths(cacValue, arppuValue, margin) : null,
            ),
          );
        } else {
          for (const id of ['ARPU', 'ARPPU', 'MRR', 'ARR', 'CAC', 'LTV', 'LTV_CAC_RATIO', 'PAYBACK_MONTHS'] as const) {
            values.push(kpiValue(id, id === 'LTV' || id === 'LTV_CAC_RATIO' || id === 'PAYBACK_MONTHS' ? 'FORECAST' : 'ACTUAL', null));
          }
        }

        return { countryCode: query.countryCode, currencyCode, businessDate, reportingTimeZone: timeZone, values };
      },
    );
  }

  /**
   * ACTIVE = a device heartbeat in the window. The same signal
   * `DashboardMetricsService` has used since Sprint 8, not a new one invented
   * here — two definitions of "active" is precisely what this module exists to
   * prevent.
   */
  private async activeFamilies(
    from: Date,
    toExclusive: Date,
    countryFilter: Record<string, unknown>,
  ): Promise<number> {
    const rows = await this.prisma.device.findMany({
      where: {
        deletedAt: null,
        lastSeenAt: { gte: from, lt: toExclusive },
        ...(Object.keys(countryFilter).length > 0 ? { family: countryFilter } : {}),
      },
      distinct: ['familyId'],
      select: { familyId: true },
    });
    return rows.length;
  }

  /**
   * Classic day-N retention: families that registered on the cohort DAY and
   * were active on day N EXACTLY. A cohort too young to have reached day N
   * returns `null` for the numerator, which `retention()` turns into a null
   * KPI rather than a 0% that would look like a catastrophe.
   */
  private async retentionCohort(
    day: RetentionDay,
    businessDate: string,
    timeZone: string,
    countryFilter: Record<string, unknown>,
  ): Promise<{ retained: number | null; size: number }> {
    const cohortDate = addBusinessDays(businessDate, -day);
    const cohortRange = getBusinessDayRange(cohortDate, timeZone);
    const targetRange = getBusinessDayRange(businessDate, timeZone);

    const size = await this.prisma.family.count({
      where: {
        deletedAt: null,
        createdAt: { gte: cohortRange.start, lt: cohortRange.endExclusive },
        ...countryFilter,
      },
    });
    if (size === 0) return { retained: null, size: 0 };

    const retainedRows = await this.prisma.device.findMany({
      where: {
        deletedAt: null,
        lastSeenAt: { gte: targetRange.start, lt: targetRange.endExclusive },
        family: {
          createdAt: { gte: cohortRange.start, lt: cohortRange.endExclusive },
          ...countryFilter,
        },
      },
      distinct: ['familyId'],
      select: { familyId: true },
    });

    return { retained: retainedRows.length, size };
  }

  /**
   * MRR from the PRICE LIST, not from last month's cash. An annual plan
   * contributes `net / 12`; the normalisation itself is done by `mrr()` in the
   * definitions module, which is why `billingIntervalMonths` is passed rather
   * than pre-divided here.
   */
  private async monthlyRecurring(countryCode: string, currencyCode: string): Promise<MoneyKpi> {
    const subscriptions = await this.prisma.subscription.findMany({
      where: {
        status: { in: ['ACTIVE', 'GRACE_PERIOD'] },
        countryCode,
        currencyCode,
      },
      select: { planTier: true, billingPeriod: true },
    });

    const prices = await this.prisma.subscriptionPrice.findMany({
      where: { countryCode, currencyCode, isActive: true },
      select: { planTier: true, billingPeriod: true, amountMinor: true },
    });
    const priceByKey = new Map(prices.map((p) => [`${p.planTier}:${p.billingPeriod}`, p.amountMinor]));

    const country = await this.prisma.country.findUnique({
      where: { code: countryCode },
      select: { vatBasisPoints: true },
    });
    const vatBps = country?.vatBasisPoints ?? 0;

    const components = subscriptions.flatMap((s) => {
      const amount = priceByKey.get(`${s.planTier}:${s.billingPeriod}`);
      if (amount === undefined) return [];
      // NET of VAT, matching the ARPU definition. The price list is stored
      // VAT-INCLUSIVE for these markets, so the net is gross × 10000/(10000+bps).
      const net = Math.round((amount * 10_000) / (10_000 + vatBps));
      const months = s.billingPeriod === 'ANNUAL' ? 12 : s.billingPeriod === 'QUARTERLY' ? 3 : 1;
      return [{ netAmountMinor: net, billingIntervalMonths: months }];
    });

    return mrr(components, currencyCode);
  }

  /** The definitions table itself — the dashboard renders formulas next to numbers. */
  definitions(): typeof KPI_DEFINITIONS {
    return KPI_DEFINITIONS;
  }
}
