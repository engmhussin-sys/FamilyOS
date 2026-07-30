import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

export class UpdateProfileDto {
  @IsOptional() @IsString() @MaxLength(200)
  fullName?: string;

  @IsOptional() @IsString() @MaxLength(30)
  phone?: string;

  @IsOptional() @IsIn(['en', 'ar'])
  locale?: string;

  @IsOptional() @IsString() @MaxLength(50)
  timezone?: string;
}
