/**
 * PHASE D — THE ONE PLACE THE TWO STATUS VOCABULARIES MEET.
 *
 * The brief names eight subscription statuses:
 *
 *   PENDING · ACTIVE · PAST_DUE · CANCELLED · EXPIRED · REFUNDED · TRIAL · GRACE_PERIOD
 *
 * This database has carried `TRIALING` and `CANCELED` (US spellings) since
 * Sprint 8, on live rows, referenced by 2,476 passing tests. Renaming a
 * PostgreSQL enum value that every existing row depends on is a breaking change
 * bought for a spelling, so migration 0013 ADDED the three missing states
 * (`PENDING`, `GRACE_PERIOD`, `REFUNDED`) and left the two spellings alone.
 *
 * The consequence is a two-vocabulary system, and a two-vocabulary system is
 * only safe if the translation happens in EXACTLY ONE PLACE. This file is that
 * place. `subscription-status.spec.ts` proves both maps are total and mutually
 * inverse; if anyone adds a ninth state to either side without the other, that
 * test goes red before the code ships.
 */

/** The vocabulary the brief, the API and every Phase D service speak. */
export type CanonicalSubscriptionStatus =
  | 'PENDING'
  | 'ACTIVE'
  | 'PAST_DUE'
  | 'CANCELLED'
  | 'EXPIRED'
  | 'REFUNDED'
  | 'TRIAL'
  | 'GRACE_PERIOD';

/** The vocabulary the `SubscriptionStatus` PostgreSQL enum speaks. */
export type PersistedSubscriptionStatus =
  | 'PENDING'
  | 'ACTIVE'
  | 'PAST_DUE'
  | 'CANCELED'
  | 'EXPIRED'
  | 'REFUNDED'
  | 'TRIALING'
  | 'GRACE_PERIOD';

export const CANONICAL_SUBSCRIPTION_STATUSES: readonly CanonicalSubscriptionStatus[] = [
  'PENDING',
  'ACTIVE',
  'PAST_DUE',
  'CANCELLED',
  'EXPIRED',
  'REFUNDED',
  'TRIAL',
  'GRACE_PERIOD',
];

const TO_PERSISTED: Readonly<Record<CanonicalSubscriptionStatus, PersistedSubscriptionStatus>> = {
  PENDING: 'PENDING',
  ACTIVE: 'ACTIVE',
  PAST_DUE: 'PAST_DUE',
  CANCELLED: 'CANCELED',
  EXPIRED: 'EXPIRED',
  REFUNDED: 'REFUNDED',
  TRIAL: 'TRIALING',
  GRACE_PERIOD: 'GRACE_PERIOD',
};

const TO_CANONICAL: Readonly<Record<PersistedSubscriptionStatus, CanonicalSubscriptionStatus>> = {
  PENDING: 'PENDING',
  ACTIVE: 'ACTIVE',
  PAST_DUE: 'PAST_DUE',
  CANCELED: 'CANCELLED',
  EXPIRED: 'EXPIRED',
  REFUNDED: 'REFUNDED',
  TRIALING: 'TRIAL',
  GRACE_PERIOD: 'GRACE_PERIOD',
};

export function toPersistedStatus(status: CanonicalSubscriptionStatus): PersistedSubscriptionStatus {
  return TO_PERSISTED[status];
}

export function toCanonicalStatus(status: PersistedSubscriptionStatus): CanonicalSubscriptionStatus {
  return TO_CANONICAL[status];
}

/**
 * THE STATES THAT GRANT ACCESS — stated once, here, and nowhere else.
 *
 * ===========================================================================
 * SPRINT F1 (P0) — WHY THIS IS A LEDGER AND NOT A LIST OF THREE WORDS.
 * ===========================================================================
 *
 * Two services used to answer «is this family entitled to feature X?» and they
 * disagreed, because each carried its OWN inline status set:
 * `EntitlementsService` said `{TRIALING, ACTIVE}` and `EntitlementService` said
 * `{TRIALING, ACTIVE, GRACE_PERIOD}`. A household in the grace window — one
 * that HAS PAID, whose card failed on RENEWAL — was refused a second child, a
 * second device, priority support and insights by the first while the second
 * considered it fully entitled. Neither set was written where a reader would
 * look, and neither had a reason attached to any member.
 *
 * So the answer is not «three strings in a Set» but A DECISION PER STATUS WITH
 * ITS REASON BESIDE IT, keyed by `Record<CanonicalSubscriptionStatus, …>`. That
 * type is what makes the promise: a NINTH status cannot be added to
 * `CanonicalSubscriptionStatus` without an entry here, because the object stops
 * compiling. A future status therefore cannot be SILENTLY ABSENT — the way
 * `GRACE_PERIOD` was silently absent from `EntitlementsService` for the whole
 * sprint after migration 0013 introduced it.
 *
 * `ENTITLEMENT_BEARING_STATUSES` below is DERIVED from this ledger rather than
 * typed out a second time, so the two cannot drift.
 *
 * SCOPE. This ledger decides what a SUBSCRIPTION STATUS means. It is half the
 * question: a family with materialised `entitlements` rows is answered by those
 * rows FIRST, and their own three-state ledger lives beside `isLive` in
 * `entitlement.service.ts`. A refunded family is refused there — because
 * `revokeAll` ran — as well as here.
 */
export interface EntitlementStatusRule {
  /** Whether a household in this status may use what its plan includes. */
  readonly entitled: boolean;
  /** Why. Not decoration: the next person to change the line needs it. */
  readonly because: string;
}

export const ENTITLEMENT_STATUS_LEDGER: Readonly<Record<CanonicalSubscriptionStatus, EntitlementStatusRule>> = {
  TRIAL: {
    entitled: true,
    because:
      'A trial is the product given deliberately. It ends by BECOMING a charge; withholding features during it would make the trial worthless.',
  },
  ACTIVE: {
    entitled: true,
    because: 'The ordinary paid state. Listed anyway, because a ledger with a hole in it is a list.',
  },
  GRACE_PERIOD: {
    entitled: true,
    because:
      'schema.prisma states the household keeps FULL access for a configured window (Q17: 7 days) after a failed renewal, and CONTEXT.md §3.7 forbids punitive UX. The subscription was paid; only the RENEWAL failed. Downgrading at the instant a card declines violates both.',
  },
  PENDING: {
    entitled: false,
    because:
      'Fawry’s model is a payment REFERENCE the customer settles at a kiosk hours or days later. Nothing has been charged; granting on an unpaid reference gives the product away to anyone who taps subscribe.',
  },
  PAST_DUE: {
    entitled: false,
    because:
      'Payment failed and the provider is retrying WITHOUT a grace window (Apple billing retry, Google account hold). `PaymentWebhookService` revokes entitlement on the way into this state, so access has already stopped.',
  },
  CANCELLED: {
    entitled: false,
    because:
      'Auto-renewal was stopped. The household keeps what it already paid for until the period ends, but that access comes from the `entitlements` row’s `valid_until` — NOT from this status. Treating the status as entitlement-bearing would extend access past the period the customer bought.',
  },
  EXPIRED: {
    entitled: false,
    because: 'The period is over and nothing renews. The calendar already made this decision.',
  },
  REFUNDED: {
    entitled: false,
    because:
      'Terminal (`TERMINAL_STATUSES`). The money went back and access went with it: `EntitlementService.revokeAll` runs on the same path that writes this status.',
  },
};

export const ENTITLEMENT_BEARING_STATUSES: ReadonlySet<CanonicalSubscriptionStatus> = new Set<
  CanonicalSubscriptionStatus
>(
  (Object.keys(ENTITLEMENT_STATUS_LEDGER) as CanonicalSubscriptionStatus[]).filter(
    (status) => ENTITLEMENT_STATUS_LEDGER[status].entitled,
  ),
);

export function isEntitlementBearing(status: CanonicalSubscriptionStatus): boolean {
  return ENTITLEMENT_BEARING_STATUSES.has(status);
}

/**
 * Terminal states: a subscription that reaches one of these never returns to
 * an entitlement-bearing state without a NEW purchase. Used by the webhook
 * handlers to refuse a late-arriving "renewed" event for a refunded lineage.
 */
export const TERMINAL_STATUSES: ReadonlySet<CanonicalSubscriptionStatus> = new Set<
  CanonicalSubscriptionStatus
>(['REFUNDED']);

/**
 * ===========================================================================
 * SPRINT F1 (DECISION 3) — THE STATES A HOUSEHOLD MAY CANCEL FROM.
 * ===========================================================================
 *
 * WHAT WAS MEASURED. The cancel affordance was gated on `status === 'ACTIVE'`,
 * so a household in `GRACE_PERIOD` — which `ENTITLEMENT_BEARING_STATUSES` above
 * says is fully entitled, and which is by definition a household whose card has
 * just failed — could not cancel. That traps a paying customer in a state they
 * cannot leave: a bad experience, and in several jurisdictions a compliance
 * problem, because the right to withdraw does not pause because a payment did.
 *
 * THE TEST IS «IS THIS HOUSEHOLD CURRENTLY SUBSCRIBED?», NOT «IS IT PAYING?».
 * Cancelling ENDS RENEWAL. It revokes nothing and shortens nothing — see
 * `SubscriptionService.cancel`. So the question each state has to answer is
 * «is there a renewal to end?», and that is what decides every line below.
 *
 *   TRIAL         YES. A trial ends by BECOMING a charge, and stopping that
 *                 charge before it happens is the most common cancellation
 *                 there is. Refusing it would mean the only way out of a trial
 *                 is to let it bill you.
 *   ACTIVE        YES. The ordinary case, unchanged.
 *   PAST_DUE      YES. A payment failed and the provider is RETRYING. A
 *                 customer who does not want that retry to succeed must be able
 *                 to say so; «you may not cancel until your card works» is the
 *                 trap in its purest form.
 *   GRACE_PERIOD  YES, and this is the defect. It bears entitlement (above),
 *                 the household is being treated as a paying customer, and it
 *                 renews if the card recovers. Everything that makes ACTIVE
 *                 cancellable is true of it.
 *
 *   PENDING       NO, and this refusal is about the customer rather than about
 *                 us. Fawry's model is a payment REFERENCE the customer settles
 *                 at a kiosk hours or days later: nothing has been charged,
 *                 nothing is entitled (see `ENTITLEMENT_BEARING_STATUSES`) and
 *                 nothing renews. There is no renewal to end, and «cancelling»
 *                 would report success while a real settlement is still in
 *                 flight toward a row that now says CANCELLED. The way out of
 *                 PENDING is not to pay.
 *   CANCELLED     NO. Renewal has already ended and there is nothing left to
 *                 stop. It is refused with its OWN code so a client can say
 *                 «already cancelled» instead of «that failed».
 *   EXPIRED       NO. The period is over and nothing renews; a cancel here
 *                 would stamp a `canceled_at` on a decision the calendar
 *                 already made.
 *   REFUNDED      NO. Terminal (`TERMINAL_STATUSES`): the money has gone back
 *                 and the lineage never returns to an entitlement-bearing state
 *                 without a new purchase.
 *
 * IT IS A SET RATHER THAN A CONDITION, and it lives HERE rather than in the
 * service, for the same reason the two vocabularies meet in this file: the
 * server ANSWERS «may I cancel?» on `GET /billing/subscription` and ENFORCES it
 * on `POST /billing/cancel`, and a client that could disagree with the server
 * about which states offer the button is how the trap was built the first time.
 * `subscription-status.spec.ts` asserts this set is total over
 * `CANONICAL_SUBSCRIPTION_STATUSES`, so a ninth state cannot be added without
 * somebody deciding this question for it.
 */
export const CANCELLABLE_STATUSES: ReadonlySet<CanonicalSubscriptionStatus> = new Set<
  CanonicalSubscriptionStatus
>(['TRIAL', 'ACTIVE', 'PAST_DUE', 'GRACE_PERIOD']);

export function isCancellable(status: CanonicalSubscriptionStatus): boolean {
  return CANCELLABLE_STATUSES.has(status);
}
