import { Test } from '@nestjs/testing';
import { RecommendationEngineService } from '../../src/modules/ai-core/application/services/recommendation-engine.service';
import { KnowledgeEngineService } from '../../src/modules/ai-core/application/services/knowledge-engine.service';
import { DecisionEngineService } from '../../src/modules/ai-core/application/services/decision-engine.service';
import { SafetyEngineService } from '../../src/modules/ai-core/application/services/safety-engine.service';
import { MemoryEngineService } from '../../src/modules/ai-core/application/services/memory-engine.service';
import { AI_PROVIDER } from '../../src/modules/ai-core/domain/ai-provider.port';

describe('RecommendationEngineService', () => {
  const knowledgeEngineMock = { buildSnapshot: jest.fn() };
  const decisionEngineMock = { decide: jest.fn() };
  const safetyEngineMock = { validate: jest.fn() };
  const memoryEngineMock = { recordRecommendation: jest.fn() };
  const aiProviderMock = { complete: jest.fn() };

  let service: RecommendationEngineService;

  beforeEach(async () => {
    jest.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [
        RecommendationEngineService,
        { provide: KnowledgeEngineService, useValue: knowledgeEngineMock },
        { provide: DecisionEngineService, useValue: decisionEngineMock },
        { provide: SafetyEngineService, useValue: safetyEngineMock },
        { provide: MemoryEngineService, useValue: memoryEngineMock },
        { provide: AI_PROVIDER, useValue: aiProviderMock },
      ],
    }).compile();
    service = moduleRef.get(RecommendationEngineService);
  });

  it('returns the deterministic ALL_CLEAR copy when no rule triggers, without calling AI unnecessarily', async () => {
    knowledgeEngineMock.buildSnapshot.mockResolvedValue({});
    decisionEngineMock.decide.mockReturnValue({ recommendationType: null, confidence: 1, rulesApplied: [], reasoningPath: [], inputs: {} });
    safetyEngineMock.validate.mockReturnValue({ isSafe: true, rejectionReason: null });
    aiProviderMock.complete.mockResolvedValue('Everything is fine!');

    const result = await service.recommend('child-1', 'family-1', 'device-1');

    expect(result.title).toBe('Everything looks good');
    expect(memoryEngineMock.recordRecommendation).not.toHaveBeenCalled(); // no recommendationType -> nothing to record
  });

  it('falls back to deterministic copy when AI phrasing fails, WITHOUT failing the whole call', async () => {
    knowledgeEngineMock.buildSnapshot.mockResolvedValue({});
    decisionEngineMock.decide.mockReturnValue({
      recommendationType: 'SET_SCREEN_TIME_POLICY', confidence: 1, rulesApplied: [], reasoningPath: [], inputs: {},
    });
    safetyEngineMock.validate.mockReturnValue({ isSafe: true, rejectionReason: null });
    aiProviderMock.complete.mockRejectedValue(new Error('provider unreachable'));

    const result = await service.recommend('child-1', 'family-1', 'device-1');

    expect(result.wasPhrasedByAI).toBe(false);
    expect(result.title).toBe('No screen time policy yet');
    expect(memoryEngineMock.recordRecommendation).toHaveBeenCalledWith(
      'child-1',
      expect.objectContaining({
        recommendationType: 'SET_SCREEN_TIME_POLICY',
        rulesApplied: [],
        reasoningPath: [],
        inputs: {},
      }),
    );
  });

  it('SAFETY: falls back to ALL_CLEAR when the Safety Engine rejects the deterministic copy', async () => {
    knowledgeEngineMock.buildSnapshot.mockResolvedValue({});
    decisionEngineMock.decide.mockReturnValue({
      recommendationType: 'SET_SCREEN_TIME_POLICY', confidence: 1, rulesApplied: [], reasoningPath: [], inputs: {},
    });
    safetyEngineMock.validate.mockReturnValue({ isSafe: false, rejectionReason: 'test rejection' });

    const result = await service.recommend('child-1', 'family-1', 'device-1');

    expect(result.title).toBe('Everything looks good');
    expect(aiProviderMock.complete).not.toHaveBeenCalled(); // rejected before phrasing was even attempted
  });

  it('uses the AI-phrased body when the completion is a plausible rephrasing', async () => {
    knowledgeEngineMock.buildSnapshot.mockResolvedValue({});
    decisionEngineMock.decide.mockReturnValue({
      recommendationType: 'SET_SCREEN_TIME_POLICY', confidence: 1, rulesApplied: [], reasoningPath: [], inputs: {},
    });
    safetyEngineMock.validate.mockReturnValue({ isSafe: true, rejectionReason: null });
    aiProviderMock.complete.mockResolvedValue('It looks like there is no daily limit yet \u2014 want to set one?');

    const result = await service.recommend('child-1', 'family-1', 'device-1');

    expect(result.wasPhrasedByAI).toBe(true);
    expect(result.body).toContain('daily limit');
  });

  it('discards an implausible AI response (way too long) and keeps deterministic copy', async () => {
    knowledgeEngineMock.buildSnapshot.mockResolvedValue({});
    decisionEngineMock.decide.mockReturnValue({
      recommendationType: 'SET_SCREEN_TIME_POLICY', confidence: 1, rulesApplied: [], reasoningPath: [], inputs: {},
    });
    safetyEngineMock.validate.mockReturnValue({ isSafe: true, rejectionReason: null });
    aiProviderMock.complete.mockResolvedValue('x'.repeat(10000));

    const result = await service.recommend('child-1', 'family-1', 'device-1');

    expect(result.wasPhrasedByAI).toBe(false);
  });
});
