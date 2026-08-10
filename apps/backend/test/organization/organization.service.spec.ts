import { Test } from '@nestjs/testing';
import { ForbiddenException, NotFoundException, BadRequestException } from '@nestjs/common';

import { OrganizationService } from '../../src/modules/organization/application/services/organization.service';
import { ORGANIZATION_REPOSITORY } from '../../src/modules/organization/application/ports/organization.repository.port';
import { RBAC_ENGINE } from '../../src/modules/organization/application/ports/rbac-engine.port';
import { POLICY_ENGINE } from '../../src/modules/organization/application/ports/policy-engine.port';
import { AuditService } from '../../src/modules/audit/application/audit.service';
import { USER_REPOSITORY } from '../../src/modules/auth/application/ports/auth.repository.ports';

describe('OrganizationService (Sprint B1)', () => {
  const repositoryMock = {
    findById: jest.fn(),
    findByType: jest.fn(),
    findChildOrganizations: jest.fn(),
    findOrganizationsForUser: jest.fn(),
    create: jest.fn(),
    updateSettings: jest.fn(),
    findMembers: jest.fn(),
    addMember: jest.fn(),
    createInvitation: jest.fn(),
    findInvitationById: jest.fn(),
    acceptInvitation: jest.fn(),
    createCampaign: jest.fn(),
    findActiveCampaignByCode: jest.fn(),
  };
  const rbacMock = { hasPermission: jest.fn(), getRole: jest.fn() };
  const policyEngineMock = { getPolicy: jest.fn(), setPolicy: jest.fn(), getEffectivePolicy: jest.fn() };
  const auditServiceMock = { record: jest.fn() };
  const userRepositoryMock = { findById: jest.fn() };

  let service: OrganizationService;

  beforeEach(async () => {
    jest.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [
        OrganizationService,
        { provide: ORGANIZATION_REPOSITORY, useValue: repositoryMock },
        { provide: RBAC_ENGINE, useValue: rbacMock },
        { provide: POLICY_ENGINE, useValue: policyEngineMock },
        { provide: AuditService, useValue: auditServiceMock },
        { provide: USER_REPOSITORY, useValue: userRepositoryMock },
      ],
    }).compile();
    service = moduleRef.get(OrganizationService);
  });

  describe('createOrganization', () => {
    it('creates a top-level organization freely (no parent, no RBAC check needed) and makes the creator OWNER', async () => {
      repositoryMock.create.mockResolvedValue({ id: 'org-1', type: 'COMPANY', name: 'Acme', parentOrganizationId: null, settings: null });

      const result = await service.createOrganization('user-1', 'COMPANY', 'Acme', null);

      expect(rbacMock.hasPermission).not.toHaveBeenCalled();
      expect(repositoryMock.addMember).toHaveBeenCalledWith('org-1', 'user-1', 'OWNER');
      expect(result.id).toBe('org-1');
    });

    it('requires ADMIN permission on the parent before creating a child organization', async () => {
      repositoryMock.findById.mockResolvedValue({ id: 'parent-1', type: 'SCHOOL', name: 'Main School', parentOrganizationId: null, settings: null });
      rbacMock.hasPermission.mockResolvedValue(false);

      await expect(service.createOrganization('user-1', 'SCHOOL', 'Branch', 'parent-1')).rejects.toBeInstanceOf(ForbiddenException);

      expect(repositoryMock.create).not.toHaveBeenCalled();
    });

    it('throws NotFoundException for a nonexistent parent organization', async () => {
      repositoryMock.findById.mockResolvedValue(null);

      await expect(service.createOrganization('user-1', 'SCHOOL', 'Branch', 'missing-parent')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('allows creating a child org when the creator has ADMIN on the parent', async () => {
      repositoryMock.findById.mockResolvedValue({ id: 'parent-1', type: 'SCHOOL', name: 'Main School', parentOrganizationId: null, settings: null });
      rbacMock.hasPermission.mockResolvedValue(true);
      repositoryMock.create.mockResolvedValue({ id: 'org-2', type: 'SCHOOL', name: 'Branch', parentOrganizationId: 'parent-1', settings: null });

      const result = await service.createOrganization('user-1', 'SCHOOL', 'Branch', 'parent-1');

      expect(result.id).toBe('org-2');
    });
  });

  describe('listMyOrganizations (Sprint B3)', () => {
    it('delegates directly to the repository — no RBAC check needed, a user always sees their own memberships', async () => {
      repositoryMock.findOrganizationsForUser.mockResolvedValue([
        { id: 'org-1', type: 'COMPANY', name: 'Acme', parentOrganizationId: null, settings: null },
      ]);

      const result = await service.listMyOrganizations('user-1');

      expect(repositoryMock.findOrganizationsForUser).toHaveBeenCalledWith('user-1');
      expect(result).toHaveLength(1);
    });

    it('returns an empty array (not an error) for a user with zero organization memberships', async () => {
      repositoryMock.findOrganizationsForUser.mockResolvedValue([]);

      const result = await service.listMyOrganizations('user-with-no-orgs');

      expect(result).toEqual([]);
    });
  });

  describe('getOrganizationOrThrow', () => {
    it('throws NotFoundException (never ForbiddenException) for a non-member — same "404 not 403" discipline as family ownership checks', async () => {
      repositoryMock.findById.mockResolvedValue({ id: 'org-1', type: 'COMPANY', name: 'Acme', parentOrganizationId: null, settings: null });
      rbacMock.getRole.mockResolvedValue(null);

      await expect(service.getOrganizationOrThrow('org-1', 'stranger')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('returns the organization for a genuine member', async () => {
      repositoryMock.findById.mockResolvedValue({ id: 'org-1', type: 'COMPANY', name: 'Acme', parentOrganizationId: null, settings: null });
      rbacMock.getRole.mockResolvedValue('MEMBER');

      const result = await service.getOrganizationOrThrow('org-1', 'user-1');

      expect(result.id).toBe('org-1');
    });
  });

  describe('inviteMember', () => {
    it('requires WRITE permission before inviting', async () => {
      repositoryMock.findById.mockResolvedValue({ id: 'org-1', type: 'COMPANY', name: 'Acme', parentOrganizationId: null, settings: null });
      rbacMock.getRole.mockResolvedValue('MEMBER');
      rbacMock.hasPermission.mockResolvedValue(false);

      await expect(service.inviteMember('org-1', 'user-1', 'new@example.com', 'MEMBER')).rejects.toBeInstanceOf(ForbiddenException);

      expect(repositoryMock.createInvitation).not.toHaveBeenCalled();
    });

    it('creates a real invitation with a 7-day expiry when permitted', async () => {
      repositoryMock.findById.mockResolvedValue({ id: 'org-1', type: 'COMPANY', name: 'Acme', parentOrganizationId: null, settings: null });
      rbacMock.getRole.mockResolvedValue('ADMIN');
      rbacMock.hasPermission.mockResolvedValue(true);
      repositoryMock.createInvitation.mockResolvedValue({
        id: 'inv-1',
        organizationId: 'org-1',
        email: 'new@example.com',
        role: 'MEMBER',
        status: 'PENDING',
        expiresAt: new Date(),
        invitedByUserId: 'user-1',
      });

      const result = await service.inviteMember('org-1', 'user-1', 'new@example.com', 'MEMBER');

      expect(repositoryMock.createInvitation).toHaveBeenCalledWith(
        expect.objectContaining({ organizationId: 'org-1', email: 'new@example.com', role: 'MEMBER', invitedByUserId: 'user-1' }),
      );
      expect(result.id).toBe('inv-1');
    });
  });

  describe('setPolicy (Sprint B2)', () => {
    it('requires WRITE permission before setting a policy', async () => {
      repositoryMock.findById.mockResolvedValue({ id: 'org-1', type: 'SCHOOL', name: 'Main School', parentOrganizationId: null, settings: null });
      rbacMock.getRole.mockResolvedValue('MEMBER');
      rbacMock.hasPermission.mockResolvedValue(false);

      await expect(service.setPolicy('org-1', 'user-1', 'default_screen_time_minutes', 90)).rejects.toBeInstanceOf(ForbiddenException);

      expect(policyEngineMock.setPolicy).not.toHaveBeenCalled();
    });

    it('sets the policy when WRITE-permitted', async () => {
      repositoryMock.findById.mockResolvedValue({ id: 'org-1', type: 'SCHOOL', name: 'Main School', parentOrganizationId: null, settings: null });
      rbacMock.getRole.mockResolvedValue('ADMIN');
      rbacMock.hasPermission.mockResolvedValue(true);

      await service.setPolicy('org-1', 'user-1', 'default_screen_time_minutes', 90);

      expect(policyEngineMock.setPolicy).toHaveBeenCalledWith('org-1', 'default_screen_time_minutes', 90);
    });
  });

  describe('getEffectivePolicy (Sprint B2)', () => {
    it('requires genuine membership (verified via getOrganizationOrThrow) before reading', async () => {
      repositoryMock.findById.mockResolvedValue({ id: 'org-1', type: 'SCHOOL', name: 'Main School', parentOrganizationId: null, settings: null });
      rbacMock.getRole.mockResolvedValue(null);

      await expect(service.getEffectivePolicy('org-1', 'stranger', 'default_screen_time_minutes')).rejects.toBeInstanceOf(NotFoundException);

      expect(policyEngineMock.getEffectivePolicy).not.toHaveBeenCalled();
    });

    it('delegates to the policy engine for a real member', async () => {
      repositoryMock.findById.mockResolvedValue({ id: 'org-1', type: 'SCHOOL', name: 'Main School', parentOrganizationId: null, settings: null });
      rbacMock.getRole.mockResolvedValue('GUEST');
      policyEngineMock.getEffectivePolicy.mockResolvedValue(90);

      const result = await service.getEffectivePolicy('org-1', 'user-1', 'default_screen_time_minutes');

      expect(policyEngineMock.getEffectivePolicy).toHaveBeenCalledWith('org-1', 'default_screen_time_minutes');
      expect(result).toBe(90);
    });
  });

  describe('updateBranding (Sprint B5)', () => {
    it('requires WRITE permission before updating branding', async () => {
      repositoryMock.findById.mockResolvedValue({ id: 'org-1', type: 'COMPANY', name: 'Acme', parentOrganizationId: null, settings: null });
      rbacMock.getRole.mockResolvedValue('MEMBER');
      rbacMock.hasPermission.mockResolvedValue(false);

      await expect(service.updateBranding('org-1', 'user-1', { logoUrl: 'https://acme.com/logo.png' })).rejects.toBeInstanceOf(ForbiddenException);

      expect(repositoryMock.updateSettings).not.toHaveBeenCalled();
    });

    it('MERGES with existing settings rather than overwriting the whole blob — a partial update must not wipe unrelated fields', async () => {
      repositoryMock.findById.mockResolvedValue({
        id: 'org-1', type: 'COMPANY', name: 'Acme', parentOrganizationId: null,
        settings: { primaryColor: '#FF0000', secondaryColor: '#00FF00' },
      });
      rbacMock.getRole.mockResolvedValue('ADMIN');
      rbacMock.hasPermission.mockResolvedValue(true);
      repositoryMock.updateSettings.mockResolvedValue({ id: 'org-1', type: 'COMPANY', name: 'Acme', parentOrganizationId: null, settings: {} });

      await service.updateBranding('org-1', 'user-1', { logoUrl: 'https://acme.com/logo.png' });

      expect(repositoryMock.updateSettings).toHaveBeenCalledWith('org-1', {
        primaryColor: '#FF0000',
        secondaryColor: '#00FF00',
        logoUrl: 'https://acme.com/logo.png',
      });
    });

    it('handles an organization with no prior settings at all (null) without crashing', async () => {
      repositoryMock.findById.mockResolvedValue({ id: 'org-1', type: 'COMPANY', name: 'Acme', parentOrganizationId: null, settings: null });
      rbacMock.getRole.mockResolvedValue('OWNER');
      rbacMock.hasPermission.mockResolvedValue(true);
      repositoryMock.updateSettings.mockResolvedValue({ id: 'org-1', type: 'COMPANY', name: 'Acme', parentOrganizationId: null, settings: {} });

      await service.updateBranding('org-1', 'user-1', { primaryColor: '#123456' });

      expect(repositoryMock.updateSettings).toHaveBeenCalledWith('org-1', { primaryColor: '#123456' });
    });
  });

  describe('audit trail (Sprint B6 — CLOSES A REAL GAP found while building the BANK organization type: zero audit trail existed for any organization write operation)', () => {
    it('records organization.created with the actor, on successful creation', async () => {
      repositoryMock.create.mockResolvedValue({ id: 'org-1', type: 'BANK', name: 'First National', parentOrganizationId: null, settings: null });

      await service.createOrganization('user-1', 'BANK', 'First National', null);

      expect(auditServiceMock.record).toHaveBeenCalledWith(
        expect.objectContaining({ actorType: 'USER', actorUserId: 'user-1', action: 'organization.created', entityId: 'org-1' }),
      );
    });

    it('records organization.member_invited on a successful invite', async () => {
      repositoryMock.findById.mockResolvedValue({ id: 'org-1', type: 'BANK', name: 'First National', parentOrganizationId: null, settings: null });
      rbacMock.getRole.mockResolvedValue('ADMIN');
      rbacMock.hasPermission.mockResolvedValue(true);
      repositoryMock.createInvitation.mockResolvedValue({ id: 'inv-1', organizationId: 'org-1', email: 'x@x.com', role: 'MEMBER', status: 'PENDING', expiresAt: new Date(), invitedByUserId: 'user-1' });

      await service.inviteMember('org-1', 'user-1', 'x@x.com', 'MEMBER');

      expect(auditServiceMock.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'organization.member_invited', entityId: 'org-1', metadata: { invitedEmail: 'x@x.com', role: 'MEMBER' } }),
      );
    });

    it('records organization.policy_set with the KEY only, never the value itself (compliance-sensitive values should not leak into audit metadata)', async () => {
      repositoryMock.findById.mockResolvedValue({ id: 'org-1', type: 'BANK', name: 'First National', parentOrganizationId: null, settings: null });
      rbacMock.getRole.mockResolvedValue('ADMIN');
      rbacMock.hasPermission.mockResolvedValue(true);

      await service.setPolicy('org-1', 'user-1', 'compliance_threshold', { sensitiveInternalValue: 12345 });

      expect(auditServiceMock.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'organization.policy_set', metadata: { key: 'compliance_threshold' } }),
      );
      const call = auditServiceMock.record.mock.calls[0][0];
      expect(JSON.stringify(call.metadata)).not.toContain('sensitiveInternalValue');
    });

    it('does NOT record an audit event when a write is denied by RBAC — only real changes are audited', async () => {
      repositoryMock.findById.mockResolvedValue({ id: 'org-1', type: 'BANK', name: 'First National', parentOrganizationId: null, settings: null });
      rbacMock.getRole.mockResolvedValue('MEMBER');
      rbacMock.hasPermission.mockResolvedValue(false);

      await expect(service.setPolicy('org-1', 'user-1', 'key', 'value')).rejects.toBeInstanceOf(ForbiddenException);

      expect(auditServiceMock.record).not.toHaveBeenCalled();
    });

    it('records organization.campaign_created', async () => {
      repositoryMock.findById.mockResolvedValue({ id: 'org-1', type: 'BANK', name: 'First National', parentOrganizationId: null, settings: null });
      rbacMock.getRole.mockResolvedValue('ADMIN');
      rbacMock.hasPermission.mockResolvedValue(true);
      repositoryMock.createCampaign.mockResolvedValue({ id: 'c1', organizationId: 'org-1', code: 'WELCOME', type: 'TRIAL_EXTENSION', config: {}, isActive: true, expiresAt: null });

      await service.createCampaign('org-1', 'user-1', 'WELCOME', 'TRIAL_EXTENSION', { extraDays: 30 }, true);

      expect(auditServiceMock.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'organization.campaign_created', metadata: { code: 'WELCOME', type: 'TRIAL_EXTENSION' } }),
      );
    });

    it('records organization.branding_updated with only the CHANGED KEYS, not the values', async () => {
      repositoryMock.findById.mockResolvedValue({ id: 'org-1', type: 'BANK', name: 'First National', parentOrganizationId: null, settings: null });
      rbacMock.getRole.mockResolvedValue('OWNER');
      rbacMock.hasPermission.mockResolvedValue(true);
      repositoryMock.updateSettings.mockResolvedValue({ id: 'org-1', type: 'BANK', name: 'First National', parentOrganizationId: null, settings: {} });

      await service.updateBranding('org-1', 'user-1', { logoUrl: 'https://x.com/logo.png' });

      expect(auditServiceMock.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'organization.branding_updated', metadata: { changedKeys: ['logoUrl'] } }),
      );
    });
  });

  describe('acceptInvitation (CLOSES A CRITICAL GAP found in a final review: invitations could be created but never accepted)', () => {
    const validInvitation = {
      id: 'inv-1', organizationId: 'org-1', email: 'invited@example.com', role: 'MEMBER',
      status: 'PENDING', expiresAt: new Date(Date.now() + 100_000), invitedByUserId: 'inviter-1',
    };

    it('throws NotFoundException for a nonexistent invitation', async () => {
      repositoryMock.findInvitationById.mockResolvedValue(null);

      await expect(service.acceptInvitation('inv-missing', 'user-1')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('throws BadRequestException when the invitation is already ACCEPTED — cannot accept twice', async () => {
      repositoryMock.findInvitationById.mockResolvedValue({ ...validInvitation, status: 'ACCEPTED' });

      await expect(service.acceptInvitation('inv-1', 'user-1')).rejects.toBeInstanceOf(BadRequestException);

      expect(repositoryMock.acceptInvitation).not.toHaveBeenCalled();
    });

    it('throws BadRequestException when the invitation was REVOKED', async () => {
      repositoryMock.findInvitationById.mockResolvedValue({ ...validInvitation, status: 'REVOKED' });

      await expect(service.acceptInvitation('inv-1', 'user-1')).rejects.toBeInstanceOf(BadRequestException);
    });

    it('throws BadRequestException when the invitation has expired, even if still marked PENDING', async () => {
      repositoryMock.findInvitationById.mockResolvedValue({ ...validInvitation, expiresAt: new Date(Date.now() - 100_000) });

      await expect(service.acceptInvitation('inv-1', 'user-1')).rejects.toBeInstanceOf(BadRequestException);

      expect(repositoryMock.acceptInvitation).not.toHaveBeenCalled();
    });

    it('CRITICAL: throws ForbiddenException when the accepting user\'s email does NOT match the invited email — prevents accepting someone else\'s invitation', async () => {
      repositoryMock.findInvitationById.mockResolvedValue(validInvitation);
      userRepositoryMock.findById.mockResolvedValue({ id: 'user-1', email: 'someone-else@example.com' });

      await expect(service.acceptInvitation('inv-1', 'user-1')).rejects.toBeInstanceOf(ForbiddenException);

      expect(repositoryMock.acceptInvitation).not.toHaveBeenCalled();
    });

    it('email matching is case-insensitive', async () => {
      repositoryMock.findInvitationById.mockResolvedValue(validInvitation);
      userRepositoryMock.findById.mockResolvedValue({ id: 'user-1', email: 'INVITED@EXAMPLE.COM' });
      repositoryMock.acceptInvitation.mockResolvedValue({ id: 'mem-1', organizationId: 'org-1', userId: 'user-1', role: 'MEMBER' });

      await expect(service.acceptInvitation('inv-1', 'user-1')).resolves.toBeDefined();
    });

    it('succeeds end-to-end for a valid, matching, non-expired PENDING invitation, and records an audit event', async () => {
      repositoryMock.findInvitationById.mockResolvedValue(validInvitation);
      userRepositoryMock.findById.mockResolvedValue({ id: 'user-1', email: 'invited@example.com' });
      repositoryMock.acceptInvitation.mockResolvedValue({ id: 'mem-1', organizationId: 'org-1', userId: 'user-1', role: 'MEMBER' });

      const result = await service.acceptInvitation('inv-1', 'user-1');

      expect(repositoryMock.acceptInvitation).toHaveBeenCalledWith('inv-1', 'user-1');
      expect(result.userId).toBe('user-1');
      expect(auditServiceMock.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'organization.invitation_accepted', actorUserId: 'user-1', entityId: 'org-1' }),
      );
    });
  });
});
