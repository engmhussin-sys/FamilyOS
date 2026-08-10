import { Test } from '@nestjs/testing';

import { LifeTimelineService } from '../../src/modules/life-intelligence/application/services/life-timeline.service';
import { PrismaLifeTimelineRepository } from '../../src/modules/life-intelligence/infrastructure/repositories/prisma-life-timeline.repository';
import { ChildrenService } from '../../src/modules/children/application/services/children.service';

describe('LifeTimelineService', () => {
  const repositoryMock = { create: jest.fn(), listForChild: jest.fn() };
  const childrenServiceMock = { assertChildBelongsToFamily: jest.fn() };

  let service: LifeTimelineService;

  beforeEach(async () => {
    jest.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [
        LifeTimelineService,
        { provide: PrismaLifeTimelineRepository, useValue: repositoryMock },
        { provide: ChildrenService, useValue: childrenServiceMock },
      ],
    }).compile();
    service = moduleRef.get(LifeTimelineService);
  });

  describe('record', () => {
    it('writes through to the repository with zero ownership re-check — the calling engine already verified it', async () => {
      await service.record({ childId: 'c1', sourceEngine: 'habit-builder', category: 'HABITS', eventType: 'x', title: 'y' });
      expect(repositoryMock.create).toHaveBeenCalledWith(
        expect.objectContaining({ childId: 'c1', sourceEngine: 'habit-builder' }),
      );
      expect(childrenServiceMock.assertChildBelongsToFamily).not.toHaveBeenCalled();
    });
  });

  describe('getTimeline', () => {
    it('verifies ownership before reading — the read path is reachable directly from a controller, unlike record()', async () => {
      repositoryMock.listForChild.mockResolvedValue([]);
      await service.getTimeline('c1', 'f1', 'HABITS');
      expect(childrenServiceMock.assertChildBelongsToFamily).toHaveBeenCalledWith('c1', 'f1');
      expect(repositoryMock.listForChild).toHaveBeenCalledWith('c1', 'HABITS', undefined);
    });

    it('propagates the ownership error and never reaches the repository (IDOR protection)', async () => {
      childrenServiceMock.assertChildBelongsToFamily.mockRejectedValue(new Error('not found'));
      await expect(service.getTimeline('c1', 'wrong-family')).rejects.toThrow('not found');
      expect(repositoryMock.listForChild).not.toHaveBeenCalled();
    });
  });
});
