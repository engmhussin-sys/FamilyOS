/**
 * F4 — EXTENDED, NOT REPLACED. `XP`/`COINS`/`BADGE` keep their exact meaning and
 * every existing reader keeps working; the six added values are the product
 * reward types from the brief, which the ledger now records faithfully instead
 * of collapsing them all into XP.
 *
 * `POINTS` is deliberately ABSENT: the product word "نقطة" maps onto the
 * existing `XP` value rather than becoming a second currency next to it
 * (CONTEXT §3 principle 1). See `src/shared/rewards/reward-spec.ts`.
 *
 * ACCOUNT SEMANTICS, stated because it is the non-obvious half: only XP, COINS
 * and BADGE move `rewards_accounts` columns. The six new types move NO balance
 * — their value is the side effect (`screen_time_reward_grants`,
 * `reward_fulfilments`), and the ledger row is the record that it was owed.
 * `SQL_RECONCILE_ACCOUNT_FROM_LEDGER` therefore stays correct unchanged,
 * because it already FILTERs by reward_type.
 */
export type RewardType =
  | 'XP'
  | 'COINS'
  | 'BADGE'
  | 'SCREEN_TIME'
  | 'PHYSICAL_REWARD'
  | 'DIGITAL_REWARD'
  | 'PRIVILEGE'
  | 'PARENT_APPROVAL_REWARD'
  | 'CUSTOM_REWARD';

/** The three that move a balance. Everything else is ledger-only. */
export const BALANCE_MOVING_REWARD_TYPES: ReadonlySet<RewardType> = new Set<RewardType>([
  'XP',
  'COINS',
  'BADGE',
]);
export type RedemptionStatus = 'REQUESTED' | 'APPROVED' | 'DENIED' | 'FULFILLED';

export interface IRewardsAccount {
  id: string;
  childId: string;
  xp: number;
  coins: number;
  stars: number;
  level: number;
}

export interface IRewardsLedgerEntry {
  id: string;
  childId: string;
  type: 'EARN' | 'REDEEM';
  rewardType: RewardType;
  amount: number;
  source: string;
  createdAt: Date;
}

export interface IRewardCatalogItem {
  id: string;
  familyId: string;
  title: string;
  costCoins: number;
  isActive: boolean;
}

export interface IRewardRedemption {
  id: string;
  childId: string;
  rewardCatalogItemId: string;
  status: RedemptionStatus;
}

export interface IBadgeDefinition {
  id: string;
  key: string;
  title: string;
  description: string;
  criteria: Record<string, unknown>;
  isGroupAchievement: boolean;
}

export interface IRewardRule {
  id: string;
  familyId: string | null;
  triggerEngine: string;
  triggerCondition: Record<string, unknown>;
  rewardType: RewardType;
  rewardAmountOrBadgeId: string;
  isActive: boolean;

  /** B4 (PA-B-015 · PA-B-013). The domain event type this rule answers.
   *
   * `null`/absent is the pre-B4 WILDCARD: match anything from `triggerEngine`.
   * It is kept because F4 companion rows match on `{programId, multiplierBps}`
   * and because rules seeded before B4 exist. Every MANAGED rule — platform
   * default or parent-authored — names its type, and a named type is what stops
   * one rule paying twice for one completion (once for the keyed
   * `HABIT_COMPLETED` trigger, once for the legacy keyless `habit_completed`
   * trigger the same engine still fires). */
  eventType?: string | null;
  /** `null` = uncapped. Counted on the FAMILY's business day. */
  maxPerDay?: number | null;
  /** `null` = uncapped. Counted on the family's rolling business week. */
  maxPerWeek?: number | null;
  /** `SELF` | `SENSOR` | `SYSTEM` | `PARENT`. The weakest evidence this rule
   * will pay for, compared against `CompletionEvent.verifiedBy`. `null` =
   * accept whatever the producer asserted. */
  minVerifiedBy?: string | null;
  /** FK into `reward_program_categories.code`. Carried for reporting only —
   * NOTHING in the grant path branches on it, which is what keeps the category
   * set open (CONTEXT: no closed enum in business logic). */
  category?: string | null;
  labelAr?: string | null;
}

/** The event a Reward Rule is evaluated against \u2014 a small, explicit
 * shape, same "reuse the pattern, not a shared class" discipline as
 * every other LIP rule component (Architecture 1.0 \u00a70). */
export interface IRewardTriggerEvent {
  engine: string;
  type: string;
  payload: Record<string, unknown>;
  /** Sprint 16.1 (Double Reward Protection) — CLOSES A REAL GAP:
   * optional, honest-absence-by-default. When the calling engine can
   * identify "this exact same real-world event" (e.g.
   * `habit-completion:${habitId}:${date}`, or
   * `streak:${childId}:${metric}:${streakDays}`), it should pass a
   * stable key here so a retry/duplicate/concurrent-request never
   * grants the same reward twice. Callers with no natural key (rare
   * — most engines have an obvious one) simply omit this; the
   * request proceeds exactly as it did before this field existed. */
  idempotencyKey?: string;

  /**
   * B4 — WHICH SIDE OF THE PIPELINE THIS TRIGGER CAME FROM, and the reason it
   * has to be stated rather than guessed.
   *
   * There are two ways a grant happens, and they announce it differently:
   *
   *   THE OUTBOX PATH (`POST /events/batch` -> `RewardsCompletionConsumer`)
   *     emits `REWARD_GRANTED` inside its own `if (granted > 0)`, and
   *     `NotificationRewardConsumer` turns that into exactly one notification.
   *     That is F3's architecture and it works.
   *
   *   THE DIRECT PATH (`POST /life-intelligence/self/habits/:id/complete` and
   *     its siblings — the routes the Child App actually calls today, PA-M-034)
   *     calls `IRewardTriggerWriter.trigger` inside the HTTP request. There is
   *     no outbox message and therefore NO `REWARD_GRANTED`, so before B4 a
   *     reward earned on the path every real client uses notified NOBODY. That
   *     is the 🔴 Phase A recorded against the Notification stage of six chains.
   *
   * Setting this to `true` tells the engine "an outbox announcement is already
   * coming, do not notify". The consumer sets it; nothing else does. Making it
   * EXPLICIT rather than inferring it from the presence of an idempotency key
   * or from the event type is deliberate: a wrong inference here produces
   * either zero notifications or two, and both are silent failures.
   */
  announcedViaOutbox?: boolean;
}

export interface IRewardGrant {
  rewardType: RewardType;
  amountOrBadgeId: string;
  source: string;
}

/** XP required to reach each level \u2014 a small, deterministic,
 * fully-explainable lookup table, same discipline as
 * HYDRATION_TARGET_ML_BY_AGE. */
export const LEVEL_XP_THRESHOLDS: ReadonlyArray<number> = [0, 100, 250, 500, 900, 1400, 2100, 3000, 4200, 5800, 8000];
