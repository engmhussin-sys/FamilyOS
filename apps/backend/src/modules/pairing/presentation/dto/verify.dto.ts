import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';

/** Decision-055's Pairing Capability Snapshot — permanent, minimal,
 * distinct from the future Full Capability Engine. See
 * pairing-backend-domain-architecture.md §2/§3's explicit two-tier note. */
class PairingCapabilitySnapshotDto {
  @IsString()
  manufacturer!: string;

  @IsString()
  model!: string;

  @IsInt()
  sdkInt!: number;

  @IsString()
  agentVersion!: string;
}

/** Mirrors risk.types.ts's IRiskSignalInput exactly — self-reported by
 * the device today (Sprint 3 scope). NOT independently verified
 * server-side yet; flagged explicitly in the controller/service docs,
 * not silently assumed trustworthy. */
class RiskSignalsDto {
  @IsBoolean() isEmulator!: boolean;
  @IsBoolean() isRooted!: boolean;
  @IsBoolean() hasTamperIndicators!: boolean;
  @IsBoolean() isUnsupportedDevice!: boolean;
  @IsBoolean() missingAttestation!: boolean;
  @IsBoolean() mockLocationEnabled!: boolean;
  @IsBoolean() developerModeEnabled!: boolean;
  @IsBoolean() usbDebuggingEnabled!: boolean;
  @IsBoolean() isOldAndroidVersion!: boolean;
}

export class VerifyDto {
  @IsOptional()
  @IsString()
  attestationChain?: string;

  @ValidateNested()
  @Type(() => PairingCapabilitySnapshotDto)
  pairingCapabilitySnapshot!: PairingCapabilitySnapshotDto;

  @ValidateNested()
  @Type(() => RiskSignalsDto)
  riskSignals!: RiskSignalsDto;
}
