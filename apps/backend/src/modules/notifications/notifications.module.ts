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
import { EngineBypassDecisionRecorder } from './application/services/engine-bypass-decision.recorder';

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
    /**
     * THE RECEIPT FOR A NOTIFICATION THE ENGINE NEVER DECIDED.
     *
     * A CLASS AND NOT A PORT, and the asymmetry with the four bindings above is
     * deliberate rather than an oversight. Those are PERSISTENCE seams, and an
     * interface is what keeps `notification-engine/` depending on a contract
     * instead of on a Prisma model. This is not persistence: it is a small
     * policy about which columns a bypassed notification's row carries, it has
     * exactly one implementation that could ever be correct, and a port would
     * make «what does a bypass row look like» swappable — which is the last
     * thing an audit trail should be.
     *
     * PROVIDED HERE, in the module that owns `notification_decisions`, and
     * consumed by `PairingModule` — the module that owns the single writer of
     * `notifications`. That direction is one-way and stays acyclic:
     * `NotificationsModule` imports nothing at all.
     */
    EngineBypassDecisionRecorder,
  ],
  exports: [
    NotificationsService,
    NOTIFICATION_REPOSITORY,
    NOTIFICATION_DELIVERY_REPOSITORY,
    NOTIFICATION_DECISION_REPOSITORY,
    NOTIFICATION_POLICY_REPOSITORY,
    EngineBypassDecisionRecorder,
  ],
})
export class NotificationsModule {}
