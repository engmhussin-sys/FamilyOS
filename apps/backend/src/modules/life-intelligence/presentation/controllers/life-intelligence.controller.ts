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
import { RecordDailyUsageSummaryDto, RecordCriticalEventDto } from '../../application/dto/digital-wellbeing.dto';
import { DigitalWellbeingEngineService } from '../../application/services/digital-wellbeing-engine.service';
import { PairingOrchestratorService } from '../../../pairing/application/services/pairing-orchestrator.service';
import { ChildrenService } from '../../../children/application/services/children.service';

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
    private readonly childrenService: ChildrenService,
    private readonly digitalWellbeing: DigitalWellbeingEngineService,
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

  /** Sprint 16 — CLOSES A REAL GAP (Missed Habit tracking, flagged
   * unbuilt since Sprint 15's own final report). On-demand trigger —
   * no scheduled-job infrastructure exists in this codebase yet, so
   * this is callable directly rather than silently assuming a cron
   * that doesn't exist. `date` defaults to yesterday server-side. */
  @Post('habits/:childId/mark-missed')
  markMissedHabits(@Param('childId') childId: string, @Body() dto: { date?: string }, @CurrentUser() user: IJwtPayload) {
    return this.habitEngine.markMissedHabits(childId, user.familyId!, dto?.date);
  }

  @Get('habits/:childId/missed')
  getMissedHabits(@Param('childId') childId: string, @Query('windowDays') windowDays: string | undefined, @CurrentUser() user: IJwtPayload) {
    const parsed = windowDays ? parseInt(windowDays, 10) : 7;
    const safeWindow = Number.isFinite(parsed) && parsed > 0 && parsed <= 90 ? parsed : 7;
    return this.habitEngine.getMissedHabitsSignal(childId, user.familyId!, safeWindow);
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

  /** Sprint 15 (Health & Daily Habits Engine) — CLOSES A REAL GAP:
   * the unified "how am I doing today" view (Hydration/Activity
   * progress + streaks) previously never existed as a single,
   * directly-consumable endpoint. */
  @Get('health/:childId/progress')
  getDailyProgress(@Param('childId') childId: string, @CurrentUser() user: IJwtPayload) {
    return this.healthEngine.getDailyProgress(childId, user.familyId!);
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

  /** CLOSES A REAL DESIGN FLAW found in a systematic frontend/backend
   * audit: the endpoint above required the CALLER to manually
   * compute the context — no real frontend anywhere could use it
   * without duplicating server-side analytical logic. This is the
   * endpoint a real frontend should actually call — zero body
   * needed, real context computed server-side from already-built
   * engines (see SmartTaskEngineService.generateForTodayAuto's own
   * docstring for exactly what's computed and the one honest
   * limitation — screenTimeOverLimit — left false). */
  @Post('smart-tasks/:childId/generate-auto')
  generateSmartTasksAuto(@Param('childId') childId: string, @CurrentUser() user: IJwtPayload) {
    return this.smartTaskEngine.generateForTodayAuto(childId, user.familyId!);
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

  /** CLOSES A CRITICAL REAL GAP: approve()/reject() below existed
   * with zero way for a parent to discover what needed approving —
   * every Smart Notification targeted at a child (Sprint 16-16.2)
   * was structurally unreachable without this. */
  @Get('communication/pending')
  getPendingMessages(@CurrentUser() user: IJwtPayload) {
    return this.communication.getPendingMessages(user.familyId!);
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

  /** CLOSES A REAL GAP: zero self-coaching endpoint existed — Coaching
   * had no path to the Child App at all. CRITICAL, found while
   * building this: getRecommendations returns ALL three tracks
   * (PARENT/CHILD/FAMILY) mixed together in one array — passing that
   * raw to a child would leak PARENT-track content (e.g. "habits are
   * slipping this week, check in with your child" — written for a
   * parent's eyes, not appropriate for the child to read about
   * themselves). Filtered to CHILD track only, server-side, before
   * this ever reaches the response — never trust a client to filter
   * something this sensitive. */
  @Get('self/coaching')
  @UseGuards(DeviceJwtAuthGuard)
  async selfGetCoaching(@CurrentUser() device: IJwtPayload) {
    const { childId, familyId } = await this.pairingOrchestrator.getChildAndFamilyIdForDevice(device.sub);
    const all = await this.coachingEngine.getRecommendations(childId, familyId);
    return all.filter((rec) => rec.track === 'CHILD');
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

  /** CLOSES A REAL GAP (found while building the Child App's design):
   * the Child App had no way to know its own child's first name at
   * all, the same class of gap Sprint 29 already found for familyId —
   * so a greeting like "Hi Ahmed!" had nothing to read. Minimal by
   * design: returns only firstName, never the full Child record (no
   * dateOfBirth, no other family data a device has no reason to hold). */
  @Get('self/profile')
  @UseGuards(DeviceJwtAuthGuard)
  async selfGetProfile(@CurrentUser() device: IJwtPayload) {
    const { childId, familyId } = await this.pairingOrchestrator.getChildAndFamilyIdForDevice(device.sub);
    const child = await this.childrenService.getChildOrThrow(childId, familyId);
    return { firstName: child.firstName };
  }

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

  /** Sprint 16.4 — CLOSES A REAL GAP: getDailyProgress existed
   * (Sprint 15/16.1) but was only reachable via the parent-facing
   * JwtAuthGuard route — a child had NO way to see their own
   * hydration/activity progress at all, which would have blocked
   * this sprint's entire "Today" screen from showing anything real. */
  @Get('self/health/progress')
  @UseGuards(DeviceJwtAuthGuard)
  async selfGetDailyProgress(@CurrentUser() device: IJwtPayload) {
    const { childId, familyId } = await this.pairingOrchestrator.getChildAndFamilyIdForDevice(device.sub);
    return this.healthEngine.getDailyProgress(childId, familyId);
  }

  @Post('self/health/activity-logs')
  @UseGuards(DeviceJwtAuthGuard)
  async selfLogActivity(@Body() dto: LogActivityDto, @CurrentUser() device: IJwtPayload) {
    const { childId, familyId } = await this.pairingOrchestrator.getChildAndFamilyIdForDevice(device.sub);
    return this.healthEngine.logActivity(childId, familyId, dto);
  }

  /** Sprint 16.4 — CLOSES A REAL GAP: LearningEngineService had zero
   * /self/* consumer at all — Education had no path to the Child App
   * whatsoever before this. */
  @Get('self/learning/progress')
  @UseGuards(DeviceJwtAuthGuard)
  async selfGetLearningProgress(@CurrentUser() device: IJwtPayload) {
    const { childId, familyId } = await this.pairingOrchestrator.getChildAndFamilyIdForDevice(device.sub);
    return this.learningEngine.getProgressSummary(childId, familyId);
  }

  @Post('self/learning/sessions')
  @UseGuards(DeviceJwtAuthGuard)
  async selfLogLearningSession(@Body() dto: LogLearningSessionDto, @CurrentUser() device: IJwtPayload) {
    const { childId, familyId } = await this.pairingOrchestrator.getChildAndFamilyIdForDevice(device.sub);
    return this.learningEngine.logSession(childId, familyId, dto);
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

  /** CLOSES A REAL GAP: acknowledgeMessage existed in the service
   * layer but had zero endpoint — combined with the IDOR fix just
   * made to that method, this is now safe to expose:
   * getChildAndFamilyIdForDevice resolves the caller's REAL child
   * server-side, never trusting a client-supplied id. */
  @Post('self/messages/:messageId/acknowledge')
  @UseGuards(DeviceJwtAuthGuard)
  async selfAcknowledgeMessage(@Param('messageId') messageId: string, @CurrentUser() device: IJwtPayload) {
    const { childId } = await this.pairingOrchestrator.getChildAndFamilyIdForDevice(device.sub);
    await this.communication.acknowledgeMessage(messageId, childId);
  }

  // ---- Child self-service: Rewards (Sprint 3 — Parent/Child parity audit) ----
  // CLOSES A REAL GAP: RewardsEngineService has had a real, working
  // account/store/redemption system since Sprint 17 — but zero
  // device-authenticated route ever let a child see their own
  // balance or the family store. A parent could always see and
  // manage it (life-intelligence/rewards/*); the child, who actually
  // earns and would spend the balance, could not.

  @Get('self/rewards/account')
  @UseGuards(DeviceJwtAuthGuard)
  async selfGetRewardsAccount(@CurrentUser() device: IJwtPayload) {
    const { childId, familyId } = await this.pairingOrchestrator.getChildAndFamilyIdForDevice(device.sub);
    return this.rewardsEngine.getAccount(childId, familyId);
  }

  @Get('self/rewards/store')
  @UseGuards(DeviceJwtAuthGuard)
  async selfGetRewardsStore(@CurrentUser() device: IJwtPayload) {
    const { familyId } = await this.pairingOrchestrator.getChildAndFamilyIdForDevice(device.sub);
    return this.rewardsEngine.listFamilyStore(familyId);
  }

  @Post('self/rewards/redeem/:catalogItemId')
  @UseGuards(DeviceJwtAuthGuard)
  async selfRequestRedemption(@Param('catalogItemId') catalogItemId: string, @CurrentUser() device: IJwtPayload) {
    const { childId, familyId } = await this.pairingOrchestrator.getChildAndFamilyIdForDevice(device.sub);
    return this.rewardsEngine.requestRedemption(childId, familyId, catalogItemId);
  }

  // ---- Digital Wellbeing (Edge-First Intelligence Architecture) ----
  // Same device-authenticated, self/* discipline as everything above:
  // the device uploads its OWN already-locally-aggregated summary,
  // resolving childId/familyId server-side. Never accepts raw events
  // — RecordDailyUsageSummaryDto is structurally incapable of carrying
  // per-tap data, message content, keystrokes, or GPS.

  @Post('self/wellbeing/daily-summary')
  @UseGuards(DeviceJwtAuthGuard)
  async selfRecordDailySummary(@Body() dto: RecordDailyUsageSummaryDto, @CurrentUser() device: IJwtPayload) {
    const { childId, familyId } = await this.pairingOrchestrator.getChildAndFamilyIdForDevice(device.sub);
    return this.digitalWellbeing.recordDailySummary(childId, familyId, device.sub, dto);
  }

  /** The near-real-time critical-event channel — expected to be
   * called within seconds of the triggering event on-device, not
   * batched with the daily summary above. */
  @Post('self/wellbeing/critical-event')
  @UseGuards(DeviceJwtAuthGuard)
  async selfRecordCriticalEvent(@Body() dto: RecordCriticalEventDto, @CurrentUser() device: IJwtPayload) {
    const { childId, familyId } = await this.pairingOrchestrator.getChildAndFamilyIdForDevice(device.sub);
    await this.digitalWellbeing.recordCriticalEvent(childId, familyId, dto);
  }

  @Get('wellbeing/:childId/snapshot')
  getWellbeingSnapshot(@Param('childId') childId: string, @CurrentUser() user: IJwtPayload) {
    return this.digitalWellbeing.getBehavioralSnapshotSummary(childId, user.familyId!);
  }

  @Get('wellbeing/:childId/top-apps/:deviceId')
  getTopApps(@Param('childId') childId: string, @Param('deviceId') deviceId: string, @CurrentUser() user: IJwtPayload) {
    return this.digitalWellbeing.getTopAppsToday(childId, user.familyId!, deviceId);
  }

  /** Sprint 14 (Behavioral Intelligence Engine) — Parent Insights.
   * `date` defaults to today if omitted. */
  @Get('wellbeing/:childId/insights')
  getWellbeingInsight(
    @Param('childId') childId: string,
    @Query('date') date: string | undefined,
    @CurrentUser() user: IJwtPayload,
  ) {
    const targetDate = date ?? new Date().toISOString().split('T')[0];
    return this.digitalWellbeing.getWellbeingInsight(childId, user.familyId!, targetDate);
  }

  // ---- Timeline ----
  @Get('timeline/:childId')
  getTimeline(@Param('childId') childId: string, @Query('category') category: string | undefined, @CurrentUser() user: IJwtPayload) {
    return this.timeline.getTimeline(childId, user.familyId!, category);
  }
}
