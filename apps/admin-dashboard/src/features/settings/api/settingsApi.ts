import { httpClient } from '../../../shared/lib/httpClient';

export interface UserProfile {
  id: string;
  email: string;
  fullName: string;
  phone: string | null;
  locale: string;
  timezone: string;
}

export interface FamilySettings {
  id: string;
  name: string;
  timezone: string;
  subscriptionPlan: string;
}

export interface PlanDefinition {
  tier: string;
  name: string;
  priceCents: number;
  currency: string;
  features: string[];
}

export interface SubscriptionInfo {
  subscription: {
    id: string;
    planTier: string;
    status: string;
    provider: string;
  } | null;
  isInTrial: boolean;
  trialDaysRemaining: number;
}

export interface Invoice {
  id: string;
  amountCents: number;
  currency: string;
  status: string;
  issuedAt: string;
}

export interface ConsentRecord {
  consentType: string;
  granted: boolean;
  grantedAt: string;
  revokedAt: string | null;
}

export const settingsApi = {
  getProfile(): Promise<UserProfile> {
    return httpClient<UserProfile>('/profile');
  },
  updateProfile(input: Partial<Pick<UserProfile, 'fullName' | 'phone' | 'locale' | 'timezone'>>): Promise<UserProfile> {
    return httpClient<UserProfile>('/profile', { method: 'PATCH', body: input });
  },

  getFamilySettings(): Promise<FamilySettings> {
    return httpClient<FamilySettings>('/settings');
  },
  updateFamilySettings(input: Partial<Pick<FamilySettings, 'name' | 'timezone'>>): Promise<FamilySettings> {
    return httpClient<FamilySettings>('/settings', { method: 'PATCH', body: input });
  },

  listPlans(): Promise<PlanDefinition[]> {
    return httpClient<PlanDefinition[]>('/billing/plans');
  },
  getSubscription(): Promise<SubscriptionInfo> {
    return httpClient<SubscriptionInfo>('/billing/subscription');
  },
  startTrial() {
    return httpClient('/billing/trial/start', { method: 'POST' });
  },
  subscribe(planTier: string, provider: string) {
    return httpClient('/billing/subscribe', { method: 'POST', body: { planTier, provider } });
  },
  cancelSubscription() {
    return httpClient('/billing/cancel', { method: 'POST' });
  },
  getBillingHistory(): Promise<Invoice[]> {
    return httpClient<Invoice[]>('/billing/history');
  },

  // CLOSES A REAL GAP (proactive business/code audit — parity review):
  // the Parent App (Flutter) had consent management and account
  // deletion; this Dashboard had neither, confirmed after a thorough
  // search (unlike billing, which turned out to already exist here).
  listConsents(childId: string): Promise<ConsentRecord[]> {
    return httpClient<ConsentRecord[]>(`/children/${childId}/consents`);
  },
  setConsent(childId: string, consentType: string, granted: boolean) {
    return httpClient(`/children/${childId}/consents`, { method: 'POST', body: { consentType, granted } });
  },
  deleteAccount(currentPassword: string) {
    return httpClient('/account', { method: 'DELETE', body: { currentPassword } });
  },
};
