import { Injectable } from '@nestjs/common';

import { PrismaService } from '../../../../common/prisma/prisma.service';
import type { IAppBlockRule, ICreateAppBlockRuleInput } from '../../domain/screen-time.types';
import type { IAppBlockRuleRepository } from '../../application/ports/screen-time.repository.port';
import { tenantIdForWrite } from '../../../../common/tenancy/tenant-context';

@Injectable()
export class PrismaAppBlockRuleRepository implements IAppBlockRuleRepository {
  constructor(private readonly prisma: PrismaService) {}

  async create(childId: string, createdByUserId: string, input: ICreateAppBlockRuleInput): Promise<IAppBlockRule> {
    const row = await this.prisma.appBlockRule.create({
      data: {
        familyId: tenantIdForWrite(),
        childId,
        createdByUserId,
        packageName: input.packageName,
        category: input.category,
        ruleType: input.ruleType,
        limitMinutes: input.limitMinutes,
        schedule: input.schedule as object | undefined,
      },
    });
    return this.toDomain(row);
  }

  async findById(ruleId: string): Promise<IAppBlockRule | null> {
    const row = await this.prisma.appBlockRule.findUnique({ where: { id: ruleId } });
    return row ? this.toDomain(row) : null;
  }

  async listActiveByChild(childId: string): Promise<IAppBlockRule[]> {
    const rows = await this.prisma.appBlockRule.findMany({ where: { childId, isActive: true, deletedAt: null } });
    return rows.map((row: Parameters<typeof this.toDomain>[0]) => this.toDomain(row));
  }

  async deactivate(ruleId: string): Promise<void> {
    await this.prisma.appBlockRule.update({ where: { id: ruleId }, data: { isActive: false, deletedAt: new Date() } });
  }

  private toDomain(row: {
    id: string;
    childId: string;
    packageName: string | null;
    category: string | null;
    ruleType: string;
    limitMinutes: number | null;
    schedule: unknown;
    isActive: boolean;
  }): IAppBlockRule {
    return {
      id: row.id,
      childId: row.childId,
      packageName: row.packageName,
      category: row.category,
      ruleType: row.ruleType as IAppBlockRule['ruleType'],
      limitMinutes: row.limitMinutes,
      schedule: (row.schedule as Record<string, unknown> | null) ?? null,
      isActive: row.isActive,
    };
  }
}
