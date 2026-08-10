import { Test } from '@nestjs/testing';

import { RbacEngineService } from '../../src/modules/organization/application/services/rbac-engine.service';
import { ORGANIZATION_REPOSITORY } from '../../src/modules/organization/application/ports/organization.repository.port';

describe('RbacEngineService (Sprint B1 — first real implementation)', () => {
  const repositoryMock = { findMembers: jest.fn() };
  let service: RbacEngineService;
  const orgId = 'org-1';

  beforeEach(async () => {
    jest.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [RbacEngineService, { provide: ORGANIZATION_REPOSITORY, useValue: repositoryMock }],
    }).compile();
    service = moduleRef.get(RbacEngineService);
  });

  describe('getRole', () => {
    it('returns null for a user with no membership at all', async () => {
      repositoryMock.findMembers.mockResolvedValue([{ id: 'm1', organizationId: orgId, userId: 'other-user', role: 'OWNER' }]);

      const role = await service.getRole('user-1', orgId);

      expect(role).toBeNull();
    });

    it('returns the real role for a genuine member', async () => {
      repositoryMock.findMembers.mockResolvedValue([{ id: 'm1', organizationId: orgId, userId: 'user-1', role: 'MANAGER' }]);

      const role = await service.getRole('user-1', orgId);

      expect(role).toBe('MANAGER');
    });
  });

  describe('hasPermission', () => {
    it('denies everything for a non-member', async () => {
      repositoryMock.findMembers.mockResolvedValue([]);

      const allowed = await service.hasPermission({ userId: 'user-1', organizationId: orgId, resource: 'x', action: 'READ' });

      expect(allowed).toBe(false);
    });

    it('a GUEST can READ but not WRITE', async () => {
      repositoryMock.findMembers.mockResolvedValue([{ id: 'm1', organizationId: orgId, userId: 'user-1', role: 'GUEST' }]);

      expect(await service.hasPermission({ userId: 'user-1', organizationId: orgId, resource: 'x', action: 'READ' })).toBe(true);
      expect(await service.hasPermission({ userId: 'user-1', organizationId: orgId, resource: 'x', action: 'WRITE' })).toBe(false);
    });

    it('a MANAGER can WRITE but not DELETE (DELETE requires OWNER-level, per the min-level table)', async () => {
      repositoryMock.findMembers.mockResolvedValue([{ id: 'm1', organizationId: orgId, userId: 'user-1', role: 'MANAGER' }]);

      expect(await service.hasPermission({ userId: 'user-1', organizationId: orgId, resource: 'x', action: 'WRITE' })).toBe(true);
      expect(await service.hasPermission({ userId: 'user-1', organizationId: orgId, resource: 'x', action: 'DELETE' })).toBe(false);
    });

    it('an OWNER can do everything, including ADMIN and DELETE', async () => {
      repositoryMock.findMembers.mockResolvedValue([{ id: 'm1', organizationId: orgId, userId: 'user-1', role: 'OWNER' }]);

      expect(await service.hasPermission({ userId: 'user-1', organizationId: orgId, resource: 'x', action: 'DELETE' })).toBe(true);
      expect(await service.hasPermission({ userId: 'user-1', organizationId: orgId, resource: 'x', action: 'ADMIN' })).toBe(true);
    });

    it('an ADMIN can WRITE but NOT DELETE/ADMIN-level actions — those require OWNER specifically', async () => {
      repositoryMock.findMembers.mockResolvedValue([{ id: 'm1', organizationId: orgId, userId: 'user-1', role: 'ADMIN' }]);

      expect(await service.hasPermission({ userId: 'user-1', organizationId: orgId, resource: 'x', action: 'WRITE' })).toBe(true);
      expect(await service.hasPermission({ userId: 'user-1', organizationId: orgId, resource: 'x', action: 'DELETE' })).toBe(false);
      expect(await service.hasPermission({ userId: 'user-1', organizationId: orgId, resource: 'x', action: 'ADMIN' })).toBe(false);
    });
  });
});
