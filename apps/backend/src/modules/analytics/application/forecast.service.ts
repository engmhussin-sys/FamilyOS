import { Injectable } from '@nestjs/common';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { runInSystemScope } from './system-scope';
import { cac, churnRate } from '../domain/kpi-definitions';
import {
  QUARTERS,
  TARGET_METRICS,
  projectScenario,
  quarterDateRange,
  validateAssumptions,
  type ForecastScenarioName,
  type IForecastAssumptions,
  type IForecastResult,
  type IQuarterlyComparison,
  type Quarter,
  type TargetMetric,
} from '../domain/forecast';

export interface IScenarioInput extends IForecastAssumptions {
  readonly countryCode: string;
  readonly currencyCode: string;
  readonly scenario: ForecastScenarioName;
}

/**
 * PHASE D (GROWTH) — FORECASTS, TARGETS AND ACTUALS, KEPT APART BY CONSTRUCTION.
 *
 * The API this service backs returns THREE SEPARATE FIELDS — `target`,
 * `actual`, `forecast` — for every metric of every quarter, and never a single
 * `value` a caller has to interpret. A dashboard that wants one number has to
 * decide which one it is showing, which is precisely the decision that must not
 * be made silently.
 *
 *   `target`   is a row a human wrote. `null` means nobody set one. It is
 *              NEVER inferred from a forecast — a projection that becomes a
 *              commitment because no one typed a number is how a company ends
 *              up accountable to its own optimism.
 *   `actual`   is measured from rows that exist, and is `null` before the
 *              quarter starts rather than 0.
 *   `forecast` is derived from `growth_forecast_scenarios`, and the assumptions
 *              are RETURNED ALONGSIDE it so a reader can disagree with the
 *              inputs rather than with the output.
 */
@Injectable()
export class ForecastService {
  constructor(private readonly prisma: PrismaService) {}

  private sys<T>(what: string, fn: () => Promise<T>): Promise<T> {
    return runInSystemScope(
      'ADMIN_CONSOLE',
      `Forecasting reads company-level plans and cross-tenant actuals; ${what}.`,
      fn,
    );
  }

  /** Upserts one scenario. Assumptions are validated before they can be stored. */
  async upsertScenario(input: IScenarioInput, updatedByUserId: string | null): Promise<void> {
    validateAssumptions(input);
    await this.sys('an admin is editing a scenario\'s assumptions', () =>
      this.prisma.growthForecastScenario.upsert({
        where: {
          countryCode_scenario: { countryCode: input.countryCode.toUpperCase(), scenario: input.scenario },
        },
        create: {
          scenario: input.scenario,
          countryCode: input.countryCode.toUpperCase(),
          currencyCode: input.currencyCode.toUpperCase(),
          monthlyAcquisition: input.monthlyAcquisition,
          conversionRate: input.conversionRate,
          paidConversionRate: input.paidConversionRate,
          churnRate: input.churnRate,
          arpuMinor: input.arpuMinor,
          cacMinor: input.cacMinor,
          retentionD30: input.retentionD30,
          updatedByUserId,
        },
        update: {
          currencyCode: input.currencyCode.toUpperCase(),
          monthlyAcquisition: input.monthlyAcquisition,
          conversionRate: input.conversionRate,
          paidConversionRate: input.paidConversionRate,
          churnRate: input.churnRate,
          arpuMinor: input.arpuMinor,
          cacMinor: input.cacMinor,
          retentionD30: input.retentionD30,
          updatedByUserId,
        },
      }),
    );
  }

  /** Every stored scenario for a country, projected forward. Tagged FORECAST. */
  async project(countryCode: string, months = 12): Promise<IForecastResult[]> {
    const rows = await this.sys('projecting the stored scenarios', () =>
      this.prisma.growthForecastScenario.findMany({
        where: { countryCode: countryCode.toUpperCase(), isActive: true },
        orderBy: { scenario: 'asc' },
      }),
    );

    // The projection starts from the CURRENT paid base, not from zero, so month
    // 1 of a forecast is comparable with the actual it will be measured against.
    const openingPaid = await this.sys('reading the current paid base', () =>
      this.prisma.subscription.count({
        where: { status: { in: ['ACTIVE', 'GRACE_PERIOD'] }, countryCode: countryCode.toUpperCase() },
      }),
    );

    return rows.map((row) =>
      projectScenario(
        row.scenario as ForecastScenarioName,
        row.countryCode,
        row.currencyCode,
        {
          monthlyAcquisition: row.monthlyAcquisition,
          conversionRate: Number(row.conversionRate),
          paidConversionRate: Number(row.paidConversionRate),
          churnRate: Number(row.churnRate),
          arpuMinor: row.arpuMinor,
          cacMinor: row.cacMinor,
          retentionD30: Number(row.retentionD30),
        },
        months,
        openingPaid,
      ),
    );
  }

  async setTarget(
    countryCode: string,
    year: number,
    quarter: Quarter,
    metric: TargetMetric,
    targetValue: number,
    currencyCode: string | null,
    setByUserId: string | null,
    note: string | null,
  ): Promise<void> {
    await this.sys('an admin is committing to a quarterly target', () =>
      this.prisma.growthQuarterlyTarget.upsert({
        where: {
          countryCode_year_quarter_metric: {
            countryCode: countryCode.toUpperCase(),
            year,
            quarter,
            metric,
          },
        },
        create: {
          countryCode: countryCode.toUpperCase(),
          year,
          quarter,
          metric,
          targetValue,
          currencyCode,
          setByUserId,
          note,
        },
        update: { targetValue, currencyCode, setByUserId, note },
      }),
    );
  }

  /**
   * THE THREE-WAY VIEW. One row per (metric, quarter), with all three fields
   * always present and `null` where there is genuinely nothing to say.
   */
  async quarterlyComparison(
    countryCode: string,
    year: number,
    now: Date,
  ): Promise<IQuarterlyComparison[]> {
    const country = countryCode.toUpperCase();

    const [targets, scenarios] = await Promise.all([
      this.sys('reading committed targets', () =>
        this.prisma.growthQuarterlyTarget.findMany({ where: { countryCode: country, year } }),
      ),
      this.project(country, 12),
    ]);

    const base = scenarios.find((s) => s.scenario === 'BASE') ?? scenarios[0] ?? null;
    const targetByKey = new Map(targets.map((t) => [`${t.quarter}:${t.metric}`, t]));

    const out: IQuarterlyComparison[] = [];

    for (const quarter of QUARTERS) {
      const range = quarterDateRange(year, quarter);
      const start = new Date(`${range.start}T00:00:00.000Z`);
      const endExclusive = new Date(`${range.endExclusive}T00:00:00.000Z`);
      const started = now.getTime() >= start.getTime();

      const actuals = started ? await this.actualsFor(country, start, endExclusive) : null;
      const forecast = base ? this.forecastFor(base, quarter) : null;

      for (const metric of TARGET_METRICS) {
        const target = targetByKey.get(`${quarter}:${metric}`);
        const targetValue = target ? Number(target.targetValue) : null;
        const actualValue = actuals ? actuals[metric] : null;

        out.push({
          countryCode: country,
          year,
          quarter,
          metric,
          target: targetValue,
          actual: actualValue,
          forecast: forecast ? forecast[metric] : null,
          attainment:
            targetValue !== null && targetValue !== 0 && actualValue !== null
              ? Math.round((actualValue / targetValue) * 10_000) / 10_000
              : null,
          currencyCode: target?.currencyCode ?? base?.currencyCode ?? null,
        });
      }
    }

    return out;
  }

  /** Measured values for one quarter. Every one of them is a row that exists. */
  private async actualsFor(
    countryCode: string,
    start: Date,
    endExclusive: Date,
  ): Promise<Record<TargetMetric, number | null>> {
    return this.sys('measuring one quarter\'s actuals across every household in the market', async () => {
      const familyFilter = {
        OR: [
          { acquisitionAttribution: { countryCode } },
          { subscription: { countryCode } },
        ],
      };

      const [users, paidUsers, subscriptions, churned, paidAtStart, revenue] = await Promise.all([
        this.prisma.family.count({
          where: { deletedAt: null, createdAt: { gte: start, lt: endExclusive }, ...familyFilter },
        }),
        this.prisma.family.count({
          where: {
            deletedAt: null,
            createdAt: { gte: start, lt: endExclusive },
            paymentTransactions: { some: { status: 'SUCCEEDED' } },
            ...familyFilter,
          },
        }),
        this.prisma.subscription.count({
          where: { countryCode, createdAt: { gte: start, lt: endExclusive } },
        }),
        this.prisma.subscription.count({
          where: { countryCode, canceledAt: { gte: start, lt: endExclusive } },
        }),
        this.prisma.subscription.count({
          where: {
            countryCode,
            status: { in: ['ACTIVE', 'TRIALING', 'GRACE_PERIOD'] },
            createdAt: { lt: start },
          },
        }),
        this.prisma.paymentTransaction.aggregate({
          where: { countryCode, status: 'SUCCEEDED', occurredAt: { gte: start, lt: endExclusive } },
          _sum: { netAmountMinor: true },
        }),
      ]);

      const netRevenue = revenue._sum.netAmountMinor ?? 0;
      const spend = await this.prisma.campaignDailySpend.aggregate({
        where: { campaign: { countryCode }, businessDate: { gte: start, lt: endExclusive } },
        _sum: { spendMinor: true },
      });

      // CURRENCY. A quarter's acquisition cost is denominated in the market's
      // own currency; the code is read from the country rather than assumed, so
      // an EGP campaign can never be divided into a SAR revenue number.
      const country = await this.prisma.country.findUnique({
        where: { code: countryCode },
        select: { currencyCode: true },
      });
      const currency = country?.currencyCode ?? 'XXX';

      return {
        USERS: users,
        PAID_USERS: paidUsers,
        REVENUE_MINOR: netRevenue,
        SUBSCRIPTIONS: subscriptions,
        // Both go through the SAME definitions every other surface uses —
        // `cac()` and `churnRate()` — rather than being re-derived here. That
        // is the whole point of the definitions module: a quarterly report and
        // a daily dashboard cannot disagree about what churn means.
        CAC_MINOR: cac(spend._sum.spendMinor ?? 0, paidUsers, currency)?.amountMinor ?? null,
        CHURN_RATE: churnRate(churned, paidAtStart),
        // MRR at quarter end is a point-in-time fact the daily aggregate holds.
        MRR_MINOR: await this.mrrAtQuarterEnd(countryCode, endExclusive),
      };
    });
  }

  /** Reads the last daily aggregate inside the quarter rather than recomputing. */
  private async mrrAtQuarterEnd(countryCode: string, endExclusive: Date): Promise<number | null> {
    const row = await this.prisma.growthDailyMetric.findFirst({
      where: { countryCode, businessDate: { lt: endExclusive } },
      orderBy: { businessDate: 'desc' },
      select: { mrrMinor: true },
    });
    return row?.mrrMinor ?? null;
  }

  /** The projected values for one quarter, taken from the monthly roll-forward. */
  private forecastFor(result: IForecastResult, quarter: Quarter): Record<TargetMetric, number | null> {
    const months = result.months.slice((quarter - 1) * 3, quarter * 3);
    if (months.length === 0) return emptyMetrics();

    const last = months[months.length - 1];
    const newPaid = months.reduce((s, m) => s + m.newPaid, 0);
    const spend = months.reduce((s, m) => s + m.acquisitionSpendMinor, 0);
    const revenue = months.reduce((s, m) => s + m.mrrMinor, 0);

    return {
      USERS: months.reduce((s, m) => s + m.newRegistrations, 0),
      PAID_USERS: newPaid,
      REVENUE_MINOR: revenue,
      SUBSCRIPTIONS: newPaid,
      // Same function as the ACTUAL above. A forecast CAC computed differently
      // from a measured CAC would make the comparison between them meaningless.
      CAC_MINOR: cac(spend, newPaid, result.currencyCode)?.amountMinor ?? null,
      // The ASSUMPTION itself, echoed back — a projected churn is an input, not
      // a derivation, and pretending otherwise would hide where it came from.
      CHURN_RATE: result.assumptions.churnRate,
      MRR_MINOR: last.mrrMinor,
    };
  }
}

function emptyMetrics(): Record<TargetMetric, number | null> {
  return {
    USERS: null,
    PAID_USERS: null,
    REVENUE_MINOR: null,
    SUBSCRIPTIONS: null,
    CAC_MINOR: null,
    CHURN_RATE: null,
    MRR_MINOR: null,
  };
}
