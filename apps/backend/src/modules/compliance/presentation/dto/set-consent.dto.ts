import { IsBoolean, IsIn } from 'class-validator';
import { CONSENT_TYPES, type ConsentTypeValue } from '../../domain/compliance.types';

export class SetConsentDto {
  @IsIn(CONSENT_TYPES)
  consentType!: ConsentTypeValue;

  @IsBoolean()
  granted!: boolean;
}
