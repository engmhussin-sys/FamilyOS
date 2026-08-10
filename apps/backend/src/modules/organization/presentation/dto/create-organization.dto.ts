import { IsIn, IsOptional, IsString, IsUUID, Length } from 'class-validator';

export class CreateOrganizationDto {
  @IsIn(['FAMILY', 'SCHOOL', 'COMPANY', 'BANK'])
  type!: 'FAMILY' | 'SCHOOL' | 'COMPANY' | 'BANK';

  @IsString()
  @Length(1, 200)
  name!: string;

  @IsOptional()
  @IsUUID()
  parentOrganizationId?: string;
}
