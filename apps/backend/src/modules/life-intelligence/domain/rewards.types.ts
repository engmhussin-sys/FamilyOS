export type RewardType = 'XP' | 'COINS' | 'BADGE';
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
}

/** The event a Reward Rule is evaluated against \u2014 a small, explicit
 * shape, same "reuse the pattern, not a shared class" discipline as
 * every other LIP rule component (Architecture 1.0 \u00a70). */
export interface IRewardTriggerEvent {
  engine: string;
  type: string;
  payload: Record<string, unknown>;
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
