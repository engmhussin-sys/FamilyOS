/* eslint-disable @typescript-eslint/no-explicit-any */
import { Injectable, Logger } from '@nestjs/common';

import { PrismaService } from '../../../../common/prisma/prisma.service';
import { runWithTenant } from '../../../../common/tenancy/tenant-context';
import { FamilyDateService } from '../../../../common/time/family-date.service';
import { forBillingEvent } from '../../../../shared/notifications/notification-source-key';
import { SmartNotificationEngineService } from '../../../notification-engine/application/services/smart-notification-engine.service';
import type { PaymentProviderValue, SubscriptionStatusValue } from '../../domain/billing.types';
import {
  SUBSCRIPTION_EXPIRY_LEAD_DAYS,
  subscriptionExpiryNotice,
} from '../../domain/subscription-expiry';

/**
 * THE TWO KEYS THIS MODULE PRODUCES, AS A CLOSED UNION AND NOT AS TWO STRING
 * LITERALS SPRINKLED THROUGH A METHOD BODY.
 *
 * It is a named type for two reasons, and the second is the load-bearing one:
 *
 *   1. Adding a third billing notification becomes a compile-time event with
 *      one obvious place to make it, exactly as `NotificationProducer` in
 *      `notification-source-key.ts` is.
 *   2. `notification-producer-chain.guard.spec.ts` READS IT. That guard exists
 *      because three notification types have shipped in this repository with
 *      copy, scoring and a destination and NO producer, and the way it proves a
 *      producer exists is by resolving the `eventType` at every `handleEvent`
 *      call site statically. A funnel method that takes `eventType: string`
 *      defeats it — the site is reported UNRESOLVED and the two keys stay on
 *      the defect ledger while looking, from inside this file, entirely
 *      produced. Declaring the union here and naming it on
 *      `BillingNotificationCandidate.eventType` is what lets the guard follow
 *      `input.eventType` back to these two members.
 */
export type BillingNotificationEventType = 'PAYMENT_FAILED' | 'SUBSCRIPTION_EXPIRING';

/** What `tell` needs to hand ONE candidate to the engine. */
interface BillingNotificationCandidate {
  readonly familyId: string;
  readonly eventType: BillingNotificationEventType;
  readonly sourceEventId: string;
  readonly now: Date;
  readonly variables?: Readonly<Record<string, string | number>>;
  /** Operator-facing log detail. English facts, never user-visible copy. */
  readonly what: string;
}

/**
 * ============================================================================
 * SPRINT F1 — THE PRODUCER OF `PAYMENT_FAILED` AND `SUBSCRIPTION_EXPIRING`.
 * ============================================================================
 *
 * WHAT WAS MISSING, measured by `notification-producer-chain.guard.spec.ts` and
 * written into production itself: `notification-class.ts:263` and `:277` said
 * «(no producer yet — billing is another work stream.)». Both keys had copy in
 * Arabic and English across four tone bands, a notification class row, both
 * scoring rows and a deep-link destination — and the billing module wrote no
 * notification of ANY kind. A parent whose card was declined was told nothing;
 * a parent three days from a renewal they have to pay for MANUALLY (which is
 * Egypt's design, `auto_renewing = false`) was told nothing.
 *
 * ==================== WHAT THIS CLASS IS, AND IS NOT ====================
 *
 * IT IS A READ AND A CALL, twice. It turns a fact billing ALREADY HAS into one
 * `SmartNotificationEngineService.handleEvent` call. That is the whole class.
 *
 * IT IS NOT A NOTIFICATION PATH. It does not touch `notifications`, it does not
 * touch `notification_deliveries`, it does not call `createForFamilyOwner`, it
 * does not call `deliverNow`, and it decides nothing. Scoring, dedup, the
 * quiet-hours class, the copy, the tone band, the safety gate, the deep link
 * and the delivery are the engine's, unchanged.
 * `notification-engine-bypass.guard.spec.ts` is the standing proof of that and
 * this file must never appear on its allow-list.
 *
 * IT IS NOT A SCHEDULER. It has no timer and reads no clock: `now` is a
 * parameter on both methods, which is what makes «is this subscription
 * expiring?» a deterministic function of rows plus one instant, provable
 * without faking a machine.
 *
 * IT NEVER THROWS. The standing rule on every notification path here: a
 * notification problem must never fail the thing that triggered it. A webhook
 * that moved a household to `PAST_DUE` must be acknowledged 200 to the provider
 * even if the notification about it could not be composed — the alternative is
 * a provider retry storm caused by a copy bug.
 *
 * ==================== NO MONEY IS RENDERED, ON PURPOSE ====================
 *
 * `COPY_CATALOGUE.PAYMENT_FAILED` declares `variables: []` and
 * `COPY_CATALOGUE.SUBSCRIPTION_EXPIRING` declares `variables: ['days']`.
 * NEITHER SENTENCE CONTAINS AN AMOUNT OR A CURRENCY, so this producer passes
 * neither. That is the honest reading of the rule «money is never fabricated»:
 * the amount and the currency of a household's subscription live in
 * `payment_transactions.gross_amount_minor` / `.currency` and in
 * `subscriptions.currency_code`, per country (EGP for Egypt, SAR for Saudi
 * Arabia), and the way to keep a rendered figure honest is not to derive one
 * for a template that has no slot for it. `{days}` IS supplied, from the
 * family's own calendar, because its slot exists and an unsupplied variable
 * makes `renderNotificationCopy` fall back to `GENERIC` — the parent would read
 * «لديك تحديث جديد» instead of a renewal notice.
 *
 * ==================== IDEMPOTENCY, AT THE DATABASE ====================
 *
 * Three layers, in the order they are reached, and not one `if` among them:
 *
 *   1. `payment_webhook_events (provider, provider_event_id)` UNIQUE — for the
 *      payment-failure arm ONLY. `PaymentWebhookService.ingest` inserts the
 *      dedupe row BEFORE the effects, so a provider redelivery returns
 *      `DUPLICATE` and never reaches `applyStatus` a second time. This is the
 *      layer that already existed.
 *   2. `notification_decisions_cause_uniq (family_id, source_event_id,
 *      target_audience)` — `SQL_RECORD_DECISION`'s `ON CONFLICT DO NOTHING`
 *      refuses a second decision for a cause already recorded and `handleEvent`
 *      returns a NULL `decisionId`. This is the layer that holds when layer 1
 *      is bypassed: a manual replay, a catch-up run, this method called twice
 *      by a test, and EVERY run of the renewal sweep after the first.
 *   3. `notifications (family_id, source_event_id, user_id)` UNIQUE — the
 *      terminal write. What makes a redelivery that somehow got past both of
 *      the above still produce ONE row on the parent's phone. (And
 *      `notification_deliveries (family_id, source_event_id)` for the same
 *      cause held overnight by quiet hours.)
 *
 * The string all three agree on is `forBillingEvent(...)`; its own docstring
 * states why neither `forDomainEvent`, nor `forEntity`, nor
 * `forRecurringSignal` was usable here.
 *
 * ==================== THE FAMILY'S CALENDAR ====================
 *
 * `FamilyDateService.timeZoneOf` is the ONE reader of `Family.timezone` and
 * this producer does not become a second. A Cairo household and a Riyadh
 * household asked at the SAME INSTANT are on different calendar days for one
 * hour out of every twenty-four in winter, and `subscription-expiry.ts` takes
 * the whole day count on those local dates. Nothing here derives a day from
 * `toISOString().slice(0, 10)`.
 */
@Injectable()
export class BillingNotificationProducer {
  private readonly logger = new Logger(BillingNotificationProducer.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly familyDate: FamilyDateService,
    /** THE ONLY DOOR. See the class header: this producer decides nothing. */
    private readonly notifications: SmartNotificationEngineService,
  ) {}

  /**
   * A RENEWAL CHARGE DID NOT GO THROUGH — the discrete moment, and it is a
   * provider webhook.
   *
   * Called by `PaymentWebhookService.applyStatus` on the three event kinds that
   * mean exactly that (`PAYMENT_FAILED`, `BILLING_RETRY`,
   * `GRACE_PERIOD_STARTED`), and ONLY after
   * `applySubscriptionStateIfNewer` reported that the state actually MOVED.
   * That ordering is the point: a stale, out-of-order callback changes no row
   * and must therefore tell the parent nothing, and «did the row change» is
   * already answered by the provider's own signed timestamp inside that
   * UPDATE's WHERE clause rather than by a comparison invented here.
   *
   * `trigger: 'SUBSCRIPTION_LIFECYCLE'` because that is the member
   * `NOTIFICATION_TRIGGERS` reserves for exactly this and it has never had a
   * producer. It is deliberately not `DOMAIN_EVENT`: there is no
   * `domain_events` row, and claiming one on the ledger would make that column
   * a lie about how the product learned the fact.
   */
  async paymentFailed(input: {
    familyId: string;
    subscriptionId: string;
    provider: PaymentProviderValue;
    /** `payment_webhook_events.provider_event_id` — the provider's own,
     * already-unique identity for this callback. */
    providerEventId: string;
    /** The provider's signed timestamp, or the ingestion instant when the
     * payload carried none. Never `new Date()` read inside. */
    occurredAt: Date;
  }): Promise<'PRODUCED' | 'ALREADY_DECIDED' | 'REFUSED'> {
    /**
     * THE ONE PLACE THIS PRODUCER ENTERS A TENANT SCOPE, AND THE ONLY REASON
     * IT MAY.
     *
     * `PaymentWebhookService.ingest` runs its whole pipeline inside
     * `runAsSystemAsync('BILLING_WEBHOOK')` because there IS no caller tenant:
     * a provider posts server-to-server with no session. Under a
     * `SystemContext`, `tenantIdForWrite()` throws `TENANT_REQUIRED_UNDER_SYSTEM`
     * on purpose — «there is no ambient tenant to inherit» — and the single
     * writer of `notifications` calls it with no argument. So without this the
     * notification is composed, scored, recorded on the ledger and then lost at
     * the write, reported as `DELIVERY_ERROR`. That was MEASURED, not
     * anticipated.
     *
     * `familyId` here is not a caller's claim: it is the household
     * `PaymentWebhookService.resolveFamily` derived from the VERIFIED payload,
     * through the store account link or the subscription lineage key — which is
     * the exact justification the `BILLING_WEBHOOK` system reason is written
     * with. Narrowing from «any tenant» to «this one tenant» is a tightening.
     *
     * `sweepExpiringSubscription` deliberately does NOT do this: its caller is
     * a per-family job runner that has already entered the scope, and a
     * producer that establishes its own is a producer that can be called with
     * any family id from anywhere.
     */
    return runWithTenant(
      { familyId: input.familyId, actorType: 'SYSTEM', actorId: 'billing-webhook' },
      () =>
        this.tell({
          familyId: input.familyId,
          eventType: 'PAYMENT_FAILED',
          sourceEventId: forBillingEvent(
            input.subscriptionId,
            `payment_failed:${input.provider}:${input.providerEventId}`,
          ),
          now: input.occurredAt,
          what: `payment_failed provider=${input.provider}`,
        }),
    );
  }

  /**
   * A RENEWAL IS `SUBSCRIPTION_EXPIRY_LEAD_DAYS` DAYS AWAY OR LESS, ON THIS
   * HOUSEHOLD'S OWN CALENDAR.
   *
   * ONE HOUSEHOLD, ONE INSTANT, NO SWEEP OF ITS OWN. The signature is the one
   * a `FamilyJobDefinition` handler already has, so this composes with the
   * keyset-paginated fan-out `JobRunner.executeFamilies` already performs
   * (`SQL_LIST_ACTIVE_FAMILIES_PAGE`) instead of adding a second enumeration of
   * the families table. There is no timer here, no cursor here, and no
   * `scheduled_jobs` row of its own: «once per household per day» is a property
   * of `job_runs (job_name, family_id, business_date)`, which that runner
   * already holds, and the renewal-day key makes the answer the same even when
   * it is asked three days running.
   *
   * MUST BE CALLED INSIDE `runWithTenant({ familyId })`. The job runner enters
   * it before every family handler; this method deliberately does not enter one
   * of its own, because a producer that establishes its own tenant scope is a
   * producer that can be called with any family id from anywhere.
   */
  async sweepExpiringSubscription(input: {
    familyId: string;
    now: Date;
  }): Promise<{ notice: boolean; produced: number; alreadyDecided: number; refused: number }> {
    const silent = { notice: false, produced: 0, alreadyDecided: 0, refused: 0 };

    let subscription: {
      id: string;
      status: SubscriptionStatusValue;
      currentPeriodEnd: Date | null;
    } | null = null;
    try {
      // `subscriptions.family_id` is UNIQUE — one household has at most one
      // subscription — so this is a lookup, not a scan. Three columns, named:
      // the status, the date the notice is about, and the id that keys it.
      subscription = await this.models().subscription.findFirst({
        where: { familyId: input.familyId },
        select: { id: true, status: true, currentPeriodEnd: true },
      });
    } catch (err) {
      this.logger.warn(
        `billing.expiry_read_failed family=${input.familyId.slice(0, 8)} ${describe(err)}`,
      );
      return silent;
    }
    if (!subscription) return silent;

    const timeZone = await this.familyDate.timeZoneOf(input.familyId);
    const notice = subscriptionExpiryNotice(
      { status: subscription.status, currentPeriodEnd: subscription.currentPeriodEnd },
      input.now,
      timeZone,
    );
    if (!notice) return silent;

    const outcome = await this.tell({
      familyId: input.familyId,
      eventType: 'SUBSCRIPTION_EXPIRING',
      sourceEventId: forBillingEvent(subscription.id, `expiring:${notice.renewalBusinessDate}`),
      now: input.now,
      // THE ONE VARIABLE THE SENTENCE HAS, and it is a count of the FAMILY'S
      // OWN DAYS. `renderNotificationCopy` turns it into Arabic-Indic digits
      // for an Arabic household; an unsupplied `{days}` would degrade the whole
      // notification to `GENERIC`.
      variables: { days: notice.daysRemaining },
      what: `expiring in=${notice.daysRemaining}d renewal=${notice.renewalBusinessDate} tz=${timeZone}`,
    });

    return {
      notice: true,
      produced: outcome === 'PRODUCED' ? 1 : 0,
      alreadyDecided: outcome === 'ALREADY_DECIDED' ? 1 : 0,
      refused: outcome === 'REFUSED' ? 1 : 0,
    };
  }

  /**
   * ONE CANDIDATE, THROUGH THE ENGINE'S REAL ENTRY POINT.
   *
   * `childId: null` because neither fact is about a child. A declined card and
   * an approaching renewal belong to the HOUSEHOLD; attaching some child of it
   * so that a `string` parameter has a value would put an arbitrary name on a
   * billing notice and would make `notifications.child_id` claim a relationship
   * that does not exist. The column is nullable and now says so all the way
   * down.
   */
  private async tell(
    input: BillingNotificationCandidate,
  ): Promise<'PRODUCED' | 'ALREADY_DECIDED' | 'REFUSED'> {
    try {
      const result = await this.notifications.handleEvent({
        familyId: input.familyId,
        childId: null,
        eventType: input.eventType,
        sourceEventId: input.sourceEventId,
        trigger: 'SUBSCRIPTION_LIFECYCLE',
        variables: input.variables,
        now: input.now,
      });

      // A NULL decision id is the ledger's unique key refusing a cause it has
      // already recorded — the idempotency guarantee, read as the absence of a
      // returned id rather than as a boolean somebody could forget to check.
      if (result.decisionId === null) return 'ALREADY_DECIDED';
      if (result.decision.verdict === 'SUPPRESS') return 'REFUSED';

      // Counts, one family id prefix, and the type. No amount, no currency, no
      // provider transaction id — the same discipline as every other log line
      // on a notification path here.
      this.logger.log(
        `billing.notified family=${input.familyId.slice(0, 8)} type=${input.eventType} ${input.what}`,
      );
      return 'PRODUCED';
    } catch (err) {
      this.logger.warn(
        `billing.notify_failed family=${input.familyId.slice(0, 8)} type=${input.eventType} ${describe(err)}`,
      );
      return 'REFUSED';
    }
  }

  /**
   * The same structural cast, for the same reason, as `JobRunner.prismaRaw()`
   * and `StalledGoalService.raw()`: this code must work against both the
   * extended production client and the WASM-engine client the tenancy proof
   * suites build, and naming a generated type would bind it to one of them.
   */
  private models(): { subscription: any } {
    return this.prisma as any;
  }
}

/** Re-exported so a caller reading the sweep does not have to know which file
 * the number lives in. The rule itself stays in `subscription-expiry.ts`. */
export { SUBSCRIPTION_EXPIRY_LEAD_DAYS };

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
