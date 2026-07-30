import { IsIn } from 'class-validator';

export class SubscribeDto {
  @IsIn(['FREE', 'PREMIUM', 'FAMILY', 'ENTERPRISE'])
  planTier!: 'FREE' | 'PREMIUM' | 'FAMILY' | 'ENTERPRISE';

  @IsIn(['STRIPE', 'PAYMOB', 'FAWRY', 'MANUAL', 'APPLE_IAP', 'GOOGLE_PLAY'])
  provider!: 'STRIPE' | 'PAYMOB' | 'FAWRY' | 'MANUAL' | 'APPLE_IAP' | 'GOOGLE_PLAY';
}
