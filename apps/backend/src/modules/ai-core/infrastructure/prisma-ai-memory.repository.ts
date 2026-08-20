import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import type { Prisma } from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';
import type {
  AiMemoryCategory,
  IAiMemoryRecord,
  IAiMemoryRepository,
} from '../domain/memory.types';
import { tenantIdForWrite } from '../../../common/tenancy/tenant-context';

@Injectable()
export class PrismaAiMemoryRepository implements IAiMemoryRepository {
  constructor(private readonly prisma: PrismaService) {}

  async upsert(
    childId: string,
    category: AiMemoryCategory,
    key: string,
    value: Record<string, unknown>,
  ): Promise<void> {
    await this.prisma.aiMemoryEntry.upsert({
      where: { childId_category_key: { childId, category, key } },
      update: { value: value as Prisma.InputJsonValue },
      create: { familyId: tenantIdForWrite(), childId, category, key, value: value as Prisma.InputJsonValue },
    });
  }

  async record(
    childId: string,
    category: AiMemoryCategory,
    value: Record<string, unknown>,
  ): Promise<void> {
    // A random key per row — this category is event history, not state,
    // so every call must produce a new, independently-countable row.
    await this.prisma.aiMemoryEntry.create({
      data: { familyId: tenantIdForWrite(), childId, category, key: randomUUID(), value: value as Prisma.InputJsonValue },
    });
  }

  async find(
    childId: string,
    category: AiMemoryCategory,
    key: string,
  ): Promise<IAiMemoryRecord | null> {
    const record = await this.prisma.aiMemoryEntry.findUnique({
      where: { childId_category_key: { childId, category, key } },
    });
    return record as unknown as IAiMemoryRecord | null;
  }

  async findAllByCategory(childId: string, category: AiMemoryCategory): Promise<IAiMemoryRecord[]> {
    const records = await this.prisma.aiMemoryEntry.findMany({
      where: { childId, category },
      orderBy: { createdAt: 'desc' },
    });
    return records as unknown as IAiMemoryRecord[];
  }

  async countByCategorySince(childId: string, category: AiMemoryCategory, since: Date): Promise<number> {
    return this.prisma.aiMemoryEntry.count({
      where: { childId, category, createdAt: { gte: since } },
    });
  }
}
