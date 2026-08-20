/**
 * PHASE D (GROWTH) — FORECASTS, TARGETS AND ACTUALS, AND THE WALL BETWEEN THEM.
 *
 * THE ONE RULE THIS FILE EXISTS FOR: **an assumption is never presented as a
 * fact.** Every number the forecasting API returns carries a `provenance` of
 * `ACTUAL`, `TARGET` or `FORECAST`, the three are different fields in the
 * response (never merged into one "value"), and there is no code path that
 * produces a `FORECAST` and labels it `ACTUAL`.
 *
 *   ACTUAL   — measured from rows that exist. Nothing else.
 *   TARGET   — what a human committed to, stored in `growth_quarterly_targets`.
 *              An input, not an output; the system never invents one.
 *   FORECAST — what the model projects from ADMIN-EDITABLE assumptions in
 *              `growth_forecast_scenarios`. Reproducible from its inputs, and
 *              the inputs are returned with it so a reader can disagree.
 *
 * WHY THIS IS A TYPE AND NOT A CONVENTION: the failure mode is not that someone
 * writes down the wrong number. It is that a chart renders a projection in the
 * same colour as a measurement, and six weeks later a decision is made on a
 * line that was always a guess. Making provenance a required field of every
 * value means a dashboard cannot render one without deciding how to show it.
 *
 * THE MODEL IS DELIBERATELY SIMPLE — a monthly cohort roll-forward with a flat
 * churn — and its simplicity is stated rather than hidden. It is not a survival
 * model, it does not fit a curve to observed retention, and it will be wrong in
 * the direction of optimism during the first quarter after launch, when churn
 * has not had time to be observed. A more elaborate model would not be more
 * right on zero months of data; it would only be harder to argue with.
 */

export const FORECAST_SCENARIOS = ['CONSERVATIVE', 'BASE', 'AGGRESSIVE'] as const;
export type ForecastScenarioName = (typeof FORECAST_SCENARIOS)[number];

export const QUARTERS = [1, 2, 3, 4] as const;
export type Quarter = (typeof QUARTERS)[number];

/** The metrics a quarterly target may be set for. Closed vocabulary. */
export const TARGET_METRICS = [
  'USERS',
  'PAID_USERS',
  'REVENUE_MINOR',
  'SUBSCRIPTIONS',
  'CAC_MINOR',
  'CHURN_RATE',
  'MRR_MINOR',
] as const;
export type TargetMetric = (typeof TARGET_METRICS)[number];

/**
 * THE SEVEN ASSUMPTIONS. Every one of them is admin-editable and every one of
 * them is returned alongside any number derived from it.
 */
export interface IForecastAssumptions {
  /** New registered families acquired per month. */
  readonly monthlyAcquisition: number;
  /** Registration → trial. */
  readonly conversionRate: number;
  /** Trial → paid. */
  readonly paidConversionRate: number;
  /** Monthly paid churn. */
  readonly churnRate: number;
  /** Average revenue per PAYING family per month, minor units. */
  readonly arpuMinor: number;
  /** Acquisition cost per PAID customer, minor units. */
  readonly cacMinor: number;
  /** D30 retention of registered families — reported, not used to drive paid maths. */
  readonly retentionD30: number;
}

export interface IForecastMonth {
  readonly monthIndex: number;
  readonly newRegistrations: number;
  readonly newTrials: number;
  readonly newPaid: number;
  readonly churnedPaid: number;
  readonly endingPaid: number;
  readonly mrrMinor: number;
  readonly acquisitionSpendMinor: number;
}

export interface IForecastResult {
  readonly scenario: ForecastScenarioName;
  readonly countryCode: string;
  readonly currencyCode: string;
  readonly assumptions: IForecastAssumptions;
  readonly months: readonly IForecastMonth[];
  readonly endingPaid: number;
  readonly endingMrrMinor: number;
  readonly totalSpendMinor: number;
}

export class InvalidAssumptionsError extends Error {}

function assertRate(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new InvalidAssumptionsError(`${label} must be a rate in [0, 1]; got ${value}.`);
  }
}

function assertNonNegative(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new InvalidAssumptionsError(`${label} must be non-negative; got ${value}.`);
  }
}

export function validateAssumptions(a: IForecastAssumptions): void {
  assertNonNegative(a.monthlyAcquisition, 'monthlyAcquisition');
  assertRate(a.conversionRate, 'conversionRate');
  assertRate(a.paidConversionRate, 'paidConversionRate');
  assertRate(a.churnRate, 'churnRate');
  assertNonNegative(a.arpuMinor, 'arpuMinor');
  assertNonNegative(a.cacMinor, 'cacMinor');
  assertRate(a.retentionD30, 'retentionD30');
}

/**
 * THE ROLL-FORWARD. Pure; no clock, no database.
 *
 * Each month:
 *   newTrials  = monthlyAcquisition × conversionRate
 *   newPaid    = newTrials × paidConversionRate
 *   churned    = round(openingPaid × churnRate)         ← on the OPENING base,
 *                                                          not the closing one,
 *                                                          which is the same
 *                                                          denominator rule the
 *                                                          CHURN_RATE KPI uses.
 *   endingPaid = openingPaid − churned + newPaid
 *   MRR        = endingPaid × arpuMinor
 *   spend      = newPaid × cacMinor
 *
 * Counts are floored, not rounded: a forecast that reports 0.6 of a customer is
 * a forecast that has stopped meaning anything, and flooring errs toward the
 * conservative side, which is the correct direction for a number a budget will
 * be built on.
 */
export function projectMonths(
  assumptions: IForecastAssumptions,
  months: number,
  openingPaid = 0,
): readonly IForecastMonth[] {
  validateAssumptions(assumptions);
  if (!Number.isInteger(months) || months < 1 || months > 60) {
    throw new InvalidAssumptionsError(`months must be an integer in [1, 60]; got ${months}.`);
  }

  const out: IForecastMonth[] = [];
  let paid = openingPaid;

  for (let m = 1; m <= months; m++) {
    const newRegistrations = Math.floor(assumptions.monthlyAcquisition);
    const newTrials = Math.floor(newRegistrations * assumptions.conversionRate);
    const newPaid = Math.floor(newTrials * assumptions.paidConversionRate);
    const churnedPaid = Math.round(paid * assumptions.churnRate);
    const endingPaid = Math.max(0, paid - churnedPaid) + newPaid;

    out.push({
      monthIndex: m,
      newRegistrations,
      newTrials,
      newPaid,
      churnedPaid,
      endingPaid,
      mrrMinor: endingPaid * assumptions.arpuMinor,
      acquisitionSpendMinor: newPaid * assumptions.cacMinor,
    });
    paid = endingPaid;
  }

  return out;
}

export function projectScenario(
  scenario: ForecastScenarioName,
  countryCode: string,
  currencyCode: string,
  assumptions: IForecastAssumptions,
  months: number,
  openingPaid = 0,
): IForecastResult {
  const projected = projectMonths(assumptions, months, openingPaid);
  const last = projected[projected.length - 1];
  return {
    scenario,
    countryCode,
    currencyCode,
    assumptions,
    months: projected,
    endingPaid: last.endingPaid,
    endingMrrMinor: last.mrrMinor,
    totalSpendMinor: projected.reduce((sum, m) => sum + m.acquisitionSpendMinor, 0),
  };
}

/** The three-way row a quarterly report renders. All three fields, always. */
export interface IQuarterlyComparison {
  readonly countryCode: string;
  readonly year: number;
  readonly quarter: Quarter;
  readonly metric: TargetMetric;
  /** Committed by a human. `null` when nobody has set one — never a guess. */
  readonly target: number | null;
  /** Measured. `null` when the quarter has not started. */
  readonly actual: number | null;
  /** Projected. `null` when no scenario is active for the country. */
  readonly forecast: number | null;
  /** `actual / target`, present only when both exist. */
  readonly attainment: number | null;
  readonly currencyCode: string | null;
}

/**
 * The quarter a date falls in, on the CALENDAR year. Deliberately not a fiscal
 * year: no fiscal calendar has been decided for this company, and inventing one
 * inside an analytics module is how two departments end up with two Q1s.
 */
export function quarterOf(month: number): Quarter {
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    throw new RangeError(`quarterOf expects a month in [1, 12]; got ${month}.`);
  }
  return (Math.floor((month - 1) / 3) + 1) as Quarter;
}

/** `[startDate, endDateExclusive]` as `YYYY-MM-DD` strings for a calendar quarter. */
export function quarterDateRange(year: number, quarter: Quarter): { start: string; endExclusive: string } {
  const startMonth = (quarter - 1) * 3 + 1;
  const endMonth = startMonth + 3;
  const pad = (n: number): string => String(n).padStart(2, '0');
  const start = `${year}-${pad(startMonth)}-01`;
  const endExclusive =
    endMonth > 12 ? `${year + 1}-01-01` : `${year}-${pad(endMonth)}-01`;
  return { start, endExclusive };
}
