import { Injectable } from '@nestjs/common';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { getBusinessDate } from '../../../common/time/family-date';
import { runInSystemScope } from './system-scope';
import { GrowthSettingsService } from './growth-settings.service';
import { KPI_DEFINITIONS } from '../domain/kpi-definitions';
import { PLATFORM_SCOPE, familyCountryWhere } from '../domain/country-attribution';

/**
 * F1 — THE MARKET READS THE OWNER OPENS THE DASHBOARD FOR.
 *
 * `Family.countryCode` (migration 0022) is what made these answerable at all.
 * Before it, "how many households are there in Egypt" could only be produced by
 * splitting a platform total by some ratio, which is a guess wearing a number's
 * clothes — and the admin dashboard correctly rendered NOT MEASURED rather than
 * print one.
 *
 * FIVE RULES EVERY METHOD BELOW OBEYS, and they are the reason to read this
 * header before adding a sixth method:
 *
 *   1. ATTRIBUTION IS NOT DECIDED HERE. Every family-scoped count goes through
 *      `familyCountryWhere()` in `domain/country-attribution.ts` — the ONE
 *      predicate — so these numbers, the KPIs, the funnel, the daily aggregate
 *      and the alerts all agree about which households are Egyptian. A second
 *      predicate in this file would re-create exactly the defect that file was
 *      written to remove.
 *
 *   2. A NULL-COUNTRY HOUSEHOLD IS NEVER FOLDED INTO A MARKET, and never
 *      silently dropped from the platform either. It is excluded from `EG` and
 *      from `SA`, and included in `**`. `scopeIncludesUnattributable` on every
 *      response says which of the two the caller just asked for, so the
 *      dashboard can label the difference instead of a reader guessing at it.
 *      `platform − (EG + SA)` IS the unattributable population; no separate
 *      metric is invented to report a number that is already derivable.
 *
 *   3. A CURRENCY NEVER TRAVELS WITHOUT ITS COUNTRY. `currencyCode` comes from
 *      the `countries` row and is `null` at platform scope — deliberately, and
 *      for the reason `kpi-definitions.ts` states: EGP and SAR are not
 *      addable, and there is no FX rate in this layer to make them so. Nothing
 *      here returns money, so nothing here can add two currencies; the field
 *      exists so a per-country count is rendered under the right symbol.
 *
 *   4. COUNTS ARE AGGREGATED IN SQL. Every number below is a `count()` or a
 *      `groupBy()` — one integer per group off the wire. No method loads
 *      families into memory to length them, and no method takes a page: a
 *      `take` here is how a sweep silently reports on its first 200 rows.
 *
 *   5. ZERO AND «NO DATA» ARE DIFFERENT FACTS. A count that ran and found
 *      nothing IS 0 and is returned as 0 — that is a measurement. A field this
 *      schema cannot answer is `null` AND is named in `unmeasured[]` with the
 *      reason, so the dashboard renders the same "—" it already renders for a
 *      null KPI rather than a confident zero. There is no third state and no
 *      placeholder anywhere in this file.
 *
 * TENANCY. Every read is cross-tenant BY DEFINITION — a market total is a count
 * over households — so each one runs inside `runInSystemScope('ADMIN_CONSOLE')`
 * with its justification, exactly as `KpiService` does, and the only route to
 * it is behind `InternalAdminGuard`. There is no parent-facing variant of any
 * of these and there will not be one.
 */

/**
 * The subscription statuses that actually grant the product. The same three
 * `KpiService` (churn base), `ForecastService` and `GrowthAlertsService` use —
 * written out here rather than imported from `billing/domain/subscription-status.ts`
 * because that module speaks the CANONICAL vocabulary (`TRIAL`), while these
 * queries filter the Prisma enum (`TRIALING`). Two spellings of one idea is
 * worse than one honest literal with this comment beside it.
 */
const ENTITLEMENT_BEARING_STATUSES = ['ACTIVE', 'TRIALING', 'GRACE_PERIOD'] as const;

/** A field this schema genuinely cannot answer, and why. Never a zero. */
export interface IUnmeasuredField {
  readonly field: string;
  readonly reason: string;
}

export interface IMarketScope {
  /** ISO-3166 alpha-2, or `**` for the whole platform. */
  readonly countryCode: string;
  /** `null` at platform scope — see rule 3. */
  readonly currencyCode: string | null;
  /** True only for `**`: the number includes households of unknown market. */
  readonly scopeIncludesUnattributable: boolean;
}

export interface IFamilyCounts extends IMarketScope {
  readonly asOf: string;
  readonly businessDate: string;
  readonly reportingTimeZone: string;
  /** STOCK. Every household not soft-deleted, attributed to this market. */
  readonly registered: number;
  /** STOCK, on the MAU definition. See `activeDefinition`. */
  readonly active: number;
  readonly activeDefinition: 'MAU';
  readonly activeWindowDays: number;
}

export interface IPlanMix extends IMarketScope {
  readonly asOf: string;
  readonly registeredFamilies: number;
  /** Households with NO entitlement-bearing subscription. */
  readonly free: number;
  readonly monthly: number;
  readonly quarterly: number;
  readonly annual: number;
  /** Entitlement-bearing subscriptions sold before `billing_period` existed. */
  readonly billingPeriodUnknown: number;
  readonly entitlementBearingStatuses: readonly string[];
  readonly byPlanTier: readonly { readonly planTier: string; readonly count: number }[];
}

export interface IProductCounts extends IMarketScope {
  readonly from: string;
  readonly to: string;
  readonly goalsRequested: number;
  readonly goalsCompleted: number;
  readonly rewardsGranted: number;
  readonly rewardsRedeemed: number;
  readonly childrenGrantedAReward: number;
  /** `null`, and named in `unmeasured` — never 0. */
  readonly aiSessions: number | null;
  readonly unmeasured: readonly IUnmeasuredField[];
}

@Injectable()
export class MarketReportingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: GrowthSettingsService,
  ) {}

  /** The currency a market's prices are denominated in. `null` = platform scope. */
  private async currencyFor(countryCode: string): Promise<string | null> {
    if (countryCode === PLATFORM_SCOPE) return null;
    const country = await this.prisma.country.findUnique({
      where: { code: countryCode },
      select: { currencyCode: true },
    });
    return country?.currencyCode ?? null;
  }

  private scopeOf(countryCode: string, currencyCode: string | null): IMarketScope {
    return {
      countryCode,
      currencyCode,
      scopeIncludesUnattributable: countryCode === PLATFORM_SCOPE,
    };
  }

  /**
   * FAMILIES PER MARKET — the headline the country column unlocked.
   *
   * `registered` is a STOCK: every household this market owns right now, not a
   * flow of registrations. `growth_daily_metrics.new_registrations` is the flow
   * and accumulating it would drift, because it never comes back down when a
   * household is deleted.
   *
   * `active` uses the MAU DEFINITION EXACTLY — a device heartbeat inside the
   * rolling 30 days ending at `asOf`, the same signal `DashboardMetricsService`
   * has used since Sprint 8. It is not re-implemented here: the count is the
   * same `family.count` shape `KpiService.activeFamilies` runs, and the window
   * length is read off `KPI_DEFINITIONS.MAU.windowDays` so the two cannot drift
   * to different numbers of days. `activeDefinition` is on the wire so the
   * dashboard labels the tile with the definition rather than the word.
   */
  async families(countryCode: string, asOf: Date): Promise<IFamilyCounts> {
    const timeZone = await this.settings.reportingTimeZone(countryCode);
    const currencyCode = await this.currencyFor(countryCode);
    const windowDays = KPI_DEFINITIONS.MAU.windowDays ?? 30;
    const windowStart = new Date(asOf.getTime() - windowDays * 24 * 60 * 60 * 1000);

    return runInSystemScope(
      'ADMIN_CONSOLE',
      'A market total is a COUNT over every household; the cross-tenant aggregation is the feature and the surface is behind InternalAdminGuard.',
      async () => {
        const countryFilter = familyCountryWhere(countryCode);

        const [registered, active] = await Promise.all([
          this.prisma.family.count({ where: { deletedAt: null, ...countryFilter } }),
          this.prisma.family.count({
            where: {
              deletedAt: null,
              devices: { some: { deletedAt: null, lastSeenAt: { gte: windowStart, lt: asOf } } },
              ...countryFilter,
            },
          }),
        ]);

        return {
          ...this.scopeOf(countryCode, currencyCode),
          asOf: asOf.toISOString(),
          businessDate: getBusinessDate(asOf, timeZone),
          reportingTimeZone: timeZone,
          registered,
          active,
          activeDefinition: 'MAU' as const,
          activeWindowDays: windowDays,
        };
      },
    );
  }

  /**
   * THE PLAN MIX — free / monthly / quarterly / annual, per market.
   *
   * THE COUNTRY OF A SUBSCRIPTION IS THE COUNTRY OF ITS HOUSEHOLD, not
   * `subscriptions.country_code`. That is deliberate and it is the only choice
   * that keeps this endpoint consistent with the one above: `registered` here
   * and `free + monthly + quarterly + annual + billingPeriodUnknown` must
   * describe the same population, and they only do if both go through
   * `familyCountryWhere`. (That predicate already consults
   * `subscriptions.country_code` as its LAST fallback, so a household the
   * server has no country for is still attributed by what it bought.)
   *
   * `free` IS QUERIED, NOT SUBTRACTED. It is «a household with no
   * entitlement-bearing subscription», which includes both a household with no
   * subscription row at all and one whose subscription lapsed — computing it as
   * `registered − paid` would silently absorb any disagreement between the two
   * queries instead of letting it show.
   *
   * `billingPeriodUnknown` EXISTS SO NOTHING IS QUIETLY CALLED MONTHLY. Rows
   * sold before Phase D have a NULL `billing_period`; folding them into
   * `monthly` would overstate the monthly plan by exactly the pre-Phase-D
   * population, and dropping them would make the parts not sum to the whole.
   */
  async subscriptionMix(countryCode: string, asOf: Date): Promise<IPlanMix> {
    const currencyCode = await this.currencyFor(countryCode);

    return runInSystemScope(
      'ADMIN_CONSOLE',
      'The plan mix is a GROUP BY over every household\'s subscription; it is cross-tenant by definition and lives behind InternalAdminGuard.',
      async () => {
        const familyWhere = { deletedAt: null, ...familyCountryWhere(countryCode) };
        const entitled = { status: { in: [...ENTITLEMENT_BEARING_STATUSES] }, family: familyWhere };

        const [registeredFamilies, free, byPeriod, byTier] = await Promise.all([
          this.prisma.family.count({ where: familyWhere }),
          this.prisma.family.count({
            where: {
              ...familyWhere,
              NOT: { subscription: { status: { in: [...ENTITLEMENT_BEARING_STATUSES] } } },
            },
          }),
          this.prisma.subscription.groupBy({
            by: ['billingPeriod'],
            where: entitled,
            _count: { _all: true },
          }),
          this.prisma.subscription.groupBy({
            by: ['planTier'],
            where: entitled,
            _count: { _all: true },
          }),
        ]);

        const period = (value: 'MONTHLY' | 'QUARTERLY' | 'ANNUAL' | null): number =>
          byPeriod.find((row: { billingPeriod: string | null }) => row.billingPeriod === value)?._count?._all ?? 0;

        return {
          ...this.scopeOf(countryCode, currencyCode),
          asOf: asOf.toISOString(),
          registeredFamilies,
          free,
          monthly: period('MONTHLY'),
          quarterly: period('QUARTERLY'),
          annual: period('ANNUAL'),
          billingPeriodUnknown: period(null),
          entitlementBearingStatuses: [...ENTITLEMENT_BEARING_STATUSES],
          byPlanTier: byTier
            .map((row: { planTier: string; _count: { _all: number } }) => ({
              planTier: row.planTier,
              count: row._count._all,
            }))
            .sort((a: { planTier: string }, b: { planTier: string }) => a.planTier.localeCompare(b.planTier)),
        };
      },
    );
  }

  /**
   * GOALS COMPLETED AND REWARDS GRANTED, per market, over a window.
   *
   * These are FLOWS and are therefore windowed — `[from, to)`, half-open, so
   * two adjacent windows partition the period rather than double-counting the
   * instant they share.
   *
   * `goalsCompleted` is `achievement_requests.status = 'VERIFIED'` with
   * `decided_at` in the window. VERIFIED is the terminal success state and
   * `decided_at` is written in the SAME update that sets it (see
   * `AchievementService.markVerified`), so there is no VERIFIED row this window
   * can lose. Counting `created_at` instead would date a completion to the day
   * the child STARTED, which is a different fact.
   *
   * `rewardsGranted` is `rewards_ledger_entries.type = 'EARN'` — the same
   * predicate `FunnelService` already uses for «this household ever earned
   * something», so the funnel and this panel cannot disagree about what a grant
   * is. The ledger is append-only, which is what makes a count of it a fact
   * rather than a snapshot of mutable state.
   *
   * WHAT IS NOT ANSWERED, and why it is `null` rather than 0: there is no AI
   * SESSION anywhere in this schema. `ai_usage_logs` records model invocations,
   * which is a cost signal, not a session — a "session" would be a windowing
   * decision nobody has made, and inventing one here would publish it as a
   * measured fact.
   */
  async product(countryCode: string, from: Date, to: Date): Promise<IProductCounts> {
    const currencyCode = await this.currencyFor(countryCode);

    return runInSystemScope(
      'ADMIN_CONSOLE',
      'Product engagement is a COUNT over every household\'s achievements and ledger rows; cross-tenant by definition, behind InternalAdminGuard.',
      async () => {
        const familyWhere = { deletedAt: null, ...familyCountryWhere(countryCode) };
        const window = { gte: from, lt: to };

        const [goalsRequested, goalsCompleted, rewardsGranted, rewardsRedeemed, childrenGrantedAReward] =
          await Promise.all([
            this.prisma.achievementRequest.count({
              where: { createdAt: window, family: familyWhere },
            }),
            this.prisma.achievementRequest.count({
              where: { status: 'VERIFIED', decidedAt: window, family: familyWhere },
            }),
            this.prisma.rewardsLedgerEntry.count({
              where: { type: 'EARN', createdAt: window, family: familyWhere },
            }),
            this.prisma.rewardsLedgerEntry.count({
              where: { type: 'REDEEM', createdAt: window, family: familyWhere },
            }),
            this.prisma.child.count({
              where: {
                deletedAt: null,
                family: familyWhere,
                rewardsLedgerEntries: { some: { type: 'EARN', createdAt: window } },
              },
            }),
          ]);

        return {
          ...this.scopeOf(countryCode, currencyCode),
          from: from.toISOString(),
          to: to.toISOString(),
          goalsRequested,
          goalsCompleted,
          rewardsGranted,
          rewardsRedeemed,
          childrenGrantedAReward,
          aiSessions: null,
          unmeasured: [
            {
              field: 'aiSessions',
              reason:
                'No table models an AI SESSION. `ai_usage_logs` counts model invocations — a cost signal — and turning those into sessions needs a windowing rule nobody has decided. Returning 0 would publish that undecided rule as a measurement.',
            },
          ],
        };
      },
    );
  }
}
