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

  findMembers(organizationId: string): Promise<IOrganizationMember[]>;
  addMember(organizationId: string, userId: string, role: string): Promise<IOrganizationMember>;

  createInvitation(input: Omit<IOrganizationInvitation, 'id' | 'status'>): Promise<IOrganizationInvitation>;
  findActiveCampaignByCode(code: string): Promise<IPartnerCampaign | null>;
}
