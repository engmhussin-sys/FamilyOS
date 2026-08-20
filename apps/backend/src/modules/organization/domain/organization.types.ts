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

/**
 * PHASE E (`PC-S-007`) — THE ROLE HIERARCHY, MOVED HERE FROM
 * `RbacEngineService`'s private static so that there is exactly ONE ordering
 * of organisation roles in this codebase.
 *
 * It moved because a second consumer appeared and a second consumer is how a
 * hierarchy becomes two hierarchies that disagree: `OrganizationService` has
 * to compare a GRANTED role against the GRANTER's role (an escalation check),
 * which is a different question from «does this role clear this action's
 * minimum level» (`RbacEngineService`'s question) but must be answered by the
 * same ladder. The ranks are unchanged, and `RbacEngineService` now reads
 * this table rather than owning a copy of it.
 */
export const ORGANIZATION_ROLE_RANK: Readonly<Record<OrganizationRoleValue, number>> = {
  OWNER: 4,
  ADMIN: 3,
  MANAGER: 2,
  MEMBER: 1,
  GUEST: 0,
};

/**
 * «Can an actor holding `actorRole` grant `grantedRole`?»
 *
 * EQUALITY IS ALLOWED and that is a deliberate product call, not an
 * oversight: an OWNER naming a co-OWNER is a legitimate B2B arrangement (a
 * school with two principals), and forbidding it would make every
 * organisation permanently dependent on a single person, with no in-product
 * way to recover from that person leaving. What is forbidden is granting
 * ABOVE oneself, which is the escalation.
 */
export function canGrantOrganizationRole(
  actorRole: OrganizationRoleValue,
  grantedRole: OrganizationRoleValue,
): boolean {
  return ORGANIZATION_ROLE_RANK[actorRole] >= ORGANIZATION_ROLE_RANK[grantedRole];
}

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
  /** CLOSES A REAL GAP found while implementing this Sprint 9
   * contract: the schema's OrganizationInvitation.invitedByUserId is
   * a required column with no corresponding field here originally. */
  invitedByUserId: string;
}

export interface IPartnerCampaign {
  id: string;
  organizationId: string;
  code: string;
  type: PartnerCampaignTypeValue;
  config: Record<string, unknown>;
  isActive: boolean;
  /** CLOSES A REAL GAP found while implementing Sprint B4: the
   * schema column and findActiveCampaignByCode's own expiry check
   * both already existed, but this domain type never had a field
   * for it — making it impossible to actually SET an expiry at
   * creation time. */
  expiresAt: Date | null;
}

/** Sprint B5 — CLOSES A REAL GAP: Organization.settings (Json,
 * intentionally loose per Sprint 9's own docstring: "concrete fields
 * are a product decision for whoever builds the White Label config
 * UI, not an architecture-layer concern") had zero concrete shape
 * until this Sprint. Deliberately minimal for a first pass — logo +
 * two colors, not a full theming system (fonts, layout variants,
 * per-screen overrides are real future extensions once a partner
 * actually asks for them). */
export interface IBrandingSettings {
  logoUrl?: string;
  primaryColor?: string;
  secondaryColor?: string;
}
