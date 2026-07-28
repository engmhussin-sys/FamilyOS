import { IsBoolean, IsOptional, IsUUID } from 'class-validator';

export class ActivateDto {
  @IsUUID()
  deviceId!: string;

  @IsOptional()
  @IsBoolean()
  overrideRiskWarning?: boolean;
}
