import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

export class RegisterDeviceDto {
  @IsString()
  publicKey!: string;

  @IsIn(['ANDROID', 'IOS'])
  platform!: 'ANDROID' | 'IOS';

  @IsOptional() @IsString() @MaxLength(100)
  deviceModel?: string;

  @IsOptional() @IsString() @MaxLength(50)
  osVersion?: string;

  @IsOptional() @IsString() @MaxLength(50)
  appVersion?: string;

  @IsOptional() @IsString() @MaxLength(20)
  pairingProtocolVersion?: string;
}
