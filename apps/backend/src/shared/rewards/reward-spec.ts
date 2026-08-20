/**
 * REWARD TYPES and how each one is actually paid out.
 *
 * REUSE NOTE, because this is the decision that shaped the whole sprint:
 * `POINTS` is NOT a new currency. It maps onto the existing ledger reward type
 * `XP`, which `RewardsAccount.xp` already tracks and
 * `SQL_RECONCILE_ACCOUNT_FROM_LEDGER` already reconciles. Inventing a `points`
 * column next to `xp` would have produced exactly the duplicate economy
 * CONTEXT §3 principle 1 forbids. The product word is "نقطة"; the ledger word
 * is `XP`; they are the same number.
 *
 * The other six types are new VALUES on the existing `RewardType` PostgreSQL
 * enum (`ALTER TYPE ... ADD VALUE`, additive), so every grant of every type is
 * one row in the one append-only `rewards_ledger_entries` table, signed and
 * idempotent by the constraint DA-002 shipped. What differs per type is the
 * SIDE EFFECT the grant triggers, not where the grant is recorded.
 */

export const PROGRAM_REWARD_TYPES = [
  'POINTS',
  'SCREEN_TIME',
  'PHYSICAL_REWARD',
  'DIGITAL_REWARD',
  'PRIVILEGE',
  'PARENT_APPROVAL_REWARD',
  'CUSTOM_REWARD',
] as const;

export type ProgramRewardType = (typeof PROGRAM_REWARD_TYPES)[number];

const TYPE_SET: ReadonlySet<string> = new Set(PROGRAM_REWARD_TYPES);
export function isProgramRewardType(v: string): v is ProgramRewardType {
  return TYPE_SET.has(v);
}

/**
 * The product-level reward type -> the LEDGER reward type actually written.
 * `POINTS -> XP` is the reuse; every other type is its own ledger value so the
 * ledger stays a faithful record of what was promised.
 */
export const REWARD_TYPE_TO_LEDGER: Readonly<Record<ProgramRewardType, string>> = {
  POINTS: 'XP',
  SCREEN_TIME: 'SCREEN_TIME',
  PHYSICAL_REWARD: 'PHYSICAL_REWARD',
  DIGITAL_REWARD: 'DIGITAL_REWARD',
  PRIVILEGE: 'PRIVILEGE',
  PARENT_APPROVAL_REWARD: 'PARENT_APPROVAL_REWARD',
  CUSTOM_REWARD: 'CUSTOM_REWARD',
};

/** Which types enter the fulfilment state machine (PENDING -> APPROVED ->
 * FULFILLED | DECLINED) and become visible in the parent's fulfilment queue. */
export const FULFILLABLE_REWARD_TYPES: ReadonlySet<ProgramRewardType> = new Set<ProgramRewardType>([
  'PHYSICAL_REWARD',
  'DIGITAL_REWARD',
  'PRIVILEGE',
  'PARENT_APPROVAL_REWARD',
  'CUSTOM_REWARD',
]);

export const FULFILMENT_STATUSES = ['PENDING', 'APPROVED', 'FULFILLED', 'DECLINED'] as const;
export type FulfilmentStatus = (typeof FULFILMENT_STATUSES)[number];

/** The only legal transitions. A terminal state has no outgoing edge — which is
 * what makes "fulfil a declined reward" a 400 rather than a silent update. */
export const FULFILMENT_TRANSITIONS: Readonly<Record<FulfilmentStatus, readonly FulfilmentStatus[]>> = {
  PENDING: ['APPROVED', 'DECLINED'],
  APPROVED: ['FULFILLED', 'DECLINED'],
  FULFILLED: [],
  DECLINED: [],
};

export function canTransitionFulfilment(from: FulfilmentStatus, to: FulfilmentStatus): boolean {
  return FULFILMENT_TRANSITIONS[from].includes(to);
}

// ---------------------------------------------------------------------------
// SCREEN_TIME — the bounded, expiring, revocable grant
// ---------------------------------------------------------------------------

/**
 * A single grant may not exceed this, and the sum of a child's ACTIVE grants
 * may not exceed `MAX_ACTIVE_BONUS_MINUTES` either. Both bounds are enforced
 * server-side at grant time, because "earn unlimited screen time by farming a
 * program" is the obvious abuse of this reward type and a per-grant cap alone
 * does not stop it.
 */
export const MAX_SCREEN_TIME_GRANT_MINUTES = 60;
export const MAX_ACTIVE_BONUS_MINUTES = 120;
/** A bonus that never expires is a permanent policy change by another name. */
export const DEFAULT_SCREEN_TIME_GRANT_TTL_HOURS = 24;
export const MAX_SCREEN_TIME_GRANT_TTL_HOURS = 168;

export interface RewardSpec {
  readonly type: ProgramRewardType;
  /** POINTS: points. SCREEN_TIME: minutes. Others: quantity (usually 1). */
  readonly amount: number;
  /** Free text shown to the parent for physical/custom rewards. */
  readonly description?: string;
  /** SCREEN_TIME only. Defaults to DEFAULT_SCREEN_TIME_GRANT_TTL_HOURS. */
  readonly expiresInHours?: number;
}

export interface RewardSpecError {
  readonly field: string;
  readonly code: string;
  readonly messageAr: string;
}

export function validateRewardSpec(spec: unknown): RewardSpecError[] {
  const errors: RewardSpecError[] = [];
  if (spec === null || typeof spec !== 'object' || Array.isArray(spec)) {
    return [{ field: 'rewardSpec', code: 'REWARD_SPEC_NOT_OBJECT', messageAr: 'مواصفات المكافأة يجب أن تكون كائنًا.' }];
  }
  const s = spec as RewardSpec;

  if (typeof s.type !== 'string' || !isProgramRewardType(s.type)) {
    errors.push({ field: 'rewardSpec.type', code: 'REWARD_TYPE_UNKNOWN', messageAr: 'نوع المكافأة غير معروف.' });
  }
  if (typeof s.amount !== 'number' || !Number.isInteger(s.amount) || s.amount <= 0) {
    errors.push({ field: 'rewardSpec.amount', code: 'REWARD_AMOUNT_INVALID', messageAr: 'قيمة المكافأة يجب أن تكون عددًا صحيحًا موجبًا.' });
  }

  if (s.type === 'SCREEN_TIME') {
    if (typeof s.amount === 'number' && s.amount > MAX_SCREEN_TIME_GRANT_MINUTES) {
      errors.push({
        field: 'rewardSpec.amount',
        code: 'SCREEN_TIME_ABOVE_MAX',
        messageAr: `الحد الأقصى لمنحة وقت الشاشة الواحدة ${MAX_SCREEN_TIME_GRANT_MINUTES} دقيقة.`,
      });
    }
    if (
      s.expiresInHours !== undefined &&
      (!Number.isInteger(s.expiresInHours) || s.expiresInHours <= 0 || s.expiresInHours > MAX_SCREEN_TIME_GRANT_TTL_HOURS)
    ) {
      errors.push({
        field: 'rewardSpec.expiresInHours',
        code: 'SCREEN_TIME_TTL_INVALID',
        messageAr: `مدة صلاحية منحة وقت الشاشة يجب أن تكون بين 1 و ${MAX_SCREEN_TIME_GRANT_TTL_HOURS} ساعة.`,
      });
    }
  }

  return errors;
}
