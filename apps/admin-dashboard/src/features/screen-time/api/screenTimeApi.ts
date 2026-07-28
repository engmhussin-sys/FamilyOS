import { httpClient } from '../../../shared/lib/httpClient';
import type { ScreenTimePolicy } from '../../../shared/types/api';

export const screenTimePolicyQueryKey = (childId: string) => ['screen-time-policy', childId] as const;

export interface SetScreenTimePolicyInput {
  dailyLimitMinutes?: number;
  bedtimeStart?: string;
  bedtimeEnd?: string;
  focusModeEnabled?: boolean;
}

export const screenTimeApi = {
  getPolicy(childId: string): Promise<ScreenTimePolicy | null> {
    return httpClient<ScreenTimePolicy | null>(`/children/${childId}/screen-time-policy`);
  },

  setPolicy(childId: string, input: SetScreenTimePolicyInput): Promise<ScreenTimePolicy> {
    return httpClient<ScreenTimePolicy>(`/children/${childId}/screen-time-policy`, {
      method: 'POST',
      body: input,
    });
  },
};
