import type {
  IOrganization,
  IOrganizationInvitation,
  IOrganizationMember,
  IPartnerCampaign,
  OrganizationTypeValue,
} from '../../domain/organization.types';

/**
 * Sprint 9 addendum. Deliberately mirrors this project's own
 * Repository Pattern discipline (see every existing `*.repository.port.ts`)
 * so a future `PrismaOrganizationRepository` slots in exactly like
 * every other repository in this codebase, not a special case.
 *
 * NOT implemented in this sprint \u2014 no `PrismaOrganizationRepository`
 * class exists, no provider token is registered in any module.
 */
export const ORGANIZATION_REPOSITORY = Symbol('ORGANIZATION_REPOSITORY');

export interface IOrganizationRepository {
  findById(id: string): Promise<IOrganization | null>;
  findByType(type: OrganizationTypeValue): Promise<IOrganization[]>;
  findChildOrganizations(parentOrganizationId: string): Promise<IOrganization[]>;
  create(input: Omit<IOrganization, 'id'>): Promise<IOrganization>;

  /** CLOSES A REAL GAP found while building Sprint B5 (White-Label):
   * `settings` (documented for branding config since Sprint 9's own
   * Organization schema docstring) was write-once at creation, with
   * no way to actually update it afterward — the exact feature this
   * Sprint needs. */
  updateSettings(organizationId: string, settings: Record<string, unknown>): Promise<IOrganization>;

  /** CLOSES A REAL GAP found while building Sprint B3 (the first real
   * UI): without this, a logged-in user has no way to discover which
   * organizations they belong to at all — every other method requires
   * already knowing an organizationId. */
  findOrganizationsForUser(userId: string): Promise<IOrganization[]>;

  findMembers(organizationId: string): Promise<IOrganizationMember[]>;
  addMember(organizationId: string, userId: string, role: string): Promise<IOrganizationMember>;

  createInvitation(input: Omit<IOrganizationInvitation, 'id' | 'status'>): Promise<IOrganizationInvitation>;

  /** CLOSES A CRITICAL GAP found in a final review: invitations could
   * be CREATED but there was no way to look one up by id, and no way
   * to ACCEPT one at all — a write-only-missing-half gap, the same
   * shape as Support's original read gap and Campaign's original
   * create gap, but more severe: the entire invitation feature was
   * unusable end-to-end without this. */
  findInvitationById(invitationId: string): Promise<IOrganizationInvitation | null>;
  acceptInvitation(invitationId: string, acceptingUserId: string): Promise<IOrganizationMember>;

  /** CLOSES A REAL GAP found while building Sprint B4: this port
   * could only READ an active campaign by code, never CREATE one —
   * a write-only-missing-half gap of the same shape Support had
   * before its own read side was added. */
  createCampaign(input: Omit<IPartnerCampaign, 'id'>): Promise<IPartnerCampaign>;
  findActiveCampaignByCode(code: string): Promise<IPartnerCampaign | null>;

  /** CLOSES A REAL GAP found in a final usability review: an
   * organization could CREATE campaigns and look one up by exact
   * code, but had no way to see ALL of its own campaigns — a company
   * would need to remember every code it ever created by heart. */
  findCampaignsByOrganization(organizationId: string): Promise<IPartnerCampaign[]>;
}
