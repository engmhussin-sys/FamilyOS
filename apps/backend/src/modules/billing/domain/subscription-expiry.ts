import { addBusinessDays, getBusinessDate, type BusinessDate } from '../../../common/time/family-date';
import type { SubscriptionStatusValue } from './billing.types';

/**
 * SPRINT F1 — WHEN IS A SUBSCRIPTION «EXPIRING»? THE WHOLE RULE, AS A PURE
 * FUNCTION, SO IT CAN BE ARGUED WITH WITHOUT A DATABASE.
 *
 * `SUBSCRIPTION_EXPIRING` is a LEAD-TIME notification: unlike a payment
 * failure, no provider ever sends «this renews soon». It has to be DERIVED,
 * and the only honest way to derive it is from rows that already exist —
 * `subscriptions.status` and `subscriptions.current_period_end` — evaluated on
 * a schedule. Everything below is that derivation and nothing else; the
 * producer that acts on it is `BillingNotificationProducer`.
 *
 * ============================ WHICH STATUS =============================
 *
 * ONLY `ACTIVE`. Not a widening, a narrowing, and each exclusion is the
 * catalogue sentence refusing to lie:
 *
 *   «يتبقى {days} يومًا على تجديد اشتراكك» — YOUR SUBSCRIPTION RENEWS IN N DAYS.
 *
 *   `TRIALING`   a trial does not RENEW, it ENDS and then a first charge is
 *                attempted. `trial_ends_at` is a different column with a
 *                different meaning, and the catalogue has no trial sentence;
 *                borrowing the renewal one would tell a parent their
 *                subscription renews when they have never paid for one.
 *   `CANCELED`   auto-renewal is OFF and `payment-webhook.service.ts` keeps
 *                access to the period end deliberately. That period end is an
 *                EXPIRY, not a renewal. `SUBSCRIPTION_EXPIRED` is the catalogue
 *                entry for that fact and it is on the defect ledger with no
 *                producer; producing it from this sweep would need a sentence
 *                about a lapse, which this key is not.
 *   `PAST_DUE` / `GRACE_PERIOD`
 *                the charge has ALREADY failed. The parent is owed
 *                `PAYMENT_FAILED`, which they get from the webhook path, and
 *                telling them the same week that a renewal is «approaching» is
 *                the flood the notification policy exists to prevent.
 *   `PENDING`    Fawry's unpaid kiosk reference. Nothing was ever granted.
 *   `EXPIRED` / `REFUNDED`
 *                over. There is nothing approaching.
 *
 * `auto_renewing` is deliberately NOT part of the condition. Egypt's design is
 * MANUAL renewal — `auto_renewing` is FALSE for a perfectly healthy Egyptian
 * subscription — and those are precisely the households for whom a lead-time
 * notice is the difference between renewing and lapsing.
 *
 * ============================ WHICH DAY ================================
 *
 * The window is measured in CALENDAR DAYS ON THE FAMILY'S OWN CLOCK, never in
 * elapsed milliseconds. «Three days before renewal» is a statement about days,
 * and a `(end - now) / 86_400_000` would be wrong for a whole day for every
 * household east of UTC and wrong twice a year in Cairo, where the day the
 * subtraction crosses can be 23 or 25 hours long. Both sides go through
 * `getBusinessDate(instant, Family.timezone)` and the difference is taken on
 * the resulting `YYYY-MM-DD` strings with `addBusinessDays`, which walks the
 * calendar.
 *
 * The window is `1 <= daysRemaining <= LEAD_DAYS` — CLOSED AT BOTH ENDS, and
 * both ends are decisions:
 *
 *   The upper end is a range rather than `=== LEAD_DAYS` so that a sweep that
 *   did not run on the exact day — a failed tick, an operator who disabled the
 *   job for an afternoon, a household created two days before its renewal —
 *   still notifies, once, on the first day it IS asked. An equality test turns
 *   one missed run into total silence, and silence is the defect being closed.
 *
 *   The lower end is 1 rather than 0 because on the renewal day itself the
 *   sentence «يتبقى ٠ يومًا» is not Arabic anyone writes, and because the
 *   charge is happening: what the parent needs then is the OUTCOME
 *   (`PAYMENT_FAILED` or nothing), not a warning about it.
 */
export const SUBSCRIPTION_EXPIRY_LEAD_DAYS = 3;

/** The one status a renewal can be approaching from. See the header. */
export const EXPIRY_NOTICE_STATUSES: ReadonlySet<SubscriptionStatusValue> =
  new Set<SubscriptionStatusValue>(['ACTIVE']);

/** The columns of `subscriptions` this rule reads, and not one more. */
export interface SubscriptionExpiryInput {
  readonly status: SubscriptionStatusValue;
  /** `subscriptions.current_period_end`. NULL for a subscription that has
   * never been through a provider period — a MANUAL row, a pre-Phase-D row. */
  readonly currentPeriodEnd: Date | null;
}

export interface SubscriptionExpiryNotice {
  /** Whole calendar days, on the family's clock, until the renewal day. */
  readonly daysRemaining: number;
  /** The renewal day itself, `YYYY-MM-DD` on the family's clock. THE DEDUPE
   * SUBJECT: one notice per subscription per renewal day. */
  readonly renewalBusinessDate: BusinessDate;
  /** The family's today, for the log line and the ledger's own business date. */
  readonly todayBusinessDate: BusinessDate;
}

/**
 * `null` means «say nothing», and every `null` below is a stated clause of the
 * rule rather than a defensive early return.
 */
export function subscriptionExpiryNotice(
  subscription: SubscriptionExpiryInput,
  now: Date,
  timeZone: string,
  leadDays: number = SUBSCRIPTION_EXPIRY_LEAD_DAYS,
): SubscriptionExpiryNotice | null {
  if (!EXPIRY_NOTICE_STATUSES.has(subscription.status)) return null;
  // NO DATE, NO NOTICE. A renewal date is the ONE fact this notification is
  // about; guessing one from `created_at` plus a billing period would be
  // inventing the number the sentence states.
  if (!subscription.currentPeriodEnd) return null;

  const todayBusinessDate = getBusinessDate(now, timeZone);
  const renewalBusinessDate = getBusinessDate(subscription.currentPeriodEnd, timeZone);

  const daysRemaining = businessDaysBetween(todayBusinessDate, renewalBusinessDate, leadDays);
  if (daysRemaining === null) return null;

  return { daysRemaining, renewalBusinessDate, todayBusinessDate };
}

/**
 * How many calendar days from `from` to `to`, or `null` if that is outside
 * `1..leadDays`.
 *
 * Counted by WALKING THE CALENDAR with `addBusinessDays` — the same function
 * `family-daily-rollover.job.ts` uses to say «yesterday» — rather than by
 * differencing two epoch timestamps. `leadDays` is small (3), so the walk is
 * three string comparisons, and it is correct across every DST transition by
 * construction instead of by argument.
 */
function businessDaysBetween(from: BusinessDate, to: BusinessDate, leadDays: number): number | null {
  for (let d = 1; d <= leadDays; d += 1) {
    if (addBusinessDays(from, d) === to) return d;
  }
  return null;
}
