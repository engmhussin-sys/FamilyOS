import { IsIn, IsString, IsUUID, Length } from 'class-validator';

/**
 * `userId`, not `familyId`. CI RULE 3 fails the build for a request DTO
 * carrying a `familyId`, and it is right to: the household is derived from the
 * user server-side, so no caller can name a tenant.
 */
export class AccountActionDto {
  @IsUUID()
  userId!: string;

  /**
   * `SUSPENDED` suspends. `ACTIVE` means RESTORE WHAT SUSPENSION REPLACED, and
   * that distinction is load-bearing: a newly registered user is
   * `PENDING_VERIFICATION`, so a literal "set to ACTIVE" would mark an
   * unverified email as verified with a support click. The service reads the
   * prior status from the audit row suspension wrote, and refuses when there is
   * none rather than guessing.
   *
   * `DELETED` is absent because it is terminal and belongs to the
   * account-deletion module's retention rules.
   */
  @IsIn(['ACTIVE', 'SUSPENDED'])
  status!: 'ACTIVE' | 'SUSPENDED';

  /** Required: the audit row is the point of doing this here rather than in SQL. */
  @IsString()
  @Length(3, 200)
  reason!: string;
}
