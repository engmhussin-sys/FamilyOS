import { IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';

export class RevokeDto {
  @IsUUID()
  deviceId!: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}
