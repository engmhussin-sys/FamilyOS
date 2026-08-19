/**
 * ============================================================================
 * THE DECISION-RECORDING ENTRY POINT THAT DOES NOT ENTER SCORING.
 * ============================================================================
 *
 * READ `notification-bypass.ts` FIRST — it holds the argument for every value
 * this service writes. This file holds only the three things that argument
 * cannot: where the analytics axes come from, why it is called from the single
 * writer rather than from the two producers, and why it never throws.
 *
 * ---------------------------------------------------------------------------
 * WHY IT IS CALLED FROM `PrismaRuntimeAlertRepository.createForFamilyOwner`
 * AND NOT FROM `DistressEscalationService` / `RuntimeAlertService`.
 *
 * The same answer that file already gives for `withDestination`, and it is the
 * stronger of the two available answers: BOTH SYSTEM entries on
 * `ENGINE_BYPASS_ALLOWLIST` reach `notifications` through that one method, so
 * fixing it there covers both — and covers the third direct producer somebody
 * adds next year without anyone remembering to give it a ledger row. Fixing it
 * at the two call sites would have covered exactly the two call sites, which is
 * how `ENGINE_BYPASS_ALLOWLIST` grew a hole in the first place.
 *
 * IT IS SAFE TO CALL FOR *EVERY* WRITE THROUGH THAT METHOD, including the ones
 * the engine itself drives, and that is a property of the DATABASE rather than
 * of a flag:
 *
 *   `SmartNotificationEngineService.recordDecision` writes its row BEFORE it
 *   calls the pipeline — deliberately, so a crash mid-delivery still leaves the
 *   reasoning recorded. By the time the write reaches this service the engine's
 *   row already exists on the same `(family_id, source_event_id,
 *   target_audience)`, so `INotificationDecisionRepository.record` conflicts and
 *   returns `null`. A scored notification therefore CANNOT acquire a second,
 *   bypass-labelled row, and no code here checks for one.
 *
 * ---------------------------------------------------------------------------
 * IDEMPOTENCY IS THE CONSTRAINT, AND ONLY THE CONSTRAINT.
 *
 * `notification_decisions_cause_uniq` — `UNIQUE (family_id, source_event_id,
 * target_audience)`, migration 0018 — is the whole of it. `SQL_RECORD_DECISION`
 * is an `ON CONFLICT DO NOTHING … RETURNING "id"`, so a replayed escalation
 * inserts nothing and this service learns that it inserted nothing from the
 * absent row rather than from a prior read. NO MIGRATION WAS NEEDED: the
 * natural key already existed and it is exactly the right one, because
 * `distressAlertSourceEventId` buckets by the family's own business DATE, so
 * «the same conversation, told once» is already what the key means.
 *
 * THERE IS NO `SELECT` ANYWHERE IN THIS FILE ON `notification_decisions`.
 * A read-before-write would have been a race with itself and is the shape this
 * codebase forbids outright.
 *
 * ---------------------------------------------------------------------------
 * IT NEVER THROWS, and the reason is `SmartNotificationEngineService`'s own:
 * the ledger is a DIAGNOSTICS surface, and failing a child-safety notification
 * because its receipt could not be written would turn an observability feature
 * into the loudest possible availability incident. Every failure degrades to a
 * log line and a `null`.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT IS STRUCTURALLY INCAPABLE OF RECORDING. There is no parameter on
 * `RecordBypassInput` that can hold a title, a body, a child's sentence or a
 * distress classification code, and `notification_decisions` has no column for
 * any of them (migration 0018 argues that at length). The service is given a
 * notification TYPE, a PRIORITY, a causal key and three tenant ids. Parents see
 * alerts, never the child's words — and the ledger does not become the back
 * door to them.
 */

import { Inject, Injectable, Logger } from '@nestjs/common';

import { PrismaService } from '../../../../common/prisma/prisma.service';
import { FamilyDateService } from '../../../../common/time/family-date.service';
import { businessAgeInYears, getBusinessDate } from '../../../../common/time/family-date';
import {
  NOTIFICATION_DECISION_REPOSITORY,
  type INotificationDecisionRepository,
} from '../ports/notification-decision.repository.port';
import {
  engineBypassDecision,
  engineBypassQuietHoursClass,
  type EngineBypassCause,
} from '../../domain/engine/notification-bypass';
import { resolveLocale } from '../../domain/engine/notification-context';
import { toneBandFor } from '../../domain/engine/notification-tone';

export interface RecordBypassInput extends EngineBypassCause {
  readonly familyId: string;
  /** `null` for a household-level alert. The column is nullable and NULL is the
   * fact, exactly as it is on `notifications.child_id`. */
  readonly childId: string | null;
  /**
   * THE PRODUCER'S OWN CAUSAL KEY, passed through untouched — never composed
   * here. «What makes this notification the same notification» is a decision
   * `notification-source-key.ts` requires the call site to have made, and it is
   * also the column this row's idempotency hangs on.
   */
  readonly sourceEventId: string;
  /**
   * The recipient's `users.locale`, already resolved by the caller from the
   * SAME `familyMember` row it used to choose the recipient — so this costs no
   * query, and the household's language on a bypass row is the household's
   * language on a scored one (`NotificationContextAssembler.readLocale` reads
   * the OWNER's locale, and the owner is who this path notifies).
   */
  readonly recipientLocale: string | null;
  /** The instant the notification was written. Frozen in tests, real in
   * production, and never `new Date()` inside this service — a receipt must
   * carry the caller's clock. */
  readonly now: Date;
}

@Injectable()
export class EngineBypassDecisionRecorder {
  private readonly logger = new Logger(EngineBypassDecisionRecorder.name);

  constructor(
    @Inject(NOTIFICATION_DECISION_REPOSITORY)
    private readonly ledger: INotificationDecisionRepository,
    private readonly familyDate: FamilyDateService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * Returns the new row's id, or `null` when the ledger already held this cause
   * (a replay, correctly ignored) or when the write failed. The two are
   * deliberately indistinguishable to the CALLER — neither is actionable there
   * — and distinguishable in the LOG, which is where a support engineer looks.
   */
  async record(input: RecordBypassInput): Promise<string | null> {
    try {
      const decision = engineBypassDecision(input);
      const timeZone = await this.familyDate.timeZoneOf(input.familyId);

      // THE THREE ANALYTICS AXES, READ THE WAY THE ENGINE READS THEM — in
      // parallel, because they are independent and this sits on a notification
      // write path. `NotificationContextAssembler` is the reference for all
      // three; a bypass row that resolved them differently would be a row that
      // silently drops out of a filtered dashboard.
      const [countryCode, ageBand] = await Promise.all([
        this.readCountry(input.familyId),
        this.readAgeBand(input.childId, input.now, timeZone),
      ]);

      const decisionId = await this.ledger.record({
        familyId: input.familyId,
        childId: input.childId,
        sourceEventId: input.sourceEventId,
        decision,
        /**
         * THE CAUSE COLUMN, AND THE ONE JUDGEMENT CALL IN THIS METHOD.
         *
         * `event_type` is «the producer's own event — what actually happened»,
         * and it is what `topCauses` groups on. A bypassed producer has no
         * domain event: `DistressEscalationService` is entered from an HTTP
         * check-in and `RuntimeAlertService` from a heartbeat comparison, and
         * neither publishes anything the ledger could name.
         *
         * So the CAUSE recorded is the notification TYPE, which on this path is
         * one-to-one with the fact: `CHILD_WELLBEING_CHECKIN` IS what happened.
         * The alternative — minting an `ENGINE_BYPASS` pseudo-cause — would
         * have put a ROUTING word in the column that answers «what happened»,
         * and `provider_id` already carries the routing.
         */
        eventType: decision.notificationType,
        ageBand,
        locale: resolveLocale(input.recipientLocale),
        countryCode,
        // NO MODEL PARTICIPATED, AND NONE COULD HAVE. `NotificationComposerService`
        // is never entered on this path — the copy is human-written and frozen
        // (`DISTRESS_ALERT_COPY`, `§11.4` property 3) — so all four flags are
        // `false` and the safety gate had nothing to refuse. These are the same
        // values a composed notification gets when the feature is off, and here
        // they are structural rather than configured.
        aiRewritten: false,
        aiFailed: false,
        aiAllowed: false,
        aiInvoked: false,
        aiSafetyRejection: null,
        /**
         * `copy_key` IS THE NOTIFICATION TYPE, and that is the truth rather
         * than a placeholder. On the engine's path this column stores
         * `composed.resolvedCopyKey` — the key the copy was rendered from, and
         * the key `resolveNotificationDestination` is asked for. The bypass
         * path renders no template, and `PrismaRuntimeAlertRepository.withDestination`
         * resolves its deep link by passing THE TYPE as the copy key. Storing
         * the same value here means the ledger and the tap agree about which
         * screen this notification points at, which is the question `copy_key`
         * exists to answer.
         */
        copyKey: decision.notificationType,
        /**
         * THE HOUSEHOLD'S OWN DAY. `getBusinessDate` — the same pure function
         * `SmartNotificationEngineService.handleEvent` calls — given the zone
         * `FamilyDateService` already resolved above, so the two layers cannot
         * disagree about what day it is and the zone is read once rather than
         * twice. A safety escalation at 00:30 in Riyadh belongs to that
         * family's night, and the alert's own dedupe key already agrees.
         */
        businessDate: getBusinessDate(input.now, timeZone),
      });

      if (decisionId === null) {
        this.logger.log(
          `notification.bypass_decision_already_recorded type=${decision.notificationType} ` +
            `provider=${decision.providerId}`,
        );
        return null;
      }

      // THE PREMISE, LOGGED RATHER THAN ASSUMED: what the quiet-hours matrix
      // says about this type is why nobody was allowed to hold it until morning.
      this.logger.log(
        `notification.engine_bypassed type=${decision.notificationType} audience=${decision.targetAudience} ` +
          `reason=${decision.reason} quietHoursClass=${engineBypassQuietHoursClass(input)} ` +
          `provider=${decision.providerId}`,
      );
      return decisionId;
    } catch (err) {
      this.logger.error(
        `notification.bypass_decision_write_failed type=${input.notificationType} ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return null;
    }
  }

  /**
   * Records what the delivery actually did, on the row this service just wrote.
   *
   * SEPARATE FROM `record`, for `SQL_RECORD_OUTCOME`'s reason: the outcome is
   * not known when the receipt is written. On this path it is known one line
   * later, and it is still written second — so a process that dies between them
   * leaves the DECISION recorded, which is the ordering the engine chose and the
   * case a support engineer most needs.
   */
  async recordOutcome(familyId: string, decisionId: string, delivered: boolean): Promise<void> {
    try {
      await this.ledger.recordOutcome(
        familyId,
        decisionId,
        delivered ? 'SEND' : 'SUPPRESS',
        // `DUPLICATE` is `SQL_DECISION_ANALYTICS`'s own word for «the causal key
        // refused this», counted into `duplicates` on the dashboard. The single
        // writer returns `false` for exactly that case and for the five-minute
        // flap window, which is the same fact at a different resolution.
        delivered ? null : 'DUPLICATE',
      );
    } catch (err) {
      this.logger.error(
        `notification.bypass_outcome_write_failed id=${decisionId.slice(0, 8)} ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /** The billing country, read exactly as `NotificationContextAssembler.readCountry`
   * reads it. `null` — an honest absence — for a household that has never
   * subscribed. This product does not derive a country from an IP address and
   * this method does not start. */
  private async readCountry(familyId: string): Promise<string | null> {
    try {
      const sub = await (this.prisma as any).subscription.findFirst({
        where: { familyId },
        select: { countryCode: true },
      });
      return sub?.countryCode ?? null;
    } catch {
      return null;
    }
  }

  /**
   * A BAND, NEVER AN AGE AND NEVER A DATE OF BIRTH — the column's own rule.
   * `toneBandFor` is the same function the assembler calls, given the same
   * `businessAgeInYears` reading against the family's own calendar, so a bypass
   * row and a scored row for the same child land in the same bucket.
   *
   * `null` for a household-level alert (no child) and for any failure, which is
   * what the nullable column already means on the engine's path.
   */
  private async readAgeBand(
    childId: string | null,
    now: Date,
    timeZone: string,
  ): Promise<string | null> {
    if (!childId) return null;
    try {
      const child = await (this.prisma as any).child.findUnique({
        where: { id: childId },
        select: { dateOfBirth: true },
      });
      if (!child?.dateOfBirth) return null;
      return toneBandFor(businessAgeInYears(child.dateOfBirth, now, timeZone));
    } catch {
      return null;
    }
  }
}
