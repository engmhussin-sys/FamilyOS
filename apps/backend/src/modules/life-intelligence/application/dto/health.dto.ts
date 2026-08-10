import { IsDateString, IsIn, IsInt, IsNumber, IsObject, IsOptional, IsString, Length, Max, Min } from 'class-validator';

export class LogNutritionDto {
  @IsDateString()
  date!: string;

  @IsString()
  @Length(1, 50)
  mealType!: string;

  @IsObject()
  items!: Record<string, unknown>;

  @IsOptional() @IsInt() @Min(0) @Max(20000) calories?: number;
  @IsOptional() @IsNumber() @Min(0) @Max(2000) proteinG?: number;
  @IsOptional() @IsNumber() @Min(0) @Max(10000) calciumMg?: number;
  @IsOptional() @IsNumber() @Min(0) @Max(200) ironMg?: number;
  @IsOptional() @IsNumber() @Min(0) @Max(2000) sugarG?: number;
}

export class LogHydrationDto {
  @IsInt()
  @Min(1)
  @Max(5000)
  amountMl!: number;
}

export class LogSleepDto {
  @IsDateString() date!: string;
  @IsDateString() sleepStart!: string;
  @IsDateString() sleepEnd!: string;
  @IsOptional() @IsInt() @Min(1) @Max(5) quality?: number;
}

export class LogActivityDto {
  @IsDateString() date!: string;
  @IsString() @Length(1, 50) activityType!: string;
  @IsInt() @Min(1) @Max(1440) durationMinutes!: number;
  @IsOptional() @IsIn(['SOLO', 'GROUP', 'TEAM']) socialContext?: 'SOLO' | 'GROUP' | 'TEAM';
}
