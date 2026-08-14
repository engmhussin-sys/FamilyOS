import { Injectable } from '@nestjs/common';

import type { Prisma } from '@prisma/client';
import { PrismaService } from '../../../../common/prisma/prisma.service';
import { ILifeTimelineEvent, IRecordTimelineEventInput } from '../../domain/life-timeline.types';
import { tenantIdForWrite } from '../../../../common/tenancy/tenant-context';

@Injectable()
export class PrismaLifeTimelineRepository {
  constructor(private readonly prisma: PrismaService) {}

  async create(input: IRecordTimelineEventInput): Promise<ILifeTimelineEvent> {
    const row = await this.prisma.lifeTimelineEvent.create({
      data: {
        familyId: tenantIdForWrite(),
        childId: input.childId,
        sourceEngine: input.sourceEngine,
        category: input.category,
        eventType: input.eventType,
        title: input.title,
        metadata: (input.metadata ?? undefined) as Prisma.InputJsonValue | undefined,
      },
    });
    return this.toDomain(row);
  }

  async listForChild(childId: string, category?: string, limit = 50): Promise<ILifeTimelineEvent[]> {
    const rows = await this.prisma.lifeTimelineEvent.findMany({
      where: { childId, ...(category ? { category: category as never } : {}) },
      orderBy: { occurredAt: 'desc' },
      take: limit,
    });
    return rows.map((row) => this.toDomain(row));
  }

  private toDomain(row: {
    id: string;
    childId: string;
    sourceEngine: string;
    category: string;
    eventType: string;
    title: string;
    occurredAt: Date;
    metadata: unknown;
  }): ILifeTimelineEvent {
    return {
      id: row.id,
      childId: row.childId,
      sourceEngine: row.sourceEngine,
      category: row.category as ILifeTimelineEvent['category'],
      eventType: row.eventType,
      title: row.title,
      occurredAt: row.occurredAt,
      metadata: (row.metadata as Record<string, unknown> | null) ?? null,
    };
  }
}
