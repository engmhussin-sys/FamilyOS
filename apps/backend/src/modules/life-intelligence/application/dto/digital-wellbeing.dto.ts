import { ArrayMaxSize, IsArray, IsIn, IsInt, IsISO8601, IsObject, IsOptional, IsString, Length, Max, Min, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

const APP_CATEGORIES = ['EDUCATION', 'COMMUNICATION', 'SOCIAL', 'GAMING', 'VIDEO', 'ENTERTAINMENT', 'PRODUCTIVITY', 'BROWSER', 'UTILITIES', 'OTHER'] as const;

class AppUsageEntryDto {
  @IsString() @Length(1, 200) packageName!: string;
  @IsInt() @Min(0) @Max(1440) minutes!: number;

  @IsOptional() @IsIn(APP_CATEGORIES) category?: typeof APP_CATEGORIES[number];
}

/** Structurally privacy-safe by construction: every field here is a
 * number or a package name — there is no field capable of carrying
 * message content, notification text, keystrokes, or raw location. */
export class RecordDailyUsageSummaryDto {
  @IsISO8601({ strict: true }) usageDate!: string;
  @IsInt() @Min(0) @Max(1440) totalScreenMinutes!: number;

  @IsArray()
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => AppUsageEntryDto)
  appBreakdown!: AppUsageEntryDto[];

  @IsInt() @Min(0) @Max(2000) pickupCount!: number;
  @IsInt() @Min(0) @Max(1440) nightUsageMinutes!: number;
  @IsInt() @Min(0) @Max(500) blockedAttemptCount!: number;

  // Sprint 14 — all optional: an older app build that never sends
  // these must not fail validation for the fields it DOES have.
  @IsOptional() @IsInt() @Min(0) @Max(500) sessionCount?: number;
  @IsOptional() @IsInt() @Min(0) @Max(1440) averageSessionMinutes?: number;
  @IsOptional() @IsInt() @Min(0) @Max(1440) longestSessionMinutes?: number;
}

export class RecordCriticalEventDto {
  @IsIn(['PROTECTION_BYPASS_ATTEMPT', 'ACCESSIBILITY_DISABLED', 'SCREEN_TIME_EXCEEDED', 'POLICY_VIOLATION', 'CHILD_REQUEST'])
  eventType!: 'PROTECTION_BYPASS_ATTEMPT' | 'ACCESSIBILITY_DISABLED' | 'SCREEN_TIME_EXCEEDED' | 'POLICY_VIOLATION' | 'CHILD_REQUEST';

  @IsString() @Length(1, 150) title!: string;
  @IsString() @Length(1, 500) body!: string;

  @IsOptional() @IsObject() metadata?: Record<string, unknown>;
}
