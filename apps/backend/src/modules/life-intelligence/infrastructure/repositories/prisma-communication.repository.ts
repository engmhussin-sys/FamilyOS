import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

import { PrismaService } from '../../../../common/prisma/prisma.service';
import { IChildMessage, ISendChildMessageInput } from '../../domain/communication.types';
import { tenantIdForWrite } from '../../../../common/tenancy/tenant-context';

@Injectable()
export class PrismaCommunicationRepository {
  constructor(private readonly prisma: PrismaService) {}

  async create(input: ISendChildMessageInput, approvalStatus: IChildMessage['approvalStatus'], deliveredAt: Date | null): Promise<IChildMessage> {
    const row = await this.prisma.childMessage.create({
      data: {
        familyId: tenantIdForWrite(),
        childId: input.childId,
        fromUserId: input.fromUserId,
        authorType: input.authorType,
        approvalStatus,
        category: input.category,
        title: input.title,
        body: input.body,
        deliveredAt: deliveredAt ?? undefined,
        // B9 — NULL for a parent-authored message, a composed causal key for a
        // machine-generated one. See `ISendChildMessageInput.sourceEventId`.
        sourceEventId: input.sourceEventId ?? null,
        // PHASE F1 — the notification payload: `{ deepLink }` and nothing else,
        // already narrowed by `childSafeNotificationPayload`. See
        // `IChildMessage.data`.
        //
        // `undefined` RATHER THAN `null` ON THE ABSENT BRANCH, and the
        // distinction is Prisma's own: on a `Json?` column, `null` writes the
        // JSON literal `null` INTO the column and `undefined` omits the column
        // so it stays SQL NULL. «This row has no destination» is the absence of
        // a value, not a stored JSON `null` a client would then have to
        // special-case.
        data: (input.data ?? undefined) as Prisma.InputJsonValue | undefined,
      },
    });
    return this.toDomain(row);
  }

  /**
   * B9 (PA-B-007 / PA-B-008) — the child-side counterpart of
   * `PrismaRuntimeAlertRepository`'s P2002 branch.
   *
   * Returns `null` when `child_messages (family_id, source_event_id)` refuses
   * the insert, which now means exactly one thing: this notification has
   * already been drafted for this cause in this family. That is a SUCCESS —
   * a redelivered outbox message did its job the first time — so the caller
   * reports a suppressed duplicate rather than failing a business transaction
   * that has already committed.
   *
   * Any other error is rethrown: swallowing a genuine write failure would turn
   * a lost notification into a silent one, which is the other half of
   * PA-B-009, and this method must not add to it.
   */
  async createIfAbsent(
    input: ISendChildMessageInput,
    approvalStatus: IChildMessage['approvalStatus'],
    deliveredAt: Date | null,
  ): Promise<IChildMessage | null> {
    try {
      return await this.create(input, approvalStatus, deliveredAt);
    } catch (err) {
      if ((err as { code?: string }).code === 'P2002') return null;
      throw err;
    }
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

  /** Only DELIVERED messages are visible to the child — a PENDING
   * AI-drafted message must never appear in the child's inbox before
   * a parent approves it. */
  async listDeliveredForChild(childId: string): Promise<IChildMessage[]> {
    const rows = await this.prisma.childMessage.findMany({
      where: { childId, deliveredAt: { not: null } },
      orderBy: { deliveredAt: 'desc' },
    });
    return rows.map((row) => this.toDomain(row));
  }

  /** CLOSES A CRITICAL REAL GAP: approve()/reject() existed, but
   * nothing ever surfaced WHAT needed approving to a parent — every
   * AI-drafted message (every Smart Notification targeted at a
   * child, built across Sprint 16-16.2) was structurally
   * unreachable without this. Scoped by familyId (via Child's own
   * relation), not childId — a parent needs to see pending messages
   * across ALL their children in one place. */
  async listPendingForFamily(familyId: string): Promise<Array<IChildMessage & { childName: string }>> {
    const rows = await this.prisma.childMessage.findMany({
      where: { approvalStatus: 'PENDING', child: { familyId } },
      include: { child: { select: { firstName: true } } },
      orderBy: { id: 'desc' }, // PENDING messages have no deliveredAt yet -- id (UUID, insertion-adjacent) is the only reasonable recency proxy without adding a new column
    });
    return rows.map((row: any) => ({ ...this.toDomain(row), childName: row.child.firstName as string }));
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
    data?: unknown;
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
      // PHASE F1 — SERVED, not only stored. This is the field
      // `GET /life-intelligence/self/messages` puts on the wire and the child
      // app reads with `deepLinkFromNotification`.
      //
      // NORMALISED TO `null` FOR ANYTHING THAT IS NOT AN OBJECT: a SQL NULL, a
      // stored JSON `null`, and (defensively) a scalar all mean «this row has
      // no destination», and the client should not have to tell three absences
      // apart to decide whether a card is tappable.
      data:
        row.data !== null && typeof row.data === 'object' && !Array.isArray(row.data)
          ? (row.data as Record<string, unknown>)
          : null,
      deliveredAt: row.deliveredAt,
      acknowledgedAt: row.acknowledgedAt,
    };
  }
}
