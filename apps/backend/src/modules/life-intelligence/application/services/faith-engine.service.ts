import { Inject, Injectable, NotFoundException } from '@nestjs/common';

import { ChildrenService } from '../../../children/application/services/children.service';
import { PrismaFaithRepository } from '../../infrastructure/repositories/prisma-faith.repository';
import { LIFE_TIMELINE_WRITER, ILifeTimelineWriter } from '../../domain/life-timeline.types';
import { REWARD_TRIGGER_WRITER, IRewardTriggerWriter } from '../../domain/reward-trigger.types';
import { IFaithPractice, IFaithPracticeLog, IFaithScoreBreakdown, ICreateFaithPracticeInput } from '../../domain/faith.types';
import { FamilyDateService } from '../../../../common/time/family-date.service';
import { getBusinessDate, isBusinessDate } from '../../../../common/time/family-date';

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
    private readonly familyDate: FamilyDateService,
  ) {}

  async createPractice(childId: string, familyId: string, input: Omit<ICreateFaithPracticeInput, 'childId'>): Promise<IFaithPractice> {
    await this.childrenService.assertChildBelongsToFamily(childId, familyId);
    return this.repository.createPractice({ ...input, childId });
  }

  async listPractices(childId: string, familyId: string): Promise<IFaithPractice[]> {
    await this.childrenService.assertChildBelongsToFamily(childId, familyId);
    return this.repository.listActivePractices(childId, await this.todayColumn(familyId));
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

    // B2: which day a Salah/Quran practice belongs to is a FAMILY calendar
    // question — a dawn prayer logged at 04:00 in Cairo is 02:00 UTC of the
    // same day, but the evening ones are the previous UTC day, so the old
    // implementation split a single day's practices across two.
    const timeZone = await this.familyDate.timeZoneOf(familyId);
    const businessDate = dateStr && isBusinessDate(dateStr)
      ? dateStr
      : getBusinessDate(dateStr ?? new Date(), timeZone);
    const date = FamilyDateService.toDateColumn(businessDate);
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

    const since = await this.daysAgo(familyId, SCORE_WINDOW_DAYS);
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

  /** Today on the family calendar, as the `@db.Date` column value. */
  private async todayColumn(familyId: string): Promise<Date> {
    const tz = await this.familyDate.timeZoneOf(familyId);
    return FamilyDateService.toDateColumn(getBusinessDate(new Date(), tz));
  }

  private async daysAgo(familyId: string, days: number): Promise<Date> {
    const tz = await this.familyDate.timeZoneOf(familyId);
    return FamilyDateService.toDateColumn(
      FamilyDateService.addDays(getBusinessDate(new Date(), tz), -days),
    );
  }
}
