import { IsDateString, IsIn, IsObject, IsOptional, IsString, Length } from 'class-validator';

const FAITH_PRACTICE_TYPES = ['QURAN_MEMORIZATION', 'QURAN_REVIEW', 'AZKAR', 'SALAH', 'ISLAMIC_VALUE', 'OCCASION'] as const;

export class CreateFaithPracticeDto {
  @IsIn(FAITH_PRACTICE_TYPES)
  type!: (typeof FAITH_PRACTICE_TYPES)[number];

  @IsString()
  @Length(1, 100)
  title!: string;

  @IsOptional()
  @IsObject()
  config?: Record<string, unknown>;
}

export class LogFaithPracticeDto {
  @IsOptional()
  @IsDateString()
  date?: string;

  @IsOptional()
  @IsObject()
  progress?: Record<string, unknown>;
}
