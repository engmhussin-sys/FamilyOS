import { Inject, Injectable, Logger } from '@nestjs/common';

import { ChildrenService } from '../../../children/application/services/children.service';
import { ScreenTimeService } from '../../../screen-time/application/services/screen-time.service';
import { calculateAge } from '../../../../common/utils/age';
import type { IChildContext, IAssistantAnswer } from '../../domain/ai-assistant.types';
import { AiAssistantUnavailableException } from '../../domain/ai-assistant.errors';
import { LLM_CLIENT, type ILlmClient } from '../ports/llm-client.port';

const SYSTEM_PROMPT = `You are a warm, evidence-informed parenting coach inside a family safety app.
A parent will describe a situation about their child and ask for guidance.

You will be given real, structured context about the specific child (age,
current daily screen time limit if one is set). Ground your answer in that
context — don't give generic advice that ignores it.

Structure every answer with these sections, in this order, using short
paragraphs or brief bullet points — not long essays:
1. Likely reasons (why this might be happening, given the child's age)
2. Risks to be aware of (realistic, not alarmist)
3. Concrete suggestions (specific, actionable, age-appropriate)
4. A simple one-week plan the parent could try

Tone: calm, supportive, non-judgmental — the parent is looking for guidance,
not a lecture. Never suggest surveillance, secret monitoring, or anything
that would undermine trust between parent and child. If the question falls
outside parenting/child-development topics, gently redirect and decline.`;

@Injectable()
export class AiAssistantService {
  private readonly logger = new Logger(AiAssistantService.name);

  constructor(
    private readonly childrenService: ChildrenService,
    private readonly screenTimeService: ScreenTimeService,
    @Inject(LLM_CLIENT) private readonly llmClient: ILlmClient,
  ) {}

  async ask(childId: string, familyId: string, question: string): Promise<IAssistantAnswer> {
    const context = await this.buildChildContext(childId, familyId);
    const userMessage = this.formatUserMessage(context, question);

    try {
      const answer = await this.llmClient.complete({
        systemPrompt: SYSTEM_PROMPT,
        userMessage,
      });

      if (!answer.trim()) {
        throw new Error('Empty completion returned from LLM.');
      }

      return { answer, generatedAt: new Date() };
    } catch (err) {
      // Ownership errors (ChildNotFoundException) are thrown by
      // buildChildContext before this try block and propagate untouched —
      // only LLM-layer failures reach here.
      this.logger.error('LLM completion failed', err instanceof Error ? err.stack : err);
      throw new AiAssistantUnavailableException();
    }
  }

  private async buildChildContext(childId: string, familyId: string): Promise<IChildContext> {
    // Ownership check happens first and is allowed to throw
    // ChildNotFoundException directly — that's a client error (404), not
    // an LLM-availability error, so it must NOT be caught by the
    // try/catch in ask() above.
    const child = await this.childrenService.getChildOrThrow(childId, familyId);
    const policy = await this.screenTimeService.getPolicy(childId, familyId);

    return {
      firstName: child.firstName,
      ageYears: calculateAge(child.dateOfBirth),
      dailyScreenLimitMinutes: policy?.dailyLimitMinutes ?? null,
      focusModeEnabled: policy?.focusModeEnabled ?? false,
    };
  }

  private formatUserMessage(context: IChildContext, question: string): string {
    const limitText =
      context.dailyScreenLimitMinutes !== null
        ? `${context.dailyScreenLimitMinutes} minutes/day`
        : 'no limit currently set';

    return [
      `Child: ${context.firstName}, age ${context.ageYears}.`,
      `Current daily screen time limit: ${limitText}.`,
      `Focus mode enabled: ${context.focusModeEnabled ? 'yes' : 'no'}.`,
      '',
      `Parent's question: ${question}`,
    ].join('\n');
  }
}
