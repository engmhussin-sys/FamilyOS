import { Injectable } from '@nestjs/common';

import { PrismaService } from '../../../../common/prisma/prisma.service';
import { IGeneratedSmartTask, ISmartTask } from '../../domain/smart-task.types';

@Injectable()
export class PrismaSmartTaskRepository {
  constructor(private readonly prisma: PrismaService) {}

  async createMany(childId: string, suggestions: IGeneratedSmartTask[], suggestedDate: Date, sourceSignals: Record<string, unknown>): Promise<number> {
    const result = await this.prisma.smartTask.createMany({
      data: suggestions.map((s) => ({
        childId,
        title: s.title,
        category: s.category,
        generatedReason: s.reason,
        sourceSignals,
        suggestedDate,
      })),
    });
    return result.count;
  }

  async listForChildOnDate(childId: string, date: Date): Promise<ISmartTask[]> {
    const rows = await this.prisma.smartTask.findMany({ where: { childId, suggestedDate: date } });
    return rows.map((row) => this.toDomain(row));
  }

  async findById(taskId: string): Promise<ISmartTask | null> {
    const row = await this.prisma.smartTask.findUnique({ where: { id: taskId } });
    return row ? this.toDomain(row) : null;
  }

  async updateStatus(taskId: string, status: ISmartTask['status']): Promise<void> {
    await this.prisma.smartTask.update({ where: { id: taskId }, data: { status, decidedAt: new Date() } });
  }

  private toDomain(row: {
    id: string;
    childId: string;
    title: string;
    category: string;
    generatedReason: string;
    sourceSignals: unknown;
    suggestedDate: Date;
    status: string;
  }): ISmartTask {
    return {
      id: row.id,
      childId: row.childId,
      title: row.title,
      category: row.category,
      generatedReason: row.generatedReason,
      sourceSignals: row.sourceSignals as Record<string, unknown>,
      suggestedDate: row.suggestedDate,
      status: row.status as ISmartTask['status'],
    };
  }
}
