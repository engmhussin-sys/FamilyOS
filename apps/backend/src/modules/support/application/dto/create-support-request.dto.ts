import { IsEmail, IsString, Length } from 'class-validator';

/** Deliberately allows submission WITHOUT being logged in — real support
 * scenarios include "I can't log in at all" and "I have a question before
 * creating an account."
 *
 * F2 (CONTEXT §3.3): `familyId` and `userId` USED to be optional fields here,
 * client-supplied. They are gone. A spoofed `familyId` was enough to claim
 * another family's `priority_support` entitlement, and — more fundamentally —
 * the tenant is never something a request body gets to assert. When a caller
 * does have a session, OptionalJwtAuthGuard puts the VERIFIED identity on the
 * request and the controller passes that instead. */
export class CreateSupportRequestDto {
  @IsEmail()
  email!: string;

  @IsString()
  @Length(1, 200)
  subject!: string;

  @IsString()
  @Length(1, 5000)
  message!: string;
}
