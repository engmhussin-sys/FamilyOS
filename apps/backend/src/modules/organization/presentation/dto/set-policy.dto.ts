import { IsDefined, IsString, Length } from 'class-validator';

export class SetPolicyDto {
  @IsString()
  @Length(1, 100)
  key!: string;

  /** Deliberately not type-narrowed further — per PolicyEngine's own
   * Sprint 9 docstring, the real key vocabulary and value shapes
   * (school default screen-time policy, bank compliance policy) are
   * product decisions for whoever builds each organization type's
   * actual features, not guessed at in this generic engine. */
  @IsDefined()
  value!: unknown;
}
