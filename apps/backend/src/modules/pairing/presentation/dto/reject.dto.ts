import { IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';

export class RejectDto {
  @IsUUID()
  deviceId!: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}
