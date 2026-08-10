import { IsIn, IsInt, IsObject, IsOptional, IsString, Length, Max, Min } from 'class-validator';

export class CreateAppBlockRuleDto {
  @IsOptional()
  @IsString()
  @Length(1, 200)
  packageName?: string;

  @IsOptional()
  @IsString()
  @Length(1, 50)
  category?: string;

  @IsIn(['BLOCK', 'ALLOW', 'TIME_LIMIT'])
  ruleType!: 'BLOCK' | 'ALLOW' | 'TIME_LIMIT';

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1440)
  limitMinutes?: number;

  @IsOptional()
  @IsObject()
  schedule?: Record<string, unknown>;
}
