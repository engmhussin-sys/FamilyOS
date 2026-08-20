import { Test } from '@nestjs/testing';

import { DataRetentionEnforcementService } from '../../src/modules/data-retention/application/data-retention-enforcement.service';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { EVIDENCE_STORAGE } from '../../src/modules/rewards-engine/application/ports/evidence-storage.port';

describe('DataRetentionEnforcementService', () => {
  const prismaMock = {
    notification: { deleteMany: jest.fn() },
    analyticsEvent: { updateMany: jest.fn() },
    locationEvent: { deleteMany: jest.fn() },
    dailyBehavioralSnapshot: { deleteMany: jest.fn() },
    appUsageLog: { deleteMany: jest.fn() },
    achievementEvidence: { findMany: jest.fn(), updateMany: jest.fn() },
    $transaction: jest.fn((operations: Promise<unknown>[]) => Promise.all(operations)),
  };

  const evidenceStorageMock = { put: jest.fn(), get: jest.fn(), delete: jest.fn(), backendName: 'test-stub' };

  let service: DataRetentionEnforcementService;

  beforeEach(async () => {
    jest.clearAllMocks();
    prismaMock.achievementEvidence.findMany.mockResolvedValue([]);
    prismaMock.achievementEvidence.updateMany.mockResolvedValue({ count: 0 });
    const moduleRef = await Test.createTestingModule({
      providers: [
        DataRetentionEnforcementService,
        { provide: PrismaService, useValue: prismaMock },
        // B5 (PA-B-019) — the sweep now deletes the BYTES of expired
        // achievement evidence before tombstoning the row, so it holds an
        // `IEvidenceStorage`. Stubbed here (this suite is about the query
        // shapes, not about a filesystem) and asserted for real in
        // `test/rewards/evidence-upload.e2e.spec.ts`.
        { provide: EVIDENCE_STORAGE, useValue: evidenceStorageMock },
      ],
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
    it('runs all FIVE enforcement methods, including B5 achievement evidence', async () => {
      prismaMock.notification.deleteMany.mockResolvedValue({ count: 1 });
      prismaMock.analyticsEvent.updateMany.mockResolvedValue({ count: 2 });
      prismaMock.locationEvent.deleteMany.mockResolvedValue({ count: 3 });
      prismaMock.dailyBehavioralSnapshot.deleteMany.mockResolvedValue({ count: 4 });
      prismaMock.appUsageLog.deleteMany.mockResolvedValue({ count: 5 });
      prismaMock.achievementEvidence.findMany.mockResolvedValue([]);
      prismaMock.achievementEvidence.updateMany.mockResolvedValue({ count: 0 });

      const results = await service.enforceAll();

      // B5 — 4 -> 5. `enforceAll` is what a future scheduler calls, so a
      // retention category that exists but is not listed here is a category
      // that never runs. Evidence is the most sensitive class of object this
      // product stores; it does not get to be the one that is forgotten.
      expect(results).toHaveLength(5);
      expect(results.map((r) => r.category)).toEqual([
        'Notifications',
        'Analytics Events',
        'Location Events',
        'App Usage Data',
        'Achievement Evidence',
      ]);
    });
  });

  describe('B5 (PA-B-019) — enforceAchievementEvidenceRetention', () => {
    it('deletes the BYTES first and tombstones the row second — never the other way round', async () => {
      const order: string[] = [];
      prismaMock.achievementEvidence.findMany.mockResolvedValue([
        { id: 'ev-1', storageKey: 'fam/child/ach/ev-1.mp3' },
        { id: 'ev-2', storageKey: 'fam/child/ach/ev-2.m4a' },
      ]);
      evidenceStorageMock.delete.mockImplementation((key: string) => {
        order.push(`storage:${key}`);
        return Promise.resolve();
      });
      prismaMock.achievementEvidence.updateMany.mockImplementation(() => {
        order.push('row:tombstone');
        return Promise.resolve({ count: 2 });
      });

      const result = await service.enforceAchievementEvidenceRetention(new Date('2026-08-15T00:00:00Z'));

      // Reversed, a crash between the two steps would leave an object with no
      // row pointing at it: unreachable by the application, invisible to every
      // future sweep, and therefore a child's voice recording retained
      // forever by accident.
      expect(order).toEqual([
        'storage:fam/child/ach/ev-1.mp3',
        'storage:fam/child/ach/ev-2.m4a',
        'row:tombstone',
      ]);
      expect(result).toEqual({
        category: 'Achievement Evidence',
        action: 'HARD_DELETE_OBJECT_SOFT_DELETE_ROW',
        affectedRows: 2,
      });
    });

    it('selects by the per-row retain_until, not by a fixed lookback — and skips rows already tombstoned', async () => {
      const now = new Date('2026-08-15T00:00:00Z');
      await service.enforceAchievementEvidenceRetention(now);

      expect(prismaMock.achievementEvidence.findMany).toHaveBeenCalledWith({
        where: { retainUntil: { lt: now }, deletedAt: null },
        select: { id: true, storageKey: true },
      });
    });

    it('touches no storage and no row when nothing is due — the sweep must be safely re-runnable', async () => {
      prismaMock.achievementEvidence.findMany.mockResolvedValue([]);
      prismaMock.achievementEvidence.updateMany.mockResolvedValue({ count: 0 });

      const result = await service.enforceAchievementEvidenceRetention();

      expect(evidenceStorageMock.delete).not.toHaveBeenCalled();
      expect(result.affectedRows).toBe(0);
    });
  });
});
