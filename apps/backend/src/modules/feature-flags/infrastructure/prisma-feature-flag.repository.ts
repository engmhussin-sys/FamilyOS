import { Injectable } from '@nestjs/common';

import { PrismaService } from '../../../common/prisma/prisma.service';
import type {
  IFeatureFlagRecord,
  IFeatureFlagRepository,
} from '../domain/feature-flag.repository.port';

@Injectable()
export class PrismaFeatureFlagRepository implements IFeatureFlagRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findByKey(key: string): Promise<IFeatureFlagRecord | null> {
    return this.prisma.featureFlag.findUnique({ where: { key } });
  }

  async listAll(): Promise<IFeatureFlagRecord[]> {
    return this.prisma.featureFlag.findMany({ orderBy: { key: 'asc' } });
  }

  async upsert(record: IFeatureFlagRecord): Promise<void> {
    await this.prisma.featureFlag.upsert({
      where: { key: record.key },
      update: record,
      create: record,
    });
  }
}
