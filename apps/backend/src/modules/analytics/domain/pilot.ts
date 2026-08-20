/**
 * G16 — THE CONTROLLED PILOT (Saudi Arabia + Egypt), DOMAIN HALF.
 *
 * Pure functions and types only: no Prisma, no Nest, no I/O. The decision this
 * file expresses is the one thing about a pilot gate that must be testable
 * without a database, because it is the thing that can wrongly refuse a real
 * family.
 *
 * WHERE THE CONFIGURATION LIVES: `growth_settings`, keys `pilot.enabled`,
 * `pilot.countries`, `pilot.cohortId`. No new configuration system was built for
 * this — see the comment beside those keys in `growth-settings.ts` for why
 * `feature_flags` was considered and does not fit (its targeting axis is
 * `enabled_family_ids`, and at registration time no family exists to target).
 */

/** Why a registration was allowed, or refused, by the pilot gate. */
export type PilotGateDecision =
  /** The gate is off. The overwhelmingly common case, and the default. */
  | 'PILOT_DISABLED'
  /** The gate is on, but this country is not part of the pilot. */
  | 'COUNTRY_NOT_IN_PILOT'
  /** The gate is on, the country is in the pilot, and this email was invited. */
  | 'INVITED'
  /** The gate is on, the country is in the pilot, and this email was NOT invited. */
  | 'NOT_INVITED'
  /** Invited, but that invitation has already been used by another household. */
  | 'INVITE_ALREADY_REDEEMED';

/**
 * The three decisions that let a registration proceed.
 *
 * Written as an explicit allow-list rather than `!== 'NOT_INVITED'` on purpose: a
 * future decision value added to the union defaults to REFUSED here, which is the
 * safe direction for a gate. The opposite spelling would silently admit it.
 */
const ALLOWED: ReadonlySet<PilotGateDecision> = new Set<PilotGateDecision>([
  'PILOT_DISABLED',
  'COUNTRY_NOT_IN_PILOT',
  'INVITED',
]);

export function isPilotGateAllowed(decision: PilotGateDecision): boolean {
  return ALLOWED.has(decision);
}

/**
 * Parses `growth_settings.pilot.countries` — a comma-separated ISO-3166 alpha-2
 * list, e.g. `"SA,EG"`.
 *
 * TOTAL, and never throws: this value is admin-editable text, so it WILL at some
 * point contain a stray space, a trailing comma, or a lower-cased code. Each of
 * those is normalised rather than treated as a configuration outage, because the
 * consequence of throwing here would be a failed registration — the most
 * expensive request in the funnel — over a typo in a settings row.
 *
 * Anything that is not exactly two letters is DISCARDED rather than guessed at.
 */
export function parsePilotCountries(raw: string): ReadonlySet<string> {
  const codes = raw
    .split(',')
    .map((part) => part.trim().toUpperCase())
    .filter((part) => /^[A-Z]{2}$/.test(part));
  return new Set(codes);
}

/**
 * Whether a registration's reported country falls under the pilot.
 *
 * A registration with NO country reported is NOT in the pilot. That direction is
 * deliberate and it is the interesting decision in this file: `countryCode` comes
 * from `RegistrationAttributionDto`, where every field is optional and untrusted,
 * so treating "absent" as "in the pilot" would refuse every household whose app
 * failed to report a country — including ones outside the pilot markets
 * altogether. A gate that fails closed on missing UNTRUSTED input does not
 * protect the pilot; it breaks registration for people the pilot was never about.
 * The allow-list is what makes the pilot controlled, and it still applies to
 * everyone who does report a pilot country.
 */
export function isCountryInPilot(
  countryCode: string | null | undefined,
  pilotCountries: ReadonlySet<string>,
): boolean {
  if (!countryCode) return false;
  return pilotCountries.has(countryCode.trim().toUpperCase());
}

/** Normalises an email the way the invite table stores it (and CHECKs it). */
export function normalisePilotEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Normalises a country the way the invite table stores it (and CHECKs it). */
export function normalisePilotCountry(countryCode: string): string {
  return countryCode.trim().toUpperCase();
}

export const PILOT_SETTING_KEYS = {
  enabled: 'pilot.enabled',
  countries: 'pilot.countries',
  cohortId: 'pilot.cohortId',
} as const;
