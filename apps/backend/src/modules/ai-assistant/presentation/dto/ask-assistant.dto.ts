import { IsString, IsUUID, Length } from 'class-validator';

export class AskAssistantDto {
  @IsUUID()
  childId!: string;

  @IsString()
  @Length(3, 2000)
  question!: string;
}
