import { Module } from '@nestjs/common';

import { NotificationsController } from './presentation/controllers/notifications.controller';
import { NotificationsService } from './application/services/notifications.service';
import { PrismaNotificationRepository } from './infrastructure/repositories/prisma-notification.repository';
import { PrismaNotificationDeliveryRepository } from './infrastructure/repositories/prisma-notification-delivery.repository';
import { NOTIFICATION_REPOSITORY } from './application/ports/notification.repository.port';
import { NOTIFICATION_DELIVERY_REPOSITORY } from './application/ports/notification-delivery.repository.port';
import { NotificationOperationsController } from './presentation/controllers/notification-operations.controller';
import {
  NOTIFICATION_DECISION_REPOSITORY,
  NOTIFICATION_POLICY_REPOSITORY,
} from './application/ports/notification-decision.repository.port';
import {
  PrismaNotificationDecisionRepository,
  PrismaNotificationPolicyRepository,
} from './infrastructure/repositories/prisma-notification-decision.repository';

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
  controllers: [NotificationsController, NotificationOperationsController],
  providers: [
    NotificationsService,
    { provide: NOTIFICATION_REPOSITORY, useClass: PrismaNotificationRepository },
    // PHASE D (PC-D-005): the deferral queue's write side. Provided HERE, in
    // the module that owns the notification tables, and consumed by
    // `life-intelligence` through the port — which is what keeps the
    // dependency a contract rather than a Prisma model, and what keeps the
    // module graph acyclic while the release path still lives next to the
    // delivery routing it reuses.
    { provide: NOTIFICATION_DELIVERY_REPOSITORY, useClass: PrismaNotificationDeliveryRepository },
    // PHASE F (`F6-002`): the decision ledger and the per-family policy, both
    // provided HERE — in the module that owns the notification tables — and
    // consumed by `NotificationEngineModule` through their ports. Same reason
    // the deferral repository is here: the dependency stays a contract rather
    // than a Prisma model, and the module graph stays acyclic while the engine
    // that reads them lives next to the pipeline it calls.
    { provide: NOTIFICATION_DECISION_REPOSITORY, useClass: PrismaNotificationDecisionRepository },
    { provide: NOTIFICATION_POLICY_REPOSITORY, useClass: PrismaNotificationPolicyRepository },
  ],
  exports: [
    NotificationsService,
    NOTIFICATION_REPOSITORY,
    NOTIFICATION_DELIVERY_REPOSITORY,
    NOTIFICATION_DECISION_REPOSITORY,
    NOTIFICATION_POLICY_REPOSITORY,
  ],
})
export class NotificationsModule {}
