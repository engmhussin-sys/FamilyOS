import { BadRequestException } from '@nestjs/common';

/**
 * F1 — THE TWO REFUSALS `Family.countryCode` CAN PRODUCE, AS TYPED ERRORS.
 *
 * Both carry `{ code, messageAr }` because B3 made that the error contract:
 * `GlobalExceptionFilter` cannot emit a body without a machine-readable `code`
 * and an Arabic sentence, and a parent must never read a raw backend token.
 *
 * THE POINT OF THROWING THESE AT ALL is what they replace. Migration 0022 put
 * a REAL foreign key on `families.country_code`. Without a check in front of
 * it, `PATCH /settings {"countryCode":"US"}` reaches Postgres, violates
 * `families_country_code_fkey`, and Prisma raises a `PrismaClientKnownRequestError`
 * — which is NOT an `HttpException`, so the filter turns it into a generic 500.
 * The household sees «حدث خطأ غير متوقّع عندنا» for what is a perfectly
 * ordinary "we are not in that market yet", and the server log carries a
 * database constraint name as the only explanation. A typed 400 is both the
 * honest status and the only one a client can act on.
 */

/**
 * The code is well-formed but is not a market this deployment serves — either
 * no `countries` row exists for it, or the row exists with `is_active = false`.
 *
 * ONE ERROR FOR BOTH CASES, DELIBERATELY. «Kuwait exists in our catalogue but is
 * switched off» is commercial information about an unlaunched market; a public
 * endpoint should not let anyone enumerate it. The distinction is kept
 * server-side, where the operator can see it.
 */
export class UnsupportedCountryException extends BadRequestException {
  constructor(countryCode: string) {
    super({
      code: 'COUNTRY_NOT_SUPPORTED',
      message: `"${countryCode}" is not a supported market. Supported markets are the active rows in the countries catalogue.`,
      messageAr: 'هذا البلد غير متاح حاليًا. اختر بلدًا من البلدان المتاحة.',
      details: { countryCode },
    });
  }
}

/**
 * The client stated a country AND a timezone, and they describe two different
 * calendars. See `CountryCalendar.reconcile` for why the pair may not disagree.
 */
export class CountryTimezoneMismatchException extends BadRequestException {
  constructor(countryCode: string, timezone: string, expected: string) {
    super({
      code: 'COUNTRY_TIMEZONE_MISMATCH',
      message:
        `Timezone "${timezone}" does not match country "${countryCode}", whose reporting calendar is ` +
        `"${expected}". A family has ONE calendar; sending a country and a contradicting timezone in the ` +
        `same request leaves the server to guess which one the household meant.`,
      messageAr: 'المنطقة الزمنية المُختارة لا تناسب البلد المُختار. اترك المنطقة الزمنية ليضبطها النظام، أو اختر المنطقة الصحيحة للبلد.',
      details: { countryCode, timezone, expectedTimezone: expected },
    });
  }
}
