import { Inject, Injectable, Logger } from '@nestjs/common';

import { AI_PROVIDER, type IAIProvider } from '../../domain/ai-provider.port';
import { AiCoreUnavailableException } from '../../domain/ai-core.errors';
import type { IChildAIContext } from '../../domain/ai-context.types';
import { AiContextManagerService } from './ai-context-manager.service';

const PARENTING_ASSISTANT_SYSTEM_PROMPT = `You are a warm, evidence-informed parenting coach inside a family safety app.
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

export interface IAssistantAnswer {
  answer: string;
  generatedAt: Date;
}

/**
 * Decision-068's Layer 1 (AI Core Orchestrator). Every AI feature calls
 * INTO this service — never a provider SDK directly (Decision-068's
 * binding rule, restated in ai-core-engine-boundary.md).
 *
 * Scope note: this is Sprint AI-1 (Foundation). Only one real capability
 * exists today — `askParentingQuestion`, migrated unchanged in behavior
 * from the original AiAssistantService. A generic
 * `processEvent(event: IAIEvent)` dispatcher for Sprint AI-2's
 * Behavioral/Safety/Recommendation engines is intentionally NOT built
 * yet — with a single real event type consumed today, a generic
 * dispatcher would have exactly one case, which is speculative
 * architecture, not foundation-building. `IAIEvent` (domain/ai-event.types.ts)
 * already declares the shape that dispatcher will route on, once there's
 * a second engine to justify it.
 */
@Injectable()
export class AiCoreOrchestratorService {
  private readonly logger = new Logger(AiCoreOrchestratorService.name);

  constructor(
    private readonly contextManager: AiContextManagerService,
    @Inject(AI_PROVIDER) private readonly aiProvider: IAIProvider,
  ) {}

  async askParentingQuestion(
    childId: string,
    familyId: string,
    question: string,
  ): Promise<IAssistantAnswer> {
    const context = await this.contextManager.buildChildContext(childId, familyId);
    const userMessage = this.formatUserMessage(context, question);

    try {
      const answer = await this.aiProvider.complete({
        systemPrompt: PARENTING_ASSISTANT_SYSTEM_PROMPT,
        userMessage,
      });

      if (!answer.trim()) {
        throw new Error('Empty completion returned from AI provider.');
      }

      return { answer, generatedAt: new Date() };
    } catch (err) {
      // Context-building errors (ChildNotFoundException) are thrown
      // above, outside this try block, and propagate untouched — only
      // provider-layer failures reach here. Same distinction the
      // original AiAssistantService made, now shared by every future
      // engine built on this orchestrator.
      this.logger.error('AI provider completion failed', err instanceof Error ? err.stack : err);
      throw new AiCoreUnavailableException();
    }
  }

  private formatUserMessage(context: IChildAIContext, question: string): string {
    const limitText =
      context.screenTime.dailyLimitMinutes !== null
        ? `${context.screenTime.dailyLimitMinutes} minutes/day`
        : 'no limit currently set';

    return [
      `Child: ${context.firstName}, age ${context.ageYears}.`,
      `Current daily screen time limit: ${limitText}.`,
      `Focus mode enabled: ${context.screenTime.focusModeEnabled ? 'yes' : 'no'}.`,
      '',
      `Parent's question: ${question}`,
    ].join('\n');
  }
}
