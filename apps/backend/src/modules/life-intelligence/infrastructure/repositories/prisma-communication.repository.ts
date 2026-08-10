import { Injectable } from '@nestjs/common';

import { PrismaService } from '../../../../common/prisma/prisma.service';
import { IChildMessage, ISendChildMessageInput } from '../../domain/communication.types';

@Injectable()
export class PrismaCommunicationRepository {
  constructor(private readonly prisma: PrismaService) {}

  async create(input: ISendChildMessageInput, approvalStatus: IChildMessage['approvalStatus'], deliveredAt: Date | null): Promise<IChildMessage> {
    const row = await this.prisma.childMessage.create({
      data: {
        childId: input.childId,
        fromUserId: input.fromUserId,
        authorType: input.authorType,
        approvalStatus,
        category: input.category,
        title: input.title,
        body: input.body,
        deliveredAt: deliveredAt ?? undefined,
      },
    });
    return this.toDomain(row);
  }

  async findById(messageId: string): Promise<IChildMessage | null> {
    const row = await this.prisma.childMessage.findUnique({ where: { id: messageId } });
    return row ? this.toDomain(row) : null;
  }

  async approveAndDeliver(messageId: string): Promise<void> {
    await this.prisma.childMessage.update({
      where: { id: messageId },
      data: { approvalStatus: 'APPROVED', deliveredAt: new Date() },
    });
  }

  async reject(messageId: string): Promise<void> {
    await this.prisma.childMessage.update({ where: { id: messageId }, data: { approvalStatus: 'REJECTED' } });
  }

  /** Only DELIVERED messages are visible to the child \u2014 a PENDING
   * AI-drafted message must never appear in the child's inbox before
   * a parent approves it. */
  async listDeliveredForChild(childId: string): Promise<IChildMessage[]> {
    const rows = await this.prisma.childMessage.findMany({
      where: { childId, deliveredAt: { not: null } },
      orderBy: { deliveredAt: 'desc' },
    });
    return rows.map((row) => this.toDomain(row));
  }

  async acknowledge(messageId: string): Promise<void> {
    await this.prisma.childMessage.update({ where: { id: messageId }, data: { acknowledgedAt: new Date() } });
  }

  private toDomain(row: {
    id: string;
    childId: string;
    fromUserId: string | null;
    authorType: string;
    approvalStatus: string;
    category: string;
    title: string;
    body: string;
    deliveredAt: Date | null;
    acknowledgedAt: Date | null;
  }): IChildMessage {
    return {
      id: row.id,
      childId: row.childId,
      fromUserId: row.fromUserId,
      authorType: row.authorType as IChildMessage['authorType'],
      approvalStatus: row.approvalStatus as IChildMessage['approvalStatus'],
      category: row.category,
      title: row.title,
      body: row.body,
      deliveredAt: row.deliveredAt,
      acknowledgedAt: row.acknowledgedAt,
    };
  }
}
