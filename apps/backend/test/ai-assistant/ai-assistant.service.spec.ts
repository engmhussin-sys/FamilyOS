import { Test } from '@nestjs/testing';
import { AiAssistantService } from '../../src/modules/ai-assistant/application/services/ai-assistant.service';
import { AiCoreOrchestratorService } from '../../src/modules/ai-core/application/services/ai-core-orchestrator.service';

describe('AiAssistantService', () => {
  const orchestratorMock = { askParentingQuestion: jest.fn() };
  let service: AiAssistantService;

  beforeEach(async () => {
    jest.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [
        AiAssistantService,
        { provide: AiCoreOrchestratorService, useValue: orchestratorMock },
      ],
    }).compile();
    service = moduleRef.get(AiAssistantService);
  });

  it('delegates directly to AiCoreOrchestratorService.askParentingQuestion', async () => {
    orchestratorMock.askParentingQuestion.mockResolvedValue({
      answer: 'Some grounded advice.',
      generatedAt: new Date('2026-07-28'),
    });

    const result = await service.ask('child-1', 'family-1', 'Why so much gaming?');

    expect(orchestratorMock.askParentingQuestion).toHaveBeenCalledWith(
      'child-1',
      'family-1',
      'Why so much gaming?',
    );
    expect(result.answer).toBe('Some grounded advice.');
  });

  it('propagates errors from the orchestrator without wrapping them further', async () => {
    orchestratorMock.askParentingQuestion.mockRejectedValue(new Error('boom'));

    await expect(service.ask('child-1', 'family-1', 'Question?')).rejects.toThrow('boom');
  });
});
