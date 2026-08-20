import type {
  Campaign,
  ChannelRow,
  CountryCode,
  CurrencyCode,
  DailyMetricRow,
  GrowthSetting,
  KpiSnapshot,
  KpiValue,
} from './types';

/**
 * ── THE ADAPTER LAYER ──────────────────────────────────────────────────
 *
 * The brief asks for a handful of numbers the growth contract v1.0 does not
 * expose. There are exactly two honest responses to that, and inventing a
 * plausible number is neither of them:
 *
 *   1. COMPOSE it from endpoints that DO exist, and say so in the UI.
 *   2. Declare it MISSING, render "no data yet — endpoint not available",
 *      and carry the gap into the report.
 *
 * Everything in this file is one of those two. There is no fixture, no
 * seeded array and no fallback constant anywhere below — a `MISSING` result
 * carries no numbers at all, precisely so that no view can accidentally
 * render one.
 */

export type AdapterKind = 'COMPOSED' | 'MISSING';

export interface AdapterGap {
  /** Stable id, also used as the i18n key suffix and as the report's row id. */
  id: string;
  /** The endpoint that would close this gap, in the contract's own shape. */
  proposedEndpoint: string;
  /** i18n key for the operator-facing explanation. */
  reasonKey: string;
}

/** A number this client assembled from endpoints that DO exist. */
export interface ComposedResult<T> {
  kind: 'COMPOSED';
  data: T;
  composedFrom: string[];
}

/** A number no endpoint provides. Carries no data field at all, so no view
 * can render one by accident. */
export interface MissingResult {
  kind: 'MISSING';
  gap: AdapterGap;
}

export type AdapterResult<T> = ComposedResult<T> | MissingResult;

export const GAPS = {
  referralAdminSummary: {
    id: 'referralAdminSummary',
    proposedEndpoint: 'GET /admin/growth/referral/summary?countryCode&from&to',
    reasonKey: 'growth.gap.referralAdminSummary',
  },
  productAiMetrics: {
    id: 'productAiMetrics',
    proposedEndpoint: 'GET /admin/growth/product?countryCode&from&to',
    reasonKey: 'growth.gap.productAiMetrics',
  },
  cohortRetention: {
    id: 'cohortRetention',
    proposedEndpoint: 'GET /admin/growth/retention/cohorts?countryCode&from&to',
    reasonKey: 'growth.gap.cohortRetention',
  },
  refunds: {
    id: 'refunds',
    proposedEndpoint: 'GET /admin/growth/refunds?countryCode&from&to',
    reasonKey: 'growth.gap.refunds',
  },
  activeChildren: {
    id: 'activeChildren',
    proposedEndpoint: 'KPI `ACTIVE_CHILDREN` in GET /admin/growth/kpis',
    reasonKey: 'growth.gap.activeChildren',
  },
  activeParents: {
    id: 'activeParents',
    proposedEndpoint: 'KPI `ACTIVE_PARENTS` in GET /admin/growth/kpis',
    reasonKey: 'growth.gap.activeParents',
  },
  familiesByCountry: {
    id: 'familiesByCountry',
    proposedEndpoint: 'GET /admin/growth/families?countryCode&asOf → { registered, active }',
    reasonKey: 'growth.gap.familiesByCountry',
  },
  subscriptionPlanMix: {
    id: 'subscriptionPlanMix',
    proposedEndpoint: 'GET /admin/growth/subscriptions?countryCode&asOf → { free, monthly, annual }',
    reasonKey: 'growth.gap.subscriptionPlanMix',
  },
  pilotEnrollment: {
    id: 'pilotEnrollment',
    proposedEndpoint: 'GET /admin/growth/pilot?countryCode → { invited, activated, byStatus }',
    reasonKey: 'growth.gap.pilotEnrollment',
  },
  safetyEvents: {
    id: 'safetyEvents',
    proposedEndpoint: 'GET /admin/growth/safety?countryCode&from&to → events by kind',
    reasonKey: 'growth.gap.safetyEvents',
  },
} as const satisfies Record<string, AdapterGap>;

export const ALL_GAPS: readonly AdapterGap[] = Object.values(GAPS);

// ── Composed: the executive headline counts ──────────────────────────────

export interface ExecutiveCounts {
  /** Stock, latest closed business day. */
  payingFamilies: number | null;
  activePaidSubscriptions: number | null;
  /** Flow over the requested window. */
  churnedPaidSubscriptions: number | null;
  newRegistrations: number | null;
  activations: number | null;
  childrenAdded: number | null;
  trialsStarted: number | null;
  trialsResolved: number | null;
  trialsConverted: number | null;
  newPaidFamilies: number | null;
  paymentSuccessCount: number | null;
  paymentFailureCount: number | null;
  netRevenueMinor: number | null;
  mrrMinor: number | null;
  currencyCode: CurrencyCode | null;
  businessDate: string | null;
}

function sumOrNull(rows: DailyMetricRow[], pick: (r: DailyMetricRow) => number | null): number | null {
  const present = rows.map(pick).filter((v): v is number => v !== null);
  // An empty window is "no data yet", not zero — the contract's rule 2, held
  // through the aggregation rather than only at its edges.
  return present.length === 0 ? null : present.reduce((a, b) => a + b, 0);
}

/**
 * COMPOSED from `GET /admin/growth/daily`. Stocks (paying families, active
 * subscriptions) are read off the LAST row, because summing a stock across
 * days counts the same family once per day. Flows are summed.
 */
export function composeExecutiveCounts(rows: DailyMetricRow[]): ComposedResult<ExecutiveCounts> {
  if (rows.length === 0) {
    return {
      kind: 'COMPOSED',
      data: {
        payingFamilies: null,
        activePaidSubscriptions: null,
        churnedPaidSubscriptions: null,
        newRegistrations: null,
        activations: null,
        childrenAdded: null,
        trialsStarted: null,
        trialsResolved: null,
        trialsConverted: null,
        newPaidFamilies: null,
        paymentSuccessCount: null,
        paymentFailureCount: null,
        netRevenueMinor: null,
        mrrMinor: null,
        currencyCode: null,
        businessDate: null,
      },
      composedFrom: ['GET /admin/growth/daily'],
    };
  }

  const ordered = [...rows].sort((a, b) => a.businessDate.localeCompare(b.businessDate));
  const latest = ordered[ordered.length - 1];

  return {
    kind: 'COMPOSED',
    data: {
      payingFamilies: latest.payingFamilies,
      activePaidSubscriptions: latest.activePaidSubscriptions,
      // A FLOW, despite the name: `growth_daily_metrics` records how many
      // subscriptions churned on that day, so the window's churn is a sum.
      churnedPaidSubscriptions: sumOrNull(ordered, (r) => r.churnedPaidSubscriptions),
      newRegistrations: sumOrNull(ordered, (r) => r.newRegistrations),
      activations: sumOrNull(ordered, (r) => r.activations),
      childrenAdded: sumOrNull(ordered, (r) => r.childrenAdded),
      trialsStarted: sumOrNull(ordered, (r) => r.trialsStarted),
      trialsResolved: sumOrNull(ordered, (r) => r.trialsResolved),
      trialsConverted: sumOrNull(ordered, (r) => r.trialsConverted),
      newPaidFamilies: sumOrNull(ordered, (r) => r.newPaidFamilies),
      paymentSuccessCount: sumOrNull(ordered, (r) => r.paymentSuccessCount),
      paymentFailureCount: sumOrNull(ordered, (r) => r.paymentFailureCount),
      netRevenueMinor: sumOrNull(ordered, (r) => r.netRevenueMinor),
      mrrMinor: latest.mrrMinor,
      currencyCode: latest.currencyCode,
      businessDate: latest.businessDate,
    },
    composedFrom: ['GET /admin/growth/daily'],
  };
}

// ── Composed: channel economics ──────────────────────────────────────────

export interface ChannelEconomicsRow extends ChannelRow {
  /** Summed from the campaigns that carry this channel. `null` when this
   * channel has no campaign rows at all — organic has no spend by
   * definition, and printing 0 for it would make its CAC read as free
   * rather than as unmeasured. */
  spendMinor: number | null;
  installs: number | null;
  netRevenueMinor: number | null;
  /** spend / new paid users, in ONE currency. `null` on a zero denominator. */
  cacMinor: number | null;
  /** revenue / spend. `null` on a zero denominator. */
  roas: number | null;
  currencyCode: CurrencyCode | null;
  /** True when no campaign backs this channel, so the row's economics are
   * unmeasured rather than zero. */
  spendUnattributed: boolean;
}

/**
 * COMPOSED from `GET /admin/growth/channels` + `GET /admin/growth/campaigns`.
 *
 * The channels endpoint returns registrations / paid / conversion only — it
 * carries no spend, so CAC and ROAS cannot come from it. Campaigns DO carry
 * spend, revenue and a channel, so channel economics are the campaign rows
 * grouped by channel. The limitation is real and is surfaced, not hidden:
 * spend that was never imported against a campaign is invisible here, and
 * the row says so via `spendUnattributed`.
 */
export function composeChannelEconomics(
  channels: ChannelRow[],
  campaigns: Campaign[],
  countryCode: CountryCode,
): ComposedResult<ChannelEconomicsRow[]> {
  const scoped = campaigns.filter((c) => c.countryCode === countryCode);

  const rows = channels.map((channel): ChannelEconomicsRow => {
    const mine = scoped.filter((c) => c.channel === channel.channel);
    const spendMinor = mine.length === 0 ? null : sumCampaign(mine, (c) => c.spendMinor);
    const netRevenueMinor = mine.length === 0 ? null : sumCampaign(mine, (c) => c.netRevenueMinor);
    const installs = mine.length === 0 ? null : sumCampaign(mine, (c) => c.installs);
    const currencyCode = mine[0]?.currencyCode ?? null;

    return {
      ...channel,
      spendMinor,
      installs,
      netRevenueMinor,
      currencyCode,
      cacMinor: spendMinor !== null && channel.paid > 0 ? Math.round(spendMinor / channel.paid) : null,
      roas: spendMinor !== null && spendMinor > 0 && netRevenueMinor !== null ? netRevenueMinor / spendMinor : null,
      spendUnattributed: mine.length === 0,
    };
  });

  return {
    kind: 'COMPOSED',
    data: rows,
    composedFrom: ['GET /admin/growth/channels', 'GET /admin/growth/campaigns'],
  };
}

function sumCampaign(campaigns: Campaign[], pick: (c: Campaign) => number | null): number | null {
  const present = campaigns.map(pick).filter((v): v is number => v !== null);
  return present.length === 0 ? null : present.reduce((a, b) => a + b, 0);
}

// ── Composed: referral funnel, as far as the contract reaches ────────────

export interface ReferralSummary {
  /** Qualified conversions, summed from the daily series. */
  qualified: number | null;
  /** NOT available from any admin endpoint — see GAPS.referralAdminSummary. */
  codesIssued: null;
  sent: null;
  registered: null;
  rewardsGranted: null;
  fraudRejectionsByReason: null;
}

/**
 * PARTIALLY COMPOSED. `growth_daily_metrics.referralsQualified` is the only
 * referral number any admin endpoint exposes. `/referral/me` is a PARENT
 * surface returning one family's own counters, and it is deliberately
 * incapable of naming another family — reading it here would be both wrong
 * (one family is not the platform) and a privacy regression. So the other
 * five fields are typed `null` and rendered as a declared gap.
 */
export function composeReferralSummary(rows: DailyMetricRow[]): ComposedResult<ReferralSummary> {
  return {
    kind: 'COMPOSED',
    data: {
      qualified: sumOrNull(rows, (r) => r.referralsQualified),
      codesIssued: null,
      sent: null,
      registered: null,
      rewardsGranted: null,
      fraudRejectionsByReason: null,
    },
    composedFrom: ['GET /admin/growth/daily'],
  };
}

// ── Declared missing ─────────────────────────────────────────────────────

export interface ProductAiMetrics {
  aiSessions: number;
  goalsCreated: number;
  goalsCompleted: number;
  rewardsGranted: number;
  rewardsRedeemed: number;
  engagedChildren: number;
}

/** MISSING. No admin endpoint exposes AI sessions, goal counts or reward
 * redemption. The activation event proves a reward was granted, but that is
 * one boolean per family, not a product-engagement series. */
export function fetchProductAiMetrics(): MissingResult {
  return { kind: 'MISSING', gap: GAPS.productAiMetrics };
}

export interface CohortRetentionRow {
  cohortDate: string;
  cohortSize: number;
  d1: number | null;
  d7: number | null;
  d30: number | null;
  d90: number | null;
}

/** MISSING. `GET /admin/growth/kpis` returns RETENTION_D1/7/30/90 for a
 * COUNTRY as of a date; there is no per-cohort breakdown. The country view
 * below is real; the cohort table is a declared gap. */
export function fetchCohortRetention(): MissingResult {
  return { kind: 'MISSING', gap: GAPS.cohortRetention };
}

export interface RefundSummary {
  refundCount: number;
  refundedMinor: number;
  currencyCode: CurrencyCode;
}

/** MISSING. `payment_transactions` records refunds (PHASE-D-Payments §4) but
 * the growth contract exposes no refund aggregate — `growth_daily_metrics`
 * carries payment success/failure counts and net revenue only. */
export function fetchRefunds(): MissingResult {
  return { kind: 'MISSING', gap: GAPS.refunds };
}

/**
 * MISSING. There is no `ACTIVE_CHILDREN` KPI. `childrenAdded` is a FLOW
 * (children added in a day) and using it as a stock would drift upward
 * forever, which is exactly the kind of number that survives a board
 * meeting and then can't be reproduced.
 */
export function activeChildrenGap(): MissingResult {
  return { kind: 'MISSING', gap: GAPS.activeChildren };
}

/**
 * MISSING. "Active parents" would need a parent-side last-seen signal.
 * `DashboardMetricsService` counts DEVICES seen in 7 days and the families
 * they belong to; a device is not a person and a family is not a parent, so
 * neither can stand in for this without inventing a definition.
 */
export function activeParentsGap(): MissingResult {
  return { kind: 'MISSING', gap: GAPS.activeParents };
}

/**
 * MISSING per market. `GET /analytics/dashboard-metrics` returns registered
 * and 7-day-active families PLATFORM-WIDE with no country parameter, and
 * `growth_daily_metrics` carries `newRegistrations` — a flow — but no family
 * STOCK per country. Splitting the platform total between Egypt and Saudi
 * Arabia by any ratio available here would be a guess wearing a number's
 * clothes.
 */
export function familiesByCountryGap(): MissingResult {
  return { kind: 'MISSING', gap: GAPS.familiesByCountry };
}

/**
 * MISSING. The database does model the mix — `Subscription.planTier` and
 * `SubscriptionPrice.billingPeriod` (MONTHLY | ANNUAL) — but no admin
 * endpoint aggregates it. `growth_daily_metrics` exposes
 * `activePaidSubscriptions` as ONE number with no plan breakdown, so free /
 * monthly / annual cannot be separated from anything this client can read.
 */
export function subscriptionPlanMixGap(): MissingResult {
  return { kind: 'MISSING', gap: GAPS.subscriptionPlanMix };
}

/**
 * MISSING. `PilotEnrollmentService` writes invitations, cohorts and
 * redemptions, but it is called from the registration path only — no
 * controller exposes a read of it. What IS readable is the pilot's
 * CONFIGURATION, via `GET /admin/growth/settings`; see `composePilotStatus`.
 */
export function pilotEnrollmentGap(): MissingResult {
  return { kind: 'MISSING', gap: GAPS.pilotEnrollment };
}

/**
 * MISSING. Safety incidents reach an operator today only as growth ALERTS of
 * type `AI_SAFETY_INCIDENT` (`GET /admin/growth/alerts`) — one row per
 * threshold breach, which is a warning, not a count of events. No endpoint
 * returns a safety-event series per country.
 */
export function safetyEventsGap(): MissingResult {
  return { kind: 'MISSING', gap: GAPS.safetyEvents };
}

// ── Composed: the controlled pilot's configuration ───────────────────────

export interface PilotStatus {
  /** `null` when the settings row is absent — unknown, not "off". */
  enabled: boolean | null;
  /** Whether THIS market is inside the pilot's country list. */
  inPilot: boolean | null;
  /** Whether a cohort is configured. The cohort's id is deliberately not
   * carried: an operator screen shows no database identifiers. */
  cohortConfigured: boolean | null;
}

/**
 * COMPOSED from `GET /admin/growth/settings`, keys `pilot.enabled`,
 * `pilot.countries` and `pilot.cohortId` — the same three rows
 * `PilotEnrollmentService` reads at registration time, so this panel shows
 * the gate's real configuration rather than a second copy of it.
 *
 * `pilot.countries` is parsed exactly as the backend parses it (comma
 * separated, trimmed, upper-cased, anything not two letters discarded), so
 * the dashboard cannot claim a market is in the pilot when the gate would
 * disagree.
 */
export function composePilotStatus(
  settings: GrowthSetting[] | undefined,
  country: CountryCode,
): ComposedResult<PilotStatus> {
  const read = (key: string) => settings?.find((setting) => setting.key === key);
  const enabledRow = read('pilot.enabled');
  const countriesRow = read('pilot.countries');
  const cohortRow = read('pilot.cohortId');

  const countries =
    typeof countriesRow?.value === 'string'
      ? new Set(
          countriesRow.value
            .split(',')
            .map((part) => part.trim().toUpperCase())
            .filter((part) => /^[A-Z]{2}$/.test(part)),
        )
      : null;

  return {
    kind: 'COMPOSED',
    data: {
      enabled: typeof enabledRow?.value === 'boolean' ? enabledRow.value : null,
      inPilot: countries === null ? null : countries.has(country),
      cohortConfigured:
        cohortRow === undefined ? null : typeof cohortRow.value === 'string' && cohortRow.value.trim() !== '',
    },
    composedFrom: ['GET /admin/growth/settings'],
  };
}

// ── Snapshot helpers ─────────────────────────────────────────────────────

/** Reads a KPI out of a snapshot without assuming the backend's ordering,
 * and without inventing a row that isn't there. */
export function pickKpi(snapshot: KpiSnapshot | undefined, kpi: KpiValue['kpi']): KpiValue | undefined {
  return snapshot?.values.find((v) => v.kpi === kpi);
}
