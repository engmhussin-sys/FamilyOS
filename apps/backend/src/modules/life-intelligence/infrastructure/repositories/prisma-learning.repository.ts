import { Injectable } from '@nestjs/common';

import { PrismaService } from '../../../../common/prisma/prisma.service';
import { ICreateLearningGoalInput, ICreateLearningSessionInput, ILearningGoal, ILearningSession } from '../../domain/learning.types';
import { tenantIdForWrite } from '../../../../common/tenancy/tenant-context';

@Injectable()
export class PrismaLearningRepository {
  constructor(private readonly prisma: PrismaService) {}

  async createGoal(input: ICreateLearningGoalInput): Promise<ILearningGoal> {
    const row = await this.prisma.learningGoal.create({
      data: {
        familyId: tenantIdForWrite(),
        childId: input.childId,
        subject: input.subject,
        title: input.title,
        targetDate: input.targetDate ? new Date(input.targetDate) : undefined,
      },
    });
    return { id: row.id, childId: row.childId, subject: row.subject, title: row.title, targetDate: row.targetDate, status: row.status as ILearningGoal['status'] };
  }

  async listActiveGoals(childId: string): Promise<ILearningGoal[]> {
    const rows = await this.prisma.learningGoal.findMany({ where: { childId, status: 'ACTIVE' } });
    return rows.map((row) => ({ id: row.id, childId: row.childId, subject: row.subject, title: row.title, targetDate: row.targetDate, status: row.status as ILearningGoal['status'] }));
  }

  async findGoalById(goalId: string): Promise<ILearningGoal | null> {
    const row = await this.prisma.learningGoal.findFirst({ where: { id: goalId } });
    return row
      ? { id: row.id, childId: row.childId, subject: row.subject, title: row.title, targetDate: row.targetDate, status: row.status as ILearningGoal['status'] }
      : null;
  }

  /** B4 — THE VERIFICATION CONDITION FOR A GOAL. A goal is not "done" because
   * someone tapped a button; it is done when real `LearningSession` rows are
   * attached to it. This count is what `LearningEngineService.completeGoal`
   * refuses to grant without. */
  async countSessionsForGoal(goalId: string): Promise<number> {
    return this.prisma.learningSession.count({ where: { goalId } });
  }

  async sumSessionMinutesForGoal(goalId: string): Promise<number> {
    const result = await this.prisma.learningSession.aggregate({
      where: { goalId },
      _sum: { durationMinutes: true },
    });
    return result._sum.durationMinutes ?? 0;
  }

  /**
   * CONDITIONAL UPDATE, not read-then-write. `WHERE status = 'ACTIVE'` makes
   * PostgreSQL the single serialisation point for two concurrent completions of
   * one goal: exactly one transaction moves the row and the other sees zero
   * rows affected. Same trick `SQL_CLAIM_REDEMPTION` uses on a redemption, for
   * the same reason — a state machine is a number with names.
   *
   * Returns whether THIS call is the one that completed the goal.
   */
  async markGoalCompletedIfActive(goalId: string): Promise<boolean> {
    const result = await this.prisma.learningGoal.updateMany({
      where: { id: goalId, status: 'ACTIVE' },
      data: { status: 'COMPLETED' },
    });
    return result.count > 0;
  }

  async createSession(input: ICreateLearningSessionInput): Promise<ILearningSession> {
    const row = await this.prisma.learningSession.create({
      data: {
        familyId: tenantIdForWrite(),
        childId: input.childId,
        goalId: input.goalId,
        subject: input.subject,
        durationMinutes: input.durationMinutes,
        progressNote: input.progressNote,
        date: new Date(input.date),
      },
    });
    return {
      id: row.id,
      childId: row.childId,
      goalId: row.goalId,
      subject: row.subject,
      durationMinutes: row.durationMinutes,
      progressNote: row.progressNote,
      date: row.date,
    };
  }

  async countSessionsInWindow(childId: string, sinceDate: Date): Promise<number> {
    return this.prisma.learningSession.count({ where: { childId, date: { gte: sinceDate } } });
  }

  /** Sprint 16.1 Phase 5 — CLOSES A REAL GAP: zero streak concept
   * existed for Learning, despite the brief's own explicit "streak"
   * requirement. Same pattern as
   * PrismaHabitRepository.findDistinctCompletionDates. */
  async findDistinctSessionDates(childId: string, sinceDate: Date): Promise<string[]> {
    const rows = await this.prisma.learningSession.findMany({
      where: { childId, date: { gte: sinceDate } },
      select: { date: true },
      distinct: ['date'],
    });
    // B2, DELIBERATELY TIMEZONE-FREE: `LearningSession.date` is a `@db.Date`
    // already holding a business date. See PrismaHabitRepository for the rule.
    return rows.map((r: { date: Date }) => r.date.toISOString().slice(0, 10));
  }

  async sumSessionMinutesInWindow(childId: string, sinceDate: Date): Promise<number> {
    const result = await this.prisma.learningSession.aggregate({
      where: { childId, date: { gte: sinceDate } },
      _sum: { durationMinutes: true },
    });
    return result._sum.durationMinutes ?? 0;
  }

  async averageAssessmentScoreInWindow(childId: string, sinceDate: Date): Promise<number | null> {
    const result = await this.prisma.learningAssessment.aggregate({
      where: { childId, takenAt: { gte: sinceDate } },
      _avg: { scorePercent: true },
    });
    return result._avg.scorePercent;
  }
}
