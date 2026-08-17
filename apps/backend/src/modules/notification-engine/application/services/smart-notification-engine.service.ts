/**
 * PHASE F (`F6-002`) — THE DECISION LAYER, AND IT IS A LAYER, NOT AN ENGINE.
 *
 * THE ONE THING TO UNDERSTAND ABOUT THIS FILE: it does not deliver anything.
 * There is exactly one place in this codebase where a notification becomes a
 * row — `SmartNotificationIntegrationService.deliverNow`, reached through
 * `notifyEvent` — and this service calls it. It does not write to
 * `notifications`, it does not write to `child_messages`, it does not enqueue a
 * deferral and it does not send a push. Every guarantee those paths already hold
 * (owner resolution, the child-message approval gate, B9's two unique indexes,
 * the family-local deferral instant, the DEAD state) is held by them, unchanged,
 * after this phase.
 *
 * WHAT IT ADDS is the four things that were missing between an event and that
 * pipeline:
 *
 *   1. A CONTEXT. One assembled input instead of four call sites each knowing a
 *      different subset.
 *   2. A NAMED, SWAPPABLE DECISION. `NotificationDecisionProvider`, behind a
 *      token, with the deterministic implementation as the only one today.
 *   3. AN EXPLANATION THAT SURVIVES. A row in `notification_decisions` with the
 *      trigger, the score, the band, the reason and the arithmetic — written
 *      BEFORE delivery is attempted, so a crash mid-delivery still leaves the
 *      decision recorded.
 *   4. TONE AND COPY. Age-banded, localised, contextual, and safety-validated,
 *      instead of six hardcoded strings in three files.
 *
 * THE ORDER, and it is the brief's:
 *
 *     Event -> Engine -> (optional AI rephrase) -> Safety -> Policy -> Dedup -> Delivery
 *              ^^^^^^     ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^   ^^^^^^^^^^^^^^^^^^^^^^^^^
 *              provider   NotificationComposerService        SmartNotificationIntegrationService
 *
 * WHY A `DEFER` DECISION STILL CALLS `notifyEvent`. Because the DEFERRAL is not
 * this layer's to perform. The engine's verdict is an OPINION, persisted so that
 * a disagreement with the outcome is legible; the pipeline then makes the
 * decision that has consequences, using the same quiet-hours matrix it always
 * has. A `DEFER` that short-circuited here would be a second deferral
 * implementation, which is the thing the brief forbids and which
 * `PC-D-005` already proved expensive.
 *
 * WHY A `SUPPRESS` DECISION DOES NOT. Because there is nothing to hand on: the
 * engine has concluded this notification should not exist, and the row that says
 * so — with its score and its reason — is the deliverable. This is the only
 * place this layer terminates a candidate, and it is recorded every time.
 *
 * IT NEVER THROWS. `SmartNotificationIntegrationService`'s standing discipline,
 * inherited deliberately: a notification problem must never fail the reward
 * grant or the habit completion that triggered it.
 */

import { Inject, Injectable, Logger } from '@nestjs/common';

import { getBusinessDate } from '../../../../common/time/family-date';
import {
  SmartNotificationIntegrationService,
  type IDeliverableNotification,
  type INotificationOutcome,
} from '../../../life-intelligence/application/services/smart-notification-integration.service';
import {
  NOTIFICATION_DECISION_PROVIDER,
  type NotificationDecisionProvider,
} from '../../../notifications/application/ports/notification-decision.provider';
import {
  NOTIFICATION_DECISION_REPOSITORY,
  type INotificationDecisionRepository,
} from '../../../notifications/application/ports/notification-decision.repository.port';
import type { NotificationDecision } from '../../../notifications/domain/engine/notification-decision.types';
import {
  NotificationContextAssembler,
  type NotificationEventInput,
} from './notification-context.assembler';
import { NotificationComposerService } from './notification-composer.service';

/**
 * What the caller gets back. It carries BOTH verdicts on purpose — the engine's
 * and the pipeline's — because a producer's log line that reports only one of
 * them cannot distinguish «we decided not to» from «we tried and the cap
 * refused», and those are different incidents.
 */
export interface SmartNotificationResult {
  readonly decision: NotificationDecision;
  /** `null` when the ledger refused the row because this cause was already
   * decided — a redelivery, correctly ignored. */
  readonly decisionId: string | null;
  /** `null` when the engine suppressed and the pipeline was never called. */
  readonly outcome: INotificationOutcome | null;
  readonly title: string;
  readonly body: string;
  readonly aiRewritten: boolean;
  readonly aiFailed: boolean;
}

@Injectable()
export class SmartNotificationEngineService {
  private readonly logger = new Logger(SmartNotificationEngineService.name);

  constructor(
    private readonly assembler: NotificationContextAssembler,
    @Inject(NOTIFICATION_DECISION_PROVIDER)
    private readonly provider: NotificationDecisionProvider,
    private readonly composer: NotificationComposerService,
    @Inject(NOTIFICATION_DECISION_REPOSITORY)
    private readonly ledger: INotificationDecisionRepository,
    /** THE EXISTING PIPELINE. Injected, not reimplemented. */
    private readonly pipeline: SmartNotificationIntegrationService,
  ) {}

  async handleEvent(input: NotificationEventInput): Promise<SmartNotificationResult> {
    const { context, policy } = await this.assembler.assemble(input);

    // ---- ENGINE ------------------------------------------------------------
    const { decision, copyKey, copyVariables } = await this.provider.decide(context, policy);

    // ---- (optional AI) -> SAFETY ------------------------------------------
    // Composition happens even for a SUPPRESS verdict, and that is deliberate:
    // the `copy_key` column is how a dashboard finds a producer that shipped a
    // type nobody wrote copy for, and a type that is always suppressed is
    // exactly the one nobody would notice otherwise. It costs one pure render.
    const composed = await this.composer.compose({
      context,
      copyKey,
      variables: copyVariables,
      audience: decision.targetAudience,
    });

    const businessDate = getBusinessDate(context.now, context.timeZone);
    const decisionId = await this.recordDecision(input, context, decision, composed, businessDate);

    if (decision.verdict === 'SUPPRESS') {
      this.logger.log(
        `notification.engine_suppressed type=${decision.notificationType} audience=${decision.targetAudience} ` +
          `score=${decision.score} reason=${decision.reason} provider=${decision.providerId}`,
      );
      return {
        decision,
        decisionId,
        outcome: null,
        title: composed.title,
        body: composed.body,
        aiRewritten: composed.aiRewritten,
        aiFailed: composed.aiFailed,
      };
    }

    // ---- POLICY -> DEDUP -> DELIVERY --------------------------------------
    // One call, to the pipeline that already owns all three. `sourceEventId` is
    // the PRODUCER'S key, passed through untouched — the engine never composes
    // one, because «what makes this notification the same notification» is a
    // decision `notification-source-key.ts` requires the call site to have made.
    const deliverable: IDeliverableNotification = {
      type: decision.notificationType,
      priority: decision.priority,
      title: composed.title,
      body: composed.body,
      targetAudience: decision.targetAudience,
      sourceEventId: input.sourceEventId,
      data: input.data,
      // The child branch must not rephrase a second time through a weaker
      // filter — see `IDeliverableNotification.preComposed`.
      preComposed: true,
    };

    let outcome: INotificationOutcome;
    try {
      outcome = await this.pipeline.notifyEvent(
        input.childId ?? '',
        input.familyId,
        deliverable,
        context.now,
      );
    } catch (err) {
      // `notifyEvent` is documented never to throw for a delivery failure. This
      // catch is for the paths that are not delivery — a lost connection during
      // the history read — and it exists so that a notification problem still
      // cannot fail the business event, which is this pipeline's standing rule.
      //
      // PHASE F (`F6-003`) — the message is CARRIED, not only logged. A caller
      // whose entire job is the notification (`NotificationRewardConsumer`)
      // rethrows on `DELIVERY_ERROR` so the outbox retries, and the operator
      // reading `outbox_messages.last_error` needs the cause rather than the
      // category. See `INotificationOutcome.detail`.
      const detail = err instanceof Error ? err.message : String(err);
      this.logger.error(`notification.pipeline_failed type=${decision.notificationType} ${detail}`);
      outcome = {
        type: decision.notificationType,
        targetAudience: decision.targetAudience,
        decision: 'SUPPRESS',
        reason: 'DELIVERY_ERROR',
        detail,
      };
    }

    if (decisionId) {
      await this.recordOutcome(input.familyId, decisionId, outcome);
    }

    this.logger.log(
      `notification.decision type=${decision.notificationType} audience=${decision.targetAudience} ` +
        `band=${decision.band} score=${decision.score} engine=${decision.verdict} ` +
        `pipeline=${outcome.decision}${outcome.reason ? `/${outcome.reason}` : ''} ` +
        `provider=${decision.providerId} ai=${composed.aiRewritten ? 'rewritten' : composed.aiFailed ? 'failed' : 'off'}`,
    );

    return {
      decision,
      decisionId,
      outcome,
      title: composed.title,
      body: composed.body,
      aiRewritten: composed.aiRewritten,
      aiFailed: composed.aiFailed,
    };
  }

  /**
   * WRITTEN BEFORE DELIVERY IS ATTEMPTED, and that ordering is the point: a
   * process that dies between the decision and the delivery leaves the reasoning
   * recorded, which is the case a support engineer most needs and the case a
   * write-after-success would lose.
   *
   * It never throws. A ledger that cannot be written is a diagnostics problem;
   * failing the notification because of it would make an observability feature
   * into an availability risk.
   */
  private async recordDecision(
    input: NotificationEventInput,
    context: { locale: string; countryCode: string | null; toneBand: string },
    decision: NotificationDecision,
    composed: { resolvedCopyKey: string; aiRewritten: boolean; aiFailed: boolean },
    businessDate: string,
  ): Promise<string | null> {
    try {
      return await this.ledger.record({
        familyId: input.familyId,
        childId: input.childId,
        sourceEventId: input.sourceEventId,
        decision,
        eventType: input.eventType,
        ageBand: context.toneBand,
        locale: context.locale,
        countryCode: context.countryCode,
        aiRewritten: composed.aiRewritten,
        aiFailed: composed.aiFailed,
        copyKey: composed.resolvedCopyKey,
        businessDate,
      });
    } catch (err) {
      this.logger.error(
        `notification.decision_ledger_write_failed type=${decision.notificationType} ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return null;
    }
  }

  private async recordOutcome(
    familyId: string,
    decisionId: string,
    outcome: INotificationOutcome,
  ): Promise<void> {
    try {
      await this.ledger.recordOutcome(familyId, decisionId, outcome.decision, outcome.reason ?? null);
    } catch (err) {
      this.logger.error(
        `notification.decision_outcome_write_failed id=${decisionId.slice(0, 8)} ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}
