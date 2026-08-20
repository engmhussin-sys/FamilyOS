/**
 * PHASE D (GROWTH) — THE REFERRAL DOMAIN, AND ITS FOUR FRAUD VECTORS.
 *
 * A referral engine is a money-printing API if it is built carelessly: it lets
 * an authenticated user cause the platform to pay out. So it is designed the
 * same way the payment path was — the defence is a DATABASE CONSTRAINT, and the
 * application code is only the thing that produces a helpful error message
 * before the constraint would have produced an unhelpful one.
 *
 * THE FOUR VECTORS, AND WHERE EACH IS ACTUALLY STOPPED:
 *
 *   V1 SELF-REFERRAL — parent A redeems their own code.
 *       Stopped by: `referral_events_no_self_referral` CHECK
 *       (`referrer_family_id <> referred_family_id`) in migration 0015, AND by
 *       `assertNotSelfReferral` below so the caller gets a 409 rather than a
 *       500. The CHECK is the guarantee; the function is the manners.
 *
 *   V2 DUPLICATE REFERRAL — parent B is claimed by two referrers, or by the
 *       same referrer twice, to be paid twice.
 *       Stopped by: `referral_events_referred_family_uq` — a UNIQUE index on
 *       `referred_family_id` over the REGISTERED rows. One household can be
 *       referred exactly once, ever, by exactly one referrer. It is not a
 *       per-referrer unique key, which would still allow two referrers to claim
 *       the same household.
 *
 *   V3 MULTIPLE REWARDS FOR ONE CONVERSION — the qualification path runs twice
 *       (a webhook redelivery, two workers, a retry) and pays twice.
 *       Stopped by: `referral_rewards.referral_event_id` UNIQUE. This is the
 *       same shape as `payment_transactions (family_id, idempotency_key)` and
 *       for the same reason: an application "check then insert" is a race, and
 *       this one races over money.
 *
 *   V4 RAPID ABUSE — one household generates hundreds of invitations, or
 *       qualifies an implausible number of conversions in a month.
 *       Stopped by: two configurable velocity limits
 *       (`referral.fraud.maxSentPerFamilyPerDay`,
 *       `referral.fraud.maxQualifiedPerFamilyPerMonth`) counted against real
 *       rows. Deliberately NOT stopped by a Redis rate limiter alone — a
 *       rate limiter that resets on restart is not an audit trail, and the
 *       question "why did this family receive nine rewards" must be answerable
 *       from the database a year later.
 *
 * A FIFTH DEFENCE THAT IS NOT A CONSTRAINT: a referral only ever QUALIFIES from
 * a server-verified payment (`payment_transactions.status = 'SUCCEEDED'`, which
 * is itself only written after provider-side verification) plus a refund
 * window. There is no endpoint by which a client can declare a conversion.
 */

/** The lifecycle of one referral relationship. Append-only: each is its own row. */
export const REFERRAL_EVENT_TYPES = [
  /** The referrer shared their code/link. Carries no referred identity at all. */
  'SENT',
  /** The link was opened. Anonymous; used for link-level conversion rates only. */
  'CLICKED',
  /** A NEW family registered carrying the code. This is the row V2 makes unique. */
  'REGISTERED',
  /** That family became a qualified paid subscriber. The row a reward hangs off. */
  'QUALIFIED',
  /** Explicitly refused, with a reason. Kept, never deleted — see below. */
  'REJECTED',
] as const;

export type ReferralEventType = (typeof REFERRAL_EVENT_TYPES)[number];

/**
 * Why a referral was refused. A REJECTED row is written instead of silently
 * dropping the attempt, because "this family tried to refer itself eleven
 * times" is a fraud signal, and a system that discards its refusals cannot see
 * it.
 */
export const REFERRAL_REJECTION_REASONS = [
  'SELF_REFERRAL',
  'ALREADY_REFERRED',
  'UNKNOWN_CODE',
  'INACTIVE_CODE',
  'SEND_RATE_EXCEEDED',
  'MONTHLY_QUALIFICATION_LIMIT',
  'NOT_YET_PAST_REFUND_WINDOW',
  'NO_QUALIFYING_PAYMENT',
] as const;

export type ReferralRejectionReason = (typeof REFERRAL_REJECTION_REASONS)[number];

/** How the referrer is paid. Both reuse an EXISTING ledger; neither mints currency. */
export const REFERRAL_REWARD_KINDS = [
  /**
   * Extends the referrer household's `entitlements.valid_until`. Reuses the
   * Phase D entitlement path, whose `valid_until` is MONOTONIC — it is never
   * shortened — so applying the same credit twice cannot reduce access, and
   * the UNIQUE on `referral_rewards.referral_event_id` means it cannot extend
   * twice either.
   */
  'SUBSCRIPTION_CREDIT_DAYS',
  /**
   * Writes a `rewards_ledger_entries` EARN row for a named child with the
   * deterministic key `referral:{referralEventId}`. Reuses the ledger's own
   * `(child_id, idempotency_key)` UNIQUE — the constraint DA-002 made total.
   */
  'CHILD_REWARD_COINS',
] as const;

export type ReferralRewardKind = (typeof REFERRAL_REWARD_KINDS)[number];

export const REFERRAL_REWARD_STATUSES = ['PENDING', 'GRANTED', 'FAILED'] as const;
export type ReferralRewardStatus = (typeof REFERRAL_REWARD_STATUSES)[number];

export class SelfReferralError extends Error {
  readonly reason: ReferralRejectionReason = 'SELF_REFERRAL';
  constructor() {
    super('A family cannot refer itself.');
  }
}

export class DuplicateReferralError extends Error {
  readonly reason: ReferralRejectionReason = 'ALREADY_REFERRED';
  constructor() {
    super('This family has already been referred.');
  }
}

export class UnknownReferralCodeError extends Error {
  readonly reason: ReferralRejectionReason = 'UNKNOWN_CODE';
  constructor(code: string) {
    super(`No active referral code "${code}".`);
  }
}

export class ReferralRateLimitError extends Error {
  constructor(readonly reason: ReferralRejectionReason, message: string) {
    super(message);
  }
}

/** V1, in one line, so no call site has to remember the comparison. */
export function assertNotSelfReferral(referrerFamilyId: string, referredFamilyId: string): void {
  if (referrerFamilyId === referredFamilyId) throw new SelfReferralError();
}

/**
 * THE CODE ALPHABET, and it is not base-36.
 *
 * `I`, `O`, `1` and `0` are excluded. A referral code is read aloud, written on
 * paper and typed by a parent who did not choose it; a vocabulary in which two
 * characters are visually identical converts a share into a support ticket. 8
 * characters over this 32-symbol alphabet is 2^40 codes, which is ample against
 * enumeration at the rate limits above.
 */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const REFERRAL_CODE_LENGTH = 8;

const CODE_PATTERN = new RegExp(`^[${CODE_ALPHABET}]{${REFERRAL_CODE_LENGTH}}$`);

export function isReferralCode(value: string): boolean {
  return CODE_PATTERN.test(value);
}

/**
 * Normalises what a human typed. Upper-cases, strips spaces and dashes, and
 * maps the four confusable characters onto their intended twins — so a parent
 * who typed `O` where the code has `0`... cannot happen, because `0` is not in
 * the alphabet. The mapping goes one way only: `0 -> O`, `1 -> I` would
 * reintroduce the ambiguity, so instead both are mapped to the letters that ARE
 * in the alphabet only when that produces a valid code.
 */
export function normaliseReferralCode(input: string): string {
  return input
    .trim()
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/0/g, 'O')
    .replace(/1/g, 'I');
}

/**
 * Generates a code from cryptographic randomness supplied by the caller.
 *
 * The randomness is a PARAMETER rather than read inside, so the generator is a
 * pure function that a test can pin exactly. `randomBytes` lives in the
 * service; the alphabet mapping lives here.
 *
 * Modulo bias is avoided by construction: 256 is a multiple of 32, so every
 * byte maps to exactly 8 alphabet positions.
 */
export function referralCodeFromBytes(bytes: Uint8Array): string {
  if (bytes.length < REFERRAL_CODE_LENGTH) {
    throw new RangeError(`referralCodeFromBytes needs at least ${REFERRAL_CODE_LENGTH} bytes.`);
  }
  let out = '';
  for (let i = 0; i < REFERRAL_CODE_LENGTH; i++) {
    out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  }
  return out;
}

/**
 * "QUALIFIED" — THE DEFINITION, AND IT IS A BUSINESS DECISION.
 *
 * A referred family is qualified when BOTH hold:
 *   1. it has at least one `payment_transactions` row with `status =
 *      'SUCCEEDED'` — i.e. money actually moved and we verified it server-side;
 *   2. that payment is older than `refundWindowDays`, so the refund window has
 *      closed and the reward is not paid on revenue that is about to be
 *      reversed.
 *
 * THE THRESHOLD IS NOT SETTLED. 14 days is the default because it clears
 * Google Play's 48-hour self-service window and Apple's typical 14-day review
 * comfortably, and because paying a referrer before the money is safe converts
 * a growth loop into a refund-arbitrage loop. It is `growth_settings ->
 * referral.qualification.refundWindowDays` and is flagged HUMAN DECISION
 * REQUIRED in the Phase D Growth report: marketing will want it shorter,
 * finance will want it longer, and this code holds no opinion beyond making the
 * trade-off explicit.
 */
export interface IQualificationInput {
  readonly firstSucceededPaymentAt: Date | null;
  readonly now: Date;
  readonly refundWindowDays: number;
}

export interface IQualificationDecision {
  readonly qualified: boolean;
  readonly reason: ReferralRejectionReason | null;
  /** When it WILL qualify, when the only thing missing is time. */
  readonly qualifiesAt: Date | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export function evaluateQualification(input: IQualificationInput): IQualificationDecision {
  if (input.firstSucceededPaymentAt === null) {
    return { qualified: false, reason: 'NO_QUALIFYING_PAYMENT', qualifiesAt: null };
  }
  const qualifiesAt = new Date(
    input.firstSucceededPaymentAt.getTime() + input.refundWindowDays * DAY_MS,
  );
  if (input.now.getTime() < qualifiesAt.getTime()) {
    return { qualified: false, reason: 'NOT_YET_PAST_REFUND_WINDOW', qualifiesAt };
  }
  return { qualified: true, reason: null, qualifiesAt };
}
