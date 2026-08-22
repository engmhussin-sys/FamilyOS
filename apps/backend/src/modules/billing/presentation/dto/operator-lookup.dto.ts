import { IsEmail, MaxLength } from 'class-validator';

/**
 * The query shape for `GET /system/billing/grants`.
 *
 * A separate class rather than a bare `@Query('email')` string, so the global
 * strict `ValidationPipe` actually validates it: an unvalidated query parameter
 * reaches the service as whatever the caller sent, and this one is used to look
 * a household up.
 */
export class OperatorLookupDto {
  @IsEmail()
  @MaxLength(255)
  email!: string;
}
