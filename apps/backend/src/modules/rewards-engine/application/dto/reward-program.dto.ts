import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
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
 *
 * B5 (PA-B-017) — `quizCorrect` and `quizTotal` USED TO BE HERE, and their
 * removal is the fix. They were `@IsInt() @Min(0)` and `@IsInt() @Min(1)`,
 * they came from the child's own device, and `VERIFICATION_MATRIX.QUIZ`
 * carried `canAutoApprove: true` — so a well-formed `{"quizCorrect": 10,
 * "quizTotal": 10}` was an auto-approved 100%. They are DELETED rather than
 * ignored, on purpose: `main.ts` runs `forbidNonWhitelisted: true`, so a
 * client still sending them now gets a 400 naming the offending property
 * instead of quietly falling back to the old behaviour. `quizAnswers` replaces
 * them, and the score is produced by `QuizService.grade` from the server's own
 * answer key.
 */
export class SubmitAchievementDto {
  @IsOptional()
  @IsBoolean()
  selfConfirmed?: boolean;

  /**
   * B5 — ONE CHOSEN INDEX PER SERVED QUESTION, positionally aligned with what
   * `GET /self/achievements/:id/quiz` returned. This is an ANSWER SHEET, and
   * the difference from what it replaces is the whole finding: a wrong answer
   * sheet scores badly, whereas a wrong score scored whatever it liked.
   *
   * `Max(5)` bounds a choice index to the schema's own
   * `jsonb_array_length(choices) BETWEEN 2 AND 6` CHECK; `ArrayMaxSize` bounds
   * the sheet to more than any served set can be, so a padded array is
   * rejected at the edge rather than truncated in the grader.
   */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsInt({ each: true })
  @Min(0, { each: true })
  @Max(5, { each: true })
  quizAnswers?: number[];

  /**
   * B5 (PA-B-017, the `CODE_CHALLENGE` half). These stay, and what changed is
   * what they are ALLOWED TO DO. There is no code sandbox in this backend and
   * building one was not in scope, so the server cannot produce these numbers
   * itself — which means they are a CLAIM, and a claim may no longer
   * auto-approve. `VERIFICATION_MATRIX.CODE_CHALLENGE.canAutoApprove` is now
   * `false`, so these become evidence a parent reads, exactly like
   * `submissionRef`, instead of an input to a grant.
   */
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

/**
 * B5 (PA-B-017) — the parent's question-authoring form.
 *
 * `correctChoiceIndex` is ACCEPTED here and returned by nothing: the read
 * routes `select` four columns and the key is not one of them. The
 * cross-field rule (the index must fall inside `choices`) is checked in the
 * controller against the actual array length rather than by a decorator,
 * because class-validator cannot express "less than the length of a sibling
 * field" — and the database enforces the same rule again in
 * `quiz_questions_choices_chk`, so a future admin path that bypasses this DTO
 * still cannot write an unanswerable question.
 */
export class CreateQuizQuestionDto {
  @IsIn([...PROGRAM_CATEGORIES])
  category!: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  subject?: string;

  @IsOptional()
  @IsIn([...PROGRAM_DIFFICULTIES])
  difficulty?: string;

  @IsOptional()
  @IsInt()
  @Min(3)
  @Max(18)
  minAge?: number;

  @IsOptional()
  @IsInt()
  @Min(3)
  @Max(18)
  maxAge?: number;

  @IsString()
  @MaxLength(500)
  promptAr!: string;

  /** 2..6 — the same bounds as the `quiz_questions_choices_chk` CHECK. */
  @IsArray()
  @ArrayMinSize(2)
  @ArrayMaxSize(6)
  @IsString({ each: true })
  @MaxLength(200, { each: true })
  choices!: string[];

  @IsInt()
  @Min(0)
  @Max(5)
  correctChoiceIndex!: number;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  explanationAr?: string;
}
