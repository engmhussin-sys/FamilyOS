import { IsOptional, IsString, MaxLength } from 'class-validator';

import { IsIanaTimeZone } from '../../../../common/time/is-iana-timezone.validator';

export class UpdateSettingsDto {
  @IsOptional() @IsString() @MaxLength(200)
  name?: string;

  /**
   * B2 (PA-B-001). THE FAMILY'S CALENDAR — now a real constraint rather than
   * `@IsString() @MaxLength(50)`.
   *
   * Until B2 this column was an orphan: writable here, echoed back by
   * `GET /settings`, and read by NO calculation anywhere in the backend. It is
   * now the input to every business date the system computes, so an
   * unvalidated value would move a whole family's day boundary silently.
   */
  @IsOptional() @IsIanaTimeZone()
  timezone?: string;
}
