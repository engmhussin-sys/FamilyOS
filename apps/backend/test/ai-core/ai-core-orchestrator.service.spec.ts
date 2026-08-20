import { Test } from '@nestjs/testing';
import { AiCoreOrchestratorService } from '../../src/modules/ai-core/application/services/ai-core-orchestrator.service';
import { AiContextManagerService } from '../../src/modules/ai-core/application/services/ai-context-manager.service';
import { AI_PROVIDER } from '../../src/modules/ai-core/domain/ai-provider.port';
import { AiCoreUnavailableException } from '../../src/modules/ai-core/domain/ai-core.errors';
import { ChildNotFoundException } from '../../src/modules/children/domain/child.errors';
import { GrowthEventEmitter } from '../../src/modules/analytics/application/growth-event-emitter.service';

describe('AiCoreOrchestratorService', () => {
  const contextManagerMock = { buildChildContext: jest.fn() };
  const aiProviderMock = { complete: jest.fn() };

  let service: AiCoreOrchestratorService;

  beforeEach(async () => {
    jest.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [
        AiCoreOrchestratorService,
        { provide: AiContextManagerService, useValue: contextManagerMock },
        { provide: AI_PROVIDER, useValue: aiProviderMock },
        // PHASE D (GROWTH). `GrowthEventEmitter.emit` never throws by contract
        // (see its class docstring: analytics must never be able to fail a
        // reward, a habit or an AI answer), so a resolving double is a faithful
        // stand-in and these suites stay about the business path.
        { provide: GrowthEventEmitter, useValue: { emit: jest.fn().mockResolvedValue(undefined) } },
      ],
    }).compile();
    service = moduleRef.get(AiCoreOrchestratorService);
  });

  it('propagates ChildNotFoundException from context-building untouched — it is a 404, not an AI-availability error', async () => {
    contextManagerMock.buildChildContext.mockRejectedValue(new ChildNotFoundException('child-1'));

    await expect(
      service.askParentingQuestion('child-1', 'family-1', 'Why so much gaming?'),
    ).rejects.toBeInstanceOf(ChildNotFoundException);

    expect(aiProviderMock.complete).not.toHaveBeenCalled();
  });

  it('grounds the prompt with the real child context before asking the provider', async () => {
    contextManagerMock.buildChildContext.mockResolvedValue({
      childId: 'child-1',
      firstName: 'Yusuf',
      ageYears: 10,
      screenTime: { dailyLimitMinutes: 90, focusModeEnabled: true },
    });
    aiProviderMock.complete.mockResolvedValue('Some grounded advice.');

    await service.askParentingQuestion('child-1', 'family-1', 'He plays games for 5 hours a day.');

    const callArgs = aiProviderMock.complete.mock.calls[0][0];
    expect(callArgs.userMessage).toContain('Yusuf');
    expect(callArgs.userMessage).toContain('90 minutes/day');
    expect(callArgs.userMessage).toContain('Focus mode enabled: yes');
    expect(callArgs.userMessage).toContain('He plays games for 5 hours a day.');
  });

  it('says "no limit currently set" when the child has no active screen time policy', async () => {
    contextManagerMock.buildChildContext.mockResolvedValue({
      childId: 'child-2',
      firstName: 'Sara',
      ageYears: 8,
      screenTime: { dailyLimitMinutes: null, focusModeEnabled: false },
    });
    aiProviderMock.complete.mockResolvedValue('Advice.');

    await service.askParentingQuestion('child-2', 'family-1', 'Question?');

    const callArgs = aiProviderMock.complete.mock.calls[0][0];
    expect(callArgs.userMessage).toContain('no limit currently set');
  });

  it('returns the answer with a generatedAt timestamp on success', async () => {
    contextManagerMock.buildChildContext.mockResolvedValue({
      childId: 'child-1',
      firstName: 'Yusuf',
      ageYears: 10,
      screenTime: { dailyLimitMinutes: null, focusModeEnabled: false },
    });
    aiProviderMock.complete.mockResolvedValue('Here is some advice.');

    const result = await service.askParentingQuestion('child-1', 'family-1', 'Question?');

    expect(result.answer).toBe('Here is some advice.');
    expect(result.generatedAt).toBeInstanceOf(Date);
  });

  it('wraps a provider failure into AiCoreUnavailableException', async () => {
    contextManagerMock.buildChildContext.mockResolvedValue({
      childId: 'child-1',
      firstName: 'Yusuf',
      ageYears: 10,
      screenTime: { dailyLimitMinutes: null, focusModeEnabled: false },
    });
    aiProviderMock.complete.mockRejectedValue(new Error('Anthropic API timeout'));

    await expect(
      service.askParentingQuestion('child-1', 'family-1', 'Question?'),
    ).rejects.toBeInstanceOf(AiCoreUnavailableException);
  });

  it('wraps an empty provider response into AiCoreUnavailableException', async () => {
    contextManagerMock.buildChildContext.mockResolvedValue({
      childId: 'child-1',
      firstName: 'Yusuf',
      ageYears: 10,
      screenTime: { dailyLimitMinutes: null, focusModeEnabled: false },
    });
    aiProviderMock.complete.mockResolvedValue('   ');

    await expect(
      service.askParentingQuestion('child-1', 'family-1', 'Question?'),
    ).rejects.toBeInstanceOf(AiCoreUnavailableException);
  });
});
