import { Test } from '@nestjs/testing';

import { PolicyEngineService } from '../../src/modules/organization/application/services/policy-engine.service';
import { PrismaService } from '../../src/common/prisma/prisma.service';

describe('PolicyEngineService (Sprint B2 — first real implementation)', () => {
  const prismaMock = {
    organizationPolicy: { findUnique: jest.fn(), upsert: jest.fn() },
    organization: { findUnique: jest.fn() },
  };

  let service: PolicyEngineService;

  beforeEach(async () => {
    jest.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [PolicyEngineService, { provide: PrismaService, useValue: prismaMock }],
    }).compile();
    service = moduleRef.get(PolicyEngineService);
  });

  describe('getPolicy / setPolicy', () => {
    it('returns null (not throw) when no policy is set for this exact org+key', async () => {
      prismaMock.organizationPolicy.findUnique.mockResolvedValue(null);

      const result = await service.getPolicy('org-1', 'some_key');

      expect(result).toBeNull();
    });

    it('returns the stored value when one exists', async () => {
      prismaMock.organizationPolicy.findUnique.mockResolvedValue({ value: 90 });

      const result = await service.getPolicy<number>('org-1', 'default_screen_time_minutes');

      expect(result).toBe(90);
    });

    it('setPolicy upserts by the (organizationId, key) composite key', async () => {
      await service.setPolicy('org-1', 'default_screen_time_minutes', 90);

      expect(prismaMock.organizationPolicy.upsert).toHaveBeenCalledWith({
        where: { organizationId_key: { organizationId: 'org-1', key: 'default_screen_time_minutes' } },
        create: { organizationId: 'org-1', key: 'default_screen_time_minutes', value: 90 },
        update: { value: 90 },
      });
    });
  });

  describe('getEffectivePolicy — the real hierarchical inheritance logic', () => {
    it("returns the org's OWN policy directly when it has one, without walking up at all", async () => {
      prismaMock.organizationPolicy.findUnique.mockResolvedValue({ value: 60 });

      const result = await service.getEffectivePolicy('family-org-1', 'default_screen_time_minutes');

      expect(result).toBe(60);
      expect(prismaMock.organization.findUnique).not.toHaveBeenCalled();
    });

    it('walks up ONE level to the parent when the org itself has no policy set (School default -> Family, per the documented use case)', async () => {
      prismaMock.organizationPolicy.findUnique
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ value: 90 });
      prismaMock.organization.findUnique.mockResolvedValueOnce({ parentOrganizationId: 'school-org-1' });

      const result = await service.getEffectivePolicy('family-org-1', 'default_screen_time_minutes');

      expect(result).toBe(90);
      expect(prismaMock.organizationPolicy.findUnique).toHaveBeenNthCalledWith(1, {
        where: { organizationId_key: { organizationId: 'family-org-1', key: 'default_screen_time_minutes' } },
      });
      expect(prismaMock.organizationPolicy.findUnique).toHaveBeenNthCalledWith(2, {
        where: { organizationId_key: { organizationId: 'school-org-1', key: 'default_screen_time_minutes' } },
      });
    });

    it('returns null (not throw) when NEITHER the org nor any ancestor has the policy set, and the chain ends at a top-level org', async () => {
      prismaMock.organizationPolicy.findUnique.mockResolvedValue(null);
      prismaMock.organization.findUnique.mockResolvedValue({ parentOrganizationId: null });

      const result = await service.getEffectivePolicy('org-1', 'nonexistent_key');

      expect(result).toBeNull();
    });

    it('stops after MAX_HOPS (10) even with a pathologically long/circular chain — the defensive bound, never an infinite loop', async () => {
      prismaMock.organizationPolicy.findUnique.mockResolvedValue(null);
      prismaMock.organization.findUnique.mockImplementation(() => Promise.resolve({ parentOrganizationId: 'always-another-parent' }));

      const result = await service.getEffectivePolicy('org-1', 'some_key');

      expect(result).toBeNull();
      expect(prismaMock.organizationPolicy.findUnique).toHaveBeenCalledTimes(10);
    });
  });
});
