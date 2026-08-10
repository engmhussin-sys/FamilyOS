import { Injectable, NotFoundException } from '@nestjs/common';

import { ChildrenService } from '../../../children/application/services/children.service';
import { PrismaSmartTaskRepository } from '../../infrastructure/repositories/prisma-smart-task.repository';
import { ISmartTask, ISmartTaskContext } from '../../domain/smart-task.types';
import { generateSmartTasks } from './smart-task-rules';

/**
 * Architecture 1.0 \u00a73/\u00a75: AI-generated, context-driven, DYNAMIC
 * suggestions \u2014 deliberately distinct from Habit Builder's static,
 * parent-defined list. "AI-generated" here means the generation LOGIC
 * is deterministic (see smart-task-rules.ts); no LLM call happens in
 * this sprint's implementation \u2014 the architecture leaves room for an
 * LLM to reword `generatedReason`/`title` later without ever letting
 * it decide WHICH tasks to suggest, matching this project's own AI
 * Freeze discipline.
 *
 * Future-Engine Contract (Architecture 1.0 \u00a72): no Memory/Audit/Safety
 * usage this sprint; Events: none yet \u2014 accepting/dismissing a
 * suggestion doesn't obviously belong on the Timeline the way a FIRST
 * completion does, left open rather than guessed at.
 */
@Injectable()
export class SmartTaskEngineService {
  constructor(
    private readonly repository: PrismaSmartTaskRepository,
    private readonly childrenService: ChildrenService,
  ) {}

  async generateForToday(childId: string, familyId: string, context: Omit<ISmartTaskContext, 'childId'>): Promise<number> {
    await this.childrenService.assertChildBelongsToFamily(childId, familyId);

    const suggestions = generateSmartTasks({ ...context, childId });
    if (suggestions.length === 0) return 0;

    return this.repository.createMany(childId, suggestions, this.today(), context as unknown as Record<string, unknown>);
  }

  async listForToday(childId: string, familyId: string): Promise<ISmartTask[]> {
    await this.childrenService.assertChildBelongsToFamily(childId, familyId);
    return this.repository.listForChildOnDate(childId, this.today());
  }

  async decide(taskId: string, childId: string, familyId: string, status: 'ACCEPTED' | 'DISMISSED' | 'COMPLETED'): Promise<void> {
    await this.childrenService.assertChildBelongsToFamily(childId, familyId);

    const task = await this.repository.findById(taskId);
    if (!task || task.childId !== childId) {
      throw new NotFoundException('Smart task not found');
    }

    await this.repository.updateStatus(taskId, status);
  }

  private today(): Date {
    const now = new Date();
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  }
}
