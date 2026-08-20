import type { CountryScope, CurrencyCode, KpiKind } from '../api/types';
import { PLATFORM_SCOPE } from '../api/types';
import type { Locale } from '../../../shared/i18n/localizationEngine';

/**
 * The rendering half of the contract's money rules.
 *
 * Backend rule 3: money is an integer in minor units and ALWAYS carries a
 * `currencyCode`; at `countryCode='**'` every money KPI is `null`, because
 * adding EGP to SAR without a rate is a lie.
 *
 * This module makes the client half of that unbreakable: `formatMoneyMinor`
 * REQUIRES a country scope alongside the currency and throws when it is
 * absent or is the platform scope. A bare "١٥٧٫٠٢" on an executive screen is
 * the single easiest way to have a Cairo number read as a Riyadh number, and
 * a throw at the call site is cheaper than that mistake in a board deck.
 */
export class CurrencyWithoutCountryError extends Error {
  constructor(
    public readonly currencyCode: CurrencyCode,
    public readonly countryScope: CountryScope | null,
  ) {
    super(
      `Refusing to render ${currencyCode} without a country context (got ${
        countryScope ?? 'null'
      }). Money is only meaningful beside the market it was earned in.`,
    );
    this.name = 'CurrencyWithoutCountryError';
  }
}

/** The dash an operator must see instead of a fabricated zero. */
export const NO_DATA = '—';

/**
 * Minor-unit divisors. The contract is explicit that "minor units = 1/100"
 * is NOT a safe assumption in general (currencies carry `minorUnits` as a
 * column), so this map is the client's declared knowledge of the two
 * launch currencies — and an unknown currency falls back to 2 rather than
 * silently mis-scaling by 100.
 */
const MINOR_UNITS: Record<CurrencyCode, number> = { EGP: 2, SAR: 2 };

const BCP47: Record<Locale, string> = { ar: 'ar-EG', en: 'en-US' };

/** Egypt reports in EGP, Saudi Arabia in SAR. Used to prove a rendered
 * currency belongs to the country it is displayed under. */
export const COUNTRY_CURRENCY: Record<'EG' | 'SA', CurrencyCode> = { EG: 'EGP', SA: 'SAR' };

/** The inverse of `COUNTRY_CURRENCY`, and the only sanctioned way to answer
 * "which market does this currency belong to" for a payload that carries a
 * currency but no country. Derived from the same single mapping above, so
 * the two can never drift apart. */
export const CURRENCY_COUNTRY: Record<CurrencyCode, 'EG' | 'SA'> = { EGP: 'EG', SAR: 'SA' };

/** Narrows a backend string to a currency this client actually knows the
 * minor-unit scale of. Anything else is unknown, not "probably /100". */
export function isKnownCurrency(code: string | null | undefined): code is CurrencyCode {
  return code === 'EGP' || code === 'SAR';
}

export interface MoneyFormatOptions {
  /** Set only where space forces it (axis ticks, dense tables). */
  compact?: boolean;
  /** Drop the currency symbol — for a column already headed by its currency. */
  omitCurrency?: boolean;
}

/**
 * Formats a minor-unit integer for display.
 *
 * @throws CurrencyWithoutCountryError when `countryScope` is missing or is
 *   the platform scope `'**'`. This is deliberate and is covered by a test:
 *   any code path that reaches a currency without knowing which market it
 *   belongs to is a bug, not a display edge case.
 */
export function formatMoneyMinor(
  locale: Locale,
  valueMinor: number | null,
  currencyCode: CurrencyCode | null,
  countryScope: CountryScope | null,
  options: MoneyFormatOptions = {},
): string {
  if (currencyCode !== null && (countryScope === null || countryScope === PLATFORM_SCOPE)) {
    throw new CurrencyWithoutCountryError(currencyCode, countryScope);
  }
  if (valueMinor === null || currencyCode === null) return NO_DATA;

  const divisor = 10 ** MINOR_UNITS[currencyCode];
  const major = valueMinor / divisor;

  return new Intl.NumberFormat(BCP47[locale], {
    style: options.omitCurrency ? 'decimal' : 'currency',
    currency: currencyCode,
    currencyDisplay: 'code',
    notation: options.compact ? 'compact' : 'standard',
    maximumFractionDigits: options.compact ? 1 : 2,
    minimumFractionDigits: options.compact ? 0 : 2,
  }).format(major);
}

/**
 * The same renderer, for the payloads that carry a currency STRING and no
 * country at all — `/billing/plans` (`priceCents` + `currency`) and
 * `/billing/history` (`amountCents` + `currency`).
 *
 * WHY THIS EXISTS (A1). Billing used to open-code `(cents / 100).toFixed(2)`,
 * which is the exact assumption this module's own header refuses: minor units
 * are a per-currency property, not a constant. It also produced Latin digits
 * with a trailing code («179.00 EGP») on a dashboard whose every other money
 * figure is locale-formatted with the currency placed by `Intl`. One number,
 * two renderings, in one product.
 *
 * The country is resolved from the currency through `CURRENCY_COUNTRY`, so
 * `formatMoneyMinor`'s country requirement is satisfied honestly rather than
 * bypassed. A currency this client does not know renders as `NO_DATA`: an
 * operator seeing a dash asks a question, and an operator seeing a number
 * scaled by a guessed divisor does not.
 *
 * `cents` in the field name is the backend's word. The value is minor units.
 */
export function formatBackendMoneyMinor(
  locale: Locale,
  valueMinor: number | null | undefined,
  currency: string | null | undefined,
  options: MoneyFormatOptions = {},
): string {
  if (!isKnownCurrency(currency)) return NO_DATA;
  if (valueMinor === null || valueMinor === undefined) return NO_DATA;
  return formatMoneyMinor(locale, valueMinor, currency, CURRENCY_COUNTRY[currency], options);
}

export function formatCount(locale: Locale, value: number | null, compact = false): string {
  if (value === null) return NO_DATA;
  return new Intl.NumberFormat(BCP47[locale], {
    notation: compact ? 'compact' : 'standard',
    maximumFractionDigits: compact ? 1 : 0,
  }).format(value);
}

/** A rate arrives as a fraction (0.1029) and is shown as a percentage. */
export function formatRate(locale: Locale, value: number | null, fractionDigits = 1): string {
  if (value === null) return NO_DATA;
  return new Intl.NumberFormat(BCP47[locale], {
    style: 'percent',
    maximumFractionDigits: fractionDigits,
    minimumFractionDigits: fractionDigits,
  }).format(value);
}

/** A ratio (LTV:CAC, ROAS) is a bare multiple, never a percentage. */
export function formatRatio(locale: Locale, value: number | null, fractionDigits = 2): string {
  if (value === null) return NO_DATA;
  return `${new Intl.NumberFormat(BCP47[locale], {
    maximumFractionDigits: fractionDigits,
    minimumFractionDigits: fractionDigits,
  }).format(value)}×`;
}

export function formatHours(locale: Locale, value: number | null, fractionDigits = 1): string {
  if (value === null) return NO_DATA;
  return new Intl.NumberFormat(BCP47[locale], {
    maximumFractionDigits: fractionDigits,
  }).format(value);
}

export interface KpiFormatContext {
  locale: Locale;
  countryScope: CountryScope | null;
  compact?: boolean;
}

/**
 * The one entry point every KPI display goes through, so `kind` — not a
 * component author's memory — decides whether a number is a percentage, a
 * multiple or money.
 */
export function formatKpi(
  kind: KpiKind,
  value: number | null,
  currencyCode: CurrencyCode | null,
  context: KpiFormatContext,
): string {
  const { locale, countryScope, compact } = context;
  switch (kind) {
    case 'MONEY_MINOR':
      return formatMoneyMinor(locale, value, currencyCode, countryScope, { compact });
    case 'RATE':
      return formatRate(locale, value);
    case 'RATIO':
      return formatRatio(locale, value);
    case 'DURATION_HOURS':
      return formatHours(locale, value);
    case 'COUNT':
      return formatCount(locale, value, compact);
  }
}

/**
 * Renders a country's label with its currency attached, e.g. "مصر · EGP".
 * The pairing is the point: a currency never appears on this dashboard
 * without the market it belongs to sitting beside it.
 */
export function countryWithCurrencyLabel(countryLabel: string, currencyCode: CurrencyCode): string {
  return `${countryLabel} · ${currencyCode}`;
}
