import { ArrayMaxSize, IsBoolean, IsDateString, IsIn, IsInt, IsOptional, IsString, IsUUID, Length, Max, Min } from 'class-validator';

export class CreateLearningGoalDto {
  @IsString() @Length(1, 50) subject!: string;
  @IsString() @Length(1, 150) title!: string;
  @IsOptional() @IsDateString() targetDate?: string;
}

export class LogLearningSessionDto {
  @IsOptional() @IsUUID() goalId?: string;
  @IsString() @Length(1, 50) subject!: string;
  @IsInt() @Min(1) @Max(600) durationMinutes!: number;
  @IsOptional() @IsString() @Length(0, 500) progressNote?: string;
  @IsDateString() date!: string;
}

export class GenerateSmartTasksDto {
  @IsBoolean() lateSleepLastNight!: boolean;
  @IsBoolean() lowHydrationToday!: boolean;
  // Bounded — an unbounded array here was a real gap (found in this
  // session's own input-validation audit): a malicious client could
  // otherwise send an arbitrarily large array. A day realistically has
  // well under 20 distinct habits to miss.
  @IsString({ each: true })
  @Length(1, 100, { each: true })
  @ArrayMaxSize(20)
  missedHabitsYesterday!: string[];
  @IsBoolean() screenTimeOverLimit!: boolean;
}

export class DecideSmartTaskDto {
  @IsIn(['ACCEPTED', 'DISMISSED', 'COMPLETED'])
  status!: 'ACCEPTED' | 'DISMISSED' | 'COMPLETED';
}
