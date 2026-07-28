import { IsIn, IsOptional, IsString, Matches, MaxLength } from 'class-validator';

export class ConfirmPairingDto {
  @IsString()
  @Matches(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/, { message: 'Malformed pairing code.' })
  code!: string;

  @IsIn(['ANDROID', 'IOS'])
  platform!: 'ANDROID' | 'IOS';

  @IsOptional()
  @IsString()
  @MaxLength(100)
  deviceModel?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  osVersion?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  appVersion?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  pushToken?: string;
}
