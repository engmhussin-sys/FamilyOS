import { Controller, Get, Inject, UseGuards } from '@nestjs/common';

import { InternalAdminGuard } from '../../../../common/guards/internal-admin.guard';
import { SystemRoute } from '../../../../common/tenancy/system-route.decorator';
import { PlatformAdminSurface } from '../../../../common/authz/roles.decorator';
import {
  NOTIFICATION_DELIVERY_REPOSITORY,
  type INotificationDeliveryRepository,
} from '../../application/ports/notification-delivery.repository.port';

/**
 * PHASE D (`PC-D-005`) — THE OPERATOR SURFACE FOR A NOTIFICATION THAT DIED.
 *
 * WHY IT EXISTS. Phase C's `PC-B-002` found that the outbox had a `DEAD` status
 * and a `maxAttempts` and gave nobody a way to see either, and the notification
 * path was worse: it had no terminal state at all. `PushNotificationService.
 * sendToDevice` caught every FCM error and returned — a stale token, an offline
 * device or a revoked credential produced one `logger.warn` and nothing else.
 * There was no number anywhere in this product for «notifications we owe and
 * cannot deliver».
 *
 * WHY THE GAUGE COUNTS `dead` SEPARATELY FROM `pending`, EXPLICITLY. Phase C
 * measured the alternative: `OutboxRelay.backlog()` counted `PENDING/FAILED`
 * only, so a message reaching DEAD made the number go DOWN and the alert got
 * quieter exactly as the incident got worse. `SQL_DELIVERY_BACKLOG` cannot do
 * that — the two counts are two columns.
 *
 * WHY THERE IS NO `POST .../recover` HERE, unlike the outbox. The refusal is
 * deliberate and it is Phase C's own argument re-applied rather than reversed:
 * a dead notification has failed eight times with exponential backoff, and
 * requeueing it on a button — let alone a timer — is how a poison row becomes a
 * loop. But there is a second reason specific to notifications, and it is the
 * stronger one: A NOTIFICATION IS PERISHABLE. Recovering a «you earned a
 * reward» announcement three days late is not a recovery, it is a confusing
 * message about a Tuesday. The operator action that matters here is fixing the
 * cause (a rotated FCM credential, a device that never re-registered), after
 * which the NEXT notification works — and the dead rows stay as evidence of
 * what the household did not receive.
 *
 * READS ARE NOT AUDITED, deliberately, for the reason `SchedulerOperationsController`
 * states: auditing reads of the observability surface is how the audit table
 * becomes the largest store of personal data in the system.
 */
@Controller('system/notifications')
export class NotificationOperationsController {
  constructor(
    @Inject(NOTIFICATION_DELIVERY_REPOSITORY)
    private readonly deliveries: INotificationDeliveryRepository,
  ) {}

  /**
   * The one call an operator makes. Counts and type names only — never a title,
   * a body, a child id or a family id, because «which household» is not needed
   * to triage «FCM credentials are rotated» and putting it here would make a
   * platform dashboard a place children's notification text is readable.
   */
  @Get('deliveries')
  @PlatformAdminSurface()
  @SystemRoute(
    'ADMIN_CONSOLE',
    'Undeliverable-notification gauge over notification_deliveries; cross-tenant because a permanently failed delivery is a platform-level condition, behind InternalAdminGuard.',
  )
  @UseGuards(InternalAdminGuard)
  async backlog() {
    return this.deliveries.backlog();
  }
}
