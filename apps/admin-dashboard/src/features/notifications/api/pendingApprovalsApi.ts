import { httpClient } from '../../../shared/lib/httpClient';

/**
 * CLOSES A CRITICAL REAL GAP: this Admin Dashboard is a SEPARATE
 * app from the Parent App (Flutter) — the same critical fix already
 * shipped there (a parent had zero way to discover AI-drafted
 * messages awaiting approval, meaning every Smart Notification
 * targeted at a child was structurally unreachable) did not exist
 * here at all. Reuses the exact same backend endpoints
 * (GET /life-intelligence/communication/pending,
 * POST .../:childId/:messageId/approve|reject) — zero new backend
 * work needed, zero duplicate API.
 */
export interface PendingMessage {
  id: string;
  childId: string;
  childName: string;
  category: string;
  title: string;
  body: string;
}

export const PENDING_APPROVALS_QUERY_KEY = ['pending-approvals'] as const;

export const pendingApprovalsApi = {
  list(): Promise<PendingMessage[]> {
    return httpClient<PendingMessage[]>('/life-intelligence/communication/pending');
  },

  approve(childId: string, messageId: string): Promise<void> {
    return httpClient<void>(`/life-intelligence/communication/${childId}/${messageId}/approve`, { method: 'POST' });
  },

  reject(childId: string, messageId: string): Promise<void> {
    return httpClient<void>(`/life-intelligence/communication/${childId}/${messageId}/reject`, { method: 'POST' });
  },
};
