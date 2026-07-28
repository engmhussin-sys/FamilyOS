import { IsDateString, IsOptional, IsString, IsUrl, Length } from 'class-validator';

export class CreateChildDto {
  @IsString()
  @Length(1, 100)
  firstName!: string;

  @IsOptional()
  @IsString()
  @Length(1, 100)
  lastName?: string;

  /** ISO date string, e.g. "2015-06-01". Age-appropriate AI behavior and
   * COPPA/GDPR age-of-consent logic (future modules) derive from this. */
  @IsDateString()
  dateOfBirth!: string;

  @IsOptional()
  @IsString()
  @Length(1, 50)
  gender?: string;

  @IsOptional()
  @IsUrl()
  avatarUrl?: string;
}
