import { Test } from '@nestjs/testing';

import { DataRetentionEnforcementService } from '../../src/modules/data-retention/application/data-retention-enforcement.service';
import { PrismaService } from '../../src/common/prisma/prisma.service';

describe('DataRetentionEnforcementService', () => {
  const prismaMock = {
    notification: { deleteMany: jest.fn() },
    analyticsEvent: { updateMany: jest.fn() },
    locationEvent: { deleteMany: jest.fn() },
  };

  let service: DataRetentionEnforcementService;

  beforeEach(async () => {
    jest.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [DataRetentionEnforcementService, { provide: PrismaService, useValue: prismaMock }],
    }).compile();
    service = moduleRef.get(DataRetentionEnforcementService);
  });

  describe('enforceLocationEventRetention', () => {
    it('deletes rows strictly by expiresAt, not by a fixed lookback window — the schema\u2019s own per-row expiry mechanism, not reinvented here', async () => {
      prismaMock.locationEvent.deleteMany.mockResolvedValue({ count: 3 });

      const result = await service.enforceLocationEventRetention();

      expect(prismaMock.locationEvent.deleteMany).toHaveBeenCalledWith({
        where: { expiresAt: { lt: expect.any(Date) } },
      });
      expect(result).toEqual({ category: 'Location Events', action: 'HARD_DELETE', affectedRows: 3 });
    });

    it('returns 0 affected rows without error when nothing has expired yet — the honest, current-day state given this table has no write path yet', async () => {
      prismaMock.locationEvent.deleteMany.mockResolvedValue({ count: 0 });

      const result = await service.enforceLocationEventRetention();

      expect(result.affectedRows).toBe(0);
    });
  });

  describe('enforceAll', () => {
    it('runs all three enforcement methods, including the newly-added LocationEvent one', async () => {
      prismaMock.notification.deleteMany.mockResolvedValue({ count: 1 });
      prismaMock.analyticsEvent.updateMany.mockResolvedValue({ count: 2 });
      prismaMock.locationEvent.deleteMany.mockResolvedValue({ count: 3 });

      const results = await service.enforceAll();

      expect(results).toHaveLength(3);
      expect(results.map((r) => r.category)).toEqual(['Notifications', 'Analytics Events', 'Location Events']);
    });
  });
});
