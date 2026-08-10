import { IsString, Length } from 'class-validator';

export class RedeemCampaignDto {
  @IsString()
  @Length(3, 50)
  code!: string;
}
