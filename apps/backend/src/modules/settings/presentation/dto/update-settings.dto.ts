import { Transform } from 'class-transformer';
import { IsOptional, IsString, Matches, MaxLength } from 'class-validator';

import { IsIanaTimeZone } from '../../../../common/time/is-iana-timezone.validator';
import { COUNTRY_CODE_PATTERN, normaliseCountryCode } from '../../domain/country';

export class UpdateSettingsDto {
  @IsOptional() @IsString() @MaxLength(200)
  name?: string;

  /**
   * B2 (PA-B-001). THE FAMILY'S CALENDAR — now a real constraint rather than
   * `@IsString() @MaxLength(50)`.
   *
   * Until B2 this column was an orphan: writable here, echoed back by
   * `GET /settings`, and read by NO calculation anywhere in the backend. It is
   * now the input to every business date the system computes, so an
   * unvalidated value would move a whole family's day boundary silently.
   */
  @IsOptional() @IsIanaTimeZone()
  timezone?: string;

  /**
   * F1 — THE FAMILY'S MARKET. THE FIELD WHOSE ABSENCE WAS THE DEFECT.
   *
   * `global-pipeline.ts` sets `forbidNonWhitelisted: true`, so until this line
   * existed a parent app sending `{"countryCode":"EG"}` did not get its country
   * ignored — it got a 400 for the whole request, and the country the household
   * had chosen was dropped on the floor with the rest of the payload. That is
   * why `families.country_code` was empty everywhere.
   *
   * TWO LAYERS, AND THE SPLIT IS DELIBERATE:
   *
   *   HERE, THE SHAPE. Trim, upper-case (`"eg"` -> `"EG"`, so a household is not
   *   refused over keyboard case), and reject anything that is not two letters
   *   before any I/O happens. `@Transform` runs during `plainToInstance`, i.e.
   *   BEFORE `@Matches`, so the pattern below is checked against the normalised
   *   value and the normalised value is what reaches the service.
   *
   *   IN `CountryCatalogueService`, THE VOCABULARY. Whether `"EG"` is a market
   *   this deployment actually serves is a question about the `countries` TABLE,
   *   not about this class. There is deliberately NO `@IsIn(['EG','SA'])` and no
   *   enum here: `schema.prisma` states that adding a market is an INSERT, and a
   *   hardcoded list would silently turn that into a deploy — and could disagree
   *   with the real foreign key migration 0022 installed. See that service's
   *   docstring for why the check is not a DI-backed validator decorator.
   */
  @IsOptional()
  @Transform(({ value }) => normaliseCountryCode(value) ?? value)
  @IsString()
  @Matches(COUNTRY_CODE_PATTERN, {
    message:
      'countryCode must be an ISO-3166-1 alpha-2 code such as "EG" or "SA". Whether that market is served is checked separately, against the countries catalogue.',
  })
  countryCode?: string;
}
