import { httpClient } from '../../../shared/lib/httpClient';
import type { Child } from '../../../shared/types/api';

export const CHILDREN_QUERY_KEY = ['children'] as const;

export interface CreateChildInput {
  firstName: string;
  lastName?: string;
  dateOfBirth: string;
  gender?: string;
}

export const childrenApi = {
  list(): Promise<Child[]> {
    return httpClient<Child[]>('/children');
  },

  create(input: CreateChildInput): Promise<Child> {
    return httpClient<Child>('/children', { method: 'POST', body: input });
  },
};
