import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';

import { PrismaService } from '../../../common/prisma/prisma.service';
import type {
  AiMemoryCategory,
  IAiMemoryRecord,
  IAiMemoryRepository,
} from '../domain/memory.types';

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
      update: { value },
      create: { childId, category, key, value },
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
      data: { childId, category, key: randomUUID(), value },
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
    return record as IAiMemoryRecord | null;
  }

  async findAllByCategory(childId: string, category: AiMemoryCategory): Promise<IAiMemoryRecord[]> {
    return this.prisma.aiMemoryEntry.findMany({
      where: { childId, category },
      orderBy: { createdAt: 'desc' },
    });
  }

  async countByCategorySince(childId: string, category: AiMemoryCategory, since: Date): Promise<number> {
    return this.prisma.aiMemoryEntry.count({
      where: { childId, category, createdAt: { gte: since } },
    });
  }
}
