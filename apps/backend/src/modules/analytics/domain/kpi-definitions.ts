/**
 * PHASE D (GROWTH) — THE ONE PLACE A KPI IS DEFINED, AND THE ONE PLACE IT IS
 * COMPUTED.
 *
 * The problem this file exists to remove is not "we have no metrics". It is the
 * one every growth stack acquires by month three: the dashboard says churn is
 * 4.1%, the investor deck says 6%, the retention job says 5.2%, and all three
 * are "right" because each divides by a different denominator. Once that has
 * happened, no number in the product can be trusted, and no amount of
 * documentation fixes it, because documentation is not what the code reads.
 *
 * So: every KPI below is (a) DEFINED as data — numerator, denominator, window,
 * unit, formula in words — and (b) COMPUTED by a pure function in this file and
 * NOWHERE ELSE. `test/analytics/kpi-single-source.spec.ts` scans `src/` and
 * fails the build if any other module performs KPI arithmetic. That test is the
 * enforcement; this comment is only the explanation.
 *
 * FOUR RULES THE FUNCTIONS BELOW OBEY WITHOUT EXCEPTION:
 *
 *   1. MONEY IS INTEGER MINOR UNITS. Never a float, never `* 100`. The minor
 *      unit exponent is a COLUMN (`currencies.minor_units`) — Phase D already
 *      refused to hardcode 100 and this file does not un-refuse it.
 *   2. CURRENCY IS NEVER MIXED. Every money function takes a single
 *      `currencyCode` and asserts on it. EGP and SAR are not addable, and a
 *      "total revenue" that silently added them is the single most expensive
 *      lie an analytics layer can tell. Cross-currency reporting is a
 *      presentation concern with an explicit FX rate, which this layer does not
 *      have and therefore does not fake.
 *   3. A ZERO DENOMINATOR RETURNS `null`, NOT ZERO. "0% conversion" and "no
 *      data yet" are different facts. Rendering the second as the first is how
 *      a launch week looks like a catastrophe.
 *   4. DAY BOUNDARIES ARE NOT DECIDED HERE. Every windowed input is handed to
 *      these functions as an already-counted number; the counting is done by
 *      the query layer against ranges produced by `FamilyDateService` /
 *      `family-date.ts`. There is no `new Date()` in this file, and no
 *      `24 * 60 * 60 * 1000`.
 *
 * REVENUE IS NOT RE-DERIVED HERE EITHER. Every money input traces to
 * `payment_transactions` / `subscription_prices` — the Phase D commercial
 * model. This file multiplies and divides; it does not decide what a
 * subscription is worth.
 */

/** The complete catalogue. Adding a KPI means adding it here first. */
export const KPI_IDS = [
  'DAU',
  'WAU',
  'MAU',
  'STICKINESS',
  'ACTIVATION_RATE',
  'TIME_TO_VALUE_HOURS',
  'RETENTION_D1',
  'RETENTION_D7',
  'RETENTION_D30',
  'RETENTION_D90',
  'CHURN_RATE',
  'CONVERSION_RATE',
  'TRIAL_CONVERSION_RATE',
  'ARPU',
  'ARPPU',
  'MRR',
  'ARR',
  'CAC',
  'LTV',
  'LTV_CAC_RATIO',
  'ROAS',
  'PAYBACK_MONTHS',
] as const;

export type KpiId = (typeof KPI_IDS)[number];

/**
 * What KIND of number this is — and therefore how a dashboard is allowed to
 * render it. A `RATE` is a fraction in [0,1] and must be shown as a percentage;
 * a `MONEY_MINOR` is an integer in the minor units of a stated currency and
 * must never be shown without that currency.
 */
export type KpiKind = 'COUNT' | 'RATE' | 'RATIO' | 'MONEY_MINOR' | 'DURATION_HOURS';

export interface KpiDefinition {
  readonly id: KpiId;
  readonly nameEn: string;
  readonly nameAr: string;
  readonly kind: KpiKind;
  /** The formula, in the same terms as the function that implements it. */
  readonly formula: string;
  readonly numerator: string;
  /** `null` for a pure count — a count has no denominator, and saying "1" would be a lie. */
  readonly denominator: string | null;
  /** The observation window in days; `null` when the KPI is point-in-time. */
  readonly windowDays: number | null;
  /** Which tables the inputs come from. Revenue always traces to Phase D. */
  readonly source: string;
  /** The trap this definition is written to avoid. */
  readonly note: string;
}

export const KPI_DEFINITIONS: Readonly<Record<KpiId, KpiDefinition>> = {
  DAU: {
    id: 'DAU',
    nameEn: 'Daily Active Users',
    nameAr: 'المستخدمون النشطون يوميًا',
    kind: 'COUNT',
    formula: 'COUNT(DISTINCT family_id) with a qualifying activity inside one reporting day',
    numerator: 'distinct families with ≥1 qualifying activity in the day',
    denominator: null,
    windowDays: 1,
    source: 'devices.last_seen_at + analytics_events.occurred_at (reporting-timezone day range)',
    note: 'A FAMILY is the active unit, not a User row. Two parents on one household is one active family; counting users would inflate DAU by the co-parent adoption rate and make it move when nothing changed.',
  },
  WAU: {
    id: 'WAU',
    nameEn: 'Weekly Active Users',
    nameAr: 'المستخدمون النشطون أسبوعيًا',
    kind: 'COUNT',
    formula: 'COUNT(DISTINCT family_id) over a rolling 7-day window',
    numerator: 'distinct families with ≥1 qualifying activity in 7 days',
    denominator: null,
    windowDays: 7,
    source: 'devices.last_seen_at + analytics_events.occurred_at',
    note: 'ROLLING, not calendar-week. A calendar week makes Monday reports incomparable to Sunday reports.',
  },
  MAU: {
    id: 'MAU',
    nameEn: 'Monthly Active Users',
    nameAr: 'المستخدمون النشطون شهريًا',
    kind: 'COUNT',
    formula: 'COUNT(DISTINCT family_id) over a rolling 30-day window',
    numerator: 'distinct families with ≥1 qualifying activity in 30 days',
    denominator: null,
    windowDays: 30,
    source: 'devices.last_seen_at + analytics_events.occurred_at',
    note: 'ROLLING 30 DAYS, not "this calendar month". A calendar month makes 1 February structurally lower than 31 January.',
  },
  STICKINESS: {
    id: 'STICKINESS',
    nameEn: 'Stickiness (DAU/MAU)',
    nameAr: 'نسبة الالتصاق',
    kind: 'RATE',
    formula: 'DAU / MAU',
    numerator: 'DAU',
    denominator: 'MAU',
    windowDays: 30,
    source: 'derived from DAU and MAU above',
    note: 'Derived, never separately counted. If DAU and MAU ever disagree with this ratio, one of them was measured somewhere else — which is what this module exists to prevent.',
  },
  ACTIVATION_RATE: {
    id: 'ACTIVATION_RATE',
    nameEn: 'Activation Rate',
    nameAr: 'معدل التفعيل',
    kind: 'RATE',
    formula: 'activated families / registered families in the same cohort',
    numerator: 'families with a CHILD_COMPLETES_FIRST_MEANINGFUL_GOAL event',
    denominator: 'families registered in the cohort window',
    windowDays: null,
    source: 'family_activations + families.created_at',
    note: 'COHORT-BASED. Dividing today\'s activations by today\'s registrations is not an activation rate — it is a ratio of two unrelated populations that happens to be dimensionless.',
  },
  TIME_TO_VALUE_HOURS: {
    id: 'TIME_TO_VALUE_HOURS',
    nameEn: 'Time To Value (median hours)',
    nameAr: 'زمن الوصول إلى القيمة',
    kind: 'DURATION_HOURS',
    formula: 'MEDIAN(activation.occurred_at − family.created_at) in hours',
    numerator: 'per-family elapsed hours from registration to activation',
    denominator: null,
    windowDays: null,
    source: 'family_activations.time_to_value_minutes',
    note: 'MEDIAN, not mean. One family that activates after 90 days moves a mean and tells you nothing about the typical family.',
  },
  RETENTION_D1: {
    id: 'RETENTION_D1',
    nameEn: 'Day-1 Retention',
    nameAr: 'الاحتفاظ بعد يوم',
    kind: 'RATE',
    formula: 'cohort families active on day N+1 / cohort size',
    numerator: 'cohort families with activity on the day after registration',
    denominator: 'families registered on the cohort day',
    windowDays: 1,
    source: 'families.created_at + activity signal',
    note: 'CLASSIC (day-N-exactly), not "unbounded". Day-1 retention that counts anyone still active later is a survival curve wearing a retention label.',
  },
  RETENTION_D7: {
    id: 'RETENTION_D7',
    nameEn: 'Day-7 Retention',
    nameAr: 'الاحتفاظ بعد 7 أيام',
    kind: 'RATE',
    formula: 'cohort families active on day N+7 / cohort size',
    numerator: 'cohort families with activity on day 7',
    denominator: 'cohort size',
    windowDays: 7,
    source: 'families.created_at + activity signal',
    note: 'Same definition as D1 with a different offset — one function, four call sites, so the four numbers cannot drift apart.',
  },
  RETENTION_D30: {
    id: 'RETENTION_D30',
    nameEn: 'Day-30 Retention',
    nameAr: 'الاحتفاظ بعد 30 يومًا',
    kind: 'RATE',
    formula: 'cohort families active on day N+30 / cohort size',
    numerator: 'cohort families with activity on day 30',
    denominator: 'cohort size',
    windowDays: 30,
    source: 'families.created_at + activity signal',
    note: 'The number the forecast model\'s retention assumption is compared against.',
  },
  RETENTION_D90: {
    id: 'RETENTION_D90',
    nameEn: 'Day-90 Retention',
    nameAr: 'الاحتفاظ بعد 90 يومًا',
    kind: 'RATE',
    formula: 'cohort families active on day N+90 / cohort size',
    numerator: 'cohort families with activity on day 90',
    denominator: 'cohort size',
    windowDays: 90,
    source: 'families.created_at + activity signal',
    note: 'A cohort younger than 90 days has NO D90 value. It returns null, not 0 — see rule 3 in this file\'s header.',
  },
  CHURN_RATE: {
    id: 'CHURN_RATE',
    nameEn: 'Paid Churn Rate (monthly)',
    nameAr: 'معدل التسرّب الشهري',
    kind: 'RATE',
    formula: 'churned paid subscriptions in the period / paid subscriptions at period start',
    numerator: 'subscriptions that left an entitlement-bearing status in the period',
    denominator: 'entitlement-bearing subscriptions at period start',
    windowDays: 30,
    source: 'subscriptions (Phase D status vocabulary)',
    note: 'DENOMINATOR IS THE START-OF-PERIOD BASE, and new subscriptions acquired mid-period are NOT in it. Including them dilutes churn and makes a bad month look flat.',
  },
  CONVERSION_RATE: {
    id: 'CONVERSION_RATE',
    nameEn: 'Registration → Paid Conversion',
    nameAr: 'معدل التحويل إلى مدفوع',
    kind: 'RATE',
    formula: 'families that ever became paid / families registered in the cohort',
    numerator: 'cohort families with ≥1 SUCCEEDED payment transaction',
    denominator: 'cohort size',
    windowDays: null,
    source: 'payment_transactions + families.created_at',
    note: 'EVER-PAID, not currently-paid. A family that paid and then churned still converted; folding churn into conversion measures neither.',
  },
  TRIAL_CONVERSION_RATE: {
    id: 'TRIAL_CONVERSION_RATE',
    nameEn: 'Trial → Paid Conversion',
    nameAr: 'تحويل التجربة إلى مدفوع',
    kind: 'RATE',
    formula: 'trials with converted_at set / trials that ENDED in the window',
    numerator: 'trials.converted_at IS NOT NULL',
    denominator: 'trials whose ends_at falls in the window (i.e. trials that have had their chance)',
    windowDays: null,
    source: 'trials (Phase D — one lifetime trial per family)',
    note: 'THE DENOMINATOR IS RESOLVED TRIALS ONLY. Counting trials still running as failures understates conversion by exactly the trial length, every single day.',
  },
  ARPU: {
    id: 'ARPU',
    nameEn: 'Average Revenue Per User',
    nameAr: 'متوسط الإيراد لكل مستخدم',
    kind: 'MONEY_MINOR',
    formula: 'net revenue (minor units) / active families, in ONE currency',
    numerator: 'SUM(payment_transactions.net_amount_minor) for SUCCEEDED rows in the currency',
    denominator: 'active families in the same period and country',
    windowDays: 30,
    source: 'payment_transactions (Phase D, append-only)',
    note: 'NET of VAT. Gross ARPU includes money that was never ours — it belongs to the tax authority — and comparing a gross Egyptian ARPU (14% VAT) with a gross Saudi one (15%) compares two tax codes.',
  },
  ARPPU: {
    id: 'ARPPU',
    nameEn: 'Average Revenue Per PAYING User',
    nameAr: 'متوسط الإيراد لكل مستخدم مدفوع',
    kind: 'MONEY_MINOR',
    formula: 'net revenue (minor units) / PAYING families, in ONE currency',
    numerator: 'SUM(payment_transactions.net_amount_minor) for SUCCEEDED rows',
    denominator: 'distinct families with ≥1 SUCCEEDED transaction in the period',
    windowDays: 30,
    source: 'payment_transactions',
    note: 'ARPPU ≥ ARPU always. If a report ever shows otherwise, the two were computed against different populations — which is the failure this module makes impossible.',
  },
  MRR: {
    id: 'MRR',
    nameEn: 'Monthly Recurring Revenue',
    nameAr: 'الإيراد الشهري المتكرر',
    kind: 'MONEY_MINOR',
    formula: 'Σ over active subscriptions of (net price normalised to one month), in ONE currency',
    numerator: 'per-subscription monthly-normalised net amount',
    denominator: null,
    windowDays: null,
    source: 'subscriptions × subscription_prices (Phase D price list)',
    note: 'AN ANNUAL PLAN CONTRIBUTES price/12, NOT price. Booking a year of cash as one month of MRR is the most common way a growth dashboard becomes fiction. NET of VAT, for the ARPU reason.',
  },
  ARR: {
    id: 'ARR',
    nameEn: 'Annual Recurring Revenue',
    nameAr: 'الإيراد السنوي المتكرر',
    kind: 'MONEY_MINOR',
    formula: 'MRR × 12',
    numerator: 'MRR',
    denominator: null,
    windowDays: null,
    source: 'derived from MRR',
    note: 'DERIVED, never summed independently. ARR that is not exactly 12 × MRR means one of them was computed elsewhere.',
  },
  CAC: {
    id: 'CAC',
    nameEn: 'Customer Acquisition Cost',
    nameAr: 'تكلفة اكتساب العميل',
    kind: 'MONEY_MINOR',
    formula: 'acquisition spend (minor units) / NEW PAID customers attributed to that spend',
    numerator: 'SUM(campaign_daily_spend.spend_minor)',
    denominator: 'new paid families attributed to the campaign in the window',
    windowDays: null,
    source: 'growth_campaigns + campaign_daily_spend + acquisition_attributions',
    note: 'DENOMINATOR IS PAID CUSTOMERS, NOT REGISTRATIONS. Cost-per-registration is a real metric with a different name; calling it CAC understates true CAC by the reciprocal of the conversion rate — a factor of ten at the 10% conversion this product plans for.',
  },
  LTV: {
    id: 'LTV',
    nameEn: 'Lifetime Value',
    nameAr: 'القيمة الدائمة للعميل',
    kind: 'MONEY_MINOR',
    formula: 'ARPPU × gross margin × expected lifetime, where lifetime = 1 / monthly churn',
    numerator: 'monthly gross margin per paying family',
    denominator: 'monthly churn rate',
    windowDays: null,
    source: 'ARPPU + CHURN_RATE + a configured gross-margin assumption',
    note: 'MARGIN-BASED, not revenue-based. docs/12 §10.2 puts Egyptian gross margin at 59.6% and Saudi at 76.5%; a revenue LTV would overstate both by those factors. Gross margin is an ASSUMPTION and is returned tagged FORECAST, never ACTUAL.',
  },
  LTV_CAC_RATIO: {
    id: 'LTV_CAC_RATIO',
    nameEn: 'LTV / CAC',
    nameAr: 'نسبة القيمة الدائمة إلى تكلفة الاكتساب',
    kind: 'RATIO',
    formula: 'LTV / CAC',
    numerator: 'LTV',
    denominator: 'CAC',
    windowDays: null,
    source: 'derived',
    note: 'Both sides must be in the SAME currency. Comparing a Saudi LTV with an Egyptian CAC produces a number with no meaning and a very convincing shape.',
  },
  ROAS: {
    id: 'ROAS',
    nameEn: 'Return On Ad Spend',
    nameAr: 'العائد على الإنفاق الإعلاني',
    kind: 'RATIO',
    formula: 'attributed net revenue / campaign spend, same currency',
    numerator: 'net revenue from families attributed to the campaign',
    denominator: 'campaign spend to date',
    windowDays: null,
    source: 'payment_transactions + acquisition_attributions + campaign_daily_spend',
    note: 'REALISED revenue only. A ROAS that includes forecast lifetime revenue is a forecast, and this module refuses to return a forecast under an ACTUAL label.',
  },
  PAYBACK_MONTHS: {
    id: 'PAYBACK_MONTHS',
    nameEn: 'CAC Payback Period (months)',
    nameAr: 'فترة استرداد تكلفة الاكتساب',
    kind: 'RATIO',
    formula: 'CAC / monthly gross margin per paying family',
    numerator: 'CAC',
    denominator: 'monthly gross margin per paying family',
    windowDays: null,
    source: 'derived from CAC + ARPPU + margin assumption',
    note: 'Margin, not revenue — same reason as LTV. docs/12 §10.3 computes 2.1 months for both markets on these definitions.',
  },
};

// ---------------------------------------------------------------------------
// THE COMPUTATIONS. Pure, total, and the only implementations that exist.
// ---------------------------------------------------------------------------

/** Rates are reported to 4 decimal places — 0.0001 = one basis point of a rate. */
const RATE_PRECISION = 10_000;

function roundRate(value: number): number {
  return Math.round(value * RATE_PRECISION) / RATE_PRECISION;
}

/**
 * The single division every rate goes through. `null` when the denominator is
 * zero (rule 3), and a thrown error when an input is negative — a negative
 * count is a bug in the query that produced it, and returning a plausible
 * number for it is how that bug reaches a board deck.
 */
export function rate(numerator: number, denominator: number): number | null {
  assertNonNegativeInteger(numerator, 'numerator');
  assertNonNegativeInteger(denominator, 'denominator');
  if (denominator === 0) return null;
  return roundRate(numerator / denominator);
}

function assertNonNegativeInteger(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`KPI ${label} must be a finite, non-negative number; got ${value}.`);
  }
}

function assertCurrency(code: string): void {
  if (!/^[A-Z]{3}$/.test(code)) {
    throw new RangeError(`KPI currency must be an ISO-4217 alpha-3 code; got "${code}".`);
  }
}

/** A money answer always carries the currency it is denominated in. */
export interface MoneyKpi {
  readonly amountMinor: number;
  readonly currencyCode: string;
}

export interface ActiveUserCounts {
  readonly dau: number;
  readonly wau: number;
  readonly mau: number;
}

/** DAU/WAU/MAU are counts the query layer produced; this asserts their shape. */
export function activeUsers(counts: ActiveUserCounts): ActiveUserCounts {
  assertNonNegativeInteger(counts.dau, 'DAU');
  assertNonNegativeInteger(counts.wau, 'WAU');
  assertNonNegativeInteger(counts.mau, 'MAU');
  return counts;
}

export function stickiness(counts: ActiveUserCounts): number | null {
  return rate(counts.dau, counts.mau);
}

export function activationRate(activatedFamilies: number, cohortSize: number): number | null {
  return rate(activatedFamilies, cohortSize);
}

/** MEDIAN, per the definition. Sorted copy; even-length averages the middle two. */
export function medianHours(elapsedMinutes: readonly number[]): number | null {
  if (elapsedMinutes.length === 0) return null;
  const sorted = [...elapsedMinutes].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const minutes =
    sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  return Math.round((minutes / 60) * 100) / 100;
}

export type RetentionDay = 1 | 7 | 30 | 90;

export const RETENTION_KPI_BY_DAY: Readonly<Record<RetentionDay, KpiId>> = {
  1: 'RETENTION_D1',
  7: 'RETENTION_D7',
  30: 'RETENTION_D30',
  90: 'RETENTION_D90',
};

/**
 * ONE retention function for all four horizons. `cohortSize` of 0 gives null,
 * and so does a cohort too young to have reached the horizon — the caller
 * passes `retainedOnDay = null` for that case rather than 0.
 */
export function retention(retainedOnDay: number | null, cohortSize: number): number | null {
  if (retainedOnDay === null) return null;
  return rate(retainedOnDay, cohortSize);
}

export function churnRate(churnedInPeriod: number, paidAtPeriodStart: number): number | null {
  return rate(churnedInPeriod, paidAtPeriodStart);
}

export function conversionRate(everPaidFamilies: number, cohortSize: number): number | null {
  return rate(everPaidFamilies, cohortSize);
}

export function trialConversionRate(convertedTrials: number, resolvedTrials: number): number | null {
  return rate(convertedTrials, resolvedTrials);
}

/**
 * ARPU / ARPPU. Integer division with rounding to the nearest minor unit — the
 * remainder is genuinely lost, and that is correct: an average is not a
 * distribution of actual money and must not pretend to sub-minor precision.
 */
export function arpu(netRevenueMinor: number, activeFamilies: number, currencyCode: string): MoneyKpi | null {
  assertCurrency(currencyCode);
  assertNonNegativeInteger(netRevenueMinor, 'netRevenueMinor');
  assertNonNegativeInteger(activeFamilies, 'activeFamilies');
  if (activeFamilies === 0) return null;
  return { amountMinor: Math.round(netRevenueMinor / activeFamilies), currencyCode };
}

export function arppu(netRevenueMinor: number, payingFamilies: number, currencyCode: string): MoneyKpi | null {
  return arpu(netRevenueMinor, payingFamilies, currencyCode);
}

/** One live subscription, reduced to the two facts MRR needs. */
export interface MrrComponent {
  readonly netAmountMinor: number;
  /** 1 = monthly, 12 = annual. Comes from `subscription_prices.billing_period`. */
  readonly billingIntervalMonths: number;
}

/**
 * MRR. An annual subscription contributes `net / 12`, rounded to the minor unit
 * — never `net`. The rounding is per-subscription and then summed, which is the
 * conservative order: rounding the sum would let 12,000 annual subscriptions
 * drift by up to 12,000 minor units against the invoices that back them.
 */
export function mrr(components: readonly MrrComponent[], currencyCode: string): MoneyKpi {
  assertCurrency(currencyCode);
  let total = 0;
  for (const c of components) {
    assertNonNegativeInteger(c.netAmountMinor, 'netAmountMinor');
    if (!Number.isInteger(c.billingIntervalMonths) || c.billingIntervalMonths < 1) {
      throw new RangeError(`billingIntervalMonths must be a positive integer; got ${c.billingIntervalMonths}.`);
    }
    total += Math.round(c.netAmountMinor / c.billingIntervalMonths);
  }
  return { amountMinor: total, currencyCode };
}

/** ARR is 12 × MRR. There is no other definition and no other implementation. */
export function arr(monthlyRecurring: MoneyKpi): MoneyKpi {
  return { amountMinor: monthlyRecurring.amountMinor * 12, currencyCode: monthlyRecurring.currencyCode };
}

export function cac(spendMinor: number, newPaidCustomers: number, currencyCode: string): MoneyKpi | null {
  assertCurrency(currencyCode);
  assertNonNegativeInteger(spendMinor, 'spendMinor');
  assertNonNegativeInteger(newPaidCustomers, 'newPaidCustomers');
  if (newPaidCustomers === 0) return null;
  return { amountMinor: Math.round(spendMinor / newPaidCustomers), currencyCode };
}

/**
 * LTV = ARPPU × grossMargin × (1 / monthlyChurn).
 *
 * `grossMarginRate` is an ASSUMPTION (docs/12 §10.2) and the caller is
 * responsible for tagging the result FORECAST. A churn of 0 has no finite
 * lifetime, so it returns `null` rather than Infinity — an infinite LTV is
 * always a measurement artefact of a cohort too young to have churned.
 */
export function ltv(
  arppuValue: MoneyKpi,
  grossMarginRate: number,
  monthlyChurnRate: number,
): MoneyKpi | null {
  if (grossMarginRate <= 0 || grossMarginRate > 1) {
    throw new RangeError(`grossMarginRate must be in (0, 1]; got ${grossMarginRate}.`);
  }
  if (monthlyChurnRate <= 0 || monthlyChurnRate > 1) return null;
  const expectedLifetimeMonths = 1 / monthlyChurnRate;
  return {
    amountMinor: Math.round(arppuValue.amountMinor * grossMarginRate * expectedLifetimeMonths),
    currencyCode: arppuValue.currencyCode,
  };
}

/** Both sides must be the same currency — enforced, not assumed. */
export function ltvToCac(lifetimeValue: MoneyKpi, acquisitionCost: MoneyKpi): number | null {
  if (lifetimeValue.currencyCode !== acquisitionCost.currencyCode) {
    throw new RangeError(
      `LTV/CAC compares ${lifetimeValue.currencyCode} with ${acquisitionCost.currencyCode}. ` +
        'Cross-currency ratios are meaningless without an FX rate this layer does not have.',
    );
  }
  if (acquisitionCost.amountMinor === 0) return null;
  return Math.round((lifetimeValue.amountMinor / acquisitionCost.amountMinor) * 100) / 100;
}

export function roas(attributedNetRevenue: MoneyKpi, spend: MoneyKpi): number | null {
  if (attributedNetRevenue.currencyCode !== spend.currencyCode) {
    throw new RangeError(
      `ROAS compares ${attributedNetRevenue.currencyCode} revenue with ${spend.currencyCode} spend.`,
    );
  }
  if (spend.amountMinor === 0) return null;
  return Math.round((attributedNetRevenue.amountMinor / spend.amountMinor) * 100) / 100;
}

export function paybackMonths(
  acquisitionCost: MoneyKpi,
  arppuValue: MoneyKpi,
  grossMarginRate: number,
): number | null {
  if (acquisitionCost.currencyCode !== arppuValue.currencyCode) {
    throw new RangeError(
      `Payback compares ${acquisitionCost.currencyCode} CAC with ${arppuValue.currencyCode} ARPPU.`,
    );
  }
  if (grossMarginRate <= 0 || grossMarginRate > 1) {
    throw new RangeError(`grossMarginRate must be in (0, 1]; got ${grossMarginRate}.`);
  }
  const marginPerMonth = arppuValue.amountMinor * grossMarginRate;
  if (marginPerMonth <= 0) return null;
  return Math.round((acquisitionCost.amountMinor / marginPerMonth) * 100) / 100;
}

/**
 * PROVENANCE. Every number this module hands to the API carries one of these,
 * and the API renders it. An assumption presented as a fact is the specific
 * failure mode a forecasting surface has, and a type is a cheaper defence than
 * a convention.
 */
export type KpiProvenance = 'ACTUAL' | 'TARGET' | 'FORECAST';

export interface KpiValue {
  readonly kpi: KpiId;
  readonly provenance: KpiProvenance;
  /** `null` means "no data", never "zero" — see rule 3. */
  readonly value: number | null;
  readonly currencyCode: string | null;
  readonly kind: KpiKind;
}

export function kpiValue(
  kpi: KpiId,
  provenance: KpiProvenance,
  value: number | MoneyKpi | null,
): KpiValue {
  const definition = KPI_DEFINITIONS[kpi];
  if (value === null) {
    return { kpi, provenance, value: null, currencyCode: null, kind: definition.kind };
  }
  if (typeof value === 'number') {
    return { kpi, provenance, value, currencyCode: null, kind: definition.kind };
  }
  return {
    kpi,
    provenance,
    value: value.amountMinor,
    currencyCode: value.currencyCode,
    kind: definition.kind,
  };
}
