import { IsBoolean, IsDefined, IsIn, IsOptional, IsString, Length } from 'class-validator';

export class CreateCampaignDto {
  @IsString()
  @Length(3, 50)
  code!: string;

  @IsIn(['REFERRAL', 'COUPON', 'TRIAL_EXTENSION', 'DISCOUNT', 'QR_CODE'])
  type!: 'REFERRAL' | 'COUPON' | 'TRIAL_EXTENSION' | 'DISCOUNT' | 'QR_CODE';

  @IsDefined()
  config!: Record<string, unknown>;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
