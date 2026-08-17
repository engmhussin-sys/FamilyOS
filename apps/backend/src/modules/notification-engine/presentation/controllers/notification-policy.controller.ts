/**
 * PHASE F (`F6-002`) — THE HOUSEHOLD'S OWN TWO SURFACES.
 *
 *   GET  /notifications/decisions      «why did I not get that notification?»
 *   GET  /notifications/policy         the caps and quiet hours in force
 *   PUT  /notifications/policy/:key    change one of them
 *
 * WHY THE DECISION LIST IS A PARENT SURFACE AND NOT ONLY AN ADMIN ONE. The
 * question «why did my child's reward not notify me» belongs to the parent who
 * asked it, and routing it through a support ticket to a platform operator would
 * mean a human at ABNY reading a household's notification history in order to
 * answer a question the household could answer itself. Tenant-scoped: the
 * `family_id` comes from the token, never from a query parameter (CONTEXT §3
 * principle 3), and the SQL names the column.
 *
 * WHAT IT RETURNS. The DECISION — score, band, reason and the component
 * arithmetic — and never a body or a title, because those are already in
 * `GET /notifications` and duplicating them into a diagnostics endpoint would
 * put the same personal data behind two authorisations instead of one.
 *
 * THE POLICY WRITE IS `@OwnerOnly`-adjacent BY ROLE: `@ParentSurface` covers
 * OWNER and PARENT, which is the right set — a parent may quiet their own
 * household's notifications, and neither role may reach another household's,
 * because there is no path that takes a family id from the request.
 */

import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Inject,
  Param,
  Put,
  Query,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';

import { JwtAuthGuard } from '../../../auth/presentation/guards/jwt-auth.guard';
import { CurrentUser } from '../../../../common/decorators/current-user.decorator';
import type { IJwtPayload } from '../../../auth/domain/auth.types';
import { ParentSurface } from '../../../../common/authz/roles.decorator';
import {
  NOTIFICATION_DECISION_REPOSITORY,
  NOTIFICATION_POLICY_REPOSITORY,
  type INotificationDecisionRepository,
  type INotificationPolicyRepository,
} from '../../../notifications/application/ports/notification-decision.repository.port';
import {
  NOTIFICATION_POLICY_SCHEMAS,
  NotificationPolicySettingError,
  resolveNotificationPolicy,
} from '../../../notifications/domain/engine/notification-policy';

const MAX_DECISIONS_PAGE = 200;

@Controller('notifications')
@UseGuards(JwtAuthGuard)
export class NotificationPolicyController {
  constructor(
    @Inject(NOTIFICATION_DECISION_REPOSITORY)
    private readonly decisions: INotificationDecisionRepository,
    @Inject(NOTIFICATION_POLICY_REPOSITORY)
    private readonly policies: INotificationPolicyRepository,
  ) {}

  @Get('decisions')
  @ParentSurface()
  async listDecisions(@CurrentUser() user: IJwtPayload, @Query('limit') limit?: string) {
    const familyId = this.familyOf(user);
    const parsed = Number(limit ?? 50);
    const bounded = Number.isFinite(parsed) ? Math.min(Math.max(1, Math.trunc(parsed)), MAX_DECISIONS_PAGE) : 50;
    return this.decisions.listForFamily(familyId, bounded);
  }

  /**
   * The EFFECTIVE policy, not the stored rows — because what a parent wants to
   * see is «quiet hours are 21:00 to 07:00», and a settings table that returns
   * an empty object for a household on defaults answers a different question.
   * The schema list is returned alongside so a client can render bounds and the
   * Arabic descriptions without restating them.
   */
  @Get('policy')
  @ParentSurface()
  async readPolicy(@CurrentUser() user: IJwtPayload) {
    const familyId = this.familyOf(user);
    const overrides = await this.policies.readSettings(familyId);
    return {
      effective: resolveNotificationPolicy(overrides),
      overrides,
      schemas: NOTIFICATION_POLICY_SCHEMAS,
    };
  }

  @Put('policy/:key')
  @ParentSurface()
  async setPolicy(
    @CurrentUser() user: IJwtPayload,
    @Param('key') key: string,
    @Body() body: { value?: unknown },
  ) {
    const familyId = this.familyOf(user);
    if (typeof body?.value !== 'string') {
      throw new BadRequestException('`value` must be a string');
    }
    try {
      await this.policies.upsertSetting(familyId, key, body.value, user.sub);
    } catch (err) {
      // A closed vocabulary and a bound, reported as a 400 with the reason the
      // schema states — the same shape `GrowthAdminController` produces, so a
      // client handles one error format for settings across the product.
      if (err instanceof NotificationPolicySettingError) {
        throw new BadRequestException(err.message);
      }
      throw err;
    }
    const overrides = await this.policies.readSettings(familyId);
    return { effective: resolveNotificationPolicy(overrides), overrides };
  }

  /** The tenant comes from the SIGNED token and from nowhere else. A user
   * without a family cannot have notification decisions, and answering with an
   * empty list would be answering a question that was not asked. */
  private familyOf(user: IJwtPayload): string {
    if (!user.familyId) {
      throw new UnauthorizedException('No family on this token');
    }
    return user.familyId;
  }
}
