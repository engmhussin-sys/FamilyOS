import { Injectable } from '@nestjs/common';

import { PrismaService } from '../../../../common/prisma/prisma.service';
import { IFaithPractice, IFaithPracticeLog, ICreateFaithPracticeInput } from '../../domain/faith.types';

@Injectable()
export class PrismaFaithRepository {
  constructor(private readonly prisma: PrismaService) {}

  async createPractice(input: ICreateFaithPracticeInput): Promise<IFaithPractice> {
    const row = await this.prisma.faithPractice.create({
      data: { childId: input.childId, type: input.type, title: input.title, config: input.config ?? undefined },
    });
    return this.toDomainPractice(row);
  }

  async findPracticeById(practiceId: string): Promise<IFaithPractice | null> {
    const row = await this.prisma.faithPractice.findUnique({ where: { id: practiceId } });
    return row ? this.toDomainPractice(row) : null;
  }

  async listActivePractices(childId: string): Promise<IFaithPractice[]> {
    const rows = await this.prisma.faithPractice.findMany({ where: { childId, isActive: true } });
    return rows.map((row) => this.toDomainPractice(row));
  }

  async countActivePractices(childId: string): Promise<number> {
    return this.prisma.faithPractice.count({ where: { childId, isActive: true } });
  }

  async recordLog(practiceId: string, childId: string, date: Date, progress?: Record<string, unknown>): Promise<IFaithPracticeLog> {
    const row = await this.prisma.faithPracticeLog.upsert({
      where: { practiceId_date: { practiceId, date } },
      create: { practiceId, childId, date, progress: progress ?? undefined },
      update: { progress: progress ?? undefined },
    });
    return {
      id: row.id,
      practiceId: row.practiceId,
      childId: row.childId,
      date: row.date,
      progress: (row.progress as Record<string, unknown> | null) ?? null,
      completedAt: row.completedAt,
    };
  }

  async countLogsInWindow(childId: string, sinceDate: Date): Promise<number> {
    return this.prisma.faithPracticeLog.count({ where: { childId, date: { gte: sinceDate } } });
  }

  async countPracticeLogsTotal(practiceId: string): Promise<number> {
    return this.prisma.faithPracticeLog.count({ where: { practiceId } });
  }

  private toDomainPractice(row: {
    id: string;
    childId: string;
    type: string;
    title: string;
    config: unknown;
    isActive: boolean;
  }): IFaithPractice {
    return {
      id: row.id,
      childId: row.childId,
      type: row.type as IFaithPractice['type'],
      title: row.title,
      config: (row.config as Record<string, unknown> | null) ?? null,
      isActive: row.isActive,
    };
  }
}
