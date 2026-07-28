import { Injectable } from '@nestjs/common';
import type { ScreenTimePolicy } from '@prisma/client';

import { PrismaService } from '../../../../common/prisma/prisma.service';
import type { ISetScreenTimePolicyInput } from '../../domain/screen-time.types';
import type { IScreenTimePolicyRepository } from '../../application/ports/screen-time.repository.port';

@Injectable()
export class PrismaScreenTimePolicyRepository implements IScreenTimePolicyRepository {
  constructor(private readonly prisma: PrismaService) {}

  create(
    childId: string,
    createdByUserId: string,
    input: ISetScreenTimePolicyInput,
  ): Promise<ScreenTimePolicy> {
    return this.prisma.screenTimePolicy.create({
      data: {
        childId,
        createdByUserId,
        dailyLimitMinutes: input.dailyLimitMinutes,
        bedtimeStart: input.bedtimeStart,
        bedtimeEnd: input.bedtimeEnd,
        // Prisma's Json columns want Prisma.InputJsonValue; cast explicitly
        // since this input is intentionally opaque (see screen-time.types.ts).
        weekdaySchedule: input.weekdaySchedule as object | undefined,
        focusModeEnabled: input.focusModeEnabled ?? false,
      },
    });
  }

  findActiveByChild(childId: string): Promise<ScreenTimePolicy | null> {
    return this.prisma.screenTimePolicy.findFirst({
      where: { childId, deletedAt: null },
      orderBy: { effectiveFrom: 'desc' },
    });
  }

  async deactivate(policyId: string): Promise<void> {
    await this.prisma.screenTimePolicy.update({
      where: { id: policyId },
      data: { deletedAt: new Date() },
    });
  }
}
