import { IsUUID } from 'class-validator';

export class InitiatePairingDto {
  @IsUUID()
  childId!: string;
}
