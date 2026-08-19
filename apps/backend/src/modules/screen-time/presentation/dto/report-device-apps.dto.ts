import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsDate,
  IsOptional,
  IsString,
  Length,
  Matches,
  MaxDate,
  MaxLength,
  ValidateNested,
} from 'class-validator';

import {
  ANDROID_PACKAGE_NAME_PATTERN,
  LAST_USED_AT_FUTURE_TOLERANCE_MS,
  MAX_APPS_PER_INVENTORY_REPORT,
  MAX_APP_NAME_LENGTH,
  MAX_CATEGORY_LENGTH,
  MAX_ICON_URL_LENGTH,
  MAX_PACKAGE_NAME_LENGTH,
} from '../../domain/app-catalog.types';

/**
 * ONE APP, AS A CHILD'S DEVICE REPORTS IT.
 *
 * Everything here is CHILD-SUPPLIED and therefore validated hard: this DTO is
 * the whole trust boundary for the only write a child can make to the
 * catalogue. There is deliberately no `deviceId`, no `childId` and no
 * `familyId` field — the server resolves all three from the token, and under
 * `main.ts`'s `forbidNonWhitelisted: true` a body that carries one is rejected
 * outright rather than silently stripped. Either way the value is never read.
 */
export class ReportedAppDto {
  /**
   * A REAL ANDROID PACKAGE SHAPE. An `AppBlockRule` will later point at this
   * string, so "any non-empty text" here would mean the block engine and the
   * catalogue disagree about what a package name is.
   */
  @IsString()
  @MaxLength(MAX_PACKAGE_NAME_LENGTH)
  @Matches(ANDROID_PACKAGE_NAME_PATTERN, {
    message: 'packageName must be a valid Android package name (e.g. com.example.app)',
  })
  packageName!: string;

  /** The label a parent reads in the picker. Capped so a hostile device
   * cannot store a paragraph per app, times five hundred apps. */
  @IsString()
  @Length(1, MAX_APP_NAME_LENGTH)
  appName!: string;

  /**
   * Free text ON PURPOSE, unlike `AppBlockRule.category`'s use: the device
   * reports whatever Play Store category it can read, and pinning that to a
   * server-side enum today would silently drop categories rather than record
   * them. Length-capped, which is the part that matters for a store.
   */
  @IsOptional()
  @IsString()
  @Length(1, MAX_CATEGORY_LENGTH)
  category?: string;

  /**
   * HTTPS ONLY, AND THAT IS THE WHOLE SCHEME POLICY.
   *
   * This string is rendered by the Parent App next to an app name. Accepting
   * arbitrary schemes would let a child's device put `javascript:`, `data:`
   * (an inline payload of its own choosing), `file:` or an Android
   * `content://` provider URI on a parent's screen. Plain `http:` is refused
   * too — a cleartext image in an app whose whole subject is a child's device
   * is a downgrade nobody needs to accept. One allowed scheme is a rule that
   * can be read off this line; a blocklist of bad ones never is.
   */
  @IsOptional()
  @IsString()
  @MaxLength(MAX_ICON_URL_LENGTH)
  @Matches(/^https:\/\/[^\s]+$/, { message: 'iconUrl must be an https:// URL' })
  iconUrl?: string;

  /**
   * NOT AUTHORITATIVE — a value read off a clock the child can change in
   * Settings, and the one field here that could reorder a parent's view.
   *
   * DECISION: REJECT beyond a five-minute skew window, then CLAMP what is
   * left. A timestamp days or years ahead is not a clock, it is a claim, and
   * it is refused with a 400 so the device learns rather than silently having
   * its report rewritten. Inside five minutes it IS ordinary phone drift, and
   * failing a whole three-hundred-app inventory over four seconds of skew
   * would be a worse bug than the one being prevented — so those are accepted
   * here and clamped to the server's `now` in `AppCatalogService`, which is
   * why no future timestamp is ever stored either way.
   */
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  @MaxDate(() => new Date(Date.now() + LAST_USED_AT_FUTURE_TOLERANCE_MS), {
    message: 'lastUsedAt must not be in the future',
  })
  lastUsedAt?: Date;
}

/** The body of `POST /self/apps`: one device's whole app inventory. */
export class ReportDeviceAppsDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_APPS_PER_INVENTORY_REPORT, {
    message: `apps must contain no more than ${MAX_APPS_PER_INVENTORY_REPORT} entries per report`,
  })
  @ValidateNested({ each: true })
  @Type(() => ReportedAppDto)
  apps!: ReportedAppDto[];
}
