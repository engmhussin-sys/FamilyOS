import { Inject, Injectable, Logger } from '@nestjs/common';

import { RUNTIME_ALERT_REPOSITORY, type IRuntimeAlertRepository } from '../../../pairing/application/ports/runtime-alert.repository.port';
import { NOTIFICATION_REPOSITORY, type INotificationRepository } from '../../../notifications/application/ports/notification.repository.port';
import {
  NOTIFICATION_DELIVERY_REPOSITORY,
  type INotificationDeliveryRepository,
} from '../../../notifications/application/ports/notification-delivery.repository.port';
import {
  NOTIFICATION_POLICY_REPOSITORY,
  type INotificationPolicyRepository,
} from '../../../notifications/application/ports/notification-decision.repository.port';
import { childSafeNotificationPayload } from '../../../notifications/domain/engine/notification-destination';
import { PrismaCommunicationRepository } from '../../infrastructure/repositories/prisma-communication.repository';
import { FamilyCommunicationService } from './family-communication.service';
import { evaluateSmartNotificationCandidates, type ISmartNotificationSignals } from './smart-notification-decision-engine';
import {
  DEFAULT_FATIGUE_POLICY,
  evaluateFatigue,
  type ICandidateNotification,
  type IFatiguePolicy,
  type IRecentNotification,
} from './notification-fatigue-guard';
import { resolveNotificationPolicy } from '../../../notifications/domain/engine/notification-policy';
import { FamilyDateService } from '../../../../common/time/family-date.service';
import {
  getBusinessDate,
  getBusinessTimeHHMM,
  getStartOfBusinessDay,
  nextLocalTimeAfter,
} from '../../../../common/time/family-date';
import {
  forAudience,
  forChildAudience,
  forRecurringSignal,
} from '../../../../shared/notifications/notification-source-key';
import {
  notificationCategoryOf,
  quietHoursClassOf,
} from '../../../../shared/notifications/notification-class';

export interface INotificationOutcome {
  type: string;
  targetAudience: 'PARENT' | 'CHILD';
  decision: 'SEND' | 'DEFER' | 'SUPPRESS';
  reason?: string;
  /**
   * PHASE F (`F6-003`) — THE ROOT-CAUSE STRING, and it exists for exactly one
   * caller.
   *
   * `reason` is a CLOSED vocabulary a dashboard can count (`DELIVERY_ERROR`,
   * `DAILY_MAX`, `QUIET_HOURS`). `detail` is the underlying message, present
   * ONLY on the two failure branches, and it is here because
   * `NotificationRewardConsumer` turns a `DELIVERY_ERROR` into a thrown error
   * so the relay retries — and `outbox_messages.last_error` has to say
   * «notification store unavailable», not «something went wrong». An operator
   * reading a dead letter needs the cause, not the category.
   *
   * Optional and never set on a success path, so nothing that existed before
   * this phase reads or writes it.
   */
  detail?: string;
}

/**
 * B9 (PA-B-007 / PA-B-008) — a candidate PLUS the one thing that makes it
 * identifiable.
 *
 * `ICandidateNotification` is left exactly as Sprint 16 wrote it: it is the
 * input to a PURE function (`evaluateFatigue`) that has no business knowing
 * about database keys, and its unit tests construct it directly. The causal
 * key belongs to DELIVERY, not to the fatigue decision, so it is added here —
 * at the layer that actually writes a row — and it is REQUIRED, so a producer
 * cannot reach `deliver()` without having composed one.
 */
export interface IDeliverableNotification extends ICandidateNotification {
  /** Composed with one of the three documented forms in
   * `src/shared/notifications/notification-source-key.ts`. */
  readonly sourceEventId: string;
  /**
   * PHASE E (`PD-N-004`) — the producer's own payload, written verbatim into
   * `notifications.data` and held verbatim in `notification_deliveries.data`
   * across a deferral.
   *
   * It exists because `DigitalWellbeingEngineService` was routed through this
   * gate and its alerts carry device specifics the parent app reads (which
   * package, which limit, how far over). Optional, so every producer written
   * before today is unchanged.
   */
  readonly data?: Record<string, unknown>;
  /**
   * PHASE F (`F6-005`) — set by `SmartNotificationEngineService` and by nothing
   * else. It means «title and body were already composed from the localisation
   * catalogue, already offered to the AI once, and already validated against
   * THIS CHILD'S OWN age band by `ChildSafetyFilterService`».
   *
   * It exists because the CHILD branch of `deliverNow` routes through
   * `FamilyCommunicationService.draftAiMessageIfAbsent`, which rephrases again
   * and re-validates with the PARENT-facing `SafetyEngineService` — a filter
   * that knows nothing about age or shaming. Measured, not inferred: an AI
   * returning «أنت كسول …» was refused at the engine's gate and then written
   * into `child_messages` verbatim by that second rephrase.
   *
   * Optional and default-absent, so every producer written before F6 keeps the
   * old two-rephrase behaviour unchanged.
   */
  readonly preComposed?: boolean;
}

const HISTORY_WINDOW_HOURS = 24;
const KNOWN_PRIORITIES = new Set(['CRITICAL', 'HIGH', 'NORMAL', 'LOW']);

/**
 * Sprint 16.1 Phase 3 (Smart Notification Integration) — CLOSES A
 * REAL GAP: SmartNotificationDecisionEngine and NotificationFatigueGuard
 * existed only as pure functions with zero real caller. This is the
 * missing wiring: the ONLY real entry point from a signal/event to an
 * actual delivered notification.
 *
 * Sprint 16.2 Phases 1-2 — CLOSES TWO MORE REAL GAPS: refactored to
 * expose deliverCandidate() as a public, reusable single-candidate
 * pipeline (extracted from processSignals's own per-candidate loop
 * body, not duplicated) — this is what lets Habit Completion and
 * Reward Grant events reuse the EXACT SAME fatigue-guarded delivery
 * pipeline as the periodic signal-based flow, instead of each
 * needing its own bespoke notification logic. Zero new Notification
 * Engine built — the brief's own explicit "no duplicate engines"
 * instruction, honored by this single shared code path.
 *
 * Deliberately reuses existing infrastructure:
 * - IRuntimeAlertRepository.createForFamilyOwner for PARENT-targeted
 *   candidates — Owner Resolution, real Deduplication, real Push.
 * - FamilyCommunicationService.draftAiMessage for CHILD-targeted
 *   candidates — enforces MessageApprovalStatus (Architecture 1.0
 *   §5.8). This layer NEVER bypasses that gate.
 */
@Injectable()
export class SmartNotificationIntegrationService {
  private readonly logger = new Logger(SmartNotificationIntegrationService.name);

  constructor(
    @Inject(NOTIFICATION_REPOSITORY) private readonly notificationRepository: INotificationRepository,
    @Inject(NOTIFICATION_DELIVERY_REPOSITORY)
    private readonly deferralRepository: INotificationDeliveryRepository,
    @Inject(RUNTIME_ALERT_REPOSITORY) private readonly runtimeAlertRepository: IRuntimeAlertRepository,
    @Inject(NOTIFICATION_POLICY_REPOSITORY)
    private readonly policySettings: INotificationPolicyRepository,
    private readonly familyCommunication: FamilyCommunicationService,
    /** THE CHILD'S OWN INBOX, for the CHILD branch of `fetchHistory` and for
     * nothing else. This service still writes child messages through
     * `FamilyCommunicationService` — the approval gate — and never through this
     * repository; what it needs here is a READ the gate does not expose. */
    private readonly childMessages: PrismaCommunicationRepository,
    private readonly familyDate: FamilyDateService,
  ) {}

  /** The signal-batch entry point (Sprint 16.1 Phase 3, unchanged
   * behavior — 8/8 existing tests still pass against this method
   * after the refactor below). */
  async processSignals(childId: string, familyId: string, signals: ISmartNotificationSignals): Promise<INotificationOutcome[]> {
    const candidates = evaluateSmartNotificationCandidates(signals);
    if (candidates.length === 0) return [];

    // B9 — ONE `now` for the whole batch, so two candidates evaluated in the
    // same call cannot land in two different dedupe buckets because a
    // millisecond passed between them. PHASE D — and the history window is
    // anchored to it too, so «the last 24 hours» means the last 24 hours
    // before the instant being evaluated.
    const now = new Date();

    /**
     * ONE HISTORY PER AUDIENCE, read at most once each and read LAZILY.
     *
     * A batch is not single-audience: `evaluateSmartNotificationCandidates` can
     * produce a child's hydration reminder and a parent's alert in the same
     * call, and after this fix they are counted against two different inboxes.
     * Lazy because a batch that turns out to be all-CHILD must not pay for a
     * read of the parent's `notifications`, and vice versa — the old code paid
     * for exactly one read, and this must not become two.
     */
    const historyByAudience = new Map<'PARENT' | 'CHILD', IRecentNotification[]>();
    const historyFor = async (audience: 'PARENT' | 'CHILD'): Promise<IRecentNotification[]> => {
      const cached = historyByAudience.get(audience);
      if (cached) return cached;
      const fetched = await this.fetchHistory(childId, now, audience);
      historyByAudience.set(audience, fetched);
      return fetched;
    };

    const outcomes: INotificationOutcome[] = [];

    for (const candidate of candidates) {
      // B9 — THE PERIODIC CLASS, composed here rather than by the caller
      // because the caller supplies SIGNALS, not notifications: it does not
      // know which candidates the decision engine will produce and cannot
      // name them. A hydration reminder has no domain event and no entity —
      // it is a recurring observation that SHOULD notify again later — so it
      // takes the bucketed form, with the bucket width equal to the fatigue
      // guard's own sliding DUPLICATE window. The guard stays the product
      // behaviour; the constraint is the floor under it.
      const deliverable: IDeliverableNotification = {
        ...candidate,
        sourceEventId: forRecurringSignal('signal', childId, candidate.type, now),
      };
      const history = await historyFor(candidate.targetAudience);
      const outcome = await this.evaluateAndDeliver(childId, familyId, deliverable, history, now);
      outcomes.push(outcome);
      // Feeds back into the SAME history array used by subsequent
      // candidates in this same batch — two candidates matching in
      // one call must each be correctly counted against
      // dailyMax/categoryMax for the other. AUDIENCE-SCOPED NOW: a child
      // message sent in this batch counts against the child's next candidate
      // and not against the parent's, which is the whole point of the fix.
      if (outcome.decision === 'SEND') {
        history.unshift({
          type: candidate.type,
          priority: candidate.priority,
          // `now`, not `new Date()`: the row this stands in for was written at
          // the instant being evaluated, and a stamp from the wall clock is a
          // stamp from a different day for every caller that is not live.
          createdAt: now,
          // THE KEY AS IT WILL BE PERSISTED, so the next candidate in this same
          // batch compares causes rather than types — the same question the
          // rows themselves answer.
          sourceEventId: forAudience(deliverable.sourceEventId, candidate.targetAudience),
        });
      }
    }

    return outcomes;
  }

  /** Sprint 16.2 Phases 1-2 — CLOSES A REAL GAP: the single-candidate
   * public entry point for EVENT-DRIVEN callers (a habit streak
   * milestone, a reward grant) — as opposed to processSignals' own
   * periodic/context-scan entry point. Fetches its own fresh history
   * (real DB read, so a caller doesn't need to manage that itself)
   * and runs the EXACT SAME fatigue-guarded delivery pipeline. Never
   * throws for a delivery failure — logged, not propagated, so a
   * notification issue never blocks the real business event (a habit
   * completion, a reward grant) that triggered it. */
  async notifyEvent(
    childId: string,
    familyId: string,
    candidate: IDeliverableNotification,
    /**
     * PHASE D — `now` IS A PARAMETER, exactly as it already is for
     * `evaluateFatigue`, `closableBusinessDate` and every other decision in
     * this codebase that has a right answer. Deferral turned this method into
     * one of those: it now computes a persisted instant from the family's
     * calendar, and a function that reads the clock inside itself cannot be
     * proven correct across a midnight or a DST boundary without faking the
     * system clock — which, for a path that also does real database I/O, means
     * faking the timers the database driver needs. Defaulted, so no existing
     * caller changes.
     */
    now: Date = new Date(),
  ): Promise<INotificationOutcome> {
    // THE CANDIDATE'S OWN AUDIENCE, not the child it is about. See
    // `fetchHistory`.
    const history = await this.fetchHistory(childId, now, candidate.targetAudience);
    return this.evaluateAndDeliver(childId, familyId, candidate, history, now);
  }

  /**
   * THE HOUSEHOLD'S OWN CEILINGS, AND NOTHING ELSE OF ITS POLICY.
   *
   * WHY THIS EXISTS AT ALL. This gate called `evaluateFatigue` with no policy
   * argument, so it always used `DEFAULT_FATIGUE_POLICY` — `dailyMax = 6`,
   * `categoryDailyMax = 2`, no hourly ceiling. That was invisible while the
   * CHILD's history was the parent's inbox, because the array it counted was
   * empty for every child-audience candidate and no cap could bite. Making the
   * history audience-correct turns those two constants into REAL ceilings, and
   * a hard-coded 2 that overrides a household which explicitly configured 10 is
   * the same defect `7abe440` fixed at the engine's gate, pointed at a
   * different set of rows: a per-family setting that is validated, persisted,
   * and inert.
   *
   * ONLY WHAT THE HOUSEHOLD ACTUALLY SET, and that is the whole design of this
   * method. A key that is absent from `notification_policy_settings` leaves the
   * Sprint 16 default exactly where it was, so a household that has configured
   * nothing — which is nearly all of them — sees no change whatsoever. An
   * hourly ceiling in particular is NOT introduced by default: `hourlyMax`
   * stays `undefined` («this rule did not exist for you») unless a household
   * asked for one.
   *
   * AND DELIBERATELY NOT THE COOLDOWN, THE DUPLICATE WINDOW OR THE QUIET-HOURS
   * WINDOW. `SmartNotificationEngineService` already enforces the configured
   * cooldown at ITS gate, over the same audience-scoped rows, together with
   * `COOLDOWN_EXEMPT_TYPES` — the table that says `DAILY_GOAL_COMPLETED`'s two
   * occurrences are two different facts. That table lives in
   * `modules/notification-engine`, which this module may not import (it imports
   * this one), so bringing the cooldown down here would mean a SECOND copy of
   * an exemption list, and a second copy of an exemption list is how one of
   * them goes stale. The ceilings need no exemption table; they are counts.
   */
  private async ceilingsFor(familyId: string): Promise<IFatiguePolicy> {
    let settings: Record<string, string> = {};
    try {
      settings = await this.policySettings.readSettings(familyId);
    } catch (err) {
      // A settings read that fails must never fail the notification. The
      // documented defaults are the conservative answer and the same one this
      // gate has always used.
      this.logger.warn(
        `notification.policy_read_failed family=${familyId.slice(0, 8)} — using the default ceilings. ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return DEFAULT_FATIGUE_POLICY;
    }

    const configured = resolveNotificationPolicy(settings);
    return {
      ...DEFAULT_FATIGUE_POLICY,
      dailyMax:
        'notification.cap.maxPerDay' in settings
          ? configured.maxPerDay
          : DEFAULT_FATIGUE_POLICY.dailyMax,
      categoryDailyMax:
        'notification.cap.categoryMaxPerDay' in settings
          ? configured.categoryMaxPerDay
          : DEFAULT_FATIGUE_POLICY.categoryDailyMax,
      hourlyMax:
        'notification.cap.maxPerHour' in settings ? configured.maxPerHour : undefined,
    };
  }

  /**
   * THE RECIPIENT'S OWN RECENT NOTIFICATIONS — and «the recipient» is the
   * AUDIENCE the candidate is addressed to, not the child it is about.
   *
   * WHAT WAS WRONG. This method read `notifications` — the PARENT's inbox —
   * for every candidate, then handed the result to `evaluateFatigue`, whose
   * `dailyMax`, `categoryDailyMax`, `hourlyMax`, `DUPLICATE` and per-type
   * COOLDOWN all count over it. So a message addressed to a CHILD was capped
   * and cooled down against THE PARENT'S DAY. `notification-class.ts` forbids
   * that in so many words on `REWARD_GRANTED_CHILD`'s own `why`: «a parent at
   * their daily maximum must not be able to silence the child's own news about
   * their own work». The damage runs in both directions and both are real:
   *
   *   THE CHILD IS SILENCED BY THE PARENT. Six parent notifications today and
   *   the child's `DAILY_MAX` is exhausted before the child has been told
   *   anything. Two parent `REWARD_GRANTED` rows and the child's
   *   `CATEGORY_MAX` for its own reward is gone.
   *
   *   AND THE CHILD'S OWN CAP DID NOT APPLY AT ALL. A child's notifications
   *   live in `child_messages` and are not in `notifications` in any form, so
   *   nothing the child had already received was ever counted. The cap meant to
   *   protect the child was measuring somebody else entirely.
   *
   * THE FIX IS THE ONE THAT LANDED ONE LAYER UP, in
   * `NotificationContextAssembler.readHistory` (`fb988c4`): read the AUDIENCE's
   * own inbox — `notifications` for PARENT, unchanged, and `child_messages`
   * restricted to `source_event_id IS NOT NULL` for CHILD.
   *
   * AND THE TWO LAYERS NOW SHARE ONE IMPLEMENTATION.
   * `readChildInboxHistory` in `shared/notifications/child-inbox-history.ts` is
   * the single definition of «the child's own notification history»; the
   * assembler calls it and so, through
   * `PrismaCommunicationRepository.findRecentNotificationsForChild`, does this.
   * Its `until` is REQUIRED, so the upper bound at `now` — the one this branch
   * used to apply in memory — is now a `created_at <= $until` in PostgreSQL
   * that no caller can forget.
   *
   * NO CAP CONSTANT MOVED, deliberately, and for the reason `fb988c4` gave:
   * `dailyMax = 6` and `categoryDailyMax = 2` are Sprint 16's numbers, chosen
   * while this array was the PARENT branch. The parent branch is unchanged, so
   * they still mean what they were calibrated to mean; the child now has its
   * own count of them, which is the first time the child has had one at all.
   *
   * PHASE D (`PD-N-003`): the window is anchored to the `now` being evaluated,
   * not to the wall clock. The two agree in production and disagree in every
   * test and every replayed instant, which is precisely where a cap silently
   * stops applying.
   */
  private async fetchHistory(
    childId: string,
    now: Date,
    audience: 'PARENT' | 'CHILD',
  ): Promise<IRecentNotification[]> {
    const since = new Date(now.getTime() - HISTORY_WINDOW_HOURS * 60 * 60 * 1000);

    if (audience === 'CHILD') {
      // BOTH BOUNDS ARE THE QUERY'S. `until: now` is required by the shared
      // module, so the «history is what already happened» rule is enforced in
      // SQL rather than by a `.filter` this method used to carry.
      const rows = await this.childMessages.findRecentNotificationsForChild(childId, since, now);
      return rows.map((m) => ({
        type: m.type,
        // `child_messages` HAS NO PRIORITY COLUMN, stated rather than guessed:
        // a child's message surface has never had a loudness axis. Nothing
        // `evaluateFatigue` does reads `priority` off a HISTORY row — it counts
        // them, buckets them by type and measures their age — so this is an
        // honest filler for a required field and not a value any decision turns
        // on. The assembler's own child branch says the same thing.
        priority: 'NORMAL' as const,
        createdAt: m.createdAt,
        sourceEventId: m.sourceEventId,
      }));
    }

    const rawHistory = await this.notificationRepository.findRecentForChild(childId, since);
    // Safe narrowing: every writer of Notification.priority uses this
    // exact union (schema's own open-string design means TypeScript
    // can't narrow it automatically) — an unexpected stored value
    // defensively falls back to NORMAL rather than crashing.
    return rawHistory
      .filter((n) => n.createdAt.getTime() <= now.getTime())
      .map((n) => ({
        type: n.type,
        priority: (KNOWN_PRIORITIES.has(n.priority) ? n.priority : 'NORMAL') as 'CRITICAL' | 'HIGH' | 'NORMAL' | 'LOW',
        createdAt: n.createdAt,
        sourceEventId: n.sourceEventId ?? null,
      }));
  }

  /** Extracted from Sprint 16.1 Phase 3's own processSignals loop
   * body — shared by both the batch (processSignals) and single-event
   * (notifyEvent) entry points, so there is exactly ONE place the
   * fatigue-guard decision and delivery routing logic lives. */
  private async evaluateAndDeliver(
    childId: string,
    familyId: string,
    candidate: IDeliverableNotification,
    history: IRecentNotification[],
    now: Date,
  ): Promise<INotificationOutcome> {
    // B2 (PA-B-002), THE SERVER-LOCAL CLASS. This line was
    // `now.getHours()` — the CONTAINER's wall clock, not UTC and not the
    // family's. The default quiet-hours policy is 21:00-07:00; evaluated
    // against UTC for a Cairo family in summer that is 00:00-10:00 LOCAL, so
    // notifications were muted through the whole morning and allowed through
    // the three hours before local bedtime. The feature was not merely
    // imprecise, it was inverted exactly where it matters.
    const timeZone = await this.familyDate.timeZoneOf(familyId);
    const currentLocalTime = getBusinessTimeHHMM(now, timeZone);
    const businessDayStart = getStartOfBusinessDay(now, timeZone);

    // PHASE E (`PD-N-004`) — THE DELIVER CLASS IS CHECKED BEFORE THE GUARD, NOT
    // INSIDE IT.
    //
    // Phase D put the matrix behind `evaluateFatigue`: a candidate had to be
    // BLOCKED for `QUIET_HOURS` before `handleQuietHours` ever asked what class
    // it was. That ordering has two consequences, and the second is a defect.
    //
    // First, `evaluateFatigue` decides the quiet-hours question on
    // `priority !== 'CRITICAL'` — the old implicit rule the matrix was written
    // to replace — so a DELIVER-class type at NORMAL priority reached the gate
    // only by accident of that comparison.
    //
    // Second and worse: a DELIVER-class safety alert blocked for DAILY_MAX,
    // CATEGORY_MAX or COOLDOWN returned SUPPRESS and never reached
    // `handleQuietHours` at all. A household that had already had twelve
    // notifications today would have had `ACCESSIBILITY_DISABLED` — the alert
    // that says the entire enforcement surface is off — silenced by a fatigue
    // cap. The matrix says in words that DELIVER «bypasses quiet hours
    // entirely, SAFETY-CRITICAL ONLY»; this is that sentence expressed as
    // control flow instead of trusted to a downstream branch.
    //
    // The list is three types long and `notification-class.spec.ts` fails if it
    // grows without a written justification, which is what keeps this from
    // being a hole. Duplicate suppression is NOT lost with it: the unique index
    // `notifications (family_id, source_event_id, user_id)` still collapses a
    // redelivered cause to one row, and it is stricter than the five-minute
    // window because it never forgets.
    if (quietHoursClassOf(candidate.type, candidate.priority) === 'DELIVER') {
      this.logger.log(
        `notification.safety_bypass type=${candidate.type} audience=${candidate.targetAudience}`,
      );
      return this.deliverEvaluated(childId, familyId, candidate);
    }

    const decision = evaluateFatigue(
      candidate,
      history,
      now,
      currentLocalTime,
      businessDayStart,
      await this.ceilingsFor(familyId),
    );

    if (!decision.allowed) {
      // PHASE D (`PC-D-005`) — THE LINE THAT USED TO LOSE THE NOTIFICATION.
      //
      // This branch read `decision: isDeferrable ? 'DEFER' : 'SUPPRESS'` and
      // then returned. `DEFER` wrote no row, enqueued nothing and scheduled
      // nothing — it was a WORD. With the default 21:00-07:00 policy that word
      // covered 41.6% of every day, and a reward the child genuinely earned
      // inside that window was announced to nobody, ever.
      //
      // Everything except QUIET_HOURS is still a real suppression and still
      // terminal: a cooldown, a duplicate or a cap means «this specific
      // occurrence should not be sent at all», and holding it until morning
      // would defeat the cap it was refused by.
      if (decision.blockedReason !== 'QUIET_HOURS') {
        return {
          type: candidate.type,
          targetAudience: candidate.targetAudience,
          decision: 'SUPPRESS',
          reason: decision.blockedReason,
        };
      }
      return this.handleQuietHours(childId, familyId, candidate, timeZone, now);
    }

    // B9 — «the constraint refused it» is a real, reportable outcome, and it is
    // a SUPPRESS rather than a SEND. Reporting SEND for a row the database
    // rejected would put a lie in the log line `NotificationRewardConsumer`
    // writes, and that log line is how the redelivery behaviour is observed in
    // production. A delivery failure is likewise reported, not propagated — a
    // notification problem must never block the reward grant that caused it.
    return this.deliverEvaluated(childId, familyId, candidate);
  }

  /**
   * PHASE D (`PC-D-005`) — THE THREE BEHAVIOURS, AT THE ONE GATE.
   *
   * The fatigue guard has just said «not now». What «not now» MEANS is a
   * per-type product decision, and it lives in `notification-class.ts` as a
   * table with a written justification per row rather than as a predicate over
   * `priority` — because priority describes how loud a notification is, not
   * whether the fact it carries survives the night. A `HYDRATION_REMINDER` and
   * a `REWARD_GRANTED` are both NORMAL and their correct behaviours here are
   * opposites.
   *
   *   DELIVER   safety-critical. Bypasses quiet hours and goes out now. The
   *             list is three types long and every member is argued for in the
   *             table; `test/notifications/notification-class.spec.ts` fails if
   *             it grows without a justification.
   *   SUPPRESS  the occurrence describes a MOMENT that will have passed by
   *             morning. Dropped — but WITH ITS REASON RECORDED, which is the
   *             entire difference between this and the defect.
   *   DEFER     the default. A row in `notification_deliveries` with a
   *             scheduled delivery instant computed on the FAMILY'S calendar,
   *             released by the existing scheduler.
   *
   * IT NEVER THROWS. A deferral that fails to enqueue is logged and reported as
   * a suppression with `DEFER_ENQUEUE_FAILED`, because this service's standing
   * discipline is that a notification problem must never fail the reward grant
   * or habit completion that triggered it.
   */
  private async handleQuietHours(
    childId: string,
    familyId: string,
    candidate: IDeliverableNotification,
    timeZone: string,
    now: Date,
  ): Promise<INotificationOutcome> {
    const quietHoursClass = quietHoursClassOf(candidate.type, candidate.priority);

    if (quietHoursClass === 'DELIVER') {
      // PHASE E: `evaluateAndDeliver` now short-circuits this class BEFORE the
      // fatigue guard, so this branch is reached only by a future caller that
      // enters here directly. Kept, and kept identical, because a gate whose
      // safety case depends on nobody ever calling it by a second door is a
      // gate with a second door.
      this.logger.log(
        `notification.quiet_hours_bypassed type=${candidate.type} audience=${candidate.targetAudience}`,
      );
      return this.deliverEvaluated(childId, familyId, candidate);
    }

    if (quietHoursClass === 'SUPPRESS') {
      // DROPPED WITH A LOGGED REASON. The log line is the deliverable: a
      // hydration nudge that is discarded because its premise expires overnight
      // is a decision, and a decision that leaves no trace is indistinguishable
      // from the bug.
      this.logger.log(
        `notification.quiet_hours_suppressed type=${candidate.type} audience=${candidate.targetAudience} reason=EXPIRES_OVERNIGHT`,
      );
      return {
        type: candidate.type,
        targetAudience: candidate.targetAudience,
        decision: 'SUPPRESS',
        reason: 'QUIET_HOURS_EXPIRES_OVERNIGHT',
      };
    }

    // DEFER. The scheduled instant is the next time THIS FAMILY'S wall clock
    // reads `quietHoursEnd`, read from tzdata at that instant — not `now + 9h`,
    // not the container's clock, and not midnight-plus-seven (which does not
    // exist on Africa/Cairo's spring-forward day).
    try {
      const scheduledFor = nextLocalTimeAfter(now, DEFAULT_FATIGUE_POLICY.quietHoursEnd, timeZone);
      const enqueuedId = await this.deferralRepository.enqueue({
        familyId,
        childId,
        type: candidate.type,
        category: notificationCategoryOf(candidate.type),
        priority: candidate.priority,
        targetAudience: candidate.targetAudience,
        title: candidate.title,
        body: candidate.body,
        /**
         * THE CAUSAL KEY, PLUS THE AUDIENCE FACET — SPRINT F1, AND IT IS A
         * PRODUCTION FIX.
         *
         * WHAT THIS LINE USED TO BE: `sourceEventId: candidate.sourceEventId`,
         * with a comment saying the key is «CARRIED UNCHANGED» so that
         * idempotency survives defer -> deliver. The idempotency half of that
         * sentence was right and is preserved below; the «unchanged» half was
         * the defect.
         *
         * `notification_deliveries (family_id, source_event_id)` is UNIQUE and
         * has NO audience column. A cause that legitimately notifies both
         * audiences — every reward (`NotificationRewardConsumer` makes two
         * `handleEvent` calls with ONE `sourceEventId`), every badge
         * (`BADGE_EARNED` + `BADGE_EARNED_PARENT` with ONE `badgeKey`) —
         * therefore enqueued the PARENT's row first and had the CHILD's refused
         * by `ON CONFLICT DO NOTHING`. The refusal was reported as
         * `ALREADY_DEFERRED`, which reads like a correct answer, and the child
         * heard nothing at all about their own reward. Between 21:00 and 07:00
         * on the family's own clock — ten hours of every day — the child half of
         * this product was silent, which is exactly `PF-E-006`'s shape on a
         * timer. MEASURED, at 23:57 Africa/Cairo, by
         * `reward-cause-producers.e2e.spec.ts` before its clock was frozen: one
         * ledger row, two decision rows, ONE deferred row.
         *
         * `forAudience` IS THE SAME FACET `deliverNow` HAS ALWAYS APPENDED, and
         * it is idempotent, so the released row goes through `deliverNow`'s
         * CHILD branch and lands in `child_messages` under the byte-identical
         * key an immediate delivery would have written. Idempotency across
         * defer -> deliver is therefore unchanged: the key composed by the
         * producer at 22:00 is still the key inserted at 07:00, and a
         * redelivery of the same cause to the same audience still collides —
         * now per audience, which is what it always meant to say.
         */
        sourceEventId: forAudience(candidate.sourceEventId, candidate.targetAudience),
        // PHASE E (`PD-N-004`) — the payload travels with the message. See
        // `IDeliverableNotification.data`.
        data: candidate.data ?? null,
        deferReason: 'QUIET_HOURS',
        scheduledFor,
        businessDate: getBusinessDate(now, timeZone),
      });

      this.logger.log(
        `notification.deferred type=${candidate.type} audience=${candidate.targetAudience} ` +
          `scheduledFor=${scheduledFor.toISOString()} ${enqueuedId ? 'enqueued' : 'already_queued'}`,
      );
      return {
        type: candidate.type,
        targetAudience: candidate.targetAudience,
        decision: 'DEFER',
        // `ALREADY_DEFERRED` and `QUIET_HOURS` are different facts and the
        // caller's log line must be able to tell them apart: the first means a
        // redelivered cause found its own row already waiting.
        reason: enqueuedId ? 'QUIET_HOURS' : 'ALREADY_DEFERRED',
      };
    } catch (err) {
      this.logger.error(
        `notification.defer_failed type=${candidate.type} ${err instanceof Error ? err.message : String(err)}`,
      );
      return {
        type: candidate.type,
        targetAudience: candidate.targetAudience,
        decision: 'SUPPRESS',
        reason: 'DEFER_ENQUEUE_FAILED',
      };
    }
  }

  /**
   * The write plus the two outcomes it can have, shared by the immediate path
   * and the DELIVER-class quiet-hours bypass so that «the constraint refused
   * it» is reported identically in both.
   */
  private async deliverEvaluated(
    childId: string,
    familyId: string,
    candidate: IDeliverableNotification,
  ): Promise<INotificationOutcome> {
    try {
      const written = await this.deliverNow(childId, familyId, candidate);
      return written
        ? { type: candidate.type, targetAudience: candidate.targetAudience, decision: 'SEND' }
        : {
            type: candidate.type,
            targetAudience: candidate.targetAudience,
            decision: 'SUPPRESS',
            reason: 'ALREADY_NOTIFIED',
          };
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Failed to deliver Smart Notification (${candidate.type})`, detail);
      return {
        type: candidate.type,
        targetAudience: candidate.targetAudience,
        decision: 'SUPPRESS',
        reason: 'DELIVERY_ERROR',
        detail,
      };
    }
  }

  /** Routes a SEND-approved candidate to its correct real delivery
   * mechanism based on targetAudience — enforced structurally (CHILD
   * always goes through the approval-gated path).
   *
   * PHASE D — PUBLIC, so that `QuietHoursReleaseService` releases a deferred
   * notification through THIS EXACT METHOD rather than through a second copy of
   * the routing rules. There is one place a notification becomes a row, and a
   * deferred notification reaches it by the same door as an immediate one; that
   * is what «no second notification engine» means in code rather than in prose.
   */
  async deliverNow(
    childId: string,
    familyId: string,
    candidate: IDeliverableNotification,
    options: { deferPushToCaller?: boolean } = {},
  ): Promise<boolean> {
    if (candidate.targetAudience === 'PARENT') {
      return this.runtimeAlertRepository.createForFamilyOwner({
        familyId,
        childId,
        title: candidate.title,
        body: candidate.body,
        priority: candidate.priority === 'HIGH' || candidate.priority === 'LOW' ? 'NORMAL' : candidate.priority,
        type: candidate.type,
        // PHASE E (`PD-N-004`) — carried through to `notifications.data`
        // unchanged, which is where the parent app reads a wellbeing alert's
        // specifics.
        data: candidate.data,
        sourceEventId: candidate.sourceEventId,
        // PHASE D: only the release path sets this, and only because it owns a
        // durable retry the repository's best-effort push would otherwise burn.
        deferPushToCaller: options.deferPushToCaller,
      });
    }
    // B9 — the CHILD branch is protected too, and by the same kind of thing:
    // `child_messages (family_id, source_event_id)`. Phase A's §5 table listed
    // seven producer paths and marked all seven «قيد DB؟ ❌»; three of them
    // (badge-to-child, level-up-to-child, and any CHILD-targeted signal) land
    // here, not on `notifications`, so a fix that touched only one table would
    // have left them exactly as exposed as before while reporting success.
    // The `:child` facet keeps the child's row and the parent's row from
    // colliding when ONE event legitimately notifies both audiences.
    //
    // SPRINT F1 — `forChildAudience` RATHER THAN THE TEMPLATE LITERAL THIS WAS,
    // and it composes the identical string. The facet is now named in
    // `notification-source-key.ts` because the QUIET-HOURS QUEUE needs the same
    // one (see `handleQuietHours`) and a separation that only exists on the
    // immediate path is a separation that disappears every night. It is
    // idempotent, so a row released from that queue — which already carries the
    // facet — arrives here and is NOT faceted twice.
    const drafted = await this.familyCommunication.draftAiMessageIfAbsent(
      childId,
      familyId,
      candidate.type,
      candidate.title,
      candidate.body,
      forChildAudience(candidate.sourceEventId),
      // PHASE E (`PE-N-001`) — SAY WHICH VOCABULARY THIS CATEGORY IS FROM.
      //
      // `candidate.type` is a NOTIFICATION TYPE (`BADGE_EARNED`,
      // `HYDRATION_REMINDER`, `LEVEL_UP`). It was being handed to
      // `SafetyEngineService.validate` as a RECOMMENDATION TYPE, whose
      // whitelist has six members and shares none of them — so every
      // CHILD-audience notification this system has ever produced was rejected
      // with «Unknown recommendation type» and reported as `SUPPRESS` /
      // `DELIVERY_ERROR`. The whole child half of the notification surface was
      // dead, behind a constraint protecting a table nothing could write to
      // through this path.
      'CHILD_MESSAGE',
      // PHASE F (`F6-005`) — see `IDeliverableNotification.preComposed`. `false`
      // for every pre-F6 producer, so nothing about their behaviour changes.
      candidate.preComposed === true,
      /**
       * PHASE F1 — WHERE THE CHILD'S TAP LANDS, PERSISTED INSTEAD OF DISCARDED.
       *
       * `SmartNotificationEngineService` resolves a destination for EVERY
       * notification, child-audience ones included, and spreads it onto
       * `candidate.data`. The PARENT branch above carries that payload to
       * `notifications.data`; this branch had nowhere to put it, so the child's
       * destination was computed and then thrown away, and the child app's
       * router — complete and tested — was never fed anything.
       *
       * NARROWED, NOT COPIED. `childSafeNotificationPayload` takes the ONE
       * whitelisted key rather than the producer's whole object: this row is
       * served to a CHILD DEVICE by `GET /life-intelligence/self/messages`, and
       * `candidate.data` may hold a producer's detail (`goalTitle`, `points`)
       * or a device-supplied `metadata` blob. That function's header carries
       * the full argument; the short version is that «no identifier reaches a
       * child-readable row» must be a property of ONE function rather than of
       * every producer that ever writes to `data`.
       *
       * IT CHANGES NO DELIVERY SEMANTICS. The row is still written PENDING with
       * `deliveredAt = null` behind the parent's approval gate, still
       * deduplicated by `child_messages (family_id, source_event_id)`, and a
       * `null` payload — a producer that carries none, or a link that failed
       * validation — writes the column NULL and leaves the card exactly as
       * inert as it already was.
       */
      childSafeNotificationPayload(candidate.data),
    );
    return drafted !== null;
  }
}
