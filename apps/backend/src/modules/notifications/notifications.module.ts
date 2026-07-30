import { Module } from '@nestjs/common';

import { NotificationsController } from './presentation/controllers/notifications.controller';
import { NotificationsService } from './application/services/notifications.service';
import { PrismaNotificationRepository } from './infrastructure/repositories/prisma-notification.repository';
import { NOTIFICATION_REPOSITORY } from './application/ports/notification.repository.port';

/**
 * Sprint 8's Notification Center. Deliberately a NEW, standalone module
 * rather than folding into PairingModule (which already writes
 * RUNTIME_ALERT-type notifications via RuntimeAlertRepository) —
 * PairingModule's repository is a narrow WRITE-side concern scoped to
 * one notification type; this module is the general READ/manage side
 * for every notification type a user has, present or future
 * (Health/Education engines will write their own types into the same
 * table later without needing this module to change).
 */
@Module({
  controllers: [NotificationsController],
  providers: [
    NotificationsService,
    { provide: NOTIFICATION_REPOSITORY, useClass: PrismaNotificationRepository },
  ],
  exports: [NotificationsService],
})
export class NotificationsModule {}
