import { httpClient } from '../../../shared/lib/httpClient';

export interface Organization {
  id: string;
  type: 'FAMILY' | 'SCHOOL' | 'COMPANY' | 'BANK';
  name: string;
  parentOrganizationId: string | null;
  settings: Record<string, unknown> | null;
}

export interface OrganizationMember {
  id: string;
  organizationId: string;
  userId: string;
  role: 'OWNER' | 'ADMIN' | 'MANAGER' | 'MEMBER' | 'GUEST';
}

export interface OrganizationInvitation {
  id: string;
  organizationId: string;
  email: string;
  role: string;
  status: string;
  expiresAt: string;
}

/** Sprint B3 — the Dashboard client for the Organization module (Sprint
 * B1/B2 backend). First real B2B2C surface — Company as the pilot
 * organization type, per the roadmap's own "Company first, Bank later"
 * sequencing (lower compliance sensitivity for a first real pilot). */
export const organizationApi = {
  listMine(): Promise<Organization[]> {
    return httpClient<Organization[]>('/organizations/mine');
  },
  create(type: string, name: string): Promise<Organization> {
    return httpClient<Organization>('/organizations', { method: 'POST', body: { type, name } });
  },
  listMembers(organizationId: string): Promise<OrganizationMember[]> {
    return httpClient<OrganizationMember[]>(`/organizations/${organizationId}/members`);
  },
  inviteMember(organizationId: string, email: string, role: string): Promise<OrganizationInvitation> {
    return httpClient<OrganizationInvitation>(`/organizations/${organizationId}/invitations`, {
      method: 'POST',
      body: { email, role },
    });
  },
  setPolicy(organizationId: string, key: string, value: unknown): Promise<void> {
    return httpClient<void>(`/organizations/${organizationId}/policies`, { method: 'POST', body: { key, value } });
  },
  getEffectivePolicy<T = unknown>(organizationId: string, key: string): Promise<T> {
    return httpClient<T>(`/organizations/${organizationId}/policies/${key}/effective`);
  },
  updateBranding(organizationId: string, branding: { logoUrl?: string; primaryColor?: string; secondaryColor?: string }): Promise<Organization> {
    return httpClient<Organization>(`/organizations/${organizationId}/branding`, { method: 'POST', body: branding });
  },
  acceptInvitation(invitationId: string): Promise<OrganizationMember> {
    return httpClient<OrganizationMember>(`/organizations/invitations/${invitationId}/accept`, { method: 'POST' });
  },
};
