import { IsArray, IsBoolean, IsDateString, IsIn, IsInt, IsOptional, IsString, Length, Matches, Max, Min } from 'class-validator';

const RECURRENCE_VALUES = ['DAILY', 'WEEKLY', 'SPECIFIC_DAYS'] as const;
const PRIORITY_VALUES = ['LOW', 'NORMAL', 'HIGH'] as const;
// "HH:MM" 24h, matching HabitEngineService.isPastScheduledEnd's own
// parsing expectation exactly.
const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

export class CreateHabitDto {
  @IsString()
  @Length(1, 100)
  title!: string;

  @IsString()
  @Length(1, 50)
  category!: string;

  // Sprint 16.1 Phase 1 — CLOSES A REAL GAP: these fields existed on
  // the Service/Repository/Schema since Sprint 16 but had no DTO
  // path to actually reach them from a real API request. All
  // optional — an existing client sending only title/category/
  // isShared continues to work identically.
  @IsOptional()
  @IsString()
  @Length(1, 500)
  description?: string;

  @IsOptional()
  @Matches(TIME_PATTERN, { message: 'scheduledStartTime must be "HH:MM" 24-hour format' })
  scheduledStartTime?: string;

  @IsOptional()
  @Matches(TIME_PATTERN, { message: 'scheduledEndTime must be "HH:MM" 24-hour format' })
  scheduledEndTime?: string;

  @IsOptional()
  @IsIn(RECURRENCE_VALUES)
  recurrence?: typeof RECURRENCE_VALUES[number];

  /** 0-6 (Sunday-Saturday) — only meaningful when recurrence is
   * SPECIFIC_DAYS; harmlessly ignored otherwise rather than
   * rejected, matching this codebase's own "additive fields degrade
   * gracefully" discipline. */
  @IsOptional()
  @IsArray()
  @IsInt({ each: true })
  @Min(0, { each: true })
  @Max(6, { each: true })
  recurrenceDaysOfWeek?: number[];

  @IsOptional()
  @IsIn(PRIORITY_VALUES)
  priority?: typeof PRIORITY_VALUES[number];

  @IsOptional()
  @IsBoolean()
  isShared?: boolean;
}

export class CompleteHabitDto {
  /** ISO date string (YYYY-MM-DD) the completion applies to — not
   * necessarily "today," since a parent may log a missed day's
   * completion after the fact. Defaults to today server-side if omitted. */
  @IsOptional()
  @IsDateString()
  date?: string;
}
