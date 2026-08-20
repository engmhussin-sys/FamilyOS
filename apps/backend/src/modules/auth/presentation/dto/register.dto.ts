import { Transform, Type } from 'class-transformer';
import {
  Equals,
  IsEmail,
  IsOptional,
  IsString,
  Length,
  Matches,
  MaxLength,
  ValidateNested,
} from 'class-validator';

import { IsIanaTimeZone } from '../../../../common/time/is-iana-timezone.validator';
import {
  COUNTRY_CODE_PATTERN,
  normaliseCountryCode,
} from '../../../settings/domain/country';

/**
 * PHASE D (GROWTH) — ACQUISITION ATTRIBUTION, CAPTURED AT THE ONE MOMENT IT
 * EXISTS.
 *
 * Every field is OPTIONAL and every field is UNTRUSTED. A direct install sends
 * none of it; a TikTok install sends most of it. The values are normalised,
 * length-capped and mapped onto a CLOSED channel vocabulary in
 * `analytics/domain/attribution.ts` before they reach the database, and an
 * unrecognised `source` becomes `OTHER` rather than a new channel invented at
 * runtime.
 *
 * NOTHING HERE AFFECTS AUTHORIZATION. There is deliberately no `familyId` and
 * no `userId`: the tenant is created by this very transaction, and CI RULE 3
 * (`assert-tenant-scoping.ts`) fails the build for any request DTO that carries
 * a `familyId` at all.
 */
export class RegistrationAttributionDto {
  @IsOptional() @IsString() @MaxLength(120) source?: string;
  @IsOptional() @IsString() @MaxLength(120) campaign?: string;
  @IsOptional() @IsString() @MaxLength(60) medium?: string;
  @IsOptional() @IsString() @MaxLength(120) content?: string;
  /** ISO-3166 alpha-2. Anything else is discarded rather than stored. */
  @IsOptional() @IsString() @MaxLength(2) countryCode?: string;
  /** ANDROID | IOS | WEB. Anything else resolves to UNKNOWN. */
  @IsOptional() @IsString() @MaxLength(20) platform?: string;
  /** Another household's referral code, if this install came from one. */
  @IsOptional() @IsString() @MaxLength(32) referralCode?: string;
  @IsOptional() @IsString() @MaxLength(400) referrer?: string;
  @IsOptional() @IsString() @MaxLength(400) landingPage?: string;
  /**
   * The anonymous session the APP_INSTALLED event was emitted under. This is
   * the ONLY join between the pre-registration funnel and the post-registration
   * one — without it, INSTALL cannot be attributed to a campaign at all.
   */
  @IsOptional() @IsString() @MaxLength(100) sessionId?: string;
}

export class RegisterDto {
  @IsEmail()
  @MaxLength(255)
  email!: string;

  /**
   * Minimum 10 chars, at least one letter and one number. This is a
   * baseline — the frontend should additionally surface a strength meter,
   * but the backend is the source of truth and must never trust the
   * client to have enforced this.
   */
  @IsString()
  @Length(10, 128)
  @Matches(/(?=.*[A-Za-z])(?=.*\d)/, {
    message: 'Password must contain at least one letter and one number.',
  })
  password!: string;

  @IsString()
  @Length(2, 100)
  fullName!: string;

  @IsOptional()
  @IsString()
  @Length(2, 100)
  familyName?: string;

  /**
   * B2: the family's calendar, set at the only moment a Family row is created.
   * Validated as a real IANA zone (see `IsIanaTimeZone`); absent means the
   * schema default, `"UTC"`.
   */
  @IsOptional()
  @IsIanaTimeZone()
  timezone?: string;

  /**
   * F1 — THE FAMILY'S MARKET, SET AT THE ONE MOMENT THE `Family` ROW IS
   * CREATED.
   *
   * WHY IT IS HERE AND NOT LEFT TO A FOLLOW-UP `PATCH /settings`. Registration
   * is the only place `tx.family.create` runs. A household created blank and
   * patched afterwards depends on a second call the client may never make — and
   * a client that crashes, loses connectivity, or simply skips the settings
   * screen leaves that family with no market forever, which is the state every
   * existing row is in today.
   *
   * OPTIONAL, AND IT STAYS OPTIONAL. A registration that omits it succeeds and
   * leaves the column NULL. There is no default: 'EG' would be an invented fact
   * about a real household, and `schema.prisma` refuses exactly that beside the
   * column.
   *
   * NOT AUTHORITATIVE, EITHER. For a pilot registration the country recorded on
   * the OPERATOR's invitation outranks this field — see `AuthService.register`.
   *
   * DELIBERATELY DISTINCT FROM `attribution.countryCode`, which stays where it
   * is and is unchanged. That one is an untrusted MARKETING label describing
   * where an ad was clicked; this one is the household's market, backed by a
   * real foreign key to `countries`. Same normalisation and the same catalogue
   * check as `UpdateSettingsDto`: the shape here, the vocabulary in
   * `CountryCatalogueService`.
   */
  @IsOptional()
  @Transform(({ value }) => normaliseCountryCode(value) ?? value)
  @IsString()
  @Matches(COUNTRY_CODE_PATTERN, {
    message:
      'countryCode must be an ISO-3166-1 alpha-2 code such as "EG" or "SA". Whether that market is served is checked separately, against the countries catalogue.',
  })
  countryCode?: string;

  @IsOptional()
  @IsString()
  locale?: string;

  /** CLOSES A REAL GAP (proactive business/code audit): zero Terms of
   * Service acceptance requirement existed anywhere in registration.
   * @Equals(true) — not @IsBoolean() — deliberately: registration
   * must genuinely fail if this isn't explicitly true, not merely
   * present as any boolean value (a client sending `false` should be
   * rejected exactly like a client sending nothing at all). */
  @Equals(true, { message: 'You must accept the Terms of Service to create an account.' })
  acceptedTerms!: boolean;

  /** PHASE D (GROWTH). See `RegistrationAttributionDto` above. */
  @IsOptional()
  @ValidateNested()
  @Type(() => RegistrationAttributionDto)
  attribution?: RegistrationAttributionDto;
}
