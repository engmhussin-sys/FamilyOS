/* eslint-disable @typescript-eslint/no-explicit-any */
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';

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
import { AchievementEvidenceService } from '../../application/services/achievement-evidence.service';
import { PrismaRewardProgramRepository } from '../../infrastructure/repositories/prisma-reward-program.repository';
import { RewardPayoutService } from '../../application/services/reward-payout.service';
import { RewardProgramService } from '../../application/services/reward-program.service';
import { RewardSuggestionService } from '../../application/services/reward-suggestion.service';
import {
  AcceptSuggestionDto,
  CreateQuizQuestionDto,
  CreateRewardProgramDto,
  DecideAchievementDto,
  TransitionFulfilmentDto,
  UpdateRewardProgramDto,
} from '../../application/dto/reward-program.dto';
import type { FulfilmentStatus } from '../../../../shared/rewards/reward-spec';
import { ParentSurface } from '../../../../common/authz/roles.decorator';

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
    private readonly evidence: AchievementEvidenceService,
    private readonly repo: PrismaRewardProgramRepository,
  ) {}

  // --- catalogue (reference data) ------------------------------------------

  /** Category -> Activity -> (for Quran) Surah. The whole first screen of the
   * create flow in one call, so the parent app does not make three. */
  @Get('catalogue')
  @ParentSurface()
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
  @ParentSurface()
  @UseGuards(JwtAuthGuard)
  surahs() {
    return { surahs: QURAN_SURAHS, total: QURAN_SURAHS.length };
  }

  // --- programs -------------------------------------------------------------

  @Post()
  @ParentSurface()
  @UseGuards(JwtAuthGuard)
  create(@Body() dto: CreateRewardProgramDto, @CurrentUser() user: IJwtPayload) {
    return this.programs.create(user.familyId!, user.sub, dto);
  }

  @Get()
  @ParentSurface()
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
  @ParentSurface()
  @UseGuards(JwtAuthGuard)
  fulfilments(@Query('status') status?: string) {
    return this.payout.listFulfilments(status);
  }

  // --- B5: routes whose FIRST segment is a literal ------------------------
  //
  // ORDER IS LOAD-BEARING. Express matches in declaration order, so
  // `@Get(':programId')` below would swallow `GET /reward-programs/achievements`
  // and `GET /reward-programs/quiz-bank` and hand the literal string
  // "achievements" to `findProgram()` as a uuid. The pre-existing
  // `achievements/pending` never hit this because it has two segments; these
  // two have one. They are declared HERE, above the parameterised route, and
  // `test/rewards/b5-mobile-contract.e2e.spec.ts` asserts both return 200 —
  // so a future reorder is caught by a test rather than by a 500 in
  // production.

  /**
   * B5 — «[الوالد] تاريخ إنجازات طفل» (`PHASE-A-Backend §13.2`). The audit's
   * exact words: «`listForChild` موجودة **بلا route والد**» — the service
   * method has existed since F4 and only the CHILD's own device could reach
   * it. This is the parent's read of the same method, tenant-scoped by the F2
   * extension, so a parent in family B gets an empty list rather than a 403.
   *
   * EXTENDED, NOT ADDED: no new service method, no new repository method, no
   * second query shape. The route is the only new thing.
   */
  @Get('achievements')
  @ParentSurface()
  @UseGuards(JwtAuthGuard)
  achievementsOfChild(@Query('childId', ParseUUIDPipe) childId: string) {
    return this.achievements.listForChild(childId);
  }

  /**
   * THE MECHANISM, SHIPPED WITH A SAMPLE BANK — and the content question
   * flagged, not answered.
   *
   * Migration 0008 seeds twelve platform questions (`family_id IS NULL`) so
   * the server-side scoring path is provable the moment it runs. Authoring a
   * real, age-graded, pedagogically-reviewed bank is a BUSINESS DECISION and
   * inventing large amounts of educational content inside a backend sprint
   * would have been the wrong kind of initiative. These two routes are how a
   * family adds its own questions today and how an admin tool will add
   * platform ones later; the open question is recorded in the B5+B9 report.
   *
   * The answer key is accepted on write and never returned on read.
   */
  @Get('quiz-bank')
  @ParentSurface()
  @UseGuards(JwtAuthGuard)
  listQuizBank(@Query('category') category: string, @Query('subject') subject?: string) {
    return this.repo.listBankQuestions({ category, subject: subject ?? null, ageYears: null });
  }

  @Get(':programId')
  @ParentSurface()
  @UseGuards(JwtAuthGuard)
  get(@Param('programId') programId: string) {
    return this.programs.get(programId);
  }

  @Patch(':programId')
  @ParentSurface()
  @UseGuards(JwtAuthGuard)
  update(@Param('programId') programId: string, @Body() dto: UpdateRewardProgramDto) {
    return this.programs.update(programId, dto);
  }

  @Delete(':programId')
  @ParentSurface()
  @UseGuards(JwtAuthGuard)
  archive(@Param('programId') programId: string) {
    return this.programs.remove(programId);
  }

  // --- achievement queue ----------------------------------------------------

  @Get('achievements/pending')
  @ParentSurface()
  @UseGuards(JwtAuthGuard)
  pending() {
    return this.achievements.listPending();
  }

  /**
   * B5 — «[الوالد] إنجاز واحد بتفاصيله». Returns the achievement, its
   * append-only attempt history and its uploaded evidence METADATA in one
   * call, because a parent deciding on a recitation needs all three and three
   * round trips on a mobile connection is a worse review experience than one.
   *
   * The evidence list carries ids, types and sizes — never `storageKey`. The
   * bytes come from the separate authenticated route below.
   */
  @Get('achievements/:achievementId')
  @ParentSurface()
  @UseGuards(JwtAuthGuard)
  async achievementDetail(@Param('achievementId', ParseUUIDPipe) achievementId: string) {
    const [attempts, evidence] = await Promise.all([
      this.achievements.attemptsOf(achievementId),
      this.evidence.list(achievementId),
    ]);
    return { attempts, evidence };
  }

  /**
   * B5 (PA-B-019) — THE PARENT'S REVIEW READ, and the reason there is no
   * signed URL anywhere in this feature.
   *
   * Streams the bytes through the application, so every read of a child's
   * voice recording passes the parent JWT guard and the F2 tenant extension.
   * A pre-signed URL would have been less code and a bearer capability that
   * leaves authz entirely — see `evidence-storage.port.ts`.
   *
   * `Content-Disposition: attachment` and `X-Content-Type-Options: nosniff`
   * together stop a stored file from ever being rendered as active content in
   * a browser context, which matters because the admin dashboard is a web app
   * on the same origin family.
   */
  @Get('achievements/:achievementId/evidence/:evidenceId')
  @ParentSurface()
  @UseGuards(JwtAuthGuard)
  async readEvidence(
    @Param('evidenceId', ParseUUIDPipe) evidenceId: string,
    @Res() res: Response,
  ): Promise<void> {
    const file = await this.evidence.read(evidenceId);
    res.setHeader('Content-Type', file.mimeType);
    res.setHeader('Content-Length', String(file.byteSize));
    res.setHeader('Content-Disposition', 'attachment');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, no-store');
    res.end(file.bytes);
  }

  /**
   * B5 — «[الوالد] streaks الطفل — متاح للطفل فقط». Same
   * `AchievementService.streaksForChild` the child route calls; the streaks
   * were computable and unreadable by the person who buys the subscription.
   */
  @Get('streaks/:childId')
  @ParentSurface()
  @UseGuards(JwtAuthGuard)
  streaksOfChild(@Param('childId', ParseUUIDPipe) childId: string) {
    return this.achievements.streaksForChild(childId);
  }

  // --- B5 (PA-B-017): the question bank a parent can author ------------------

  /**
   * PHASE F (`F6-009`, defect `PF-E-005`) — THE CREATE RESPONSE NO LONGER
   * ECHOES THE ANSWER KEY.
   *
   * The rule this route states about itself, a few lines above, is «the answer
   * key is ACCEPTED on write and returned by nothing», and every READ path
   * honoured it: `listBankQuestions` and `listBankQuestionsByIds` both select
   * four columns and the key is not one of them. THIS handler did not — it
   * returned `repo.createBankQuestion(...)` directly, i.e. the whole Prisma row
   * with `correct_choice_index` in it, and the golden quiz scenario caught it on
   * the first HTTP call it made.
   *
   * WHY IT IS FIXED EVEN THOUGH THE CALLER IS THE AUTHOR. The blast radius today
   * is small: the route is `@ParentSurface()` and the parent typed the answer a
   * millisecond earlier. It is fixed anyway because the whole value of «the key
   * never leaves the server» is that it holds WITHOUT EXCEPTIONS — an exception
   * is the thing a future feature copies. A parent-app screen that caches this
   * response, a proxy that logs response bodies, or a later bulk-import route
   * that reuses this shape all inherit a leak nobody re-examines, because the
   * docstring says there is not one.
   *
   * The four fields returned are EXACTLY the four the read paths return, so no
   * client can come to depend on a field the list route would never have given.
   */
  @Post('quiz-bank')
  @ParentSurface()
  @UseGuards(JwtAuthGuard)
  async createQuizQuestion(@Body() dto: CreateQuizQuestionDto, @CurrentUser() user: IJwtPayload) {
    if (dto.correctChoiceIndex >= dto.choices.length) {
      throw new BadRequestException({
        code: 'QUIZ_ANSWER_OUT_OF_RANGE',
        messageAr: 'رقم الإجابة الصحيحة خارج نطاق الخيارات المُدخلة.',
      });
    }
    const created = await this.repo.createBankQuestion({
      category: dto.category,
      subject: dto.subject ?? null,
      difficulty: dto.difficulty ?? 'EASY',
      minAge: dto.minAge ?? null,
      maxAge: dto.maxAge ?? null,
      promptAr: dto.promptAr,
      choices: dto.choices,
      correctChoiceIndex: dto.correctChoiceIndex,
      explanationAr: dto.explanationAr ?? null,
      createdByUserId: user.sub,
    });
    return {
      id: created.id,
      promptAr: created.promptAr,
      choices: created.choices,
      difficulty: created.difficulty,
    };
  }

  @Get('achievements/:achievementId/attempts')
  @ParentSurface()
  @UseGuards(JwtAuthGuard)
  attempts(@Param('achievementId') achievementId: string) {
    return this.achievements.attemptsOf(achievementId);
  }

  @Post('achievements/:achievementId/approve')
  @ParentSurface()
  @UseGuards(JwtAuthGuard)
  approve(
    @Param('achievementId') achievementId: string,
    @Body() dto: DecideAchievementDto,
    @CurrentUser() user: IJwtPayload,
  ) {
    return this.achievements.decide(user.sub, achievementId, true, dto.note);
  }

  @Post('achievements/:achievementId/reject')
  @ParentSurface()
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
  @ParentSurface()
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
  @ParentSurface()
  @UseGuards(JwtAuthGuard)
  grants(@Param('childId') childId: string, @CurrentUser() user: IJwtPayload) {
    return this.payout.listScreenTimeGrants(childId, user.familyId!);
  }

  @Delete('screen-time-grants/:grantId')
  @ParentSurface()
  @UseGuards(JwtAuthGuard)
  revokeGrant(@Param('grantId') grantId: string, @CurrentUser() user: IJwtPayload) {
    return this.payout.revokeScreenTimeGrant(grantId, user.sub);
  }

  // --- AI, advisory only ----------------------------------------------------

  /** Returns DRAFTS. Nothing is created by this call — see
   * `RewardSuggestionService`'s header for why that is structural. */
  @Get('suggestions/:childId')
  @ParentSurface()
  @UseGuards(JwtAuthGuard)
  suggest(@Param('childId') childId: string, @CurrentUser() user: IJwtPayload) {
    return this.suggestions.suggest(user.familyId!, childId);
  }

  /** The parent's EXPLICIT accept — the only path from a suggestion to a row. */
  @Post('suggestions/accept')
  @ParentSurface()
  @UseGuards(JwtAuthGuard)
  acceptSuggestion(@Body() dto: AcceptSuggestionDto, @CurrentUser() user: IJwtPayload) {
    return this.suggestions.accept(user.familyId!, user.sub, dto.childId, dto.suggestionId);
  }
}
