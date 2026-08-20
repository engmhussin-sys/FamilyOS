import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Length,
  Max,
  Min,
} from 'class-validator';

import {
  MIN_VERIFIED_BY_VALUES,
  RULE_AMOUNT_MAX,
  RULE_AMOUNT_MIN,
  RULE_ENGINES,
  RULE_EVENT_TYPES,
  RULE_MAX_PER_DAY_MAX,
  RULE_MAX_PER_WEEK_MAX,
} from '../../../../shared/rewards/reward-rule-catalogue';

/**
 * B4 (PA-B-015) — the DTO that gives `RewardRule` a creation path.
 *
 * EVERY BOUNDED FIELD IS BOUNDED BY THE SHARED CATALOGUE, NOT BY A LITERAL
 * LIST. `@IsIn([...RULE_EVENT_TYPES])` reads the same constant the platform
 * seed and the engine read, so a list that grows in one place cannot fail to
 * grow here. The one existing precedent in this module —
 * `TriggerRewardEventDto`'s `@IsIn(['habit-builder', ...])` — hardcoded its
 * engine list and has already drifted (it names `learning-education`, an engine
 * no producer emits). That is the failure mode this avoids.
 *
 * `category` is deliberately NOT `@IsIn(...)`. It is validated against the
 * `reward_program_categories` TABLE at service level, because the whole reason
 * that table exists is that a nineteenth category must be an INSERT and not a
 * code change. A closed enum here would have undone migration 0006's own
 * design decision (schema.prisma:2270) and broken the client's "Custom
 * parent-defined" requirement outright.
 */
export class CreateRewardRuleDto {
  @IsIn([...RULE_ENGINES])
  triggerEngine!: string;

  /**
   * MANDATORY, and that is the point (PA-B-013). A rule with no event type
   * matches every trigger its engine fires — including the legacy KEYLESS ones
   * — and pays twice for one completion. There is no way to create a wildcard
   * rule through this API; wildcards survive only as pre-B4 rows and F4
   * companion rows.
   */
  @IsIn([...RULE_EVENT_TYPES])
  eventType!: string;

  /** Subset-matched against the trigger payload. `{}` matches every event of
   * this type — a legitimate and common choice ("pay for any habit"). */
  @IsOptional()
  @IsObject()
  triggerCondition?: Record<string, unknown>;

  /** BADGE is deliberately absent: a badge rule points at a
   * `BadgeDefinition.key`, and there is no parent-facing badge authoring path
   * to make that key mean anything yet. Offering it would let a parent create
   * a rule that silently never pays. */
  @IsIn(['XP', 'COINS'])
  rewardType!: string;

  @Type(() => Number)
  @IsInt()
  @Min(RULE_AMOUNT_MIN)
  @Max(RULE_AMOUNT_MAX)
  amount!: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(RULE_MAX_PER_DAY_MAX)
  maxPerDay?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(RULE_MAX_PER_WEEK_MAX)
  maxPerWeek?: number;

  /** The verification floor. `PARENT` turns this rule into "pay only after I
   * approved it" without any per-domain code. */
  @IsOptional()
  @IsIn([...MIN_VERIFIED_BY_VALUES])
  minVerifiedBy?: string;

  /** Validated against the `reward_program_categories` table, not an enum. */
  @IsOptional()
  @IsString()
  @Length(1, 40)
  category?: string;

  @IsOptional()
  @IsString()
  @Length(1, 120)
  labelAr?: string;
}

/** Everything a parent may change after creation. `triggerEngine`, `eventType`
 * and `triggerCondition` are NOT here: changing them turns the rule into a
 * different rule while keeping the id that every past ledger row's `source`
 * points at, which would rewrite history. Create a new rule instead. */
export class UpdateRewardRuleDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(RULE_AMOUNT_MIN)
  @Max(RULE_AMOUNT_MAX)
  amount?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(RULE_MAX_PER_DAY_MAX)
  maxPerDay?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(RULE_MAX_PER_WEEK_MAX)
  maxPerWeek?: number;

  @IsOptional()
  @IsIn([...MIN_VERIFIED_BY_VALUES])
  minVerifiedBy?: string;

  @IsOptional()
  @IsString()
  @Length(1, 40)
  category?: string;

  @IsOptional()
  @IsString()
  @Length(1, 120)
  labelAr?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
