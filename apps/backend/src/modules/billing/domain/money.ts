/**
 * PHASE D — MONEY, AND THE ARITHMETIC AROUND VAT.
 *
 * Two rules, both structural:
 *
 *  1. AMOUNTS ARE INTEGERS IN MINOR UNITS. Never a float, never a Number of
 *     major units. `99.00` cannot be represented exactly in IEEE-754 and a
 *     subscription system that rounds a tenth of a piastre the wrong way
 *     14,000 times has an accounting problem no test will find.
 *
 *  2. THE MINOR-UNIT EXPONENT IS DATA, not the constant 100. EGP and SAR are
 *     both 2, which is exactly why hardcoding 100 would look correct here and
 *     be wrong the first time this product is sold in Kuwait (KWD, 3) — and
 *     both launch markets border it.
 *
 * VAT is expressed in BASIS POINTS (1400 = 14.00%) for the same reason: 0.14 is
 * not exactly representable either, and a tax authority does not accept
 * "floating point" as an explanation.
 */

export type VatMode = 'INCLUSIVE' | 'EXCLUSIVE';

/** The three parts of a charge. They always satisfy net + vat === gross. */
export interface IMoneyBreakdown {
  /** What the customer is actually charged, VAT included. */
  readonly grossMinor: number;
  /** The tax component of `grossMinor`. */
  readonly vatMinor: number;
  /** `grossMinor - vatMinor`. The part that is revenue. */
  readonly netMinor: number;
  readonly currency: string;
  /** The rate this breakdown was computed at, frozen for the invoice. */
  readonly vatBasisPoints: number;
}

export class MoneyError extends Error {}

const BASIS_POINT_SCALE = 10_000;

/**
 * Splits a configured price into net/VAT/gross.
 *
 * INCLUSIVE (the default for consumer pricing in both launch markets): the
 * configured `amountMinor` IS the gross. The customer sees 99 EGP and pays 99
 * EGP; the 14% is carved out of it. `vat = round(gross * bp / (10000 + bp))`.
 *
 * EXCLUSIVE: the configured `amountMinor` is the net and VAT is added on top.
 * `vat = round(net * bp / 10000)`.
 *
 * Rounding is half-up on a single integer division, applied once, to the VAT
 * component only — the net is then derived by subtraction. That ordering is
 * what guarantees `net + vat === gross` exactly, for every input, with no
 * residual cent. Computing net and vat independently and hoping they add up is
 * the classic way this goes wrong.
 */
export function splitVat(params: {
  amountMinor: number;
  vatBasisPoints: number;
  vatMode: VatMode;
  currency: string;
}): IMoneyBreakdown {
  const { amountMinor, vatBasisPoints, vatMode, currency } = params;

  if (!Number.isInteger(amountMinor) || amountMinor < 0) {
    throw new MoneyError(`amountMinor must be a non-negative integer of minor units, got ${amountMinor}.`);
  }
  if (!Number.isInteger(vatBasisPoints) || vatBasisPoints < 0 || vatBasisPoints > BASIS_POINT_SCALE) {
    throw new MoneyError(`vatBasisPoints must be an integer in [0, 10000], got ${vatBasisPoints}.`);
  }
  assertCurrencyCode(currency);

  if (vatMode === 'INCLUSIVE') {
    const grossMinor = amountMinor;
    const vatMinor = roundHalfUp(grossMinor * vatBasisPoints, BASIS_POINT_SCALE + vatBasisPoints);
    return { grossMinor, vatMinor, netMinor: grossMinor - vatMinor, currency, vatBasisPoints };
  }

  const netMinor = amountMinor;
  const vatMinor = roundHalfUp(netMinor * vatBasisPoints, BASIS_POINT_SCALE);
  return { grossMinor: netMinor + vatMinor, vatMinor, netMinor, currency, vatBasisPoints };
}

/** Integer half-up division. No Math.round, no float intermediate. */
function roundHalfUp(numerator: number, denominator: number): number {
  return Math.floor((numerator * 2 + denominator) / (denominator * 2));
}

/**
 * ISO-4217 is three uppercase letters. Enforced here AND by a CHECK constraint
 * in migration 0014 — "egp" and "EGP " are the kind of value that produces a
 * silent currency mismatch discovered three months later in a reconciliation.
 */
export function assertCurrencyCode(currency: string): void {
  if (!/^[A-Z]{3}$/.test(currency)) {
    throw new MoneyError(`Currency must be an ISO-4217 alpha-3 code in uppercase, got "${currency}".`);
  }
}

/**
 * Compares an amount a PROVIDER reported against the amount our own price
 * catalogue says the thing costs.
 *
 * A tolerance exists and is deliberately tiny (default: 0 minor units). It is a
 * parameter and not a hardcoded slack because a store's FX conversion of a
 * price we set in EGP can legitimately land a unit away, while a direct
 * gateway charging a price we ourselves computed cannot. Whoever widens it has
 * to say so at the call site.
 */
export function amountsMatch(expectedMinor: number, actualMinor: number, toleranceMinor = 0): boolean {
  return Math.abs(expectedMinor - actualMinor) <= toleranceMinor;
}

/** Renders minor units for a log line or an invoice. Never for arithmetic. */
export function formatMinor(amountMinor: number, minorUnits: number): string {
  if (minorUnits === 0) return String(amountMinor);
  const divisor = 10 ** minorUnits;
  const major = Math.floor(Math.abs(amountMinor) / divisor);
  const minor = Math.abs(amountMinor) % divisor;
  const sign = amountMinor < 0 ? '-' : '';
  return `${sign}${major}.${String(minor).padStart(minorUnits, '0')}`;
}
