import type { ScreenTimePolicy } from '@prisma/client';
import type { IAppBlockRule, ICreateAppBlockRuleInput, ISetScreenTimePolicyInput } from '../../domain/screen-time.types';

export const SCREEN_TIME_POLICY_REPOSITORY = Symbol('SCREEN_TIME_POLICY_REPOSITORY');

export interface IScreenTimePolicyRepository {
  create(
    childId: string,
    createdByUserId: string,
    input: ISetScreenTimePolicyInput,
  ): Promise<ScreenTimePolicy>;
  findActiveByChild(childId: string): Promise<ScreenTimePolicy | null>;
  deactivate(policyId: string): Promise<void>;
}

/**
 * F4. The bonus minutes a child has EARNED and not yet used up, read at policy
 * time. A port rather than a direct Prisma call for the same reason the two
 * above are ports: `ScreenTimeService` is the one place the effective allowance
 * is computed, and it must stay testable without a database.
 */
export const SCREEN_TIME_BONUS_REPOSITORY = Symbol('SCREEN_TIME_BONUS_REPOSITORY');

export interface IScreenTimeBonusGrant {
  id: string;
  minutes: number;
  grantedAt: Date;
  expiresAt: Date;
}

export interface IScreenTimeBonusRepository {
  /** ACTIVE = not revoked and not expired at `now`. */
  listActiveGrants(childId: string, now: Date): Promise<IScreenTimeBonusGrant[]>;
}

export const APP_BLOCK_RULE_REPOSITORY = Symbol('APP_BLOCK_RULE_REPOSITORY');

export interface IAppBlockRuleRepository {
  create(childId: string, createdByUserId: string, input: ICreateAppBlockRuleInput): Promise<IAppBlockRule>;
  findById(ruleId: string): Promise<IAppBlockRule | null>;
  listActiveByChild(childId: string): Promise<IAppBlockRule[]>;
  deactivate(ruleId: string): Promise<void>;
}
