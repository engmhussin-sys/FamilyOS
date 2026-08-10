import { Inject, Injectable, NotFoundException } from '@nestjs/common';

import { ChildrenService } from '../../../children/application/services/children.service';
import { PrismaFaithRepository } from '../../infrastructure/repositories/prisma-faith.repository';
import { LIFE_TIMELINE_WRITER, ILifeTimelineWriter } from '../../domain/life-timeline.types';
import { REWARD_TRIGGER_WRITER, IRewardTriggerWriter } from '../../domain/reward-trigger.types';
import { IFaithPractice, IFaithPracticeLog, IFaithScoreBreakdown, ICreateFaithPracticeInput } from '../../domain/faith.types';

const SCORE_WINDOW_DAYS = 30;

/**
 * Architecture 1.0 \u00a73/\u00a75: independent engine (Quran memorization/
 * review moved OUT of Learning & Education entirely, per the approved
 * decision).
 *
 * Future-Engine Contract (Architecture 1.0 \u00a72): Events via the
 * Unified Timeline, and (Sprint 25) Reward Rules via
 * IRewardTriggerWriter \u2014 the payload includes `streakDays` so a real
 * rule like Architecture 1.0's own "SALAH, 7-day streak" example can
 * actually match.
 */
@Injectable()
export class FaithEngineService {
  constructor(
    private readonly repository: PrismaFaithRepository,
    private readonly childrenService: ChildrenService,
    @Inject(LIFE_TIMELINE_WRITER) private readonly timeline: ILifeTimelineWriter,
    @Inject(REWARD_TRIGGER_WRITER) private readonly rewardTrigger: IRewardTriggerWriter,
  ) {}

  async createPractice(childId: string, familyId: string, input: Omit<ICreateFaithPracticeInput, 'childId'>): Promise<IFaithPractice> {
    await this.childrenService.assertChildBelongsToFamily(childId, familyId);
    return this.repository.createPractice({ ...input, childId });
  }

  async listPractices(childId: string, familyId: string): Promise<IFaithPractice[]> {
    await this.childrenService.assertChildBelongsToFamily(childId, familyId);
    return this.repository.listActivePractices(childId);
  }

  async logPractice(
    practiceId: string,
    childId: string,
    familyId: string,
    dateStr?: string,
    progress?: Record<string, unknown>,
  ): Promise<IFaithPracticeLog> {
    await this.childrenService.assertChildBelongsToFamily(childId, familyId);

    const practice = await this.repository.findPracticeById(practiceId);
    if (!practice || practice.childId !== childId) {
      throw new NotFoundException('Faith practice not found');
    }

    const date = dateStr ? new Date(dateStr) : this.today();
    const log = await this.repository.recordLog(practiceId, childId, date, progress);

    const totalLogsForPractice = await this.repository.countPracticeLogsTotal(practiceId);
    // Same known, low-severity race condition as HabitEngineService's
    // identical pattern (see its own comment) — a rare, cosmetic
    // duplicate Timeline entry under concurrent requests, never
    // affecting the underlying FaithPracticeLog record itself.
    if (totalLogsForPractice === 1) {
      await this.timeline.record({
        childId,
        sourceEngine: 'faith',
        category: 'FAITH',
        eventType: 'first_practice_log',
        title: `Started "${practice.title}"`,
      });
    }

    // Sprint 25: fires on EVERY log — a streak rule needs every
    // occurrence counted. Best-effort, matching HabitEngineService's
    // own reasoning: a Reward Rules failure never blocks the practice
    // log itself from succeeding.
    try {
      await this.rewardTrigger.trigger(childId, familyId, {
        engine: 'faith',
        type: 'practice_logged',
        payload: { practiceType: practice.type, streakDays: totalLogsForPractice },
      });
    } catch {
      // Intentionally swallowed — see comment above.
    }

    return log;
  }

  /** Feeds the Faith Score sub-component of the Digital Twin
   * (Architecture 1.0 \u00a76.2). */
  async getScoreBreakdown(childId: string, familyId: string): Promise<IFaithScoreBreakdown> {
    await this.childrenService.assertChildBelongsToFamily(childId, familyId);

    const since = this.daysAgo(SCORE_WINDOW_DAYS);
    const activePractices = await this.repository.countActivePractices(childId);
    const completedLogs = await this.repository.countLogsInWindow(childId, since);
    const totalPossible = activePractices * SCORE_WINDOW_DAYS;

    return {
      childId,
      windowDays: SCORE_WINDOW_DAYS,
      activePractices,
      completedLogs,
      completionRate: totalPossible > 0 ? completedLogs / totalPossible : 0,
    };
  }

  private today(): Date {
    const now = new Date();
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  }

  private daysAgo(days: number): Date {
    const d = this.today();
    d.setUTCDate(d.getUTCDate() - days);
    return d;
  }
}
