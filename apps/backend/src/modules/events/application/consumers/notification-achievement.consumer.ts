import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';

import {
  SmartNotificationEngineService,
  type SmartNotificationResult,
} from '../../../notification-engine/application/services/smart-notification-engine.service';
import type { DomainEventEnvelope } from '../../../../shared/events/event-envelope';
import { achievementSummaryArOf } from '../../../../shared/rewards/achievement-summary';
import { forDomainEvent } from '../../../../shared/notifications/notification-source-key';
import { EVENT_SUBSCRIBER, type IEventSubscriber } from '../../domain/event-bus.port';
import { ConsumerIdempotency } from './consumer-idempotency.service';

export const NOTIFICATION_ACHIEVEMENT_CONSUMER = 'NotificationAchievementConsumer';

/**
 * `ACHIEVEMENT_REJECTED` -> the Smart Notification Decision Engine.
 *
 * ---------------------------------------------------------------------------
 * `F1-002` — THE PRODUCER FOR THE KEY PRODUCTION SAID MUST NOT HAVE ONE.
 *
 * `achievement.service.ts` stated «`ACHIEVEMENT_REJECTED` has NO consumer,
 * deliberately (principle 7)» while `COPY_CATALOGUE.ACHIEVEMENT_REJECTED`
 * carried a child-facing sentence in four tone bands and two languages, with a
 * quiet-hours class, two scoring rows and a deep link. The full argument for
 * resolving that contradiction in favour of TELLING THE CHILD is written at the
 * rejection branch itself, next to the comment it replaces; the short form is
 * that principle 7 forbids PUNISHING a child, not ANSWERING one, and a child
 * who submitted evidence and heard nothing has been answered only when they
 * were right.
 *
 * WHAT THE CHILD READS: «يحتاج {goalTitle} مراجعة بسيطة مع أهلك» at their own
 * tone band, in the household's locale — a goal by name and a conversation to
 * have. It states no reason and no fault, and the parent's rejection `note`
 * never leaves the attempt row (see the payload in `AchievementService.decide`).
 *
 * WHY IT IS SILENT WHEN THE GOAL HAS NO NAME. Every template in this entry
 * takes `{goalTitle}`. Without it `renderNotificationCopy` correctly refuses the
 * template and falls through to `GENERIC` — «لديك جديد في التطبيق ✨» — and
 * pushing THAT at a child after a rejected submission is a notification that
 * makes them open the app to find bad news with no context. A rejection the
 * product cannot name is a rejection it should not announce, so this consumer
 * stops. `describeTargetSpec` writes the summary at program creation and the
 * absent case is the enum-shaped fallback `achievementSummaryArOf` refuses —
 * never a program a parent created normally.
 *
 * NO SECOND NOTIFICATION IS POSSIBLE. A rejected achievement grants nothing, so
 * `RewardsCompletionConsumer` emits no `REWARD_GRANTED` and
 * `NotificationRewardConsumer` never runs for it — this key and the reward keys
 * are reachable only on mutually exclusive branches of one parent decision.
 *
 * B9 — the source key is `forDomainEvent(envelope.id)`, the strongest form:
 * `domain_events.id` is server-assigned, unique under
 * `domain_events (family_id, idempotency_key)` and IDENTICAL on every
 * redelivery, so `child_messages (family_id, source_event_id)` refuses the
 * second row. `ConsumerIdempotency.once` is the optimisation above it, not the
 * guarantee.
 *
 * DELIVERY OUTCOME IS NOT DELIVERY, and unlike `NotificationRewardConsumer`
 * this consumer does NOT rethrow on `DELIVERY_ERROR`. The distinction is the
 * one that file draws: it rethrows because the notification IS the whole job
 * and a lost reward announcement is a lost reward. Here the business outcome —
 * the REJECTED row and the still-open attempt — is committed and visible in the
 * child's own goal screen, and re-running the outbox message would re-enter a
 * pipeline whose dedup keys are already written. A failure is logged and the
 * message is done.
 * ---------------------------------------------------------------------------
 */
@Injectable()
export class NotificationAchievementConsumer implements OnModuleInit {
  private readonly logger = new Logger(NotificationAchievementConsumer.name);

  constructor(
    @Inject(EVENT_SUBSCRIBER) private readonly bus: IEventSubscriber,
    private readonly engine: SmartNotificationEngineService,
    private readonly idempotency: ConsumerIdempotency,
  ) {}

  onModuleInit(): void {
    this.bus.register('ACHIEVEMENT_REJECTED', NOTIFICATION_ACHIEVEMENT_CONSUMER, (envelope) =>
      this.handle(envelope),
    );
  }

  async handle(envelope: DomainEventEnvelope): Promise<void> {
    const payload = (envelope.payload ?? {}) as {
      childId?: string;
      /** `RewardProgram.targetSummaryAr`, put on the event by
       * `AchievementService.decide`. */
      targetSummaryAr?: string | null;
    };
    const childId = payload.childId ?? envelope.childId;
    if (!childId) return;

    // The SAME reader the reward path uses, so «what was achieved, in Arabic»
    // has one definition: it trims, bounds the length and — the point of the
    // function — treats an ENUM-SHAPED value (`QURAN_MEMORIZE_AYAH_RANGE`, which
    // `describeTargetSpec` returns for a spec it cannot describe) as absent
    // rather than shouting a database value at a child.
    const goalTitle = achievementSummaryArOf({ metadata: { targetSummaryAr: payload.targetSummaryAr } });
    if (goalTitle === null) {
      this.logger.debug(
        `achievement.rejection_not_announced event=${envelope.id} — no nameable goal; ` +
          `a rejection this product cannot name is one it does not announce.`,
      );
      return;
    }

    await this.idempotency.once(NOTIFICATION_ACHIEVEMENT_CONSUMER, envelope.id, async () => {
      const result = await this.engine.handleEvent({
        familyId: envelope.familyId,
        childId,
        eventType: 'ACHIEVEMENT_REJECTED',
        sourceEventId: forDomainEvent(envelope.id),
        trigger: 'DOMAIN_EVENT',
        variables: { goalTitle },
      });

      this.assertChildAudience(result);
      this.logger.debug(
        `notification.decision type=ACHIEVEMENT_REJECTED eventId=${envelope.id} ` +
          `engine=${result.decision.verdict}/${result.decision.reason} audience=${result.decision.targetAudience} ` +
          `pipeline=${result.outcome?.decision ?? 'not_called'}`,
      );
    });
  }

  /**
   * `PE-N-001`'s lesson, borrowed verbatim from `NotificationRewardConsumer`:
   * the child path fails QUIETLY by default. The audience is read from
   * `COPY_CATALOGUE[type].audience` by the decision provider, so an entry edited
   * to `PARENT` would keep scoring, keep writing decision rows, and tell a
   * PARENT their child's attempt needs review while the child heard nothing —
   * which is this producer's entire purpose, inverted, with a full ledger
   * describing it.
   */
  private assertChildAudience(result: SmartNotificationResult): void {
    if (result.decision.targetAudience !== 'CHILD') {
      throw new Error(
        `ACHIEVEMENT_REJECTED resolved to targetAudience=${result.decision.targetAudience}, ` +
          `but this producer exists to reach the CHILD whose attempt it is about.`,
      );
    }
  }
}
