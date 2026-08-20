/**
 * Transcription of `apps/backend/docs/api/GROWTH_ANALYTICS_API.md` v1.0.
 *
 * Nothing here is invented. Every field name, every union member and every
 * nullability decision is copied from that contract, because the contract's
 * rule 4 (additive-only) is what makes this file safe to keep: a new KPI
 * arrives as a new element of `values`, and a dashboard that does not know
 * it ignores it without harm.
 *
 * Two of the contract's five invariants are encoded in the *types* rather
 * than left to reviewer discipline:
 *   - `null` means "no data yet", never zero — so every measured field is
 *     `number | null`, and the formatters refuse to print `0` for `null`.
 *   - money always carries `currencyCode`, and `countryCode: '**'` returns
 *     no money at all — so `currencyCode` is `CurrencyCode | null` and the
 *     money formatter demands a country alongside it.
 */

/** The two launch markets. `'**'` is the platform scope — and per contract
 * rule 3 it carries NO money, because summing EGP into SAR without a rate
 * is a lie, not an aggregate. */
export type CountryCode = 'EG' | 'SA';
export type CountryScope = CountryCode | '**';
export const COUNTRY_CODES: readonly CountryCode[] = ['EG', 'SA'] as const;
export const PLATFORM_SCOPE = '**' as const;

export type CurrencyCode = 'EGP' | 'SAR';

/** The single most load-bearing enum in this dashboard. An assumption that
 * renders like a fact is the one failure mode the whole growth layer was
 * designed to prevent (contract rule 1). */
export type Provenance = 'ACTUAL' | 'TARGET' | 'FORECAST';

export type KpiKind = 'COUNT' | 'RATE' | 'RATIO' | 'MONEY_MINOR' | 'DURATION_HOURS';

export type KpiId =
  | 'DAU'
  | 'WAU'
  | 'MAU'
  | 'STICKINESS'
  | 'ACTIVATION_RATE'
  | 'TIME_TO_VALUE_HOURS'
  | 'RETENTION_D1'
  | 'RETENTION_D7'
  | 'RETENTION_D30'
  | 'RETENTION_D90'
  | 'CHURN_RATE'
  | 'CONVERSION_RATE'
  | 'TRIAL_CONVERSION_RATE'
  | 'ARPU'
  | 'ARPPU'
  | 'MRR'
  | 'ARR'
  | 'CAC'
  | 'LTV'
  | 'LTV_CAC_RATIO'
  | 'ROAS'
  | 'PAYBACK_MONTHS';

/** Contract §3: these three multiply a measured number by an *assumed*
 * margin. They arrive as `FORECAST` and must never be painted as `ACTUAL`. */
export const ALWAYS_FORECAST_KPIS: readonly KpiId[] = ['LTV', 'LTV_CAC_RATIO', 'PAYBACK_MONTHS'] as const;

export interface KpiValue {
  kpi: KpiId;
  provenance: Provenance;
  /** `null` = no data yet. NOT zero. */
  value: number | null;
  currencyCode: CurrencyCode | null;
  kind: KpiKind;
}

export interface KpiSnapshot {
  countryCode: CountryScope;
  /** `null` when `countryCode === '**'` — the platform scope has no currency. */
  currencyCode: CurrencyCode | null;
  businessDate: string;
  reportingTimeZone: string;
  values: KpiValue[];
}

export type FunnelStepName =
  | 'IMPRESSION'
  | 'VISIT'
  | 'INSTALL'
  | 'REGISTRATION'
  | 'FAMILY_CREATED'
  | 'CHILD_ADDED'
  | 'FIRST_GOAL'
  | 'FIRST_REWARD'
  | 'TRIAL'
  | 'PAID'
  | 'RENEWAL';

/**
 * Contract §2: "visually binding". `EXTERNAL_REPORTED` is an ad platform's
 * own count of itself; rendering it at the same visual weight as a row of
 * `payment_transactions` is lying by formatting.
 */
export type FunnelSource = 'EXTERNAL_REPORTED' | 'ANALYTICS_EVENT' | 'DOMAIN_TABLE';

export interface FunnelStepRow {
  step: FunnelStepName;
  /** Families, not events. A family with three children crosses CHILD_ADDED once. */
  count: number;
  source: FunnelSource;
  stepConversion: number | null;
  /** Conversion from INSTALL — the first step this backend actually measures. */
  fromMeasurableTop: number | null;
  note?: string;
}

export interface FunnelResponse {
  countryCode: CountryScope;
  channel: Channel | null;
  campaignId: string | null;
  from: string;
  to: string;
  reportingTimeZone: string;
  steps: FunnelStepRow[];
  /** Reported, never zeroed: a later step outnumbering an earlier one is a
   * real, diagnosable state, and hiding it makes bad data look clean. */
  monotonicityViolations: string[];
}

export type Channel =
  | 'ORGANIC'
  | 'TIKTOK'
  | 'INSTAGRAM'
  | 'FACEBOOK'
  | 'YOUTUBE'
  | 'GOOGLE'
  | 'INFLUENCER'
  | 'SCHOOL'
  | 'PARENT_COMMUNITY'
  | 'REFERRAL'
  | 'PARTNERSHIP'
  | 'APP_STORE'
  | 'GOOGLE_PLAY'
  | 'OTHER';

export interface ChannelRow {
  channel: Channel;
  registrations: number;
  paid: number;
  conversion: number | null;
}

export interface DailyMetricRow {
  businessDate: string;
  countryCode: CountryCode;
  currencyCode: CurrencyCode | null;
  reportingTimeZone: string;
  dau: number | null;
  wau: number | null;
  mau: number | null;
  newRegistrations: number | null;
  activations: number | null;
  childrenAdded: number | null;
  devicesPaired: number | null;
  trialsStarted: number | null;
  trialsResolved: number | null;
  trialsConverted: number | null;
  newPaidFamilies: number | null;
  payingFamilies: number | null;
  activePaidSubscriptions: number | null;
  churnedPaidSubscriptions: number | null;
  paymentSuccessCount: number | null;
  paymentFailureCount: number | null;
  referralsQualified: number | null;
  netRevenueMinor: number | null;
  mrrMinor: number | null;
  medianTimeToValueMinutes: number | null;
}

export interface Campaign {
  id: string;
  name: string;
  channel: Channel;
  countryCode: CountryCode;
  currencyCode: CurrencyCode;
  startsAt: string;
  endsAt: string | null;
  isActive: boolean;
  /** Admin-declared. NOT NULL server-side: a campaign with no budget and no
   * stated target cannot exist. */
  budgetMinor: number;
  targetUsers: number;
  targetPaidUsers: number;
  /** Reported by the ad platform (idempotent daily import). */
  spendMinor: number | null;
  impressions: number | null;
  clicks: number | null;
  visits: number | null;
  leads: number | null;
  budgetUtilisation: number | null;
  /** Measured by us, from rows the server wrote. */
  installs: number | null;
  registrations: number | null;
  paidUsers: number | null;
  netRevenueMinor: number | null;
  kpis: KpiValue[];
  targetAttainment: { users: number | null; paidUsers: number | null };
}

export interface CreateCampaignInput {
  name: string;
  channel: Channel;
  countryCode: CountryCode;
  budgetMinor: number;
  currencyCode: CurrencyCode;
  startsAt: string;
  endsAt: string;
  targetUsers: number;
  targetPaidUsers: number;
  utmCampaign?: string;
  notes?: string;
}

export interface CampaignSpendInput {
  businessDate: string;
  spendMinor: number;
  impressions: number;
  clicks: number;
  visits: number;
  leads: number;
}

export type ForecastScenarioName = 'CONSERVATIVE' | 'BASE' | 'AGGRESSIVE';
export const FORECAST_SCENARIOS: readonly ForecastScenarioName[] = [
  'CONSERVATIVE',
  'BASE',
  'AGGRESSIVE',
] as const;

/** The seven editable inputs. Returned alongside every number derived from
 * them so a reader can disagree with the inputs instead of the output. */
export interface ForecastAssumptions {
  monthlyAcquisition: number;
  conversionRate: number;
  paidConversionRate: number;
  churnRate: number;
  arpuMinor: number;
  cacMinor: number;
  retentionD30: number;
}

export const ASSUMPTION_KEYS: readonly (keyof ForecastAssumptions)[] = [
  'monthlyAcquisition',
  'conversionRate',
  'paidConversionRate',
  'churnRate',
  'arpuMinor',
  'cacMinor',
  'retentionD30',
] as const;

/** The four assumptions that are rates and are rejected with 400 outside [0,1]. */
export const RATE_ASSUMPTION_KEYS: readonly (keyof ForecastAssumptions)[] = [
  'conversionRate',
  'paidConversionRate',
  'churnRate',
  'retentionD30',
] as const;

export interface ForecastMonth {
  monthIndex: number;
  newRegistrations: number;
  newTrials: number;
  newPaid: number;
  churnedPaid: number;
  endingPaid: number;
  mrrMinor: number;
  acquisitionSpendMinor: number;
}

export interface ForecastScenarioRow {
  scenario: ForecastScenarioName;
  countryCode: CountryCode;
  currencyCode: CurrencyCode;
  assumptions: ForecastAssumptions;
  months: ForecastMonth[];
  endingPaid: number;
  endingMrrMinor: number;
  totalSpendMinor: number;
}

export type TargetMetric =
  | 'USERS'
  | 'PAID_USERS'
  | 'REVENUE_MINOR'
  | 'SUBSCRIPTIONS'
  | 'CAC_MINOR'
  | 'CHURN_RATE'
  | 'MRR_MINOR';

export const TARGET_METRICS: readonly TargetMetric[] = [
  'USERS',
  'PAID_USERS',
  'REVENUE_MINOR',
  'SUBSCRIPTIONS',
  'CAC_MINOR',
  'CHURN_RATE',
  'MRR_MINOR',
] as const;

/**
 * Contract §6: "there is no `value` field in this response and there never
 * will be." A dashboard that wants one number is obliged to decide which of
 * the three it shows — and that is exactly the decision that must not be
 * taken silently.
 */
export interface QuarterlyRow {
  countryCode: CountryCode;
  year: number;
  quarter: 1 | 2 | 3 | 4;
  metric: TargetMetric;
  /** Written by a human. `null` = nobody committed to anything — and it is
   * NEVER inferred from the forecast. */
  target: number | null;
  /** Measured. `null` before the quarter opens, not zero. */
  actual: number | null;
  /** Projected from `growth_forecast_scenarios`. */
  forecast: number | null;
  attainment: number | null;
  currencyCode: CurrencyCode | null;
}

export type AlertType =
  | 'CONVERSION_DROP'
  | 'CHURN_RISE'
  | 'PAYMENT_FAILURE_SPIKE'
  | 'REWARD_FAILURE_RISE'
  | 'NOTIFICATION_FAILURE_RISE'
  | 'AI_SAFETY_INCIDENT'
  | 'RETENTION_DROP'
  | 'COUNTRY_PERFORMANCE_SHIFT';

export type AlertSeverity = 'INFO' | 'WARNING' | 'CRITICAL';

export interface GrowthAlert {
  id: string;
  alertType: AlertType;
  scopeKey: string;
  businessDate: string;
  severity: AlertSeverity;
  /** Server-authored Arabic prose. Rendered as-is — it is the operator's
   * language and it already carries the numbers. */
  message: string;
  observedValue: number | null;
  thresholdValue: number | null;
  acknowledgedAt: string | null;
  createdAt: string;
}

export type SettingType = 'INT' | 'DECIMAL' | 'BOOL' | 'STRING';

export interface GrowthSetting {
  key: string;
  value: number | string | boolean;
  isDefault: boolean;
  type: SettingType;
  min?: number;
  max?: number;
  descriptionAr?: string;
  /** Contract §8: must render differently. These are the numbers that still
   * need a business owner, not an engineer. */
  humanDecision: boolean;
}

export interface CatalogueKpiDefinition {
  id: KpiId;
  nameEn: string;
  nameAr: string;
  kind: KpiKind;
  formula: string;
  numerator: string;
  denominator: string;
  windowDays: number;
  source: string;
  note?: string;
}

export interface CatalogueFunnelStep {
  step: FunnelStepName;
  source: FunnelSource;
  measuredBy: string;
  note?: string;
}

export interface CatalogueActivation {
  eventName: string;
  ruleVersion: string;
  meaningfulCompletionKinds: string[];
  gates: string[];
}

export interface GrowthCatalogue {
  kpis: CatalogueKpiDefinition[];
  growthEvents: Array<{
    name: string;
    tenancy: 'FAMILY_SCOPED' | 'ANONYMOUS';
    funnelStep: FunnelStepName | null;
    producer: string;
    hadPriorDomainSignal: boolean;
    priorSignal?: string;
  }>;
  channels: Channel[];
  funnelSteps: CatalogueFunnelStep[];
  forecastScenarios: ForecastScenarioName[];
  targetMetrics: TargetMetric[];
  activation: CatalogueActivation;
}
