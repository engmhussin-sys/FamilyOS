import { Transform } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

import { AccountsConsoleService } from '../../application/accounts-console.service';

/**
 * Query shape for `GET /system/accounts`. Every field is optional and every
 * field is bounded — an operator console is still a public HTTP surface behind
 * a key, and "the key holder would never send limit=1000000" is not a control.
 */
export class AccountsQueryDto {
  @IsOptional()
  @Transform(({ value }) => (value === undefined || value === '' ? undefined : Number(value)))
  @IsInt()
  @Min(1)
  @Max(AccountsConsoleService.MAX_LIMIT)
  limit?: number;

  /** Opaque; produced by this endpoint's own `nextCursor`. */
  @IsOptional()
  @IsString()
  @MaxLength(120)
  cursor?: string;

  /** Matches the household name or the owner's email, case-insensitively. */
  @IsOptional()
  @IsString()
  @MaxLength(120)
  search?: string;
}
