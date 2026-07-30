import { IsBoolean, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

export class HeartbeatDto {
  @IsOptional() @IsInt() @Min(0) @Max(100)
  batteryPercent?: number;

  @IsOptional() @IsInt() @Min(0)
  availableStorageMb?: number;

  @IsOptional() @IsBoolean()
  isConnected?: boolean;

  @IsOptional() @IsString()
  appVersion?: string;

  @IsOptional() @IsBoolean()
  accessibilityServiceEnabled?: boolean;

  @IsOptional() @IsBoolean()
  enforcementActive?: boolean;
}
