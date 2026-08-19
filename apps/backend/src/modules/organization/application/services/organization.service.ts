import { Inject, Injectable, ForbiddenException, NotFoundException, BadRequestException } from '@nestjs/common';

import { ORGANIZATION_REPOSITORY, type IOrganizationRepository } from '../ports/organization.repository.port';
import { RBAC_ENGINE, type IRbacEngine } from '../ports/rbac-engine.port';
import { POLICY_ENGINE, type IPolicyEngine } from '../ports/policy-engine.port';
import { AuditService } from '../../../audit/application/audit.service';
import { USER_REPOSITORY, type IUserRepository } from '../../../auth/application/ports/auth.repository.ports';
import { canGrantOrganizationRole } from '../../domain/organization.types';
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

    // PHASE E (`PC-S-007`) — NOBODY GRANTS A ROLE ABOVE THEIR OWN.
    //
    // `hasPermission({ action: 'WRITE' })` clears at MANAGER (level 2), while
    // DELETE and ADMIN both require OWNER (level 4). Without this check a
    // MANAGER could invite an OWNER at an address they control and hold the
    // whole organisation one acceptance later — and the only trace would be an
    // `organization.member_invited` audit row, which reads like routine
    // administration. The escalation is refused here, at the point the role is
    // chosen, and again in `acceptInvitation` at the point it is conferred.
    const actorRole = await this.rbac.getRole(requestingUserId, organizationId);
    if (!actorRole || !canGrantOrganizationRole(actorRole, role)) {
      throw new ForbiddenException('You cannot invite a member at a role higher than your own.');
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

  /**
   * THE ONE «no» FOR AN INVITATION THE CALLER MAY NOT ACT ON.
   *
   * Built in one place, from constants only, so the two paths that throw it
   * cannot drift into two different sentences — which is all an oracle needs
   * to come back. Nothing about the request is interpolated: the old message
   * carried `invitationId`, and a body that varies with the id is not a body
   * a probe can compare byte for byte.
   *
   * `{ code, messageAr }` is the B3 contract (`common/errors/error-response.ts`).
   * The Arabic is the sentence a parent actually reads, and it is the same
   * whether the id was never real or simply was not theirs.
   */
  private static invitationNotFound(): NotFoundException {
    return new NotFoundException({
      code: 'INVITATION_NOT_FOUND',
      message: 'This invitation is not available.',
      messageAr: 'هذه الدعوة غير متاحة. اطلب من الجهة التي دعتك إرسال دعوة جديدة إلى بريدك.',
    });
  }

  /** CLOSES A CRITICAL GAP found in a final review: invitations could
   * be created, but nothing let anyone actually accept one — the
   * feature was unusable end-to-end.
   *
   * =====================================================================
   * F1 — THE EXISTENCE ORACLE THIS ROUTE USED TO BE, AND THE ORDER THAT
   * REMOVES IT.
   * =====================================================================
   *
   * The checks were right; the ORDER was the defect. The old sequence asked
   * "does this row exist?" (404), then "what is its status?" (400), then
   * "has it expired?" (400), and only THEN "is the caller the person it was
   * sent to?" (403). Every answer before the last one was given to a caller
   * who had proved nothing at all — so any authenticated parent could walk
   * invitation ids and read back, for EVERY organization on the platform,
   * whether an id existed and whether it was pending, accepted, revoked or
   * expired. The email check that was supposed to be the whole control was
   * the last gate, behind three disclosures.
   *
   * THE RULE NOW: an invitation the caller may not act on is answered
   * EXACTLY as one that does not exist — same status (404), same body
   * (`INVITATION_NOT_FOUND`, no id interpolated, so the sentence is
   * byte-identical for a real id and an unknown one), and the same amount
   * of work (both lookups are issued unconditionally, in one `Promise.all`,
   * so the two paths are the same timing class rather than one DB round
   * trip apart).
   *
   * WHAT IS STILL SAID, AND WHY IT DISCLOSES NOTHING. Past the recipient
   * check, «already accepted» / «expired» / «the inviter can no longer
   * grant that role» remain distinct, real sentences. Their audience is the
   * person the invitation was addressed to, who received the id by email
   * and therefore already knows it exists; telling them nothing but 404
   * would trade a leak for an unusable feature. The oracle was never the
   * messages — it was giving them to strangers.
   */
  async acceptInvitation(invitationId: string, acceptingUserId: string): Promise<IOrganizationMember> {
    // BOTH READS, ALWAYS, CONCURRENTLY. Short-circuiting on a missing
    // invitation is what made "unknown id" one query and "not yours" two —
    // a difference a caller can measure even when the bodies match.
    const [invitation, acceptingUser] = await Promise.all([
      this.repository.findInvitationById(invitationId),
      this.userRepository.findById(acceptingUserId),
    ]);

    // THE SINGLE ANSWER for "no such invitation" and "not addressed to you".
    if (
      !invitation ||
      !acceptingUser ||
      acceptingUser.email.toLowerCase() !== invitation.email.toLowerCase()
    ) {
      throw OrganizationService.invitationNotFound();
    }

    if (invitation.status !== 'PENDING') {
      throw new BadRequestException(`This invitation is ${invitation.status.toLowerCase()} and can no longer be accepted.`);
    }
    if (invitation.expiresAt < new Date()) {
      throw new BadRequestException('This invitation has expired.');
    }

    // PHASE E (`PC-S-007`) — THE SAME RULE, RE-CHECKED AT CONFERRAL.
    //
    // The invitation ROW carries the role and is redeemed up to seven days
    // later, by a different person. Checking only at invite time would leave a
    // week-long window in which an OWNER-level grant outlives the authority
    // that issued it: an owner who invites a co-owner and is then demoted (or
    // whose account is compromised, invitation sent, then cleaned up) has left
    // a live escalation on the table. The inviter's CURRENT rank is what
    // authorises the grant, so it is read now and not trusted from then.
    const inviterRole = await this.rbac.getRole(invitation.invitedByUserId, invitation.organizationId);
    if (!inviterRole || !canGrantOrganizationRole(inviterRole, invitation.role)) {
      throw new ForbiddenException('The person who sent this invitation can no longer grant that role.');
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
