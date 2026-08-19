import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

import { PrismaService } from '../../../../common/prisma/prisma.service';
import { PushNotificationService } from '../../application/services/push-notification.service';
import type {
  ICreateRuntimeAlertInput,
  IRuntimeAlertRecord,
  IRuntimeAlertRepository,
  PushFanoutOutcome,
} from '../../application/ports/runtime-alert.repository.port';
import { tenantIdForWrite } from '../../../../common/tenancy/tenant-context';
import {
  NOTIFICATION_DEEP_LINK_DATA_KEY,
  isValidDeepLink,
  resolveNotificationDestination,
} from '../../../notifications/domain/engine/notification-destination';
import { EngineBypassDecisionRecorder } from '../../../notifications/application/services/engine-bypass-decision.recorder';

@Injectable()
export class PrismaRuntimeAlertRepository implements IRuntimeAlertRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly pushNotification: PushNotificationService,
    /**
     * THE DECISION LEDGER'S BYPASS ENTRY POINT. Injected from
     * `NotificationsModule`, which owns `notification_decisions`, exactly as
     * `notification-destination.ts` is imported from the module that owns the
     * map. This repository still decides nothing — it asks two questions of two
     * owners and writes the answers down.
     */
    private readonly bypassLedger: EngineBypassDecisionRecorder,
  ) {}

  /**
   * B9 (PA-B-007 / PA-B-008) — THE SINGLE WRITER OF `notifications`.
   *
   * `grep -rn "notification.create" src/` returns exactly one line and it is
   * in this method. That was already true before B9 and it is what makes the
   * fix a constraint rather than seven scattered checks: threading
   * `sourceEventId` to this one place protects every producer at once, and a
   * future eighth producer cannot reach the table without going through the
   * required field on `ICreateRuntimeAlertInput`.
   *
   * TWO DEFENCES NOW, NOT ONE, AND THE OLD ONE IS KEPT ON PURPOSE:
   *   1. the five-minute `findFirst` below — unchanged, still the product
   *      behaviour for a flapping device, still a sliding window;
   *   2. `notifications (family_id, source_event_id, user_id)` — the
   *      constraint, which sees concurrent writers and never forgets.
   * Deleting (1) in favour of (2) would have changed flap-suppression from a
   * sliding window to a bucket boundary; keeping both means the product
   * behaviour is untouched and the correctness floor is absolute. This is the
   * same relationship `consumed_messages` has with the ledger's unique index,
   * and F3's own docstring calls that one an optimisation for the same reason.
   *
   * ==========================================================================
   * THE PUSH CHANNEL IS COMPUTED HERE AND DISCARDED HERE, AND THE REASON IT IS
   * STILL DISCARDED IS A SIGNATURE THIS MODULE DOES NOT OWN.
   * ==========================================================================
   *
   * `pushToUser` below already returns a `PushFanoutOutcome` — SENT · SKIPPED ·
   * NONE · RETRYABLE · PERMANENT · NO_RECIPIENT — and the call on the last line
   * of this method throws it away. So `notification_decisions` cannot say which
   * channel a notification actually went out on, and an operator reading the
   * decision ledger cannot tell «no push problems» from «we never looked».
   * That is a real gap and it is stated here rather than left to be rediscovered.
   *
   * IT CANNOT BE CLOSED FROM INSIDE THIS FILE. Surfacing the value to the ledger
   * needs the return type widened along a chain whose middle links live in
   * modules that own their own signatures:
   *
   *   `pairing/application/ports/runtime-alert.repository.port.ts`
   *       `createForFamilyOwner(input: ICreateRuntimeAlertInput): Promise<boolean>`
   *   `life-intelligence/.../smart-notification-integration.service.ts`
   *       `deliverNow(childId, familyId, candidate, options): Promise<boolean>`
   *         — the caller that receives this method's result and returns a bare
   *           boolean;
   *       `deliverEvaluated(childId, familyId, candidate): Promise<INotificationOutcome>`
   *         — the only place a SEND outcome is constructed for the PARENT path;
   *       `export interface INotificationOutcome`
   *         — the shape the channel would have to travel in.
   *   `ai-core/.../distress-escalation.service.ts`
   *       `const parentAlerted = await this.alerts.createForFamilyOwner({…})`
   *         — a second consumer of the boolean, which a widened return breaks.
   *
   * The ledger's own half is ready: `INotificationDecisionRepository.recordOutcome`
   * and `SmartNotificationEngineService.recordOutcome` already carry an outcome
   * per decision row and would carry a channel with it. NO COLUMN HAS BEEN ADDED
   * for it, deliberately — `test/architecture/dormant-schema.guard.spec.ts`
   * exists because a column nothing can populate is worse than an absent one, and
   * this repository is the only place in the chain that currently holds a value
   * to put in it.
   */
  async createForFamilyOwner(input: ICreateRuntimeAlertInput): Promise<boolean> {
    const notificationType = input.type ?? 'RUNTIME_ALERT';
    /**
     * SPRINT F1 (BILLING) — `notifications.child_id` IS NULLABLE, and this is
     * the line that lets a household-level notification use it.
     *
     * `ICreateRuntimeAlertInput.childId` is `string`, and the producers that
     * have no child pass the empty string, because
     * `SmartNotificationIntegrationService.deliverNow` receives
     * `input.childId ?? ''` (the same convention `quiet-hours-release.service.ts`
     * uses for a digest). `''` is not a uuid: the dedupe `findFirst` below and
     * the `create` after it both reached PostgreSQL as
     * `22P02 invalid input syntax for type uuid: ""`, so a payment failure or a
     * renewal notice — facts about a HOUSEHOLD, which has no child attached to
     * them and must not have one invented — could never become a row.
     *
     * Normalised once, here, at the boundary that owns the column. `undefined`
     * is NOT used: `childId: undefined` in a Prisma `where` DROPS the clause
     * and would have made the dedupe window match every childless alert of the
     * same title; `null` means IS NULL in the query and NULL in the row, which
     * is the fact.
     */
    const childId = input.childId || null;

    const data = this.withDestination(input.data, notificationType);

    const recipient = await this.resolveRecipient(input.familyId);
    if (!recipient) return false; // no one to notify — nothing more this method can do

    // CLOSES A REAL GAP (Master Completeness Audit): zero
    // deduplication existed — the same event firing repeatedly in a
    // short window (e.g. a flaky Accessibility Service toggling on
    // and off) previously created a duplicate notification every
    // single time. A 5-minute window matching the exact same
    // recipient/type/childId/title is treated as the same real-world
    // event, not a new one worth re-alerting about.
    //
    // FIXES A REAL BUG (Sprint 16.1 Phase 3): this query was
    // hardcoded to type: 'RUNTIME_ALERT' — deduplication would have
    // silently never matched for any of the new Smart Notification
    // types this Phase introduces (HYDRATION_REMINDER, etc.), since
    // every one of THOSE rows also has type='RUNTIME_ALERT' baked in
    // by the OLD version of this same query, comparing the wrong
    // field entirely. Now compares the REAL type.
    const DEDUP_WINDOW_MS = 5 * 60 * 1000;
    const recentDuplicate = await this.prisma.notification.findFirst({
      where: {
        userId: recipient.userId,
        childId,
        type: notificationType,
        title: input.title,
        createdAt: { gte: new Date(Date.now() - DEDUP_WINDOW_MS) },
      },
    });
    if (recentDuplicate) return false;

    try {
      await this.prisma.notification.create({
        data: {
          familyId: tenantIdForWrite(),
          userId: recipient.userId,
          childId,
          type: notificationType,
          title: input.title,
          body: input.body,
          // CLOSES A REAL GAP (Master Completeness Audit): every
          // caller previously had no priority distinction at all.
          priority: input.priority ?? 'NORMAL',
          data: data as Prisma.InputJsonValue,
          // B9 — the causal key. Composed by the producer, never here: this
          // layer does not know what caused the alert and must not guess.
          sourceEventId: input.sourceEventId,
        },
      });
    } catch (err) {
      // B9 — ON CONFLICT DO NOTHING, expressed the way Prisma expresses it.
      // P2002 on this table now means exactly one thing: this notification has
      // already been delivered for this cause, to this recipient, in this
      // family. That is a SUCCESS — a redelivered outbox message did its job
      // the first time — so it is swallowed and reported as "not written",
      // never propagated. Any other error is a real failure and is rethrown,
      // because silently eating a lost notification is the OTHER half of
      // PA-B-009 and this method must not add to it.
      if ((err as { code?: string }).code === 'P2002') return false;
      throw err;
    }

    /**
     * ======================================================================
     * THE RECEIPT, FOR THE PRODUCERS THAT DO NOT COME THROUGH THE ENGINE.
     * ======================================================================
     *
     * WHAT WAS MEASURED, driving a real distress check-in through the real
     * route against a real PostgreSQL (`e2e-16 ACT IV`): one `ai_alerts` row,
     * one `notifications` row, and ZERO `notification_decisions` rows. The two
     * SYSTEM entries on `ENGINE_BYPASS_ALLOWLIST` reach this method without
     * `SmartNotificationEngineService.handleEvent`, the ledger is written from
     * that door and only from it, and so the most important notification this
     * product sends was invisible to `GET /system/notifications/analytics`, to
     * `GET /system/notifications/decision-breakdown` and to
     * `GET /notifications/decisions`.
     *
     * IT IS FIXED HERE, AT THE SINGLE WRITER, for `withDestination`'s reason
     * twenty lines below and it is the same reason: a third direct producer
     * added tomorrow gets a ledger row without anyone remembering to give it
     * one. THE BYPASS ITSELF IS UNTOUCHED — nothing above this line asks a
     * scorer, a fatigue cap or a quiet-hours matrix anything, and nothing here
     * can refuse a write that has already happened. This records what
     * happened; it does not decide it.
     *
     * IT RUNS FOR EVERY WRITE, INCLUDING THE ENGINE'S OWN, and no flag says
     * which is which. `SmartNotificationEngineService.recordDecision` writes
     * its row BEFORE calling the pipeline, so for an engine-decided
     * notification the row already exists on the same `(family_id,
     * source_event_id, target_audience)` and `record` conflicts and returns
     * `null`. The DATABASE tells the two apart; this file does not have to.
     *
     * AFTER THE ROW AND BEFORE THE PUSH, mirroring the engine's own ordering:
     * a process that dies mid-delivery still leaves the decision recorded,
     * which is the case a support engineer most needs.
     *
     * IT CANNOT FAIL THIS METHOD. `EngineBypassDecisionRecorder.record` never
     * throws — a ledger that cannot be written is a diagnostics problem, and
     * failing a child-safety notification because of one would be the loudest
     * possible way to turn an observability feature into an outage.
     */
    const decisionId = await this.bypassLedger.record({
      familyId: input.familyId,
      childId,
      sourceEventId: input.sourceEventId,
      notificationType,
      priority: input.priority ?? 'NORMAL',
      // No extra query: the same `familyMember` row that chose the recipient.
      recipientLocale: recipient.locale,
      now: new Date(),
    });

    // Sprint 5 (Push Notifications) — CLOSES A REAL GAP: every
    // critical alert already flowed through this exact method
    // (accessibility disabled, and now the five Digital Wellbeing
    // event types) — this is the same single point, now also
    // triggering a real push instead of relying entirely on the
    // in-app Notification row being noticed via polling. Best-effort
    // and non-blocking: a push failure never prevents the in-app
    // record above, which is already saved by the time this runs.
    //
    // PHASE D (`PD-N-002`): unless the caller has said it owns the retry. The
    // quiet-hours release path passes `deferPushToCaller` because it holds a
    // durable row with an attempt counter and a terminal DEAD state, and a
    // best-effort push fired from here would burn the one attempt it was going
    // to retry. Every other caller passes nothing and behaves exactly as before.
    if (input.deferPushToCaller !== true) {
      await this.pushToUser(recipient.userId, input.title, input.body);
    }

    /**
     * WHAT THE DELIVERY DID, ON THE RECEIPT THIS METHOD JUST WROTE — and only
     * on that one. `decisionId` is non-null ONLY when this call created a
     * bypass row, so an engine-decided notification (whose `record` conflicted
     * and returned `null`) never has its outcome overwritten from here. The
     * engine records its own, with the pipeline's own vocabulary.
     */
    if (decisionId) {
      await this.bypassLedger.recordOutcome(input.familyId, decisionId, true);
    }

    return true;
  }

  /**
   * WHERE THE TAP LANDS, FOR THE PRODUCERS THAT DO NOT COME THROUGH THE ENGINE.
   *
   * `SmartNotificationEngineService` resolves a destination for every
   * notification it decides, and spreads it onto `data` before the row is
   * written. The two SYSTEM producers on `ENGINE_BYPASS_ALLOWLIST` —
   * `DistressEscalationService` and `RuntimeAlertService` — deliberately do NOT
   * go through the engine (a fatigue cap must never silence a safety alert),
   * and so they arrived here with no destination at all. The consequence was
   * that `CHILD_WELLBEING_CHECKIN`, the distress alert and the most important
   * message this product sends a parent, reached the phone with a dead tap that
   * fell back to the inbox — while the parent app's `SafetyScreen`, built for
   * exactly this notification, could not be reached from it.
   *
   * IT IS FIXED HERE, at the single writer, rather than at the two call sites,
   * for the same reason `sourceEventId` is required here: a third direct
   * producer added tomorrow gets a destination without anyone remembering to
   * give it one. This is not a second resolver — `notification-destination.ts`
   * remains the only map, and this method only asks it a question.
   *
   * IT FILLS, IT NEVER OVERWRITES. A row arriving from the engine already
   * carries the server's own answer, resolved from `composed.resolvedCopyKey`
   * so the link degrades in step with the sentence when the safety gate rejects
   * a template. Recomputing it from `type` here would silently undo that. An
   * INVALID value is replaced rather than kept, so a producer payload cannot
   * choose a screen by spelling `deepLink` itself.
   *
   * AUDIENCE IS `PARENT` AND CANNOT BE ANYTHING ELSE: this method writes
   * `notifications`, whose recipient is resolved by `resolveRecipient` as the
   * family's owner. The child's half of the product is `child_messages`, a
   * different writer.
   *
   * IT ADDS A DESTINATION AND NOTHING ELSE. The distress alert is deliberately
   * contentless — it names the child, says a conversation would help, and
   * quotes nothing — and a `data` payload is exactly where a "little context"
   * would be smuggled back in six months from now. `resolveNotificationDestination`
   * is given a copy key and an audience, never the classification, never the
   * child's words, and never a tenant identifier; the links it can return for
   * this key are `abny://screen-time` and `abny://safety/<uuid>`.
   */
  private withDestination(
    data: Record<string, unknown> | undefined,
    notificationType: string,
  ): Record<string, unknown> {
    const merged: Record<string, unknown> = { ...(data ?? {}) };
    if (!isValidDeepLink(merged[NOTIFICATION_DEEP_LINK_DATA_KEY])) {
      merged[NOTIFICATION_DEEP_LINK_DATA_KEY] = resolveNotificationDestination({
        copyKey: notificationType,
        audience: 'PARENT',
      });
    }
    return merged;
  }

  /**
   * PHASE D (`PD-N-002`) — the retry half. Resolves the same recipient by the
   * same rule and pushes to their devices, writing nothing.
   */
  async pushToFamilyOwner(input: {
    familyId: string;
    title: string;
    body: string;
  }): Promise<PushFanoutOutcome> {
    const recipient = await this.resolveRecipient(input.familyId);
    if (!recipient) return 'NO_RECIPIENT';
    return this.pushToUser(recipient.userId, input.title, input.body);
  }

  /**
   * OWNER FIRST, THEN ANY MEMBER — one rule, one implementation, used by both
   * the write path and the push-retry path. Two copies of «who gets notified»
   * is how a retry ends up on a different phone than the original.
   */
  private async resolveRecipient(
    familyId: string,
  ): Promise<{ userId: string; locale: string | null } | null> {
    /**
     * `include: { user: … }` RATHER THAN A SECOND QUERY. The decision ledger
     * stores the household's language on every row, and
     * `NotificationContextAssembler.readLocale` resolves it from the OWNER's
     * `users.locale` — the very row this method already fetches to decide who
     * gets notified. Reading it here costs one join on a query that was already
     * happening; reading it in `EngineBypassDecisionRecorder` would have cost a
     * second round trip on the notification write path to learn the same fact.
     *
     * `null` when the member has no locale set, and `resolveLocale` — the one
     * function that owns the fallback — turns that into the product's first
     * language. This method does not decide what «no locale» means.
     */
    const owner = await this.prisma.familyMember.findFirst({
      where: { familyId, role: 'OWNER', deletedAt: null },
      include: { user: { select: { locale: true } } },
    });
    if (owner) return { userId: owner.userId, locale: owner.user?.locale ?? null };
    const anyMember = await this.prisma.familyMember.findFirst({
      where: { familyId, deletedAt: null },
      include: { user: { select: { locale: true } } },
    });
    return anyMember ? { userId: anyMember.userId, locale: anyMember.user?.locale ?? null } : null;
  }

  /**
   * THE FAN-OUT, AND ITS AGGREGATION RULE: optimistic. One device accepting the
   * message means the household was reached, which is the product question; a
   * second phone with a stale token is a cleanup task, not a failed delivery.
   * Only when EVERY device failed does the outcome become a failure, and the
   * class of that failure is the worst class present — a token that is
   * permanently dead alongside one that timed out is still worth retrying.
   */
  private async pushToUser(userId: string, title: string, body: string): Promise<PushFanoutOutcome> {
    const devices = await this.prisma.device.findMany({
      where: { userId, pushToken: { not: null } },
      select: { pushToken: true },
    });
    const tokens = devices
      .filter((d: { pushToken: string | null }): d is { pushToken: string } => d.pushToken !== null)
      .map((d: { pushToken: string }) => d.pushToken);

    if (tokens.length === 0) return 'NONE';

    const results = await Promise.all(
      tokens.map((token: string) => this.pushNotification.sendToDevice(token, title, body)),
    );
    const outcomes = results.map((r) => r.outcome);
    if (outcomes.includes('SENT')) return 'SENT';
    if (outcomes.includes('RETRYABLE')) return 'RETRYABLE';
    if (outcomes.includes('PERMANENT')) return 'PERMANENT';
    return 'SKIPPED';
  }

  async listForUser(userId: string): Promise<IRuntimeAlertRecord[]> {
    return this.prisma.notification.findMany({
      where: { userId, type: 'RUNTIME_ALERT' },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
  }
}
