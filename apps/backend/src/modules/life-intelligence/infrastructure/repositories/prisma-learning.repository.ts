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
