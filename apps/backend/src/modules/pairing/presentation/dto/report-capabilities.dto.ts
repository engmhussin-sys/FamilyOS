import { IsBoolean, IsInt, IsString } from 'class-validator';

export class ReportCapabilitiesDto {
  @IsString() manufacturer!: string;
  @IsString() model!: string;
  @IsInt() sdkInt!: number;
  @IsBoolean() usageAccessGranted!: boolean;
  @IsBoolean() accessibilityEnabled!: boolean;
  @IsBoolean() overlayGranted!: boolean;
  @IsBoolean() batteryOptimizationExempted!: boolean;
  @IsBoolean() notificationsGranted!: boolean;
  @IsString() profileHash!: string;
}
