import {
  IsBoolean,
  IsInt,
  IsObject,
  IsOptional,
  Matches,
  Max,
  Min,
} from 'class-validator';

const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/; // "HH:mm", 24h

export class SetScreenTimePolicyDto {
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1440)
  dailyLimitMinutes?: number;

  @IsOptional()
  @Matches(TIME_PATTERN, { message: 'bedtimeStart must be in HH:mm 24h format.' })
  bedtimeStart?: string;

  @IsOptional()
  @Matches(TIME_PATTERN, { message: 'bedtimeEnd must be in HH:mm 24h format.' })
  bedtimeEnd?: string;

  @IsOptional()
  @IsObject()
  weekdaySchedule?: Record<string, unknown>;

  @IsOptional()
  @IsBoolean()
  focusModeEnabled?: boolean;
}
