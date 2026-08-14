import { Injectable } from '@nestjs/common';

import type { Prisma } from '@prisma/client';
import { PrismaService } from '../../../../common/prisma/prisma.service';
import { IFaithPractice, IFaithPracticeLog, ICreateFaithPracticeInput } from '../../domain/faith.types';
import { tenantIdForWrite } from '../../../../common/tenancy/tenant-context';

@Injectable()
export class PrismaFaithRepository {
  constructor(private readonly prisma: PrismaService) {}

  async createPractice(input: ICreateFaithPracticeInput): Promise<IFaithPractice> {
    const row = await this.prisma.faithPractice.create({
      data: { familyId: tenantIdForWrite(), childId: input.childId, type: input.type, title: input.title, config: (input.config ?? undefined) as Prisma.InputJsonValue | undefined },
    });
    // A just-created practice cannot have a log yet — false is certain.
    return this.toDomainPractice(row, false);
  }

  async findPracticeById(practiceId: string): Promise<IFaithPractice | null> {
    const row = await this.prisma.faithPractice.findUnique({ where: { id: practiceId } });
    // Only used internally for ownership checks today — none of its
    // callers read completedToday.
    return row ? this.toDomainPractice(row, false) : null;
  }

  async listActivePractices(childId: string): Promise<IFaithPractice[]> {
    const [rows, todaysLogs] = await Promise.all([
      this.prisma.faithPractice.findMany({ where: { childId, isActive: true } }),
      // One query for all of today's logs, not one per practice.
      this.prisma.faithPracticeLog.findMany({
        where: { childId, date: this.todayDateOnly() },
        select: { practiceId: true },
      }),
    ]);
    const completedPracticeIds = new Set(todaysLogs.map((l: { practiceId: string }) => l.practiceId));
    return rows.map((row: { id: string }) => this.toDomainPractice(row as any, completedPracticeIds.has(row.id)));
  }

  /** Matches FaithEngineService.today()'s own UTC-midnight convention
   * exactly, so "today" here and "today" at write time always agree. */
  private todayDateOnly(): Date {
    const now = new Date();
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  }

  async countActivePractices(childId: string): Promise<number> {
    return this.prisma.faithPractice.count({ where: { childId, isActive: true } });
  }

  async recordLog(practiceId: string, childId: string, date: Date, progress?: Record<string, unknown>): Promise<IFaithPracticeLog> {
    const row = await this.prisma.faithPracticeLog.upsert({
      where: { practiceId_date: { practiceId, date } },
      create: { familyId: tenantIdForWrite(), practiceId, childId, date, progress: (progress ?? undefined) as Prisma.InputJsonValue | undefined },
      update: { progress: (progress ?? undefined) as Prisma.InputJsonValue | undefined },
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
  }, completedToday: boolean): IFaithPractice {
    return {
      id: row.id,
      childId: row.childId,
      type: row.type as IFaithPractice['type'],
      title: row.title,
      config: (row.config as Record<string, unknown> | null) ?? null,
      isActive: row.isActive,
      completedToday,
    };
  }
}
