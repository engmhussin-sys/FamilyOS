import { IsIn } from 'class-validator';

export class SubscribeDto {
  @IsIn(['FREE', 'PREMIUM', 'FAMILY', 'ENTERPRISE'])
  planTier!: 'FREE' | 'PREMIUM' | 'FAMILY' | 'ENTERPRISE';

  @IsIn(['STRIPE', 'PAYMOB', 'FAWRY', 'MANUAL'])
  provider!: 'STRIPE' | 'PAYMOB' | 'FAWRY' | 'MANUAL';
}
