import { Test } from '@nestjs/testing';
import { MemoryEngineService } from '../../src/modules/ai-core/application/services/memory-engine.service';
import { AI_MEMORY_REPOSITORY } from '../../src/modules/ai-core/domain/memory.types';

describe('MemoryEngineService', () => {
  const repositoryMock = {
    upsert: jest.fn(),
    record: jest.fn(),
    find: jest.fn(),
    findAllByCategory: jest.fn(),
    countByCategorySince: jest.fn(),
  };

  let service: MemoryEngineService;

  beforeEach(async () => {
    jest.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [MemoryEngineService, { provide: AI_MEMORY_REPOSITORY, useValue: repositoryMock }],
    }).compile();
    service = moduleRef.get(MemoryEngineService);
  });

  it('recordViolation uses record() (event), not upsert() (state)', async () => {
    await service.recordViolation('child-1', 'DAILY_LIMIT_EXCEEDED', { minutesOver: 15 });
    expect(repositoryMock.record).toHaveBeenCalledWith('child-1', 'VIOLATION', {
      violationType: 'DAILY_LIMIT_EXCEEDED',
      minutesOver: 15,
    });
    expect(repositoryMock.upsert).not.toHaveBeenCalled();
  });

  it('getRecentViolationCount defaults to a 30-day lookback', async () => {
    repositoryMock.countByCategorySince.mockResolvedValue(5);
    const count = await service.getRecentViolationCount('child-1');
    expect(count).toBe(5);
    const sinceArg = repositoryMock.countByCategorySince.mock.calls[0][2] as Date;
    const daysAgo = (Date.now() - sinceArg.getTime()) / (24 * 60 * 60 * 1000);
    expect(daysAgo).toBeCloseTo(30, 0);
  });

  it('setPreference uses upsert() (state), not record()', async () => {
    await service.setPreference('child-1', 'bedtime_reminder_style', { style: 'gentle' });
    expect(repositoryMock.upsert).toHaveBeenCalledWith('child-1', 'PREFERENCE', 'bedtime_reminder_style', {
      style: 'gentle',
    });
    expect(repositoryMock.record).not.toHaveBeenCalled();
  });

  it('recordRecommendation stores a new history entry every call', async () => {
    await service.recordRecommendation('child-1', { recommendationType: 'SET_SCREEN_TIME_POLICY' });
    expect(repositoryMock.record).toHaveBeenCalledWith('child-1', 'RECOMMENDATION', {
      recommendationType: 'SET_SCREEN_TIME_POLICY',
    });
  });
});
