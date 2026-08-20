import { Injectable, Logger } from '@nestjs/common';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { runInSystemScope } from './system-scope';
import { getBusinessDate, getBusinessDayRange } from '../../../common/time/family-date';
import { GrowthSettingsService } from './growth-settings.service';
import { KpiService, PLATFORM_SCOPE } from './kpi.service';
import { familyCountryWhere } from '../domain/country-attribution';
import { medianHours } from '../domain/kpi-definitions';

const DAY_MS = 24 * 60 * 60 * 1000;

export interface IAggregationOutcome {
  readonly businessDate: string;
  readonly countryCode: string;
  readonly created: boolean;
}

/**
 * PHASE D (GROWTH) — THE DAILY AGGREGATE, AND WHY IT IS AN UPSERT.
 *
 * WHAT IT IS FOR. A dashboard that recomputes DAU from `devices` on every page
 * load is a dashboard that gets slower every week and eventually becomes the
 * heaviest query in the system. This job freezes one row per (reporting day,
 * country) so the dashboard reads rows instead of scanning tables, and so that
 * "what was MRR on 3 March" is answerable next year without reconstructing the
 * price list as it stood that day.
 *
 * IDEMPOTENCY IS `growth_daily_metrics (business_date, country_code)` UNIQUE
 * plus an UPSERT. Re-running today's aggregation ten times produces one row
 * with today's numbers, not ten rows or one row with ten times the counts.
 * That property is what makes the job safe to trigger manually after an
 * incident, which is precisely when someone will want to.
 *
 * TIMEZONE CORRECTNESS. The day boundary for a country's row comes from
 * `getBusinessDayRange(instant, reporting.timezone.<CC>)` — Africa/Cairo for
 * Egypt, Asia/Riyadh for Saudi Arabia, both admin-editable. Egypt reintroduced
 * DST in 2023 and this reads it from tzdata rather than from a remembered
 * offset, exactly as `family-date.ts` documents. The zone that was used is
 * STORED on the row, so a later configuration change appears as a
 * discontinuity that can be segmented rather than as an unexplained step.
 *
 * IT AGGREGATES YESTERDAY, NOT TODAY. A row for a day that has not finished is
 * a row whose numbers will change, and a dashboard cell that changes while you
 * look at it destroys trust faster than a missing one. `run(now)` closes the
 * day that has ENDED on each country's own calendar — the same rule
 * `family-daily-rollover` follows.
 */
@Injectable()
export class GrowthAggregationService {
  private readonly logger = new Logger(GrowthAggregationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: GrowthSettingsService,
    private readonly kpis: KpiService,
  ) {}

  /** Closes the previous reporting day for every active country and the platform. */
  async run(now: Date): Promise<IAggregationOutcome[]> {
    const countries = await runInSystemScope(
      'SCHEDULED_JOB',
      'The growth aggregation enumerates active markets; the country catalogue is global reference data.',
      () => this.prisma.country.findMany({ where: { isActive: true }, select: { code: true, currencyCode: true } }),
    );

    const scopes: Array<{ code: string; currencyCode: string | null }> = [
      ...countries.map((c) => ({ code: c.code, currencyCode: c.currencyCode })),
      { code: PLATFORM_SCOPE, currencyCode: null },
    ];

    const out: IAggregationOutcome[] = [];
    for (const scope of scopes) {
      try {
        out.push(await this.aggregateOne(scope.code, scope.currencyCode, now));
      } catch (err) {
        this.logger.error(
          `growth.aggregation_failed scope=${scope.code} — ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return out;
  }

  private async aggregateOne(
    countryCode: string,
    currencyCode: string | null,
    now: Date,
  ): Promise<IAggregationOutcome> {
    const timeZone = await this.settings.reportingTimeZone(countryCode);
    // The day that has ENDED on this country's calendar.
    const closingInstant = new Date(now.getTime() - DAY_MS);
    const businessDate = getBusinessDate(closingInstant, timeZone);
    const { start, endExclusive } = getBusinessDayRange(closingInstant, timeZone);

    const snapshot = await this.kpis.snapshot({ countryCode, asOf: closingInstant });
    const valueOf = (id: string): number => {
      const found = snapshot.values.find((v) => v.kpi === id);
      return found?.value ?? 0;
    };

    return runInSystemScope(
      'SCHEDULED_JOB',
      'Writing one cross-tenant daily aggregate row; growth_daily_metrics is a global table with no family_id.',
      async () => {
        // F1 — «REGISTERED FAMILIES IN SA» BECOMES A REAL NUMBER HERE.
        //
        // `new_registrations` below is a `family.count` filtered by this
        // predicate, and until F1 the predicate could not see a family's own
        // country at all: it ORed the untrusted marketing label with the
        // subscription's country, so a household that told us it was in Saudi
        // Arabia at registration and had not yet bought anything counted in no
        // market. The inline copy is gone; this is the SAME predicate
        // `KpiService` uses, from the one file that defines it.
        const countryFilter = familyCountryWhere(countryCode);
        const subscriptionFilter = countryCode === PLATFORM_SCOPE ? {} : { countryCode };
        const window = { gte: start, lt: endExclusive };

        const [
          newRegistrations,
          activations,
          childrenAdded,
          devicesPaired,
          trialsStarted,
          trialsResolved,
          trialsConverted,
          newPaidFamilies,
          activePaidSubs,
          churnedPaidSubs,
          referralsQualified,
        ] = await Promise.all([
          this.prisma.family.count({ where: { deletedAt: null, createdAt: window, ...countryFilter } }),
          this.prisma.familyActivation.count({
            where: {
              occurredAt: window,
              ...(countryCode === PLATFORM_SCOPE ? {} : { countryCode }),
            },
          }),
          this.prisma.child.count({
            where: { createdAt: window, deletedAt: null, family: countryFilter },
          }),
          this.prisma.device.count({
            where: { createdAt: window, deletedAt: null, family: countryFilter },
          }),
          this.prisma.trial.count({ where: { startedAt: window } }),
          this.prisma.trial.count({ where: { endsAt: window } }),
          this.prisma.trial.count({ where: { convertedAt: window } }),
          this.prisma.family.count({
            where: {
              createdAt: window,
              paymentTransactions: { some: { status: 'SUCCEEDED' } },
              ...countryFilter,
            },
          }),
          this.prisma.subscription.count({
            where: { status: { in: ['ACTIVE', 'GRACE_PERIOD'] }, ...subscriptionFilter },
          }),
          this.prisma.subscription.count({
            where: { canceledAt: window, ...subscriptionFilter },
          }),
          this.prisma.referralEvent.count({ where: { kind: 'QUALIFIED', occurredAt: window } }),
        ]);

        const paymentGroups = await this.prisma.paymentTransaction.groupBy({
          by: ['status'],
          where: { occurredAt: window, ...(countryCode === PLATFORM_SCOPE ? {} : { countryCode }) },
          _count: { _all: true },
        });
        const paymentSuccessCount =
          paymentGroups.find((g) => g.status === 'SUCCEEDED')?._count._all ?? 0;
        const paymentFailureCount = paymentGroups.find((g) => g.status === 'FAILED')?._count._all ?? 0;

        // REVENUE IS PER-CURRENCY OR IT IS NOT REPORTED. The platform row has
        // no currency, so it carries zero revenue rather than a meaningless
        // sum of EGP and SAR — the same refusal `KpiService` makes.
        let netRevenueMinor = 0;
        let payingFamilies = 0;
        if (currencyCode) {
          const revenue = await this.prisma.paymentTransaction.aggregate({
            where: { status: 'SUCCEEDED', currency: currencyCode, countryCode, occurredAt: window },
            _sum: { netAmountMinor: true },
          });
          netRevenueMinor = revenue._sum.netAmountMinor ?? 0;
          payingFamilies = (
            await this.prisma.paymentTransaction.findMany({
              where: { status: 'SUCCEEDED', currency: currencyCode, countryCode, occurredAt: window },
              distinct: ['familyId'],
              select: { familyId: true },
            })
          ).length;
        }

        const ttvRows = await this.prisma.familyActivation.findMany({
          where: { occurredAt: window, ...(countryCode === PLATFORM_SCOPE ? {} : { countryCode }) },
          select: { timeToValueMinutes: true },
        });
        const medianTtvHours = medianHours(ttvRows.map((r) => r.timeToValueMinutes));

        const data = {
          currencyCode,
          reportingTimeZone: timeZone,
          dau: valueOf('DAU'),
          wau: valueOf('WAU'),
          mau: valueOf('MAU'),
          newRegistrations,
          activations,
          childrenAdded,
          devicesPaired,
          trialsStarted,
          trialsResolved,
          trialsConverted,
          newPaidFamilies,
          payingFamilies,
          activePaidSubs,
          churnedPaidSubs,
          paymentSuccessCount,
          paymentFailureCount,
          referralsQualified,
          netRevenueMinor,
          mrrMinor: valueOf('MRR'),
          medianTimeToValueMinutes: medianTtvHours === null ? null : Math.round(medianTtvHours * 60),
          computedAt: new Date(),
        };

        const existing = await this.prisma.growthDailyMetric.findFirst({
          where: { businessDate: new Date(`${businessDate}T00:00:00.000Z`), countryCode },
          select: { id: true },
        });

        await this.prisma.growthDailyMetric.upsert({
          where: {
            businessDate_countryCode: {
              businessDate: new Date(`${businessDate}T00:00:00.000Z`),
              countryCode,
            },
          },
          create: {
            businessDate: new Date(`${businessDate}T00:00:00.000Z`),
            countryCode,
            ...data,
          },
          update: data,
        });

        return { businessDate, countryCode, created: existing === null };
      },
    );
  }

  /** The stored series a dashboard charts. Read-only, admin-scoped. */
  async series(countryCode: string, fromDate: string, toDate: string): Promise<
    Array<Record<string, number | string | null>>
  > {
    return runInSystemScope(
      'ADMIN_CONSOLE',
      'Reading the stored cross-tenant daily aggregate for the admin dashboard.',
      async () => {
        const rows = await this.prisma.growthDailyMetric.findMany({
          where: {
            countryCode,
            businessDate: {
              gte: new Date(`${fromDate}T00:00:00.000Z`),
              lte: new Date(`${toDate}T00:00:00.000Z`),
            },
          },
          orderBy: { businessDate: 'asc' },
        });

        return rows.map((r) => ({
          businessDate: r.businessDate.toISOString().slice(0, 10),
          countryCode: r.countryCode,
          currencyCode: r.currencyCode,
          reportingTimeZone: r.reportingTimeZone,
          dau: r.dau,
          wau: r.wau,
          mau: r.mau,
          newRegistrations: r.newRegistrations,
          activations: r.activations,
          childrenAdded: r.childrenAdded,
          devicesPaired: r.devicesPaired,
          trialsStarted: r.trialsStarted,
          trialsResolved: r.trialsResolved,
          trialsConverted: r.trialsConverted,
          newPaidFamilies: r.newPaidFamilies,
          payingFamilies: r.payingFamilies,
          activePaidSubscriptions: r.activePaidSubs,
          churnedPaidSubscriptions: r.churnedPaidSubs,
          paymentSuccessCount: r.paymentSuccessCount,
          paymentFailureCount: r.paymentFailureCount,
          referralsQualified: r.referralsQualified,
          netRevenueMinor: r.netRevenueMinor,
          mrrMinor: r.mrrMinor,
          medianTimeToValueMinutes: r.medianTimeToValueMinutes,
        }));
      },
    );
  }
}
