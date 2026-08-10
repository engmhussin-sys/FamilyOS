import { Inject, Injectable, ForbiddenException, NotFoundException, BadRequestException } from '@nestjs/common';

import { ORGANIZATION_REPOSITORY, type IOrganizationRepository } from '../ports/organization.repository.port';
import { RBAC_ENGINE, type IRbacEngine } from '../ports/rbac-engine.port';
import { POLICY_ENGINE, type IPolicyEngine } from '../ports/policy-engine.port';
import { AuditService } from '../../../audit/application/audit.service';
import { USER_REPOSITORY, type IUserRepository } from '../../../auth/application/ports/auth.repository.ports';
import type {
  IOrganization,
  IOrganizationInvitation,
  IOrganizationMember,
  OrganizationRoleValue,
  OrganizationTypeValue,
  PartnerCampaignTypeValue,
  IBrandingSettings,
} from '../../domain/organization.types';

/**
 * Sprint B1 — the first real service for the Organization surface
 * (Sprint 9's architecture, previously zero implementation). Mirrors
 * ChildrenService's own thin-orchestration style: verify, then
 * delegate to the repository — no business logic duplicated here
 * that the repository or RBAC engine already owns.
 *
 * UPDATED (Sprint B6): CLOSES A REAL GAP found while building the
 * BANK organization type specifically — every write operation here
 * (create, invite, policy change, branding change, campaign
 * creation) had ZERO audit trail. This matters for every
 * organization type, but is a genuine, non-negotiable compliance
 * baseline for a BANK specifically — a bank's own internal audit
 * requires knowing WHO changed WHAT, WHEN. Uses the existing
 * AuditService exactly as SubscriptionService.cancel() already does
 * — no new audit mechanism invented.
 *
 * HONEST SCOPE NOTE: this is an audit TRAIL (who/what/when), not a
 * claim of regulatory compliance (PCI-DSS, SAMA/central-bank
 * requirements, SOC 2, etc.) — those are real legal/compliance
 * determinations this project has consistently declined to
 * fabricate, same discipline as never guessing at real pricing or
 * writing real Terms of Service text.
 */
@Injectable()
export class OrganizationService {
  constructor(
    @Inject(ORGANIZATION_REPOSITORY) private readonly repository: IOrganizationRepository,
    @Inject(RBAC_ENGINE) private readonly rbac: IRbacEngine,
    @Inject(POLICY_ENGINE) private readonly policyEngine: IPolicyEngine,
    private readonly auditService: AuditService,
    @Inject(USER_REPOSITORY) private readonly userRepository: IUserRepository,
  ) {}

  /** Creating a top-level organization (no parent) is open to any
   * authenticated user — they become its OWNER. Creating a CHILD
   * organization (e.g. a School's Department) requires ADMIN+ on the
   * parent, enforced via the RBAC engine this Sprint just built. */
  async createOrganization(
    creatorUserId: string,
    type: OrganizationTypeValue,
    name: string,
    parentOrganizationId: string | null,
  ): Promise<IOrganization> {
    if (parentOrganizationId) {
      const parent = await this.repository.findById(parentOrganizationId);
      if (!parent) {
        throw new NotFoundException(`Parent organization "${parentOrganizationId}" not found.`);
      }
      const canManage = await this.rbac.hasPermission({
        userId: creatorUserId,
        organizationId: parentOrganizationId,
        resource: 'organization.child_organization',
        action: 'ADMIN',
      });
      if (!canManage) {
        throw new ForbiddenException('You do not have permission to create a sub-organization here.');
      }
    }

    const organization = await this.repository.create({ type, name, parentOrganizationId, settings: null });
    await this.repository.addMember(organization.id, creatorUserId, 'OWNER');

    await this.auditService.record({
      actorType: 'USER',
      actorUserId: creatorUserId,
      action: 'organization.created',
      entityType: 'Organization',
      entityId: organization.id,
      metadata: { type, name, parentOrganizationId },
    });

    return organization;
  }

  /** CLOSES A REAL GAP (Sprint B3): the actual entry point any real
   * UI needs FIRST — "what organizations do I belong to at all." */
  async listMyOrganizations(userId: string): Promise<IOrganization[]> {
    return this.repository.findOrganizationsForUser(userId);
  }

  async getOrganizationOrThrow(organizationId: string, requestingUserId: string): Promise<IOrganization> {
    const organization = await this.repository.findById(organizationId);
    if (!organization) {
      throw new NotFoundException(`Organization "${organizationId}" not found.`);
    }
    const role = await this.rbac.getRole(requestingUserId, organizationId);
    if (!role) {
      // Same "404, not 403" discipline this codebase already uses
      // for family-scoped ownership checks — never confirm an
      // organization's existence to someone with no membership in it.
      throw new NotFoundException(`Organization "${organizationId}" not found.`);
    }
    return organization;
  }

  async listMembers(organizationId: string, requestingUserId: string): Promise<IOrganizationMember[]> {
    await this.getOrganizationOrThrow(organizationId, requestingUserId);
    return this.repository.findMembers(organizationId);
  }

  async inviteMember(
    organizationId: string,
    requestingUserId: string,
    email: string,
    role: OrganizationRoleValue,
  ): Promise<IOrganizationInvitation> {
    await this.getOrganizationOrThrow(organizationId, requestingUserId);

    const canInvite = await this.rbac.hasPermission({
      userId: requestingUserId,
      organizationId,
      resource: 'organization.member',
      action: 'WRITE',
    });
    if (!canInvite) {
      throw new ForbiddenException('You do not have permission to invite members to this organization.');
    }

    const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
    const invitation = await this.repository.createInvitation({
      organizationId,
      email,
      role,
      expiresAt: new Date(Date.now() + SEVEN_DAYS_MS),
      invitedByUserId: requestingUserId,
    });

    await this.auditService.record({
      actorType: 'USER',
      actorUserId: requestingUserId,
      action: 'organization.member_invited',
      entityType: 'Organization',
      entityId: organizationId,
      metadata: { invitedEmail: email, role },
    });

    return invitation;
  }

  /** CLOSES A CRITICAL GAP found in a final review: invitations could
   * be created, but nothing let anyone actually accept one — the
   * feature was unusable end-to-end. Verifies, in order: the
   * invitation exists, it's still PENDING (not already accepted,
   * expired, or revoked), it hasn't passed its expiresAt, and —
   * critically — the ACCEPTING user's own email matches the invited
   * email, so one user can never accept an invitation meant for
   * someone else just by knowing its id. */
  async acceptInvitation(invitationId: string, acceptingUserId: string): Promise<IOrganizationMember> {
    const invitation = await this.repository.findInvitationById(invitationId);
    if (!invitation) {
      throw new NotFoundException(`Invitation "${invitationId}" not found.`);
    }
    if (invitation.status !== 'PENDING') {
      throw new BadRequestException(`This invitation is ${invitation.status.toLowerCase()} and can no longer be accepted.`);
    }
    if (invitation.expiresAt < new Date()) {
      throw new BadRequestException('This invitation has expired.');
    }

    const acceptingUser = await this.userRepository.findById(acceptingUserId);
    if (!acceptingUser || acceptingUser.email.toLowerCase() !== invitation.email.toLowerCase()) {
      throw new ForbiddenException('This invitation was sent to a different email address.');
    }

    const member = await this.repository.acceptInvitation(invitationId, acceptingUserId);

    await this.auditService.record({
      actorType: 'USER',
      actorUserId: acceptingUserId,
      action: 'organization.invitation_accepted',
      entityType: 'Organization',
      entityId: invitation.organizationId,
      metadata: { invitationId },
    });

    return member;
  }

  /** Sprint B2 — real, WRITE-permission-gated policy setting. e.g. a
   * School's ADMIN setting a default screen-time-related policy for
   * every Family sub-organization enrolled under it. */
  async setPolicy(organizationId: string, requestingUserId: string, key: string, value: unknown): Promise<void> {
    await this.getOrganizationOrThrow(organizationId, requestingUserId);

    const canWrite = await this.rbac.hasPermission({
      userId: requestingUserId,
      organizationId,
      resource: 'organization.policy',
      action: 'WRITE',
    });
    if (!canWrite) {
      throw new ForbiddenException('You do not have permission to set policies for this organization.');
    }

    await this.policyEngine.setPolicy(organizationId, key, value);

    await this.auditService.record({
      actorType: 'USER',
      actorUserId: requestingUserId,
      action: 'organization.policy_set',
      entityType: 'Organization',
      entityId: organizationId,
      // Key only — never the value itself, since policy values are
      // free-form (Json) and could legitimately contain something
      // sensitive a bank sets (e.g. a compliance threshold). The
      // audit trail proves WHAT KEY changed and WHO changed it,
      // matching AuditService's own existing discipline elsewhere in
      // this codebase of never logging raw sensitive payloads.
      metadata: { key },
    });
  }

  /** READ-permission-gated — any real member (including GUEST) can
   * see the effective policy that applies to them, matching the
   * RBAC engine's own min-level table (READ requires no more than
   * genuine membership). */
  async getEffectivePolicy<T = unknown>(organizationId: string, requestingUserId: string, key: string): Promise<T | null> {
    await this.getOrganizationOrThrow(organizationId, requestingUserId);
    return this.policyEngine.getEffectivePolicy<T>(organizationId, key);
  }

  /** Sprint B4 — WRITE-permission-gated campaign creation, same
   * discipline as setPolicy. */
  async createCampaign(
    organizationId: string,
    requestingUserId: string,
    code: string,
    type: PartnerCampaignTypeValue,
    config: Record<string, unknown>,
    isActive: boolean,
  ) {
    await this.getOrganizationOrThrow(organizationId, requestingUserId);

    const canWrite = await this.rbac.hasPermission({
      userId: requestingUserId,
      organizationId,
      resource: 'organization.campaign',
      action: 'WRITE',
    });
    if (!canWrite) {
      throw new ForbiddenException('You do not have permission to create campaigns for this organization.');
    }

    const campaign = await this.repository.createCampaign({ organizationId, code, type, config, isActive, expiresAt: null });

    await this.auditService.record({
      actorType: 'USER',
      actorUserId: requestingUserId,
      action: 'organization.campaign_created',
      entityType: 'Organization',
      entityId: organizationId,
      metadata: { code, type },
    });

    return campaign;
  }

  /** CLOSES A REAL GAP found in a final usability review. READ-scoped
   * — any genuine member can see their organization's campaigns,
   * same discipline as getEffectivePolicy. */
  async listCampaigns(organizationId: string, requestingUserId: string) {
    await this.getOrganizationOrThrow(organizationId, requestingUserId);
    return this.repository.findCampaignsByOrganization(organizationId);
  }

  /** Sprint B5 — White-Label. WRITE-permission-gated, same
   * discipline as setPolicy/createCampaign. Merges with any existing
   * settings rather than overwriting the whole JSON blob — a partial
   * update (e.g. just changing logoUrl) should never silently wipe
   * out a previously-set primaryColor. */
  async updateBranding(
    organizationId: string,
    requestingUserId: string,
    branding: IBrandingSettings,
  ): Promise<IOrganization> {
    const organization = await this.getOrganizationOrThrow(organizationId, requestingUserId);

    const canWrite = await this.rbac.hasPermission({
      userId: requestingUserId,
      organizationId,
      resource: 'organization.branding',
      action: 'WRITE',
    });
    if (!canWrite) {
      throw new ForbiddenException('You do not have permission to update branding for this organization.');
    }

    const mergedSettings = { ...(organization.settings ?? {}), ...branding };
    const updated = await this.repository.updateSettings(organizationId, mergedSettings);

    await this.auditService.record({
      actorType: 'USER',
      actorUserId: requestingUserId,
      action: 'organization.branding_updated',
      entityType: 'Organization',
      entityId: organizationId,
      metadata: { changedKeys: Object.keys(branding) },
    });

    return updated;
  }
}
