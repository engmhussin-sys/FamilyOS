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

import { getBusinessDate, getStartOfBusinessDay } from '../../../../common/time/family-date';
import {
  evaluateFatigue,
  type IFatigueDecision,
} from '../../../life-intelligence/application/services/notification-fatigue-guard';
import {
  SmartNotificationIntegrationService,
  type IDeliverableNotification,
  type INotificationOutcome,
} from '../../../life-intelligence/application/services/smart-notification-integration.service';
import { quietHoursClassOf } from '../../../../shared/notifications/notification-class';
import {
  NOTIFICATION_DECISION_PROVIDER,
  type NotificationDecisionProvider,
} from '../../../notifications/application/ports/notification-decision.provider';
import {
  NOTIFICATION_DECISION_REPOSITORY,
  type INotificationDecisionRepository,
} from '../../../notifications/application/ports/notification-decision.repository.port';
import type { NotificationDecision } from '../../../notifications/domain/engine/notification-decision.types';
import type { NotificationContext } from '../../../notifications/domain/engine/notification-context';
import {
  COOLDOWN_EXEMPT_TYPES,
  toFatiguePolicy,
  type NotificationPolicy,
} from '../../../notifications/domain/engine/notification-policy';
import {
  NOTIFICATION_DEEP_LINK_DATA_KEY,
  resolveNotificationDestination,
} from '../../../notifications/domain/engine/notification-destination';
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
      /**
       * PHASE F (`F6-007`) — WHERE THE TAP LANDS, RESOLVED HERE AND NOWHERE
       * ELSE.
       *
       * `notification-destination.ts` holds the map; this line is the only
       * thing that puts its answer on the wire. It goes on `data` — already
       * persisted to `notifications.data`, already carried verbatim across a
       * quiet-hours deferral, already read by the parent app (`PD-N-004`) — so
       * a destination costs no column, no migration and no backfill.
       *
       * IT IS SPREAD LAST, and that is a security property rather than a style
       * choice: `DigitalWellbeingEngineService` spreads a DEVICE-SUPPLIED
       * `metadata` object into `data`, so a payload carrying its own `deepLink`
       * would otherwise choose the screen. The server's answer overwrites the
       * producer's, always.
       *
       * `composed.resolvedCopyKey` RATHER THAN `copyKey`, so the destination
       * and the sentence can never describe different things: when a template
       * is rejected by the safety gate and `GENERIC` ships instead, the link
       * degrades to the inbox with it, and `notification_decisions.copy_key` —
       * which stores the same resolved key — explains both.
       *
       * NO IDS ARE PASSED, and that is a decision rather than a gap:
       * `e2e-13 STEP 14` reads this exact payload back and asserts it contains
       * no `familyId`, `childId`, `deviceId`, `programId` or `achievementId`
       * («CONTEXT §3 principle 8 … just as much as of the FCM one»), and no
       * producer on this path carries a row id anyway. The resolver therefore
       * emits the LIST form of every surface — `abny://goals`, not
       * `abny://goal/<unknown>`. Its own header carries the full argument.
       */
      data: {
        ...(input.data ?? {}),
        [NOTIFICATION_DEEP_LINK_DATA_KEY]: resolveNotificationDestination({
          copyKey: composed.resolvedCopyKey,
          audience: decision.targetAudience,
        }),
      },
      // The child branch must not rephrase a second time through a weaker
      // filter — see `IDeliverableNotification.preComposed`.
      preComposed: true,
    };

    /**
     * ========================================================================
     * SPRINT F1 — THE HOUSEHOLD'S OWN POLICY, AT THE GATE THAT ENFORCES IT.
     * ========================================================================
     *
     * WHAT WAS MEASURED, against a real PostgreSQL and read back from
     * `notification_decisions`: a `REWARD_GRANTED` delivered at 12:04 and a
     * second one at 12:24 — TWENTY MINUTES apart, inside the configured
     * thirty-minute cooldown — BOTH produced a `notifications` row, and the
     * second row's `outcome` was `SEND` with a NULL `outcome_reason`. The same
     * run showed `notification.cap.maxPerHour` doing nothing at all.
     *
     * THE CAUSE. `SmartNotificationIntegrationService.evaluateAndDeliver` calls
     * `evaluateFatigue(candidate, history, now, localTime, businessDayStart)`
     * with NO sixth argument, so the guard falls back to
     * `DEFAULT_FATIGUE_POLICY`, in which `hourlyMax`, `defaultCooldownMinutes`
     * and `duplicateWindowMs` are all `undefined` — «this rule did not exist
     * for you». `toFatiguePolicy`, the documented bridge that carries a
     * household's `notification_policy_settings` into that argument, had no
     * call site anywhere in `src/`. So every per-family cap an operator or a
     * parent could set was validated, persisted, and inert.
     *
     * WHY THE CALL IS HERE AND NOT THERE. Two reasons, and the second is the
     * stronger one:
     *
     *   1. `evaluateAndDeliver` is `life-intelligence`'s and is reached by
     *      producers that have no policy — `processSignals`, the quiet-hours
     *      release — so the policy has to arrive from a layer that resolved
     *      one. This layer resolved one: `assemble()` returns it.
     *   2. THE HISTORY. `evaluateAndDeliver` counts over
     *      `SmartNotificationIntegrationService.fetchHistory`, which reads
     *      `notifications` — THE PARENT'S INBOX — for a CHILD candidate too.
     *      `NotificationContextAssembler.readHistory` already fixed exactly
     *      that defect for the SCORER by reading `child_messages` for a CHILD
     *      audience, and `context.recentNotifications` is that audience-scoped
     *      stream. Enforcing the caps HERE means the cap and the penalty are
     *      computed over the SAME rows; enforcing them one layer down would
     *      have re-opened the defect `fb988c4` closed, one gate later.
     *
     * IT IS NOT A SECOND GUARD. `evaluateFatigue` is the same pure function,
     * with the same vocabulary; what is new is that it is finally handed the
     * policy the household configured. The pipeline still runs its own
     * (weaker, default-policy) pass afterwards, so nothing this layer allows is
     * thereby forced through.
     *
     * QUIET HOURS ARE DELIBERATELY NOT ACTED ON HERE. `evaluateFatigue` answers
     * `QUIET_HOURS` before it reaches the cooldown, and acting on that answer
     * would turn a DEFER into a SUPPRESS — `PC-D-005` exactly, the defect that
     * silently deleted every earned reward for ten hours a day. The deferral
     * belongs to `handleQuietHours` and stays there; this gate reports only the
     * five refusals that are genuinely terminal.
     */
    const fatigue = this.fatigueRefusal(context, policy, decision, composed);
    if (fatigue) {
      const refused: INotificationOutcome = {
        type: decision.notificationType,
        targetAudience: decision.targetAudience,
        decision: 'SUPPRESS',
        reason: fatigue,
      };
      if (decisionId) {
        await this.recordOutcome(input.familyId, decisionId, refused);
      }
      this.logger.log(
        `notification.fatigue_refused type=${decision.notificationType} audience=${decision.targetAudience} ` +
          `reason=${fatigue} provider=${decision.providerId}`,
      );
      return {
        decision,
        decisionId,
        outcome: refused,
        title: composed.title,
        body: composed.body,
        aiRewritten: composed.aiRewritten,
        aiFailed: composed.aiFailed,
      };
    }

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
   * THE HOUSEHOLD'S CAPS, ASKED OF THE ONE FUNCTION THAT ANSWERS THEM.
   *
   * Returns the guard's own blocked reason when this candidate must not be
   * delivered NOW, or `null` when the pipeline should proceed. The reason
   * strings are `IFatigueDecision.blockedReason`'s, unchanged, so
   * `notification_decisions.outcome_reason` keeps the vocabulary
   * `SQL_DECISION_ANALYTICS` already counts `fatigue_blocked` over — the panel
   * needed no change to start showing a number that was previously always zero
   * for cooldowns.
   *
   * THE DELIVER CLASS IS CHECKED FIRST, mirroring `evaluateAndDeliver`'s own
   * ordering (PHASE E, `PD-N-004`) and for the same reason: a household that has
   * already had six notifications today must still be told that the entire
   * enforcement surface was switched off. A cap is not allowed to silence a
   * safety alert, and the check that guarantees it has to sit BEFORE the guard,
   * not inside it.
   */
  private fatigueRefusal(
    context: NotificationContext,
    policy: NotificationPolicy,
    decision: NotificationDecision,
    composed: { title: string; body: string },
  ): NonNullable<IFatigueDecision['blockedReason']> | null {
    if (quietHoursClassOf(decision.notificationType, decision.priority) === 'DELIVER') {
      return null;
    }

    const verdict = evaluateFatigue(
      {
        type: decision.notificationType,
        priority: decision.priority,
        title: composed.title,
        body: composed.body,
        targetAudience: decision.targetAudience,
      },
      // THE AUDIENCE'S OWN INBOX. `readHistory` chose the table; this passes it
      // through with the three fields the guard reads and nothing else.
      context.recentNotifications.map((n) => ({
        type: n.type,
        priority: n.priority,
        createdAt: n.createdAt,
      })),
      context.now,
      // The SAME local clock reading the scorer's quiet-hours term used, taken
      // off the context rather than recomputed, so the two layers cannot
      // disagree about what time it is for this household.
      context.quietHours.localTimeHHMM,
      getStartOfBusinessDay(context.now, context.timeZone),
      /**
       * ======================================================================
       * THE DUPLICATE WINDOW IS TURNED OFF AT THIS GATE ONLY, DELIBERATELY.
       * ======================================================================
       *
       * `evaluateFatigue`'s duplicate rule is `n.type === candidate.type` inside
       * a sliding window — a TYPE used as a proxy for IDENTITY. `DUPLICATE_PENALTY`
       * already measured what that proxy does the moment the history becomes the
       * audience's own: a child who crossed their hydration goal and their
       * activity goal in one afternoon produced two `DAILY_GOAL_COMPLETED`
       * candidates with two DIFFERENT causes, and the second was declared a
       * duplicate of the first. The scorer's answer was to compare the CAUSAL
       * KEY instead, and its header states the principle in one line: «THIS
       * EXACT THING» IS A CAUSE, NOT A TYPE.
       *
       * This gate exists to enforce the CAPS that were inert — the cooldown and
       * the hourly ceiling — not to move the duplicate rule onto a stream it was
       * never calibrated for. So it hands the guard a ZERO window, and duplicate
       * suppression stays exactly where it already works, unchanged:
       *
       *   - `evaluateAndDeliver`'s own pass, over the PARENT's inbox, with the
       *     five minutes it has always had;
       *   - `notifications (family_id, source_event_id, user_id)` and
       *     `child_messages (family_id, source_event_id)`, which never forget;
       *   - `DUPLICATE_PENALTY`, which compares causes and is the term that
       *     actually knows what «the same thing» means.
       *
       * ZERO RATHER THAN OMITTING THE FIELD: an ABSENT `duplicateWindowMs` means
       * five minutes — the guard's documented pre-F6 default — which is the
       * opposite of what this line intends.
       */
      {
        ...toFatiguePolicy(policy),
        duplicateWindowMs: 0,
        // `COOLDOWN_EXEMPT_TYPES` carries the full argument: `DAILY_GOAL_COMPLETED`
        // is the one type whose two occurrences are two different facts, and it
        // is applied HERE rather than in the bridge so that
        // `toFatiguePolicy(DEFAULT_NOTIFICATION_POLICY)` keeps reproducing
        // Sprint 16's numbers exactly for every other caller.
        cooldownMinutesByType: { ...policy.cooldownMinutesByType, ...COOLDOWN_EXEMPT_TYPES },
      },
    );

    if (verdict.allowed) return null;
    // See the call site: `QUIET_HOURS` is the pipeline's to act on, and turning
    // it into a suppression here would delete a fact that survives the night.
    if (verdict.blockedReason === undefined || verdict.blockedReason === 'QUIET_HOURS') {
      return null;
    }
    return verdict.blockedReason;
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
    composed: {
      resolvedCopyKey: string;
      aiRewritten: boolean;
      aiFailed: boolean;
      aiAllowed: boolean;
      aiInvoked: boolean;
      safetyRejection: string | null;
    },
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
        /**
         * SPRINT F1 — THE THREE VALUES THE COMPOSER ALREADY COMPUTED AND THIS
         * METHOD USED TO DROP ON THE FLOOR. Nothing new is derived here: they
         * are carried from `ComposedNotification` verbatim, which is the only
         * place that knows whether the flag was on, whether the model was
         * entered, and what the safety gate said.
         */
        aiAllowed: composed.aiAllowed,
        aiInvoked: composed.aiInvoked,
        aiSafetyRejection: composed.safetyRejection,
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
