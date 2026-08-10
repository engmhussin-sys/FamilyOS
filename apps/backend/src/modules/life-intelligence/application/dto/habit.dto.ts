import { IsBoolean, IsDateString, IsOptional, IsString, Length } from 'class-validator';

export class CreateHabitDto {
  @IsString()
  @Length(1, 100)
  title!: string;

  @IsString()
  @Length(1, 50)
  category!: string;

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
