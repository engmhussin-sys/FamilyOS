import { IsString, Matches } from 'class-validator';

export class AcceptDto {
  @IsString()
  @Matches(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/, { message: 'Malformed pairing code.' })
  code!: string;
}
