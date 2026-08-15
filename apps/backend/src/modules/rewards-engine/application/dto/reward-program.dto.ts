import {
  IsBoolean,
  IsIn,
  IsInt,
  IsISO8601,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

import {
  PROGRAM_ACTIVITIES,
  PROGRAM_CATEGORIES,
  PROGRAM_DIFFICULTIES,
  PROGRAM_FREQUENCIES,
  PROGRAM_STATUSES,
} from '../../../../shared/rewards/program-taxonomy';
import { VERIFICATION_METHODS } from '../../../../shared/rewards/verification';

/**
 * The parent's create form, field for field: Category -> Activity -> Target ->
 * Duration -> Reward -> Rules.
 *
 * WHAT THIS LAYER DOES AND DOES NOT DO. `class-validator` here checks SHAPE and
 * MEMBERSHIP only. The two decisions that need domain knowledge —
 * "is this activity legal for this category?" and "is ayah 300 inside
 * Al-Mulk?" — are made by `validateTargetSpec` inside the service, against the
 * real surah table. Putting them in a decorator would have meant a second copy
 * of the Quran in the presentation layer.
 */
export class CreateRewardProgramDto {
  /** NULL/absent = every child in the family. */
  @IsOptional()
  @IsUUID()
  childId?: string;

  @IsIn([...PROGRAM_CATEGORIES])
  category!: string;

  @IsIn([...PROGRAM_ACTIVITIES])
  activity!: string;

  @IsObject()
  targetSpec!: Record<string, unknown>;

  @IsInt()
  @Min(1)
  @Max(480)
  durationMinutes!: number;

  @IsIn([...VERIFICATION_METHODS])
  verificationLevel!: string;

  @IsOptional()
  @IsObject()
  verificationConfig?: Record<string, unknown>;

  @IsObject()
  rewardSpec!: Record<string, unknown>;

  @IsOptional()
  @IsIn([...PROGRAM_FREQUENCIES])
  frequency?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(20)
  maxPerDay?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(140)
  maxPerWeek?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(18)
  minAge?: number;

  @IsOptional()
  @IsIn([...PROGRAM_DIFFICULTIES])
  difficulty?: string;

  @IsOptional()
  @IsBoolean()
  requiresParentApproval?: boolean;

  @IsOptional()
  @IsISO8601()
  expiresAt?: string;

  /** 10000 = 1.00x. The CEILING this program allows, not the applied value. */
  @IsOptional()
  @IsInt()
  @Min(10000)
  @Max(30000)
  streakMultiplierBps?: number;
}

export class UpdateRewardProgramDto {
  @IsOptional()
  @IsIn([...PROGRAM_STATUSES])
  status?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(20)
  maxPerDay?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(140)
  maxPerWeek?: number;

  @IsOptional()
  @IsBoolean()
  requiresParentApproval?: boolean;

  @IsOptional()
  @IsISO8601()
  expiresAt?: string;

  @IsOptional()
  @IsIn([...PROGRAM_DIFFICULTIES])
  difficulty?: string;
}

/** Child: "I am starting this program now." Creates an AchievementRequest —
 * never a grant. */
export class StartAchievementDto {
  @IsUUID()
  programId!: string;
}

/**
 * Child: "here is my evidence." Every field is EVIDENCE, not a decision, and
 * none of them is `result`. There is deliberately no way for a child to state
 * an outcome.
 */
export class SubmitAchievementDto {
  @IsOptional()
  @IsBoolean()
  selfConfirmed?: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  quizCorrect?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  quizTotal?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  testsPassed?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  testsTotal?: number;

  /** Opaque pointer to an upload. No media is processed in this sprint. */
  @IsOptional()
  @IsString()
  @MaxLength(512)
  submissionRef?: string;

  /**
   * Device-reported foreground minutes. It is EVIDENCE and it is bounded by the
   * server's own wall clock before it counts — see
   * `verification-strategies.ts#checkDuration`.
   */
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1440)
  foregroundMinutes?: number;

  @IsOptional()
  @IsString()
  @MaxLength(280)
  note?: string;
}

/** Parent decision on an escalated achievement. */
export class DecideAchievementDto {
  @IsOptional()
  @IsString()
  @MaxLength(280)
  note?: string;
}

export class TransitionFulfilmentDto {
  @IsIn(['APPROVED', 'FULFILLED', 'DECLINED'])
  to!: string;

  @IsOptional()
  @IsString()
  @MaxLength(280)
  note?: string;
}

/** AI ADVISORY ONLY — the parent explicitly accepts a suggestion, and only then
 * is anything created. There is no endpoint by which the AI creates a program. */
export class AcceptSuggestionDto {
  @IsString()
  @MaxLength(64)
  suggestionId!: string;

  @IsUUID()
  childId!: string;
}
