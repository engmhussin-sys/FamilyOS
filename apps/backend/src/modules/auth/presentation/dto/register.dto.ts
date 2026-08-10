import { Equals, IsEmail, IsOptional, IsString, Length, Matches, MaxLength } from 'class-validator';

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

  /** CLOSES A REAL GAP (proactive business/code audit): zero Terms of
   * Service acceptance requirement existed anywhere in registration.
   * @Equals(true) — not @IsBoolean() — deliberately: registration
   * must genuinely fail if this isn't explicitly true, not merely
   * present as any boolean value (a client sending `false` should be
   * rejected exactly like a client sending nothing at all). */
  @Equals(true, { message: 'You must accept the Terms of Service to create an account.' })
  acceptedTerms!: boolean;
}
