import { Test } from '@nestjs/testing';
import { ForbiddenException } from '@nestjs/common';

import { FamilyInsightService } from '../../src/modules/life-intelligence/application/services/family-insight.service';
import { ChildrenService } from '../../src/modules/children/application/services/children.service';
import { DigitalTwinService } from '../../src/modules/life-intelligence/application/services/digital-twin.service';
import { LifeTimelineService } from '../../src/modules/life-intelligence/application/services/life-timeline.service';
import { EntitlementsService } from '../../src/modules/billing/application/services/entitlements.service';

describe('FamilyInsightService', () => {
  const childrenServiceMock = { assertChildBelongsToFamily: jest.fn() };
  const digitalTwinMock = { refreshAndGet: jest.fn() };
  const timelineMock = { getTimeline: jest.fn() };
  const entitlementsMock = { hasFeature: jest.fn() };

  let service: FamilyInsightService;
  const childId = 'child-1';
  const familyId = 'family-1';

  beforeEach(async () => {
    jest.resetAllMocks(); // FIXES A REAL ROOT CAUSE: clearAllMocks() only resets call history, not configured mockResolvedValue/mockRejectedValue implementations -- resetAllMocks() resets both.
    const moduleRef = await Test.createTestingModule({
      providers: [
        FamilyInsightService,
        { provide: ChildrenService, useValue: childrenServiceMock },
        { provide: DigitalTwinService, useValue: digitalTwinMock },
        { provide: LifeTimelineService, useValue: timelineMock },
        { provide: EntitlementsService, useValue: entitlementsMock },
      ],
    }).compile();
    service = moduleRef.get(FamilyInsightService);
  });

  describe('entitlement enforcement (proactive business/code audit finding)', () => {
    it('throws ForbiddenException and computes NOTHING when family_insights is not entitled', async () => {
      entitlementsMock.hasFeature.mockResolvedValue(false);

      await expect(service.getWeeklySummary(childId, familyId)).rejects.toThrow(ForbiddenException);

      expect(entitlementsMock.hasFeature).toHaveBeenCalledWith(familyId, 'family_insights');
      expect(digitalTwinMock.refreshAndGet).not.toHaveBeenCalled();
      expect(timelineMock.getTimeline).not.toHaveBeenCalled();
    });

    it('checks ownership BEFORE entitlement — a request for a child outside the caller\'s family fails on ownership first', async () => {
      childrenServiceMock.assertChildBelongsToFamily.mockRejectedValue(new Error('not found'));

      await expect(service.getWeeklySummary(childId, familyId)).rejects.toThrow('not found');

      expect(entitlementsMock.hasFeature).not.toHaveBeenCalled();
    });

    it('proceeds normally and returns the composed summary when entitled', async () => {
      entitlementsMock.hasFeature.mockResolvedValue(true);
      digitalTwinMock.refreshAndGet.mockResolvedValue({ childId, growthScore: null });
      timelineMock.getTimeline.mockResolvedValue([{ id: 'event-1' }]);

      const result = await service.getWeeklySummary(childId, familyId);

      expect(result.childId).toBe(childId);
      expect(result.recentTimelineHighlights).toEqual([{ id: 'event-1' }]);
    });
  });
});
