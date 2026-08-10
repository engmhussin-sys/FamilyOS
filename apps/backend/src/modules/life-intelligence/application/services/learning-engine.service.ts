import { Injectable } from '@nestjs/common';

import { ChildrenService } from '../../../children/application/services/children.service';
import { PrismaLearningRepository } from '../../infrastructure/repositories/prisma-learning.repository';
import { ICreateLearningGoalInput, ICreateLearningSessionInput, ILearningGoal, ILearningProgressSummary, ILearningSession } from '../../domain/learning.types';
import { computeCurrentStreak } from './streak-calculator';

const PROGRESS_WINDOW_DAYS = 30;

/**
 * Architecture 1.0 \u00a73/\u00a75: school study, languages, reading, homework,
 * courses, tests. Quran memorization/review explicitly excluded \u2014
 * that lives in the independent Faith Engine per the approved decision.
 *
 * Future-Engine Contract (Architecture 1.0 \u00a72): no Memory/Audit/Safety
 * usage yet, same honest scope boundary as every other LIP engine so
 * far. No Timeline write yet either \u2014 "first learning session" isn't
 * obviously a parent-facing milestone the same way habit/health/faith
 * first-events are; left for a future product decision rather than
 * guessed at.
 */
@Injectable()
export class LearningEngineService {
  constructor(
    private readonly repository: PrismaLearningRepository,
    private readonly childrenService: ChildrenService,
  ) {}

  async createGoal(childId: string, familyId: string, input: Omit<ICreateLearningGoalInput, 'childId'>): Promise<ILearningGoal> {
    await this.childrenService.assertChildBelongsToFamily(childId, familyId);
    return this.repository.createGoal({ ...input, childId });
  }

  async listGoals(childId: string, familyId: string): Promise<ILearningGoal[]> {
    await this.childrenService.assertChildBelongsToFamily(childId, familyId);
    return this.repository.listActiveGoals(childId);
  }

  async logSession(childId: string, familyId: string, input: Omit<ICreateLearningSessionInput, 'childId'>): Promise<ILearningSession> {
    await this.childrenService.assertChildBelongsToFamily(childId, familyId);
    return this.repository.createSession({ ...input, childId });
  }

  /** Feeds the Learning Score sub-component of the Digital Twin
   * (Architecture 1.0). Sprint 16.1 Phase 5 -- CLOSES A REAL GAP:
   * now also computes streakDays, reusing computeCurrentStreak
   * exactly as already tested (Sprint 15/16) -- zero duplicated logic. */
  async getProgressSummary(childId: string, familyId: string): Promise<ILearningProgressSummary> {
    await this.childrenService.assertChildBelongsToFamily(childId, familyId);

    const since = this.daysAgo(PROGRESS_WINDOW_DAYS);
    const totalSessions = await this.repository.countSessionsInWindow(childId, since);
    const totalMinutes = await this.repository.sumSessionMinutesInWindow(childId, since);
    const averageAssessmentScore = await this.repository.averageAssessmentScoreInWindow(childId, since);

    const sessionDates = await this.repository.findDistinctSessionDates(childId, since);
    const todayStr = this.daysAgo(0).toISOString().slice(0, 10);
    const streakDays = computeCurrentStreak(sessionDates, todayStr);

    return { childId, windowDays: PROGRESS_WINDOW_DAYS, totalSessions, totalMinutes, averageAssessmentScore, streakDays };
  }

  private daysAgo(days: number): Date {
    const now = new Date();
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    d.setUTCDate(d.getUTCDate() - days);
    return d;
  }
}
