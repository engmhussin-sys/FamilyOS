/**
 * F1 — `Family.countryCode`, THE DOMAIN HALF.
 *
 * Pure functions only: no Prisma, no Nest, no I/O. What lives here is the
 * SHAPE of a country code (two letters, upper case) — never the LIST of
 * supported ones.
 *
 * WHY THE LIST IS NOT HERE, AND WILL NOT BE. `schema.prisma` states it beside
 * the column: «`countries` is the launch-market catalogue and adding a market is
 * an INSERT, not a migration.» A TypeScript union `'EG' | 'SA'`, or an enum, or
 * a `const SUPPORTED = ['EG','SA']` in this file, would all quietly contradict
 * that: opening Kuwait would become a code change, a review, a build and a
 * deploy instead of one row. Worse, it would create a SECOND source of truth
 * that can disagree with the `countries` table and with the real foreign key
 * migration 0022 installed — and when those two disagree, the validator says
 * yes and the database says no, which is a 500 with a constraint name in it.
 *
 * So the vocabulary check is a query (`CountryCatalogueService`), and this file
 * only removes the inputs that cannot possibly be a country code before that
 * query is worth making.
 */

/** ISO-3166-1 alpha-2: exactly two letters. Nothing else is a country code. */
const ALPHA2 = /^[A-Za-z]{2}$/;

/**
 * Trims and UPPER-CASES a client-supplied country code, or returns `null` when
 * the input cannot be one at all.
 *
 * Normalisation happens BEFORE validation everywhere this is used, so `"eg"`,
 * `" eg "` and `"Eg"` are the same market and all three are stored as `"EG"`.
 * The database column is `VarChar(2)` and the FK targets `countries.code`,
 * whose rows are upper case — accepting `"eg"` unnormalised would mean a
 * foreign-key violation surfacing as a 500 for what is really a formatting
 * difference.
 *
 * Returns `null` rather than throwing: the caller decides whether an
 * unusable value is a 400 (a client sent it) or a logged fallback (an operator
 * record contained it).
 */
export function normaliseCountryCode(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!ALPHA2.test(trimmed)) return null;
  return trimmed.toUpperCase();
}

/** The regex the DTOs use, exported so the shape rule is stated exactly once. */
export const COUNTRY_CODE_PATTERN = ALPHA2;
