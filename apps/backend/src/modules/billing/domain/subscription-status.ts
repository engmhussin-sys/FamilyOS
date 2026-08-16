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
 * `TRIAL`, `ACTIVE` and `GRACE_PERIOD` all mean "this household may use what it
 * paid for". `GRACE_PERIOD` in particular is deliberately INSIDE this set:
 * `00-Company-Response.md` Q17 specifies full permissions during the 7-day
 * window with a clear, non-frightening notice, and CONTEXT.md §3.7 forbids
 * punitive UX. Downgrading a family at the instant a card fails would violate
 * both.
 *
 * `PENDING` is deliberately OUTSIDE it. Fawry's model is a payment reference
 * the customer settles at a kiosk hours or days later; granting access on the
 * strength of an unpaid reference is giving the product away.
 */
export const ENTITLEMENT_BEARING_STATUSES: ReadonlySet<CanonicalSubscriptionStatus> = new Set<
  CanonicalSubscriptionStatus
>(['TRIAL', 'ACTIVE', 'GRACE_PERIOD']);

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
