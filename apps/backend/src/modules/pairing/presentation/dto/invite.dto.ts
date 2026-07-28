import { IsUUID } from 'class-validator';

export class InviteDto {
  @IsUUID()
  childId!: string;
}
