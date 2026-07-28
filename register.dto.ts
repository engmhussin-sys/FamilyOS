import { IsEmail, IsOptional, IsString, Length, Matches, MaxLength } from 'class-validator';

export class RegisterDto {
  @IsEmail()
  @MaxLength(255)
  email!: string;

  /**
   * Minimum 10 chars, at least one letter and one number. This is a
   * baseline — the frontend should additionally surface a strength meter,
   * but the backend is the source of truth and must never trust the
   * client to have enforced this.
   */
  @IsString()
  @Length(10, 128)
  @Matches(/(?=.*[A-Za-z])(?=.*\d)/, {
    message: 'Password must contain at least one letter and one number.',
  })
  password!: string;

  @IsString()
  @Length(2, 100)
  fullName!: string;

  @IsOptional()
  @IsString()
  @Length(2, 100)
  familyName?: string;

  @IsOptional()
  @IsString()
  timezone?: string;

  @IsOptional()
  @IsString()
  locale?: string;
}
