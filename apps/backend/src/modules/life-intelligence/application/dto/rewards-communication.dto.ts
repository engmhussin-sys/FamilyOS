import { IsIn, IsObject, IsString, IsUUID, Length } from 'class-validator';

export class RequestRedemptionDto {
  @IsUUID()
  catalogItemId!: string;
}

export class TriggerRewardEventDto {
  // Bounded to the real, small set of engine names this platform has
  // — an open @IsString() here was a real gap (this session's own
  // audit): a client could send an arbitrary string that never
  // matches any real RewardRule.triggerEngine, silently wasting a
  // request, or an unbounded-length string as a minor DoS vector.
  @IsIn(['habit-builder', 'health', 'faith', 'learning-education', 'smart-tasks'])
  engine!: string;

  @IsString() @Length(1, 100) type!: string;
  @IsObject() payload!: Record<string, unknown>;
}

export class SendParentMessageDto {
  @IsString() @Length(1, 50) category!: string;
  @IsString() @Length(1, 100) title!: string;
  @IsString() @Length(1, 2000) body!: string;
}

export class DraftAiMessageDto {
  @IsString() @Length(1, 50) category!: string;
  @IsString() @Length(1, 100) title!: string;
  @IsString() @Length(1, 2000) body!: string;
}
