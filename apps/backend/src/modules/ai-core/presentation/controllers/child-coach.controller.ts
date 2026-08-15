import { BadRequestException, Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';

import { CurrentUser } from '../../../../common/decorators/current-user.decorator';
import { DeviceJwtAuthGuard } from '../../../auth/presentation/guards/jwt-auth.guard';
import type { IJwtPayload } from '../../../auth/domain/auth.types';
import { PairingOrchestratorService } from '../../../pairing/application/services/pairing-orchestrator.service';
import { ChildCoachService } from '../../application/services/child-coach.service';
import { DistressEscalationService } from '../../application/services/distress-escalation.service';
import { isChildTopicCode } from '../../domain/child-coach-content';
import { ChildCheckinDto } from '../dto/coach.dto';

/**
 * B8 — THE CHILD'S AI COACH TAB — `/api/v1/self/coach/*`.
 *
 * THE SECURITY SHAPE, in the same terms `ChildAchievementsController` states
 * its own (B5), because it is deliberately the same shape:
 *
 *   - Every route carries `@UseGuards(DeviceJwtAuthGuard)` PER ROUTE — the
 *     `'device-jwt'` Passport strategy. A parent token cannot reach these
 *     routes and a device token cannot reach `ParentCoachController`.
 *   - `childId` is NEVER read from the request. It is derived from the DEVICE
 *     in the verified token via
 *     `PairingOrchestratorService.getChildAndFamilyIdForDevice`. A device that
 *     posts another child's id gains nothing, because the value is not read.
 *   - There is NO endpoint here that grants, verifies, approves, or creates
 *     anything. Two of the four are pure reads; `checkin` writes only a
 *     classification code to the AI's own memory table and asks the
 *     notification engine to alert a parent.
 *
 * THE OPEN-CHAT DECISION, ENFORCED AT THE ROUTE LAYER (§11.1). `answer` takes a
 * `:code` and validates it against `CHILD_TOPIC_CODES` — a nine-value enum —
 * before the service is reached. There is no route on this controller that
 * accepts free text and returns model output. `checkin` accepts free text and
 * returns either a fixed human-written card or nothing at all; its text reaches
 * `classifyDistress` and no further.
 *
 * B3 ERROR CONTRACT: the 400 below carries `{ code, messageAr }`, so the child's
 * app renders a real Arabic sentence rather than «Bad Request». The message is
 * non-punitive (CONTEXT §3 principle 7): it says what to do, not what went
 * wrong with the child.
 */
@Controller('self/coach')
export class ChildCoachController {
  constructor(
    private readonly coach: ChildCoachService,
    private readonly distress: DistressEscalationService,
    private readonly pairing: PairingOrchestratorService,
  ) {}

  private async selfOf(device: IJwtPayload): Promise<{ childId: string; familyId: string }> {
    return this.pairing.getChildAndFamilyIdForDevice(device.sub);
  }

  /** The encouragement card. No child input exists on this path at all. */
  @Get('today')
  @UseGuards(DeviceJwtAuthGuard)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  async today(@CurrentUser() device: IJwtPayload) {
    const { childId, familyId } = await this.selfOf(device);
    return this.coach.today(childId, familyId);
  }

  /** The closed question vocabulary the app renders as buttons. Static, so a
   * generous throttle — it is the cheapest call in the product. */
  @Get('topics')
  @UseGuards(DeviceJwtAuthGuard)
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  topics() {
    return { topics: this.coach.topics() };
  }

  /** The answer for one code, at the child's own age band. Never billed. */
  @Get('answer/:topicCode')
  @UseGuards(DeviceJwtAuthGuard)
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  async answer(@Param('topicCode') topicCode: string, @CurrentUser() device: IJwtPayload) {
    if (!isChildTopicCode(topicCode)) {
      // THE GATE. An unknown code is refused here, before any service runs —
      // which is what makes "no open-ended child chat" a routing property
      // rather than a prompt instruction.
      throw new BadRequestException({
        code: 'UNKNOWN_COACH_TOPIC',
        messageAr: 'هذا السؤال غير متاح. اختر سؤالًا من القائمة.',
      });
    }
    const { childId, familyId } = await this.selfOf(device);
    return this.coach.answer(childId, familyId, topicCode);
  }

  /**
   * «كيف تشعر اليوم؟» — the ONLY free-text field a child has, and it is a
   * SAFETY path, not a chat.
   *
   * The text is classified offline by `classifyDistress` and then dropped: it
   * is not stored, not logged, not echoed back, and not sent to any provider.
   * On a signal the child gets one fixed, human-written card and the parent
   * gets one generically-worded alert. On no signal the child gets today's
   * ordinary encouragement — the same card `GET today` would have returned, so
   * a child cannot learn what the classifier does by watching how the screen
   * changes.
   *
   * Throttled tightly: the classifier is cheap, but a field that runs a regex
   * list should not be a free loop.
   */
  @Post('checkin')
  @UseGuards(DeviceJwtAuthGuard)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async checkin(@Body() dto: ChildCheckinDto, @CurrentUser() device: IJwtPayload) {
    const { childId, familyId } = await this.selfOf(device);
    const result = await this.distress.checkin(childId, familyId, dto.feeling);

    if (result.escalated) {
      return { escalated: true as const, card: result.card, encouragement: null };
    }
    return { escalated: false as const, card: null, encouragement: await this.coach.today(childId, familyId) };
  }
}
