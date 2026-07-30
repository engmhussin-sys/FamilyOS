/**
 * Sprint 9 addendum \u2014 Organization Platform architecture direction.
 * Every type here mirrors the additive schema in schema.prisma exactly.
 * NOTHING in this file is wired into AppModule, injected anywhere, or
 * called by any existing service \u2014 these are contracts for future
 * Sprints to implement against, per the explicit "architecture and
 * interfaces, not full implementation" scope.
 */

export type OrganizationTypeValue = 'FAMILY' | 'SCHOOL' | 'COMPANY' | 'BANK';
export type OrganizationRoleValue = 'OWNER' | 'ADMIN' | 'MANAGER' | 'MEMBER' | 'GUEST';
export type InvitationStatusValue = 'PENDING' | 'ACCEPTED' | 'EXPIRED' | 'REVOKED';
export type PartnerCampaignTypeValue = 'REFERRAL' | 'COUPON' | 'TRIAL_EXTENSION' | 'DISCOUNT' | 'QR_CODE';

export interface IOrganization {
  id: string;
  type: OrganizationTypeValue;
  name: string;
  parentOrganizationId: string | null;
  settings: Record<string, unknown> | null;
}

export interface IOrganizationMember {
  id: string;
  organizationId: string;
  userId: string;
  role: OrganizationRoleValue;
}

export interface IOrganizationPolicy {
  organizationId: string;
  key: string;
  value: unknown;
}

export interface IOrganizationInvitation {
  id: string;
  organizationId: string;
  email: string;
  role: OrganizationRoleValue;
  status: InvitationStatusValue;
  expiresAt: Date;
}

export interface IPartnerCampaign {
  id: string;
  organizationId: string;
  code: string;
  type: PartnerCampaignTypeValue;
  config: Record<string, unknown>;
  isActive: boolean;
}
