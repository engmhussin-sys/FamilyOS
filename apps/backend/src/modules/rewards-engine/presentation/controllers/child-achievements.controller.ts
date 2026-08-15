/* eslint-disable @typescript-eslint/no-explicit-any */
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';

import { CurrentUser } from '../../../../common/decorators/current-user.decorator';
import { DeviceJwtAuthGuard } from '../../../auth/presentation/guards/jwt-auth.guard';
import type { IJwtPayload } from '../../../auth/domain/auth.types';
import { PairingOrchestratorService } from '../../../pairing/application/services/pairing-orchestrator.service';
import { AchievementService } from '../../application/services/achievement.service';
import { AchievementEvidenceService } from '../../application/services/achievement-evidence.service';
import { QuizService } from '../../application/services/quiz.service';
import { PrismaRewardProgramRepository } from '../../infrastructure/repositories/prisma-reward-program.repository';
import { StartAchievementDto, SubmitAchievementDto } from '../../application/dto/reward-program.dto';
import { ALLOWED_EVIDENCE_MIME_TYPES, MAX_EVIDENCE_BYTES } from '../../../../shared/rewards/evidence';

/**
 * B5 (PA-B-019) — the shape multer hands a handler, declared HERE rather than
 * pulled in as `Express.Multer.File`.
 *
 * `@types/multer` is not a dependency of this project and adding one to read
 * four fields would put a types-only package in `package.json` and a new entry
 * in `package-lock.json` for no runtime benefit. `multer` itself is a declared
 * dependency of `@nestjs/platform-express`, so `FileInterceptor` is a
 * supported API being used as documented — this interface just names what it
 * returns, with no `any` anywhere.
 */
interface IUploadedEvidenceFile {
  readonly buffer: Buffer;
  readonly mimetype: string;
  readonly size: number;
  readonly originalname: string;
}

/**
 * CHILD SURFACE — `/api/v1/self/achievements/*`.
 *
 * THE SECURITY SHAPE OF THIS FILE, in one paragraph:
 *
 *   - Every route carries `@UseGuards(DeviceJwtAuthGuard)` PER ROUTE. That is
 *     the `'device-jwt'` Passport strategy, a different strategy from the
 *     parent one — a parent token cannot reach these routes and a device token
 *     cannot reach the parent controller. There is no class-level guard and no
 *     stacked pair, per the pattern F1 established.
 *   - `childId` is NEVER read from the request. It is derived from the DEVICE
 *     in the verified token, via the existing
 *     `PairingOrchestratorService.getChildAndFamilyIdForDevice`. A device that
 *     posts another child's id gains nothing because the value is not read.
 *   - There is NO endpoint here that verifies, approves, grants, or creates a
 *     program. `start` and `submit` are the entire child-writable surface, and
 *     neither can produce a ledger row.
 */
@Controller('self/achievements')
export class ChildAchievementsController {
  constructor(
    private readonly achievements: AchievementService,
    private readonly pairing: PairingOrchestratorService,
    private readonly repo: PrismaRewardProgramRepository,
    private readonly quiz: QuizService,
    private readonly evidence: AchievementEvidenceService,
  ) {}

  private async childOf(device: IJwtPayload): Promise<string> {
    const { childId } = await this.pairing.getChildAndFamilyIdForDevice(device.sub);
    return childId;
  }

  /** Today's programs, each with `available` and, when it is not, the reason —
   * so the app can explain rather than fail on tap. */
  @Get('today')
  @UseGuards(DeviceJwtAuthGuard)
  async today(@CurrentUser() device: IJwtPayload) {
    return this.achievements.todayForChild(await this.childOf(device));
  }

  @Post('start')
  @UseGuards(DeviceJwtAuthGuard)
  async start(@Body() dto: StartAchievementDto, @CurrentUser() device: IJwtPayload) {
    return this.achievements.start(await this.childOf(device), dto.programId);
  }

  /** SUBMIT EVIDENCE — not a result. There is deliberately no field on
   * `SubmitAchievementDto` by which a child states an outcome. */
  @Post(':achievementId/submit')
  @UseGuards(DeviceJwtAuthGuard)
  async submit(
    @Param('achievementId') achievementId: string,
    @Body() dto: SubmitAchievementDto,
    @CurrentUser() device: IJwtPayload,
  ) {
    return this.achievements.submit(await this.childOf(device), achievementId, dto);
  }

  /**
   * B5 (PA-B-017) — THE QUESTIONS, WITHOUT THE ANSWERS.
   *
   * ADDED, not extended: there was no route by which a child could receive a
   * question, because there were no questions. The response is the served set
   * for THIS attempt, drawn and recorded by the server; a second call inside
   * the same attempt returns the identical set rather than re-rolling, which
   * is enforced by `quiz_assignments (achievement_id, attempt_no)` and not by
   * a check here.
   *
   * `correctChoiceIndex` is unreachable from this route: the repository method
   * behind it `select`s four columns and the key is not one of them.
   */
  @Get(':achievementId/quiz')
  @UseGuards(DeviceJwtAuthGuard)
  async quizFor(
    @Param('achievementId', ParseUUIDPipe) achievementId: string,
    @CurrentUser() device: IJwtPayload,
  ) {
    return this.quiz.serve(await this.childOf(device), achievementId);
  }

  /**
   * B5 (PA-B-019) — THE UPLOAD THAT DID NOT EXIST, and the route the whole
   * Quran journey was blocked on.
   *
   * `memoryStorage` deliberately: the bytes must be inspected (magic-byte
   * signature) and hashed BEFORE anything is written anywhere, and multer's
   * disk storage would have put an unvalidated, client-named file on the
   * filesystem first. The 15 MiB limit is declared twice on purpose — here, so
   * multer aborts a hostile stream early instead of buffering it, and again in
   * `inspectEvidence`, which is the pure function the unit tests exercise.
   *
   * The declared `Content-Type` is filtered here as a CHEAP REJECTION ONLY.
   * The type that gets stored is decided from the bytes, in
   * `inspectEvidence` — a client's own statement about a child's file is
   * exactly the class of input PA-B-017 taught this codebase to stop trusting.
   */
  @Post(':achievementId/evidence')
  @UseGuards(DeviceJwtAuthGuard)
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: MAX_EVIDENCE_BYTES, files: 1 },
      fileFilter: (_req, file: { mimetype: string }, cb: (e: Error | null, ok: boolean) => void) => {
        cb(null, ALLOWED_EVIDENCE_MIME_TYPES.includes(file.mimetype));
      },
    }),
  )
  async uploadEvidence(
    @Param('achievementId', ParseUUIDPipe) achievementId: string,
    @UploadedFile() file: IUploadedEvidenceFile | undefined,
    @CurrentUser() device: IJwtPayload,
  ) {
    if (!file?.buffer) {
      throw new BadRequestException({
        code: 'EVIDENCE_MISSING',
        messageAr: 'لم يصل أي ملف. اختر التسجيل أو الصورة ثم أعد المحاولة.',
      });
    }
    return this.evidence.upload({
      childId: await this.childOf(device),
      achievementId,
      bytes: file.buffer,
      originalFilename: file.originalname,
    });
  }

  @Get('mine')
  @UseGuards(DeviceJwtAuthGuard)
  async mine(@CurrentUser() device: IJwtPayload) {
    return this.achievements.listForChild(await this.childOf(device));
  }

  /**
   * B5 — CHILD-FACING BADGES (`PHASE-A-Mobile` child path C10).
   *
   * `ChildBadgeAward` has been written by `RewardsEngineService` since Sprint
   * 13 and read by NOBODY: «`ChildBadgeAward` يُكتب خادميًا ولا يقرؤه أحد».
   * The badges existed, the awards existed, and no client could ever show one.
   *
   * SEARCHED BEFORE ADDING: `GET /life-intelligence/self/rewards/account`
   * returns the child's points/XP/level and does NOT include badges, and
   * `/self/achievements/rewards` returns screen-time grants and fulfilments.
   * Neither could be extended without changing an existing response shape the
   * admin dashboard already consumes, so this is a new, additive read.
   */
  @Get('badges')
  @UseGuards(DeviceJwtAuthGuard)
  async badges(@CurrentUser() device: IJwtPayload) {
    const rows = await this.repo.listBadgeAwards(await this.childOf(device));
    return rows.map((row) => ({
      id: row.id,
      badgeId: row.badgeId,
      awardedAt: row.awardedAt,
      key: row.badge?.key ?? null,
      title: row.badge?.title ?? null,
      description: row.badge?.description ?? null,
      isGroupAchievement: row.badge?.isGroupAchievement ?? false,
    }));
  }

  @Get('streaks')
  @UseGuards(DeviceJwtAuthGuard)
  async streaks(@CurrentUser() device: IJwtPayload) {
    return this.achievements.streaksForChild(await this.childOf(device));
  }

  /** The child's own earned rewards: bonus screen-time minutes still alive, and
   * the physical/custom rewards waiting on a parent. */
  @Get('rewards')
  @UseGuards(DeviceJwtAuthGuard)
  async rewards(@CurrentUser() device: IJwtPayload) {
    const childId = await this.childOf(device);
    const now = new Date();
    return {
      activeBonusMinutes: await this.repo.activeBonusMinutes(childId, now),
      screenTimeGrants: await this.repo.listScreenTimeGrants({ childId, revokedAt: null }),
      fulfilments: await this.repo.listFulfilments({ childId }),
    };
  }
}
