import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';

import { SmartNotificationIntegrationService } from '../../../life-intelligence/application/services/smart-notification-integration.service';
import type { DomainEventEnvelope } from '../../../../shared/events/event-envelope';
import { forDomainEvent } from '../../../../shared/notifications/notification-source-key';
import { EVENT_SUBSCRIBER, type IEventSubscriber } from '../../domain/event-bus.port';
import { ConsumerIdempotency } from './consumer-idempotency.service';

export const NOTIFICATION_REWARD_CONSUMER = 'NotificationRewardConsumer';

/**
 * `REWARD_GRANTED` -> the Smart Notification Decision Engine.
 *
 * ZERO NEW NOTIFICATION LOGIC IS BUILT HERE, and that is the point. It calls
 * `SmartNotificationIntegrationService.notifyEvent`, which is the existing
 * single-candidate pipeline built in Sprint 16.2, which runs the existing
 * `NotificationFatigueGuard` (Cooldown -> Duplicate -> Quiet Hours -> Daily Max
 * -> Category Max -> Priority) and routes PARENT candidates through the
 * existing runtime-alert repository. This consumer's entire contribution is
 * subscribing that pipeline to an event instead of to a direct method call.
 *
 * WHY THIS CONSUMER CANNOT FIRE ON A DUPLICATE: it subscribes to
 * `REWARD_GRANTED` and nothing else, and the only producer of `REWARD_GRANTED`
 * is `RewardsCompletionConsumer`, inside its `if (granted > 0)`. "No grant ⇒ no
 * notification" is therefore a property of the wiring, not a runtime check that
 * could be forgotten — there is no code path from a duplicate completion to
 * this file.
 *
 * B9 (PA-B-007 / PA-B-008) — WHY THE «KNOWN LIMIT» IS GONE. The paragraph
 * above was true and was not enough. `ConsumerIdempotency.once` writes a
 * `consumed_messages` row, and F3's own docstring calls that an OPTIMISATION:
 * lose the row and the handler runs again. The fatigue guard's five-minute
 * DUPLICATE window caught the fast case and nothing caught the slow one, which
 * is exactly what `reward-engine.e2e.spec.ts`'s «KNOWN LIMIT» test measured —
 * marker deleted, clock at 12:30, notificationCount = 2 for one reward.
 *
 * `envelope.id` IS `domain_events.id`. It is server-assigned, unique under
 * `domain_events (family_id, idempotency_key)`, and IDENTICAL on every
 * redelivery of the same message for as long as the row exists. Composing the
 * notification's source key from it means the second notification is refused
 * by `notifications (family_id, source_event_id, user_id)` — not by a window,
 * not by a marker, and not by anything that can be deleted while the cause
 * survives.
 *
 * DELIVERY OUTCOME IS NOT DELIVERY: `notifyEvent` may return DEFER (quiet
 * hours) or SUPPRESS (fatigue). Both are successes from the outbox's point of
 * view — the decision engine was consulted and it decided. Treating a
 * fatigue-suppression as a delivery failure would make the relay retry it eight
 * times and then dead-letter a message that was handled correctly.
 */
@Injectable()
export class NotificationRewardConsumer implements OnModuleInit {
  private readonly logger = new Logger(NotificationRewardConsumer.name);

  constructor(
    @Inject(EVENT_SUBSCRIBER) private readonly bus: IEventSubscriber,
    private readonly notifications: SmartNotificationIntegrationService,
    private readonly idempotency: ConsumerIdempotency,
  ) {}

  onModuleInit(): void {
    this.bus.register('REWARD_GRANTED', NOTIFICATION_REWARD_CONSUMER, (envelope) =>
      this.handle(envelope),
    );
  }

  async handle(envelope: DomainEventEnvelope): Promise<void> {
    const payload = (envelope.payload ?? {}) as {
      childId?: string;
      grantCount?: number;
      completionKind?: string;
    };
    const childId = payload.childId ?? envelope.childId;
    if (!childId) {
      throw new Error(`REWARD_GRANTED ${envelope.id} has no childId — cannot target a notification.`);
    }

    await this.idempotency.once(NOTIFICATION_REWARD_CONSUMER, envelope.id, async () => {
      const outcome = await this.notifications.notifyEvent(childId, envelope.familyId, {
        type: 'REWARD_GRANTED',
        priority: 'NORMAL',
        // B9 — the strongest form: the id of the domain event that caused it.
        sourceEventId: forDomainEvent(envelope.id),
        // CONTEXT §3 principle 7 (NO PUNITIVE UX). Also principle 8: no child
        // name, no habit title — the FCM message is a pointer, the app fetches
        // the content over an authenticated GET (docs/06 §8.3).
        title: 'مكافأة جديدة',
        body: 'حصل طفلك على مكافأة جديدة اليوم. افتح التطبيق لرؤية التفاصيل.',
        targetAudience: 'PARENT',
      });

      this.logger.debug(
        `notification.decision type=REWARD_GRANTED eventId=${envelope.id} decision=${outcome.decision}` +
          (outcome.reason ? ` reason=${outcome.reason}` : ''),
      );
    });
  }
}
