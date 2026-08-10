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

export const APP_BLOCK_RULE_REPOSITORY = Symbol('APP_BLOCK_RULE_REPOSITORY');

export interface IAppBlockRuleRepository {
  create(childId: string, createdByUserId: string, input: ICreateAppBlockRuleInput): Promise<IAppBlockRule>;
  findById(ruleId: string): Promise<IAppBlockRule | null>;
  listActiveByChild(childId: string): Promise<IAppBlockRule[]>;
  deactivate(ruleId: string): Promise<void>;
}
