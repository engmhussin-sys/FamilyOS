import { IsIn, IsString, MaxLength } from 'class-validator';

export class RegisterParentDevicePushTokenDto {
  @IsIn(['ANDROID', 'IOS'])
  platform!: 'ANDROID' | 'IOS';

  @IsString()
  @MaxLength(500)
  pushToken!: string;
}
