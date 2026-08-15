/* eslint-disable @typescript-eslint/no-explicit-any */
import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';

import { CurrentUser } from '../../../../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../../../auth/presentation/guards/jwt-auth.guard';
import type { IJwtPayload } from '../../../auth/domain/auth.types';
import {
  CATEGORY_ACTIVITIES,
  PROGRAM_ACTIVITY_LABEL_AR,
  PROGRAM_CATEGORIES,
  PROGRAM_CATEGORY_LABEL_AR,
  type ProgramCategory,
} from '../../../../shared/rewards/program-taxonomy';
import { QURAN_SURAHS } from '../../../../shared/rewards/quran';
import { VERIFICATION_MATRIX, VERIFICATION_METHODS } from '../../../../shared/rewards/verification';
import { PROGRAM_REWARD_TYPES } from '../../../../shared/rewards/reward-spec';
import { AchievementService } from '../../application/services/achievement.service';
import { RewardPayoutService } from '../../application/services/reward-payout.service';
import { RewardProgramService } from '../../application/services/reward-program.service';
import { RewardSuggestionService } from '../../application/services/reward-suggestion.service';
import {
  AcceptSuggestionDto,
  CreateRewardProgramDto,
  DecideAchievementDto,
  TransitionFulfilmentDto,
  UpdateRewardProgramDto,
} from '../../application/dto/reward-program.dto';
import type { FulfilmentStatus } from '../../../../shared/rewards/reward-spec';

/**
 * PARENT SURFACE — `/api/v1/reward-programs` (the `api/v1` prefix is applied by
 * `main.ts`'s `setGlobalPrefix`, this repository's existing convention).
 *
 * GUARDS, per the pattern F1 established: `@UseGuards(JwtAuthGuard)` PER ROUTE,
 * never a class-level guard, and never a parent guard stacked with a device
 * guard on the same handler. A device token reaching any handler in this file
 * is rejected because `JwtAuthGuard` is the `'jwt'` Passport strategy and a
 * device token is issued for `'device-jwt'` — two different strategies, which
 * is what makes "a child cannot create a program" a property of the guard
 * rather than a role check someone can forget.
 */
@Controller('reward-programs')
export class RewardProgramsController {
  constructor(
    private readonly programs: RewardProgramService,
    private readonly achievements: AchievementService,
    private readonly payout: RewardPayoutService,
    private readonly suggestions: RewardSuggestionService,
  ) {}

  // --- catalogue (reference data) ------------------------------------------

  /** Category -> Activity -> (for Quran) Surah. The whole first screen of the
   * create flow in one call, so the parent app does not make three. */
  @Get('catalogue')
  @UseGuards(JwtAuthGuard)
  catalogue() {
    return {
      categories: PROGRAM_CATEGORIES.map((code) => ({
        code,
        labelAr: PROGRAM_CATEGORY_LABEL_AR[code],
        activities: CATEGORY_ACTIVITIES[code as ProgramCategory].map((a) => ({
          code: a,
          labelAr: PROGRAM_ACTIVITY_LABEL_AR[a],
        })),
      })),
      verificationLevels: VERIFICATION_METHODS.map((m) => ({
        code: m,
        labelAr: VERIFICATION_MATRIX[m].labelAr,
        rationaleAr: VERIFICATION_MATRIX[m].rationaleAr,
        strength: VERIFICATION_MATRIX[m].strength,
        canAutoApprove: VERIFICATION_MATRIX[m].canAutoApprove,
        requiresExplicitChoice: VERIFICATION_MATRIX[m].requiresExplicitChoice,
      })),
      rewardTypes: PROGRAM_REWARD_TYPES,
    };
  }

  /** The 114 surahs. Reference data, identical for every family. */
  @Get('catalogue/surahs')
  @UseGuards(JwtAuthGuard)
  surahs() {
    return { surahs: QURAN_SURAHS, total: QURAN_SURAHS.length };
  }

  // --- programs -------------------------------------------------------------

  @Post()
  @UseGuards(JwtAuthGuard)
  create(@Body() dto: CreateRewardProgramDto, @CurrentUser() user: IJwtPayload) {
    return this.programs.create(user.familyId!, user.sub, dto);
  }

  @Get()
  @UseGuards(JwtAuthGuard)
  list(@Query('childId') childId: string | undefined, @CurrentUser() user: IJwtPayload) {
    return this.programs.list(user.familyId!, childId);
  }

  /**
   * DECLARED BEFORE `:programId` ON PURPOSE. NestJS matches routes in
   * declaration order, and `fulfilments` is a single path segment — declared
   * after the parameterised route it would be swallowed by it and every call
   * would try to load a program whose id is the literal string "fulfilments".
   * (`achievements/pending` and `suggestions/:childId` are two segments and so
   * cannot collide; this one can.)
   */
  @Get('fulfilments')
  @UseGuards(JwtAuthGuard)
  fulfilments(@Query('status') status?: string) {
    return this.payout.listFulfilments(status);
  }

  @Get(':programId')
  @UseGuards(JwtAuthGuard)
  get(@Param('programId') programId: string) {
    return this.programs.get(programId);
  }

  @Patch(':programId')
  @UseGuards(JwtAuthGuard)
  update(@Param('programId') programId: string, @Body() dto: UpdateRewardProgramDto) {
    return this.programs.update(programId, dto);
  }

  @Delete(':programId')
  @UseGuards(JwtAuthGuard)
  archive(@Param('programId') programId: string) {
    return this.programs.remove(programId);
  }

  // --- achievement queue ----------------------------------------------------

  @Get('achievements/pending')
  @UseGuards(JwtAuthGuard)
  pending() {
    return this.achievements.listPending();
  }

  @Get('achievements/:achievementId/attempts')
  @UseGuards(JwtAuthGuard)
  attempts(@Param('achievementId') achievementId: string) {
    return this.achievements.attemptsOf(achievementId);
  }

  @Post('achievements/:achievementId/approve')
  @UseGuards(JwtAuthGuard)
  approve(
    @Param('achievementId') achievementId: string,
    @Body() dto: DecideAchievementDto,
    @CurrentUser() user: IJwtPayload,
  ) {
    return this.achievements.decide(user.sub, achievementId, true, dto.note);
  }

  @Post('achievements/:achievementId/reject')
  @UseGuards(JwtAuthGuard)
  reject(
    @Param('achievementId') achievementId: string,
    @Body() dto: DecideAchievementDto,
    @CurrentUser() user: IJwtPayload,
  ) {
    return this.achievements.decide(user.sub, achievementId, false, dto.note);
  }

  // --- fulfilment -----------------------------------------------------------

  @Patch('fulfilments/:fulfilmentId')
  @UseGuards(JwtAuthGuard)
  moveFulfilment(
    @Param('fulfilmentId') fulfilmentId: string,
    @Body() dto: TransitionFulfilmentDto,
    @CurrentUser() user: IJwtPayload,
  ) {
    return this.payout.transition(fulfilmentId, dto.to as FulfilmentStatus, user.sub, dto.note);
  }

  // --- screen-time grants ---------------------------------------------------

  @Get('screen-time-grants/:childId')
  @UseGuards(JwtAuthGuard)
  grants(@Param('childId') childId: string, @CurrentUser() user: IJwtPayload) {
    return this.payout.listScreenTimeGrants(childId, user.familyId!);
  }

  @Delete('screen-time-grants/:grantId')
  @UseGuards(JwtAuthGuard)
  revokeGrant(@Param('grantId') grantId: string, @CurrentUser() user: IJwtPayload) {
    return this.payout.revokeScreenTimeGrant(grantId, user.sub);
  }

  // --- AI, advisory only ----------------------------------------------------

  /** Returns DRAFTS. Nothing is created by this call — see
   * `RewardSuggestionService`'s header for why that is structural. */
  @Get('suggestions/:childId')
  @UseGuards(JwtAuthGuard)
  suggest(@Param('childId') childId: string, @CurrentUser() user: IJwtPayload) {
    return this.suggestions.suggest(user.familyId!, childId);
  }

  /** The parent's EXPLICIT accept — the only path from a suggestion to a row. */
  @Post('suggestions/accept')
  @UseGuards(JwtAuthGuard)
  acceptSuggestion(@Body() dto: AcceptSuggestionDto, @CurrentUser() user: IJwtPayload) {
    return this.suggestions.accept(user.familyId!, user.sub, dto.childId, dto.suggestionId);
  }
}
