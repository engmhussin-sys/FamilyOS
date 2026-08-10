import { Injectable } from '@nestjs/common';

import { ChildrenService } from '../../../children/application/services/children.service';
import { PrismaLifeTimelineRepository } from '../../infrastructure/repositories/prisma-life-timeline.repository';
import { ILifeTimelineEvent, ILifeTimelineWriter, IRecordTimelineEventInput } from '../../domain/life-timeline.types';

/**
 * Architecture 1.0 \u00a71/\u00a75/\u00a76: the ONE append-only writer every Life
 * Intelligence engine (and, additively, Digital Safety engines later)
 * calls when something is timeline-worthy. No engine writes into
 * another engine's table directly \u2014 this is the single seam.
 *
 * Deliberately does NOT decide what's "milestone-worthy" \u2014 that
 * curation judgment belongs to the calling engine (Architecture 1.0
 * \u00a75.11's reasoning: a query-time heuristic guessing significance
 * from raw logs would be fragile and inconsistent across engines).
 */
@Injectable()
export class LifeTimelineService implements ILifeTimelineWriter {
  constructor(
    private readonly repository: PrismaLifeTimelineRepository,
    private readonly childrenService: ChildrenService,
  ) {}

  /** Called by engines that already verified ownership themselves
   * (e.g. HabitEngineService.completeHabit already ran
   * assertChildBelongsToFamily before this is reached) \u2014 no redundant
   * check here, matching how ai-core's MemoryEngineService trusts its
   * callers rather than re-verifying on every write. */
  async record(input: IRecordTimelineEventInput): Promise<void> {
    await this.repository.create(input);
  }

  /** Read path, reachable directly from a controller \u2014 unlike
   * record(), THIS one must verify ownership itself, matching every
   * other read endpoint in this codebase (Sprint 10's 17/17
   * IDOR-audit precedent). */
  async getTimeline(childId: string, familyId: string, category?: string, limit?: number): Promise<ILifeTimelineEvent[]> {
    await this.childrenService.assertChildBelongsToFamily(childId, familyId);
    return this.repository.listForChild(childId, category, limit);
  }
}
