import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';

import {
  SmartNotificationEngineService,
  type SmartNotificationResult,
} from '../../../notification-engine/application/services/smart-notification-engine.service';
import type { DomainEventEnvelope } from '../../../../shared/events/event-envelope';
import { forDomainEvent } from '../../../../shared/notifications/notification-source-key';
import { EVENT_SUBSCRIBER, type IEventSubscriber } from '../../domain/event-bus.port';
import { ConsumerIdempotency } from './consumer-idempotency.service';

export const NOTIFICATION_REWARD_CONSUMER = 'NotificationRewardConsumer';

/**
 * `REWARD_GRANTED` -> the Smart Notification Decision Engine.
 *
 * ---------------------------------------------------------------------------
 * PHASE F (`F6-003`, closing `PF-E-001`) — THIS FILE WAS THE MEASUREMENT.
 *
 * The Golden E2E suite asked one question of the product — «what does a parent
 * actually receive when their child earns a reward?» — and answered it here:
 * two Arabic string literals, written inline, that could not name the child
 * because this consumer holds an envelope and never had the child's name. The
 * engine `F6-002` shipped — the context assembler, the scoring provider, the
 * tone matrix, the localisation catalogue, `notification_decisions` — had
 * exactly zero callers in `src/`, so the ledger built to make «why did this
 * arrive / not arrive» answerable was EMPTY IN EVERY PRODUCTION PATH.
 *
 * WHAT CHANGED, and it is one call: `notifyEvent` became `handleEvent`.
 *
 *   BEFORE  consumer -> notifyEvent(title: 'مكافأة جديدة', body: '…طفلك…')
 *   AFTER   consumer -> handleEvent({ eventType, sourceEventId, trigger })
 *                       -> assembler -> decision provider -> composer
 *                       -> notification_decisions row
 *                       -> THE SAME notifyEvent, with copy from the catalogue
 *
 * NOTHING BELOW THE ENGINE MOVED. `notifyEvent` is still the only pipeline,
 * `evaluateFatigue` is still the only guard, `notification-class.ts` is still
 * the only quiet-hours matrix, and B9's two unique indexes are still what
 * refuses a redelivered cause. The engine is inserted BETWEEN the event and
 * that pipeline; it did not replace any part of it.
 *
 * WHAT THE PARENT READS NOW: «🌟 محمد أكمل الآيات 1–5 من سورة الملك اليوم وحصل
 * على ٢٠ نقطة. افتح التطبيق لتشجيعه.» — rendered from
 * `COPY_CATALOGUE.REWARD_GRANTED_WITH_GOAL`, with `{childName}` resolved by the
 * assembler from two selected columns and the goal and the points supplied as
 * VARIABLES by `handle` below. The name is a FACT ABOUT THE HOUSEHOLD, not a
 * leak: CONTEXT §3 principle 8 bars identifiers from the FCM payload and from
 * the decision ledger, and both remain free of it — `notification_decisions` has
 * no `title` and no `body` column, asserted from `information_schema` by `e2e-05`.
 *
 * A REWARD WITH NO GOAL — a habit tick, a hydration target, a streak — still
 * reads «حصل محمد على مكافأة جديدة اليوم…» from `COPY_CATALOGUE.REWARD_GRANTED`,
 * because nothing on those paths knows what was achieved and inventing a title
 * for them would be worse than the general sentence.
 *
 * WHY NO `reward` FACTS ARE PASSED — meaning `RewardFacts`, the SCORING input,
 * which is a different thing from the copy variables above. The `REWARD_GRANTED`
 * payload carries a grant COUNT and the resulting balance; `RewardFacts.amount`
 * is a magnitude and feeds a logarithmic curve. Passing `grantCount` as an
 * amount would put a number into a STORED EXPLANATION that means something else,
 * and an explanation that does not mean what it says is worse than one that is
 * absent. The type's own `ACHIEVEMENT_BASELINE_BY_TYPE` row is the honest
 * reading, and it is the reading the scorer was designed for. The points the
 * SENTENCE states are not that number and never enter the score: they are read
 * from `rewards_ledger_entries` by the producer of this event.
 * ---------------------------------------------------------------------------
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
    private readonly engine: SmartNotificationEngineService,
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
      /** `RewardProgram.targetSummaryAr`, put on the event by
       * `RewardsCompletionConsumer`. `null` for every cause that is not a
       * parent-authored program. */
      achievementSummaryAr?: string | null;
      /** Summed from `rewards_ledger_entries` by the same producer. */
      pointsGranted?: number;
    };
    const childId = payload.childId ?? envelope.childId;
    if (!childId) {
      throw new Error(`REWARD_GRANTED ${envelope.id} has no childId — cannot target a notification.`);
    }

    await this.idempotency.once(NOTIFICATION_REWARD_CONSUMER, envelope.id, async () => {
      // B9 — the strongest form: the id of the domain event that caused it.
      // Composed ONCE and shared by both audiences, because it identifies THE
      // CAUSE and the cause is one. The ledger separates the two decisions on
      // `(family_id, source_event_id, target_audience)` and the delivery layer
      // separates the two rows with the `:child` facet it already appended
      // before this phase; neither deduplicates the other away.
      const sourceEventId = forDomainEvent(envelope.id);

      /**
       * ======================================================================
       * THE FACTS THE PARENT'S SENTENCE IS MADE OF — AND THE DEFECT THEY CLOSE.
       * ======================================================================
       *
       * WHAT WAS MEASURED (`e2e-13 STEP 14`): this call passed NO `data` and NO
       * `variables`, `COPY_CATALOGUE.REWARD_GRANTED` declared exactly one
       * variable (`childName`), and so a household whose whole chain began at
       * «حفظ سورة الملك، الآيات ١–٥» was told only «حصل محمد على مكافأة جديدة
       * اليوم» with `notifications.data` NULL. The goal was unreachable from the
       * notification by any field at all.
       *
       * THE PRODUCER PASSES VARIABLES; THE CATALOGUE HOLDS THE SENTENCE. There
       * is deliberately no string in this file — that is the rule `F6-003`
       * established when it deleted the two Arabic literals that used to live
       * here, and naming a goal is not a reason to put one back. Which of the
       * two reward templates these facts earn is
       * `RuleBasedNotificationDecisionProvider`'s decision, recorded on
       * `notification_decisions.copy_key`.
       *
       * AND THE ENGINE IS STILL THE ONLY DOOR. This is the same single
       * `handleEvent` call it has always been — EVENT -> engine -> decision ->
       * dedup -> safety -> persistence -> outbox, unchanged. Nothing here writes
       * a row, and `notification-engine-bypass.guard.spec.ts` is right to fail
       * anything that would.
       *
       * VARIABLES vs `data`, and they are not the same job:
       *   `variables` are what the SENTENCE is rendered from, and they are
       *      omitted entirely when a fact is absent — a partial set would only
       *      make the renderer reject the template. `points` stays a NUMBER so
       *      the catalogue writes it in the locale's own digits («٢٠» in ar,
       *      «20» in en); pre-formatting it here would move a localisation
       *      decision into a producer.
       *   `data` is the STRUCTURED payload the parent app renders from — the
       *      «open the app» in the sentence has to lead somewhere, and a client
       *      must not have to parse Arabic prose to deep-link. It carries facts
       *      only: no child id, no family id, no name that is not already in
       *      the body (CONTEXT §3 principle 8).
       */
      const summaryAr =
        typeof payload.achievementSummaryAr === 'string' && payload.achievementSummaryAr.trim().length > 0
          ? payload.achievementSummaryAr.trim()
          : null;
      const points =
        typeof payload.pointsGranted === 'number' && Number.isFinite(payload.pointsGranted) && payload.pointsGranted > 0
          ? payload.pointsGranted
          : null;

      const parent = await this.engine.handleEvent({
        familyId: envelope.familyId,
        childId,
        eventType: 'REWARD_GRANTED',
        sourceEventId,
        trigger: 'DOMAIN_EVENT',
        variables: {
          ...(summaryAr === null ? {} : { goalTitle: summaryAr }),
          ...(points === null ? {} : { points }),
        },
        data: {
          completionKind: payload.completionKind ?? null,
          grantCount: payload.grantCount ?? null,
          goalTitle: summaryAr,
          points,
        },
      });

      this.log('REWARD_GRANTED', envelope.id, parent);

      /**
       * PHASE F (`F6-006`, closing `PF-E-006`) — THE HALF OF THIS EVENT THAT
       * HAD NO PRODUCER AT ALL.
       *
       * The parent was told; the CHILD was not. `NotificationRewardConsumer`
       * was the only subscriber to `REWARD_GRANTED` and it targeted `PARENT`,
       * so a child completed a task, earned points, and heard nothing — with
       * their own app, the product's commercial wedge, as the surface that
       * stayed silent. `child_messages` held zero rows after a real grant, and
       * `e2e-06 ACT I` measured exactly that.
       *
       * A SECOND CALL, NOT A FLAG, and the reason is scoring. Each audience is
       * assembled, scored, capped and RECORDED separately: the parent's
       * household load must not be able to suppress the child's own news about
       * their own work, and «why did the child not hear about this?» must have
       * its own row with its own arithmetic. One flag on one call would have
       * produced one score and one explanation for two different people.
       *
       * THE SAME `sourceEventId`, on purpose — see above. The ledger separates
       * the two on `target_audience`; `deliverNow` appends the `:child` facet
       * before writing to `child_messages`. Neither can deduplicate the other.
       *
       * THE ORDER MATTERS AND IS THE PARENT'S. If the child's call throws, the
       * message retries and the parent's notification is already protected by
       * `notifications (family_id, source_event_id, user_id)`; the reverse
       * order would leave a child told about a reward their parent has not been
       * told about, on a surface the parent gates.
       */
      const child = await this.engine.handleEvent({
        familyId: envelope.familyId,
        childId,
        eventType: 'REWARD_GRANTED_CHILD',
        sourceEventId,
        trigger: 'DOMAIN_EVENT',
      });

      this.assertChildAudience(child);
      this.log('REWARD_GRANTED_CHILD', envelope.id, child);

      this.rethrowInfrastructureFailure('REWARD_GRANTED', parent);
      this.rethrowInfrastructureFailure('REWARD_GRANTED_CHILD', child);
    });
  }

  /**
   * PHASE F (`F6-006`) — THE ASSERTION `PE-N-001` EARNED.
   *
   * The child branch of `deliverNow` is reached ONLY when the decision's
   * `targetAudience` is `CHILD`, and that audience is not something this
   * producer states — it is read from `COPY_CATALOGUE[type].audience` by the
   * decision provider, falling back to «is there a child in the context?».
   * So a `REWARD_GRANTED_CHILD` whose catalogue entry were ever edited to
   * `audience: 'PARENT'` would keep working, keep scoring, keep writing decision
   * rows, and write a SECOND PARENT NOTIFICATION while the child went silent
   * again — which is `PF-E-006` restored with a full ledger describing it.
   *
   * `PE-N-001` is the reason this is a hard failure and not a log line. That
   * defect dropped every child notification for months while every component
   * reported success, and the lesson recorded in the Phase E report is that the
   * child path fails QUIETLY by default. So the producer states the audience it
   * is producing FOR, and a mismatch fails the outbox message loudly.
   */
  private assertChildAudience(result: SmartNotificationResult): void {
    if (result.decision.targetAudience !== 'CHILD') {
      throw new Error(
        `PF-E-006 GUARD: ${result.decision.notificationType} resolved to ` +
          `targetAudience=${result.decision.targetAudience}, but this producer exists to reach the CHILD. ` +
          `The audience comes from COPY_CATALOGUE[type].audience — a child-facing type whose catalogue ` +
          `entry says PARENT writes a second parent notification and leaves the child silent again.`,
      );
    }
  }

  private log(eventType: string, envelopeId: string, result: SmartNotificationResult): void {
    this.logger.debug(
      `notification.decision type=${eventType} eventId=${envelopeId} ` +
        `engine=${result.decision.verdict}/${result.decision.reason} score=${result.decision.score} ` +
        `band=${result.decision.band} audience=${result.decision.targetAudience} ` +
        `pipeline=${result.outcome?.decision ?? 'not_called'}${
          result.outcome?.reason ? `/${result.outcome.reason}` : ''
        } ledger=${result.decisionId ? 'written' : 'already_decided'}`,
    );
  }

  /**
   * PHASE F (`F6-003`) — THE ONE PLACE THE ENGINE'S «NEVER THROW» RULE MUST NOT
   * BE THE LAST WORD.
   *
   * `SmartNotificationEngineService` swallows a delivery failure and reports it
   * as `SUPPRESS` / `DELIVERY_ERROR`. That is correct FOR ITS OTHER CALLERS:
   * `RewardsEngineService` and `DigitalWellbeingEngineService` are inside an
   * HTTP request whose subject is a reward or a device report, and failing that
   * request because a notification could not be written would be the tail
   * wagging the dog.
   *
   * IT IS WRONG HERE, and `reward-delivery-recovery.e2e.spec.ts` has measured
   * why since Phase C. This consumer's ENTIRE JOB is the notification. There is
   * no business event to protect — the grant committed in a previous outbox
   * message and the ledger row already exists — and there IS a durable retry:
   * the relay. Returning normally after a failed write tells the relay the
   * message was handled, the message is marked PUBLISHED, and the notification
   * for a reward the child genuinely earned is lost FOREVER. That is
   * `PA-B-009`'s shape one table over, and it is exactly what wiring the engine
   * would have re-introduced if this method did not exist.
   *
   * SO THE DISTINCTION IS DRAWN ON THE REASON, not on the verdict. A
   * `SUPPRESS` from the fatigue guard, a `DEFER` into quiet hours, and an
   * engine-side `SCORE_BELOW_FLOOR` are all DECISIONS: the system was asked and
   * it answered, and retrying them eight times before dead-lettering would turn
   * a correct answer into an incident. `DELIVERY_ERROR` is not an answer, it is
   * the absence of one.
   */
  private rethrowInfrastructureFailure(eventType: string, result: SmartNotificationResult): void {
    if (result.outcome?.decision === 'SUPPRESS' && result.outcome.reason === 'DELIVERY_ERROR') {
      // The ROOT CAUSE, not the category — `outbox_messages.last_error` is what
      // an operator reads off a dead letter, and `DELIVERY_ERROR` alone would
      // tell them nothing they could act on.
      throw new Error(
        `${eventType} notification delivery failed: ${result.outcome.detail ?? 'unknown cause'}`,
      );
    }
  }
}
