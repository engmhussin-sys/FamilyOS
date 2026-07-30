import { Injectable } from '@nestjs/common';

import { PrismaService } from '../../../../common/prisma/prisma.service';
import type {
  ICreateRuntimeAlertInput,
  IRuntimeAlertRecord,
  IRuntimeAlertRepository,
} from '../../application/ports/runtime-alert.repository.port';

@Injectable()
export class PrismaRuntimeAlertRepository implements IRuntimeAlertRepository {
  constructor(private readonly prisma: PrismaService) {}

  async createForFamilyOwner(input: ICreateRuntimeAlertInput): Promise<void> {
    const owner = await this.prisma.familyMember.findFirst({
      where: { familyId: input.familyId, role: 'OWNER', deletedAt: null },
    });
    // Fall back to any member if no OWNER row is found (shouldn't
    // happen given Family creation always assigns one, but a runtime
    // alert failing silently is worse than a slightly-wrong recipient).
    const recipient =
      owner ??
      (await this.prisma.familyMember.findFirst({
        where: { familyId: input.familyId, deletedAt: null },
      }));

    if (!recipient) return; // no one to notify — nothing more this method can do

    await this.prisma.notification.create({
      data: {
        userId: recipient.userId,
        childId: input.childId,
        type: 'RUNTIME_ALERT',
        title: input.title,
        body: input.body,
        data: input.data,
      },
    });
  }

  async listForUser(userId: string): Promise<IRuntimeAlertRecord[]> {
    return this.prisma.notification.findMany({
      where: { userId, type: 'RUNTIME_ALERT' },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
  }
}
