import { Body, Controller, ForbiddenException, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';

import { JwtAuthGuard, DeviceJwtAuthGuard } from '../../../auth/presentation/guards/jwt-auth.guard';
import { CurrentUser } from '../../../../common/decorators/current-user.decorator';
import type { IJwtPayload } from '../../../auth/domain/auth.types';
import { HabitEngineService } from '../../application/services/habit-engine.service';
import { LifeTimelineService } from '../../application/services/life-timeline.service';
import { HealthEngineService } from '../../application/services/health-engine.service';
import { FaithEngineService } from '../../application/services/faith-engine.service';
import { LearningEngineService } from '../../application/services/learning-engine.service';
import { SmartTaskEngineService } from '../../application/services/smart-task-engine.service';
import { RewardsEngineService } from '../../application/services/rewards-engine.service';
import { FamilyCommunicationService } from '../../application/services/family-communication.service';
import { CoachingEngineService } from '../../application/services/coaching-engine.service';
import { DigitalTwinService } from '../../application/services/digital-twin.service';
import { FamilyInsightService } from '../../application/services/family-insight.service';
import { CreateHabitDto, CompleteHabitDto } from '../../application/dto/habit.dto';
import { LogNutritionDto, LogHydrationDto, LogSleepDto, LogActivityDto } from '../../application/dto/health.dto';
import { CreateFaithPracticeDto, LogFaithPracticeDto } from '../../application/dto/faith.dto';
import { CreateLearningGoalDto, LogLearningSessionDto, GenerateSmartTasksDto, DecideSmartTaskDto } from '../../application/dto/learning-smart-task.dto';
import { RequestRedemptionDto, TriggerRewardEventDto, SendParentMessageDto, DraftAiMessageDto } from '../../application/dto/rewards-communication.dto';
import { PairingOrchestratorService } from '../../../pairing/application/services/pairing-orchestrator.service';

@Controller('life-intelligence')
@UseGuards(JwtAuthGuard)
export class LifeIntelligenceController {
  constructor(
    private readonly habitEngine: HabitEngineService,
    private readonly timeline: LifeTimelineService,
    private readonly healthEngine: HealthEngineService,
    private readonly faithEngine: FaithEngineService,
    private readonly learningEngine: LearningEngineService,
    private readonly smartTaskEngine: SmartTaskEngineService,
    private readonly rewardsEngine: RewardsEngineService,
    private readonly communication: FamilyCommunicationService,
    private readonly coachingEngine: CoachingEngineService,
    private readonly digitalTwin: DigitalTwinService,
    private readonly familyInsight: FamilyInsightService,
    private readonly pairingOrchestrator: PairingOrchestratorService,
  ) {}

  // ---- Habit Builder ----
  @Post('habits/:childId')
  createHabit(@Param('childId') childId: string, @Body() dto: CreateHabitDto, @CurrentUser() user: IJwtPayload) {
    return this.habitEngine.createHabit(childId, user.familyId!, { ...dto, createdByUserId: user.sub });
  }

  @Get('habits/:childId')
  listHabits(@Param('childId') childId: string, @CurrentUser() user: IJwtPayload) {
    return this.habitEngine.listHabits(childId, user.familyId!);
  }

  @Post('habits/:childId/:habitId/complete')
  completeHabit(
    @Param('childId') childId: string,
    @Param('habitId') habitId: string,
    @Body() dto: CompleteHabitDto,
    @CurrentUser() user: IJwtPayload,
  ) {
    return this.habitEngine.completeHabit(habitId, childId, user.familyId!, dto.date);
  }

  @Get('habits/:childId/score')
  getHabitScore(@Param('childId') childId: string, @CurrentUser() user: IJwtPayload) {
    return this.habitEngine.getScoreBreakdown(childId, user.familyId!);
  }

  // ---- Health ----
  @Post('health/:childId/nutrition-logs')
  logNutrition(@Param('childId') childId: string, @Body() dto: LogNutritionDto, @CurrentUser() user: IJwtPayload) {
    return this.healthEngine.logNutrition(childId, user.familyId!, dto);
  }

  @Post('health/:childId/hydration-logs')
  logHydration(@Param('childId') childId: string, @Body() dto: LogHydrationDto, @CurrentUser() user: IJwtPayload) {
    return this.healthEngine.logHydration(childId, user.familyId!, dto);
  }

  @Post('health/:childId/sleep-logs')
  logSleep(@Param('childId') childId: string, @Body() dto: LogSleepDto, @CurrentUser() user: IJwtPayload) {
    return this.healthEngine.logSleep(childId, user.familyId!, dto);
  }

  @Post('health/:childId/activity-logs')
  logActivity(@Param('childId') childId: string, @Body() dto: LogActivityDto, @CurrentUser() user: IJwtPayload) {
    return this.healthEngine.logActivity(childId, user.familyId!, dto);
  }

  @Get('health/:childId/score')
  getHealthScore(@Param('childId') childId: string, @Query('date') date: string | undefined, @CurrentUser() user: IJwtPayload) {
    return this.healthEngine.computeAndStoreHealthScore(childId, user.familyId!, date);
  }

  // ---- Faith ----
  @Post('faith/:childId/practices')
  createFaithPractice(@Param('childId') childId: string, @Body() dto: CreateFaithPracticeDto, @CurrentUser() user: IJwtPayload) {
    return this.faithEngine.createPractice(childId, user.familyId!, dto);
  }

  @Get('faith/:childId/practices')
  listFaithPractices(@Param('childId') childId: string, @CurrentUser() user: IJwtPayload) {
    return this.faithEngine.listPractices(childId, user.familyId!);
  }

  @Post('faith/:childId/:practiceId/log')
  logFaithPractice(
    @Param('childId') childId: string,
    @Param('practiceId') practiceId: string,
    @Body() dto: LogFaithPracticeDto,
    @CurrentUser() user: IJwtPayload,
  ) {
    return this.faithEngine.logPractice(practiceId, childId, user.familyId!, dto.date, dto.progress);
  }

  @Get('faith/:childId/score')
  getFaithScore(@Param('childId') childId: string, @CurrentUser() user: IJwtPayload) {
    return this.faithEngine.getScoreBreakdown(childId, user.familyId!);
  }

  // ---- Learning & Education ----
  @Post('learning/:childId/goals')
  createLearningGoal(@Param('childId') childId: string, @Body() dto: CreateLearningGoalDto, @CurrentUser() user: IJwtPayload) {
    return this.learningEngine.createGoal(childId, user.familyId!, dto);
  }

  @Get('learning/:childId/goals')
  listLearningGoals(@Param('childId') childId: string, @CurrentUser() user: IJwtPayload) {
    return this.learningEngine.listGoals(childId, user.familyId!);
  }

  @Post('learning/:childId/sessions')
  logLearningSession(@Param('childId') childId: string, @Body() dto: LogLearningSessionDto, @CurrentUser() user: IJwtPayload) {
    return this.learningEngine.logSession(childId, user.familyId!, dto);
  }

  @Get('learning/:childId/progress')
  getLearningProgress(@Param('childId') childId: string, @CurrentUser() user: IJwtPayload) {
    return this.learningEngine.getProgressSummary(childId, user.familyId!);
  }

  // ---- Smart Tasks ----
  @Post('smart-tasks/:childId/generate')
  generateSmartTasks(@Param('childId') childId: string, @Body() dto: GenerateSmartTasksDto, @CurrentUser() user: IJwtPayload) {
    return this.smartTaskEngine.generateForToday(childId, user.familyId!, dto);
  }

  @Get('smart-tasks/:childId')
  listSmartTasksToday(@Param('childId') childId: string, @CurrentUser() user: IJwtPayload) {
    return this.smartTaskEngine.listForToday(childId, user.familyId!);
  }

  @Post('smart-tasks/:childId/:taskId/decide')
  decideSmartTask(
    @Param('childId') childId: string,
    @Param('taskId') taskId: string,
    @Body() dto: DecideSmartTaskDto,
    @CurrentUser() user: IJwtPayload,
  ) {
    return this.smartTaskEngine.decide(taskId, childId, user.familyId!, dto.status);
  }

  // ---- Rewards ----
  @Get('rewards/:childId/account')
  getRewardsAccount(@Param('childId') childId: string, @CurrentUser() user: IJwtPayload) {
    return this.rewardsEngine.getAccount(childId, user.familyId!);
  }

  /**
   * Stricter than the global default (100/min via APP_GUARD, already
   * covering every route in this controller) \u2014 this specific
   * endpoint grants coins/XP/badges, so even same-family repeated
   * calls have real product-integrity impact (reward farming) the
   * generic default wasn't specifically tuned for. This is a
   * tightening, not a fix \u2014 the endpoint was never unprotected.
   */
  @Post('rewards/:childId/trigger')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  triggerRewardEvent(@Param('childId') childId: string, @Body() dto: TriggerRewardEventDto, @CurrentUser() user: IJwtPayload) {
    return this.rewardsEngine.processTriggerEvent(childId, user.familyId!, dto);
  }

  @Get('rewards/store/:familyId')
  getFamilyStore(@Param('familyId') familyId: string, @CurrentUser() user: IJwtPayload) {
    // FIXING A REAL IDOR (found during Sprint 23's audit of every
    // life-intelligence endpoint): this route previously had no
    // @CurrentUser() at all — any authenticated user could pass any
    // other family's familyId and see their entire reward store. A
    // user can only ever request their OWN family's store; no
    // repository round-trip needed to prove that, their own verified
    // JWT already settles it.
    if (user.familyId !== familyId) {
      throw new ForbiddenException('Cannot view another family\u2019s store');
    }
    return this.rewardsEngine.listFamilyStore(familyId);
  }

  @Post('rewards/:childId/redemptions')
  requestRedemption(@Param('childId') childId: string, @Body() dto: RequestRedemptionDto, @CurrentUser() user: IJwtPayload) {
    return this.rewardsEngine.requestRedemption(childId, user.familyId!, dto.catalogItemId);
  }

  @Post('rewards/redemptions/:redemptionId/approve')
  approveRedemption(@Param('redemptionId') redemptionId: string, @CurrentUser() user: IJwtPayload) {
    return this.rewardsEngine.approveRedemption(redemptionId, user.familyId!, user.sub);
  }

  @Post('rewards/redemptions/:redemptionId/deny')
  denyRedemption(@Param('redemptionId') redemptionId: string, @CurrentUser() user: IJwtPayload) {
    return this.rewardsEngine.denyRedemption(redemptionId, user.familyId!, user.sub);
  }

  // ---- Family Communication ----
  @Post('communication/:childId/parent-message')
  sendParentMessage(@Param('childId') childId: string, @Body() dto: SendParentMessageDto, @CurrentUser() user: IJwtPayload) {
    return this.communication.sendParentMessage(childId, user.familyId!, user.sub, dto.category, dto.title, dto.body);
  }

  @Post('communication/:childId/ai-draft')
  draftAiMessage(@Param('childId') childId: string, @Body() dto: DraftAiMessageDto, @CurrentUser() user: IJwtPayload) {
    return this.communication.draftAiMessage(childId, user.familyId!, dto.category, dto.title, dto.body);
  }

  @Post('communication/:childId/:messageId/approve')
  approveMessage(@Param('childId') childId: string, @Param('messageId') messageId: string, @CurrentUser() user: IJwtPayload) {
    return this.communication.approve(messageId, childId, user.familyId!);
  }

  @Post('communication/:childId/:messageId/reject')
  rejectMessage(@Param('childId') childId: string, @Param('messageId') messageId: string, @CurrentUser() user: IJwtPayload) {
    return this.communication.reject(messageId, childId, user.familyId!);
  }

  /** Device-authenticated (the Child App's own session), not the
   * parent JwtAuthGuard the rest of this controller defaults to.
   * PREVIOUSLY DOCUMENTED GAP NOW CLOSED (Sprint 23 hardening): the
   * service verifies the authenticated device's own paired childId
   * matches :childId before returning anything. */
  @Get('communication/child/:childId')
  @UseGuards(DeviceJwtAuthGuard)
  getChildInbox(@Param('childId') childId: string, @CurrentUser() device: IJwtPayload) {
    return this.communication.getChildInbox(device.sub, childId);
  }

  // ---- Coaching ----
  @Get('coaching/:childId')
  getCoachingRecommendations(@Param('childId') childId: string, @CurrentUser() user: IJwtPayload) {
    return this.coachingEngine.getRecommendations(childId, user.familyId!);
  }

  // ---- Digital Twin ----
  @Get('digital-twin/:childId')
  getDigitalTwin(@Param('childId') childId: string, @CurrentUser() user: IJwtPayload) {
    return this.digitalTwin.refreshAndGet(childId, user.familyId!);
  }

  // ---- Family Insight ----
  @Get('insights/:childId/weekly')
  getWeeklyInsight(@Param('childId') childId: string, @CurrentUser() user: IJwtPayload) {
    return this.familyInsight.getWeeklySummary(childId, user.familyId!);
  }

  // ---- Child self-logging (device-authenticated — Sprint 29) ----
  // The Child App itself has no parent JWT; it authenticates as a
  // DEVICE. These routes let a paired device log its OWN child's
  // habit/health/faith actions directly — resolving the real childId
  // AND familyId from the device record (never trusted from the
  // request body), the same verification discipline proven on the
  // child inbox route. A device can only ever act for its own paired
  // child, never an arbitrary childId.

  @Post('self/habits/:habitId/complete')
  @UseGuards(DeviceJwtAuthGuard)
  async selfCompleteHabit(@Param('habitId') habitId: string, @Body() dto: CompleteHabitDto, @CurrentUser() device: IJwtPayload) {
    const { childId, familyId } = await this.pairingOrchestrator.getChildAndFamilyIdForDevice(device.sub);
    return this.habitEngine.completeHabit(habitId, childId, familyId, dto.date);
  }

  @Get('self/habits')
  @UseGuards(DeviceJwtAuthGuard)
  async selfListHabits(@CurrentUser() device: IJwtPayload) {
    const { childId, familyId } = await this.pairingOrchestrator.getChildAndFamilyIdForDevice(device.sub);
    return this.habitEngine.listHabits(childId, familyId);
  }

  @Post('self/health/hydration-logs')
  @UseGuards(DeviceJwtAuthGuard)
  async selfLogHydration(@Body() dto: LogHydrationDto, @CurrentUser() device: IJwtPayload) {
    const { childId, familyId } = await this.pairingOrchestrator.getChildAndFamilyIdForDevice(device.sub);
    return this.healthEngine.logHydration(childId, familyId, dto);
  }

  @Get('self/faith/practices')
  @UseGuards(DeviceJwtAuthGuard)
  async selfListFaithPractices(@CurrentUser() device: IJwtPayload) {
    const { childId, familyId } = await this.pairingOrchestrator.getChildAndFamilyIdForDevice(device.sub);
    return this.faithEngine.listPractices(childId, familyId);
  }

  @Post('self/faith/:practiceId/log')
  @UseGuards(DeviceJwtAuthGuard)
  async selfLogFaithPractice(@Param('practiceId') practiceId: string, @Body() dto: LogFaithPracticeDto, @CurrentUser() device: IJwtPayload) {
    const { childId, familyId } = await this.pairingOrchestrator.getChildAndFamilyIdForDevice(device.sub);
    return this.faithEngine.logPractice(practiceId, childId, familyId, dto.date, dto.progress);
  }

  @Get('self/messages')
  @UseGuards(DeviceJwtAuthGuard)
  async selfGetMessages(@CurrentUser() device: IJwtPayload) {
    return this.communication.getChildInbox(device.sub, await this.pairingOrchestrator.getChildIdForDevice(device.sub));
  }

  // ---- Timeline ----
  @Get('timeline/:childId')
  getTimeline(@Param('childId') childId: string, @Query('category') category: string | undefined, @CurrentUser() user: IJwtPayload) {
    return this.timeline.getTimeline(childId, user.familyId!, category);
  }
}
