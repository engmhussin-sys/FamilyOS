import { IsUUID } from 'class-validator';

export class TransferOwnershipDto {
  /**
   * The member who becomes the new OWNER. A user ID, not a family ID: the
   * family is never named by the client (CONTEXT §3 principle 3) — it is
   * always the caller's own, derived from the verified token.
   */
  @IsUUID()
  toUserId!: string;
}
