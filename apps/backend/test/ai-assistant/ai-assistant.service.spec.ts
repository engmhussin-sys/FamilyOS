import { Test } from '@nestjs/testing';
import { AiAssistantService } from '../../src/modules/ai-assistant/application/services/ai-assistant.service';
import { ChildrenService } from '../../src/modules/children/application/services/children.service';
import { ScreenTimeService } from '../../src/modules/screen-time/application/services/screen-time.service';
import { LLM_CLIENT } from '../../src/modules/ai-assistant/application/ports/llm-client.port';
import { ChildNotFoundException } from '../../src/modules/children/domain/child.errors';
import { AiAssistantUnavailableException } from '../../src/modules/ai-assistant/domain/ai-assistant.errors';

describe('AiAssistantService', () => {
  const childrenServiceMock = { getChildOrThrow: jest.fn() };
  const screenTimeServiceMock = { getPolicy: jest.fn() };
  const llmClientMock = { complete: jest.fn() };

  let service: AiAssistantService;

  beforeEach(async () => {
    jest.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [
        AiAssistantService,
        { provide: ChildrenService, useValue: childrenServiceMock },
        { provide: ScreenTimeService, useValue: screenTimeServiceMock },
        { provide: LLM_CLIENT, useValue: llmClientMock },
      ],
    }).compile();
    service = moduleRef.get(AiAssistantService);
  });

  it('propagates ChildNotFoundException untouched — it is a 404, not an LLM-availability error', async () => {
    childrenServiceMock.getChildOrThrow.mockRejectedValue(new ChildNotFoundException('child-1'));

    await expect(service.ask('child-1', 'family-1', 'Why so much gaming?')).rejects.toBeInstanceOf(
      ChildNotFoundException,
    );

    expect(llmClientMock.complete).not.toHaveBeenCalled();
  });

  it('grounds the prompt with the real child context before asking the LLM', async () => {
    childrenServiceMock.getChildOrThrow.mockResolvedValue({
      firstName: 'Yusuf',
      dateOfBirth: new Date('2016-01-01'),
    });
    screenTimeServiceMock.getPolicy.mockResolvedValue({
      dailyLimitMinutes: 90,
      focusModeEnabled: true,
    });
    llmClientMock.complete.mockResolvedValue('Some grounded advice.');

    await service.ask('child-1', 'family-1', 'He plays games for 5 hours a day.');

    const callArgs = llmClientMock.complete.mock.calls[0][0];
    expect(callArgs.userMessage).toContain('Yusuf');
    expect(callArgs.userMessage).toContain('90 minutes/day');
    expect(callArgs.userMessage).toContain('Focus mode enabled: yes');
    expect(callArgs.userMessage).toContain('He plays games for 5 hours a day.');
  });

  it('says "no limit currently set" when the child has no active screen time policy', async () => {
    childrenServiceMock.getChildOrThrow.mockResolvedValue({
      firstName: 'Sara',
      dateOfBirth: new Date('2018-01-01'),
    });
    screenTimeServiceMock.getPolicy.mockResolvedValue(null);
    llmClientMock.complete.mockResolvedValue('Advice.');

    await service.ask('child-2', 'family-1', 'Question?');

    const callArgs = llmClientMock.complete.mock.calls[0][0];
    expect(callArgs.userMessage).toContain('no limit currently set');
  });

  it('returns the answer with a generatedAt timestamp on success', async () => {
    childrenServiceMock.getChildOrThrow.mockResolvedValue({
      firstName: 'Yusuf',
      dateOfBirth: new Date('2016-01-01'),
    });
    screenTimeServiceMock.getPolicy.mockResolvedValue(null);
    llmClientMock.complete.mockResolvedValue('Here is some advice.');

    const result = await service.ask('child-1', 'family-1', 'Question?');

    expect(result.answer).toBe('Here is some advice.');
    expect(result.generatedAt).toBeInstanceOf(Date);
  });

  it('wraps an LLM client failure into AiAssistantUnavailableException', async () => {
    childrenServiceMock.getChildOrThrow.mockResolvedValue({
      firstName: 'Yusuf',
      dateOfBirth: new Date('2016-01-01'),
    });
    screenTimeServiceMock.getPolicy.mockResolvedValue(null);
    llmClientMock.complete.mockRejectedValue(new Error('Anthropic API timeout'));

    await expect(service.ask('child-1', 'family-1', 'Question?')).rejects.toBeInstanceOf(
      AiAssistantUnavailableException,
    );
  });

  it('wraps an empty LLM response into AiAssistantUnavailableException', async () => {
    childrenServiceMock.getChildOrThrow.mockResolvedValue({
      firstName: 'Yusuf',
      dateOfBirth: new Date('2016-01-01'),
    });
    screenTimeServiceMock.getPolicy.mockResolvedValue(null);
    llmClientMock.complete.mockResolvedValue('   ');

    await expect(service.ask('child-1', 'family-1', 'Question?')).rejects.toBeInstanceOf(
      AiAssistantUnavailableException,
    );
  });
});
