import { IsEmail, IsOptional, IsString, IsUUID, Length } from 'class-validator';

/** Deliberately allows submission WITHOUT being logged in — real
 * support scenarios include "I can't log in at all" and "I have a
 * question before creating an account." `familyId`/`userId` are
 * optional client-supplied context (the Parent App fills them in
 * when a session exists), never trusted alone for authorization —
 * this endpoint creates a record, it doesn't grant any access. */
export class CreateSupportRequestDto {
  @IsEmail()
  email!: string;

  @IsString()
  @Length(1, 200)
  subject!: string;

  @IsString()
  @Length(1, 5000)
  message!: string;

  @IsOptional()
  @IsUUID()
  familyId?: string;

  @IsOptional()
  @IsUUID()
  userId?: string;
}
