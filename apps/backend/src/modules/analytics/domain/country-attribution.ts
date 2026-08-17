/**
 * F1 — HOW A HOUSEHOLD IS ATTRIBUTED TO A MARKET. ONE ANSWER, ONE FILE.
 *
 * Before this file, four services each carried their own copy of the predicate
 * (`kpi.service.ts`, `growth-aggregation.service.ts`, `growth-alerts.service.ts`,
 * `funnel.service.ts`), and they were not even the same predicate: two ORed
 * attribution with the subscription's country, two used attribution alone. So
 * "registrations in SA" and "the SA conversion alert" counted different sets of
 * families, and nothing in the system could tell you they disagreed. That is
 * exactly the failure `kpi-definitions.ts` was written to prevent one layer up.
 *
 * ── THE PRECEDENCE, AND WHY IT IS THIS ORDER ────────────────────────────────
 *
 *   1. `families.country_code` — the SERVER's answer. Set at registration (or
 *      by the household in settings), verified against the ACTIVE `countries`
 *      rows, and backed by a REAL foreign key since migration 0022. When it is
 *      present it DECIDES, and nothing else is consulted.
 *
 *   2. `acquisition_attribution.country_code` — an untrusted marketing label
 *      about where an ad was clicked. Consulted ONLY for families whose own
 *      column is NULL, which is every household created before F1.
 *
 *   3. `subscriptions.country_code` — what the household actually bought in.
 *      Same condition: only when (1) is NULL.
 *
 * THE `country_code IS NULL` CONDITION ON (2) AND (3) IS THE LOAD-BEARING PART.
 * Without it a family whose server-held country is 'EG' but whose ad label says
 * 'SA' would be counted in BOTH markets: the sum of the per-country numbers
 * would exceed the platform number, and every rate computed from them would be
 * wrong in a direction nobody could explain. With it, the markets are DISJOINT
 * by construction — each family is counted in at most one — and a client's
 * claim can never overrule the server's record.
 *
 * ── FAMILIES WITH NO COUNTRY AT ALL ─────────────────────────────────────────
 *
 * A family with a NULL column, no attribution row and no subscription is NOT
 * COUNTRY-ATTRIBUTABLE. It is:
 *
 *   - EXCLUDED from every per-country number. Folding it into EG (the larger
 *     market, or the platform default calendar) would publish an invented fact
 *     as a measured one — the thing `schema.prisma` refuses beside the column
 *     and the thing this module's «null, never 0» rule exists for.
 *
 *   - INCLUDED in every platform-scope (`**`) number, because it is a real
 *     household and the platform total is a count of real households. Dropping
 *     it would understate the platform silently.
 *
 * That combination is deliberate and it is OBSERVABLE rather than hidden: the
 * platform row of `growth_daily_metrics` minus the sum of the country rows IS
 * the unattributable population, on any given day, without a new metric being
 * invented to report it.
 */

/** The platform-wide sentinel used by `growth_daily_metrics.country_code`. */
export const PLATFORM_SCOPE = '**';

/**
 * A Prisma `where` fragment over `Family`, restricting to one market.
 *
 * Returns `{}` for platform scope — every family, attributable or not.
 * Spread it into a family `where`; it introduces exactly one top-level key
 * (`OR`), which no caller in this module otherwise uses.
 */
export function familyCountryWhere(countryCode: string): Record<string, unknown> {
  if (countryCode === PLATFORM_SCOPE) return {};
  return {
    OR: [
      // (1) The server's own record. Authoritative, and exclusive.
      { countryCode },
      // (2) and (3) apply ONLY to families the server has no country for.
      {
        countryCode: null,
        OR: [{ acquisitionAttribution: { countryCode } }, { subscription: { countryCode } }],
      },
    ],
  };
}

/**
 * THE SAME PRECEDENCE APPLIES ROW-BY-ROW, and it is written out — not
 * re-implemented — in `ActivationService.countryOf`, which STAMPS
 * `family_activations.country_code` at the moment a household activates. It
 * short-circuits on the first source that answers rather than loading all
 * three, which is why it is not a call to a function here; the ordering it
 * follows is the ordering above, and its comment says so. If that ordering ever
 * changes, both places are named in this paragraph.
 */
