/* eslint-disable @typescript-eslint/no-explicit-any */
import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';

import { CurrentUser } from '../../../../common/decorators/current-user.decorator';
import { DeviceJwtAuthGuard } from '../../../auth/presentation/guards/jwt-auth.guard';
import type { IJwtPayload } from '../../../auth/domain/auth.types';
import { PairingOrchestratorService } from '../../../pairing/application/services/pairing-orchestrator.service';
import { AchievementService } from '../../application/services/achievement.service';
import { PrismaRewardProgramRepository } from '../../infrastructure/repositories/prisma-reward-program.repository';
import { StartAchievementDto, SubmitAchievementDto } from '../../application/dto/reward-program.dto';

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

  @Get('mine')
  @UseGuards(DeviceJwtAuthGuard)
  async mine(@CurrentUser() device: IJwtPayload) {
    return this.achievements.listForChild(await this.childOf(device));
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
