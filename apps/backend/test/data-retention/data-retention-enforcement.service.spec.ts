import { Test } from '@nestjs/testing';

import { DataRetentionEnforcementService } from '../../src/modules/data-retention/application/data-retention-enforcement.service';
import { PrismaService } from '../../src/common/prisma/prisma.service';

describe('DataRetentionEnforcementService', () => {
  const prismaMock = {
    notification: { deleteMany: jest.fn() },
    analyticsEvent: { updateMany: jest.fn() },
    locationEvent: { deleteMany: jest.fn() },
    dailyBehavioralSnapshot: { deleteMany: jest.fn() },
    appUsageLog: { deleteMany: jest.fn() },
    $transaction: jest.fn((operations: Promise<unknown>[]) => Promise.all(operations)),
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

  describe('enforceDigitalWellbeingRetention', () => {
    it('deletes rows from BOTH tables by a fixed lookback window, in one transaction', async () => {
      prismaMock.dailyBehavioralSnapshot.deleteMany.mockResolvedValue({ count: 5 });
      prismaMock.appUsageLog.deleteMany.mockResolvedValue({ count: 40 });

      const result = await service.enforceDigitalWellbeingRetention();

      expect(prismaMock.$transaction).toHaveBeenCalled();
      expect(prismaMock.dailyBehavioralSnapshot.deleteMany).toHaveBeenCalledWith({
        where: { usageDate: { lt: expect.any(Date) } },
      });
      expect(prismaMock.appUsageLog.deleteMany).toHaveBeenCalledWith({
        where: { usageDate: { lt: expect.any(Date) } },
      });
      // Sums BOTH tables into one reported count — they're written
      // together as one conceptual dataset (a day's usage summary).
      expect(result).toEqual({ category: 'App Usage Data', action: 'HARD_DELETE', affectedRows: 45 });
    });

    it('respects a custom retentionDays argument', async () => {
      prismaMock.dailyBehavioralSnapshot.deleteMany.mockResolvedValue({ count: 0 });
      prismaMock.appUsageLog.deleteMany.mockResolvedValue({ count: 0 });

      await service.enforceDigitalWellbeingRetention(30);

      const call = prismaMock.dailyBehavioralSnapshot.deleteMany.mock.calls[0][0];
      const cutoff = call.where.usageDate.lt as Date;
      const daysAgo = (Date.now() - cutoff.getTime()) / (1000 * 60 * 60 * 24);
      expect(daysAgo).toBeCloseTo(30, 0);
    });
  });

  describe('enforceAll', () => {
    it('runs all FOUR enforcement methods, including the newly-added Digital Wellbeing one', async () => {
      prismaMock.notification.deleteMany.mockResolvedValue({ count: 1 });
      prismaMock.analyticsEvent.updateMany.mockResolvedValue({ count: 2 });
      prismaMock.locationEvent.deleteMany.mockResolvedValue({ count: 3 });
      prismaMock.dailyBehavioralSnapshot.deleteMany.mockResolvedValue({ count: 4 });
      prismaMock.appUsageLog.deleteMany.mockResolvedValue({ count: 5 });

      const results = await service.enforceAll();

      expect(results).toHaveLength(4);
      expect(results.map((r) => r.category)).toEqual([
        'Notifications',
        'Analytics Events',
        'Location Events',
        'App Usage Data',
      ]);
    });
  });
});
