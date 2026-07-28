import type { ScreenTimePolicy } from '@prisma/client';
import type { ISetScreenTimePolicyInput } from '../../domain/screen-time.types';

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
