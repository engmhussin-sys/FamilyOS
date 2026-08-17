import { Injectable, Logger } from '@nestjs/common';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { canonicalTimeZone } from '../../../common/time/family-date';
import { GrowthSettingsService } from '../../analytics/application/growth-settings.service';
import { growthSettingSchema } from '../../analytics/domain/growth-settings';
import { normaliseCountryCode } from '../domain/country';
import {
  CountryTimezoneMismatchException,
  UnsupportedCountryException,
} from '../domain/settings.errors';

/**
 * F1 — THE ONE PLACE A COUNTRY CODE IS ACCEPTED, AND THE ONE PLACE A COUNTRY
 * AND A TIMEZONE ARE RECONCILED.
 *
 * ── WHY A SERVICE AND NOT A `class-validator` DECORATOR ────────────────────
 *
 * The obvious alternative is `@IsSupportedCountry()` next to `@IsIanaTimeZone()`
 * in the DTO. It was rejected for a concrete, checkable reason: a
 * class-validator constraint that needs a database needs Nest's DI container,
 * which needs `useContainer(app, { fallbackOnErrors: true })` at bootstrap.
 * `grep -rn useContainer src/ test/` returns NOTHING in this repository — so a
 * DI-backed validator would be constructed by class-validator itself, with an
 * undefined `PrismaService`, and would throw a `TypeError` inside the
 * ValidationPipe on the first request. Adding `useContainer` to `main.ts` is
 * possible, but `main.ts` is outside this change's ownership and it alters the
 * bootstrap of EVERY validator in the application to make one field easier to
 * annotate.
 *
 * The DTO therefore validates the SHAPE (two letters, normalised to upper case)
 * — which needs no I/O and belongs in a DTO — and the VOCABULARY is checked
 * here, one service call before the write. The refusal is a typed 400 either
 * way; only the layer differs.
 *
 * ── NO CACHE, DELIBERATELY ─────────────────────────────────────────────────
 *
 * `GrowthSettingsService` caches for 60 seconds because it is read on every
 * referral qualification. This is read on `PATCH /settings` and on
 * `POST /auth/register` — a household changes its country approximately once,
 * ever. One primary-key lookup on a two-row table is not worth a cache that
 * would keep serving a market an operator has just switched OFF.
 */
@Injectable()
export class CountryCatalogueService {
  private readonly logger = new Logger(CountryCatalogueService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly growthSettings: GrowthSettingsService,
  ) {}

  /**
   * Normalises and verifies a CLIENT-supplied country code, or throws.
   *
   * `Country` is a GLOBAL model in `tenant-model-registry.ts` («the launch-market
   * catalogue … facts of law, owned by the deployment, identical for every
   * household»), so this read needs no tenant scope and no system bypass —
   * exactly as `PrismaPaymentRepository.findCountry` already reads it.
   */
  async resolveSupported(raw: unknown): Promise<string> {
    const code = normaliseCountryCode(raw);
    // Unreachable through a DTO that already applied COUNTRY_CODE_PATTERN, but
    // this method is also the entry point for values that never passed one.
    if (code === null) throw new UnsupportedCountryException(String(raw));

    const country = await this.prisma.country.findUnique({
      where: { code },
      select: { code: true, isActive: true },
    });

    // INACTIVE IS AS REFUSED AS ABSENT. `countries.is_active` is how a market is
    // closed without deleting rows that prices, subscriptions and payments still
    // point at; a family may not be created in, or moved into, a closed market.
    // The database FK alone would NOT catch this — the row still exists.
    if (!country || !country.isActive) throw new UnsupportedCountryException(code);

    return country.code;
  }

  /**
   * Like `resolveSupported`, but for a value the SERVER already holds (an
   * operator-set `pilot_invites.country_code`, a stored `families.country_code`).
   * Returns `null` instead of throwing.
   *
   * A registration must not fail because an operator typed a country that has
   * since been closed — the same posture `AttributionService` and
   * `PilotEnrollmentService` take with every other label they write.
   */
  async resolveSupportedOrNull(raw: unknown): Promise<string | null> {
    const code = normaliseCountryCode(raw);
    if (code === null) return null;
    const country = await this.prisma.country.findUnique({
      where: { code },
      select: { code: true, isActive: true },
    });
    if (!country || !country.isActive) {
      this.logger.warn(
        `country.server_value_not_supported code=${code} — it is absent from the countries ` +
          `catalogue or inactive. Treated as "no country" rather than failing the request.`,
      );
      return null;
    }
    return country.code;
  }

  /**
   * THE CANONICAL COUNTRY → TIMEZONE MAPPING, READ FROM THE ONE THAT ALREADY
   * EXISTS.
   *
   * `growth_settings` key `reporting.timezone.<CC>` (defaults in
   * `analytics/domain/growth-settings.ts`: `Africa/Cairo` for EG,
   * `Asia/Riyadh` for SA) is already THE mapping this codebase uses to decide
   * where a country's day begins — `GrowthAggregationService` closes each
   * market's day on it and `KpiService` takes every window from it. Writing a
   * second `{ EG: 'Africa/Cairo' }` literal in the settings module would create
   * exactly the two-sources-of-truth failure `kpi-definitions.ts` exists to
   * prevent, one layer down: an admin who moved the reporting calendar would
   * move the dashboard and not the families.
   *
   * Returns `null` when the country has NO configured zone. That case is real
   * and must not be guessed at: `reportingTimeZone()` falls back to
   * `reporting.timezone.PLATFORM` (Africa/Cairo) for an unknown market, which is
   * a sane default for a REPORT and would be plainly wrong as a Kuwaiti
   * household's calendar. A market added by INSERT with no reporting zone
   * therefore constrains nothing here until an operator sets one.
   */
  async canonicalTimeZoneFor(countryCode: string): Promise<string | null> {
    const key = `reporting.timezone.${countryCode}`;
    if (!growthSettingSchema(key)) return null;
    const zone = await this.growthSettings.text(key);
    return canonicalTimeZone(zone);
  }

  /**
   * ── THE COUNTRY / TIMEZONE RULE (T1.3), IN ONE PLACE ──────────────────────
   *
   * THE PROBLEM. `FamilyDateService` derives every business date from
   * `Family.timezone`, and every streak, every daily limit and every reward
   * idempotency key is keyed on a business date. A family row saying «Egypt»
   * and «UTC» is not a cosmetic inconsistency: its day ends two hours late, its
   * streak breaks on a different night than the parent's calendar says, and
   * nothing in the system reports a contradiction because each column is
   * individually valid.
   *
   * THE RULE, and it is one rule with two halves:
   *
   *   1. THE COUNTRY DECIDES THE CALENDAR WHEN THE CLIENT DOES NOT.
   *      A request that sets a country and says nothing about a timezone gets
   *      that country's canonical zone written for it. This is the case that
   *      actually happens — the parent app knows the country from the SIM or the
   *      store front and has no timezone picker — and leaving `timezone` at the
   *      schema default `"UTC"` for an Egyptian household is precisely the
   *      silent breakage above. The server decides; the client never has to
   *      know the mapping (CONTEXT: server is authoritative).
   *
   *   2. A CLIENT MAY NOT ASSERT A CONTRADICTION.
   *      A request that sends BOTH, and sends them disagreeing, is refused with
   *      `COUNTRY_TIMEZONE_MISMATCH`. The alternative — silently overriding the
   *      timezone with the country's — would let a client believe it had set a
   *      calendar it did not set, and the alternative to THAT — storing both as
   *      sent — is the incoherent row this rule exists to prevent.
   *
   * WHY «PLAUSIBLE» IS «EQUAL» HERE. Both launch markets are single-timezone
   * countries: Egypt is `Africa/Cairo` and Saudi Arabia is `Asia/Riyadh`, and
   * the catalogue stores exactly one reporting zone per country. There is no
   * second plausible zone to admit. A future multi-zone market would widen this
   * to a set — the check is against `canonicalTimeZoneFor`, so that becomes a
   * change to the mapping, not to every call site.
   *
   * COMPARISON IS CANONICALISED FIRST. `"egypt"` is a real tzdata link that ICU
   * resolves to `"Africa/Cairo"`; comparing raw strings would reject a caller
   * who was right. `SettingsService` already canonicalises for the same reason.
   *
   * @param countryCode the EFFECTIVE country after precedence, or `null`
   * @param timezone    the timezone the CLIENT sent, or `undefined`
   * @param enforce     `false` when the country came from the SERVER (an
   *                    operator's invitation) rather than from this client — see
   *                    the call site in `AuthService.register` for why refusing
   *                    there would punish a household for someone else's
   *                    mismatch.
   * @returns the timezone to persist, or `undefined` to leave it untouched.
   */
  async reconcileTimeZone(params: {
    countryCode: string | null;
    timezone?: string;
    enforce: boolean;
  }): Promise<string | undefined> {
    const { countryCode, timezone, enforce } = params;
    if (countryCode === null) return timezone;

    const expected = await this.canonicalTimeZoneFor(countryCode);
    // A market with no configured reporting zone constrains nothing.
    if (expected === null) return timezone;

    // Half 1: the client said nothing about a calendar, so the country picks it.
    if (timezone === undefined) return expected;

    const sent = canonicalTimeZone(timezone);
    if (sent === expected) return expected;

    // Half 2: the client contradicted itself.
    if (enforce) throw new CountryTimezoneMismatchException(countryCode, timezone, expected);

    // The country came from the server and outranks the client's timezone. Loud,
    // because a household whose calendar the server chose deserves a trace.
    this.logger.warn(
      `country.timezone_overridden country=${countryCode} sent="${sent}" stored="${expected}" — ` +
        `the country was set by an operator record, which outranks a client-supplied calendar.`,
    );
    return expected;
  }
}
