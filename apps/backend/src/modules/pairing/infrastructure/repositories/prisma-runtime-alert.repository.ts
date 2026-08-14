import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

import { PrismaService } from '../../../../common/prisma/prisma.service';
import { PushNotificationService } from '../../application/services/push-notification.service';
import type {
  ICreateRuntimeAlertInput,
  IRuntimeAlertRecord,
  IRuntimeAlertRepository,
} from '../../application/ports/runtime-alert.repository.port';
import { tenantIdForWrite } from '../../../../common/tenancy/tenant-context';

@Injectable()
export class PrismaRuntimeAlertRepository implements IRuntimeAlertRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly pushNotification: PushNotificationService,
  ) {}

  async createForFamilyOwner(input: ICreateRuntimeAlertInput): Promise<void> {
    const notificationType = input.type ?? 'RUNTIME_ALERT';

    const owner = await this.prisma.familyMember.findFirst({
      where: { familyId: input.familyId, role: 'OWNER', deletedAt: null },
    });
    const recipient =
      owner ??
      (await this.prisma.familyMember.findFirst({
        where: { familyId: input.familyId, deletedAt: null },
      }));

    if (!recipient) return; // no one to notify — nothing more this method can do

    // CLOSES A REAL GAP (Master Completeness Audit): zero
    // deduplication existed — the same event firing repeatedly in a
    // short window (e.g. a flaky Accessibility Service toggling on
    // and off) previously created a duplicate notification every
    // single time. A 5-minute window matching the exact same
    // recipient/type/childId/title is treated as the same real-world
    // event, not a new one worth re-alerting about.
    //
    // FIXES A REAL BUG (Sprint 16.1 Phase 3): this query was
    // hardcoded to type: 'RUNTIME_ALERT' — deduplication would have
    // silently never matched for any of the new Smart Notification
    // types this Phase introduces (HYDRATION_REMINDER, etc.), since
    // every one of THOSE rows also has type='RUNTIME_ALERT' baked in
    // by the OLD version of this same query, comparing the wrong
    // field entirely. Now compares the REAL type.
    const DEDUP_WINDOW_MS = 5 * 60 * 1000;
    const recentDuplicate = await this.prisma.notification.findFirst({
      where: {
        userId: recipient.userId,
        childId: input.childId,
        type: notificationType,
        title: input.title,
        createdAt: { gte: new Date(Date.now() - DEDUP_WINDOW_MS) },
      },
    });
    if (recentDuplicate) return;

    await this.prisma.notification.create({
      data: {
        familyId: tenantIdForWrite(),
        userId: recipient.userId,
        childId: input.childId,
        type: notificationType,
        title: input.title,
        body: input.body,
        // CLOSES A REAL GAP (Master Completeness Audit): every
        // caller previously had no priority distinction at all.
        priority: input.priority ?? 'NORMAL',
        data: input.data as Prisma.InputJsonValue | undefined,
      },
    });

    // Sprint 5 (Push Notifications) — CLOSES A REAL GAP: every
    // critical alert already flowed through this exact method
    // (accessibility disabled, and now the five Digital Wellbeing
    // event types) — this is the same single point, now also
    // triggering a real push instead of relying entirely on the
    // in-app Notification row being noticed via polling. Best-effort
    // and non-blocking: a push failure never prevents the in-app
    // record above, which is already saved by the time this runs.
    const pushTokens = await this.prisma.device.findMany({
      where: { userId: recipient.userId, pushToken: { not: null } },
      select: { pushToken: true },
    });
    await Promise.all(
      pushTokens
        .filter((d: { pushToken: string | null }): d is { pushToken: string } => d.pushToken !== null)
        .map((d: { pushToken: string }) => this.pushNotification.sendToDevice(d.pushToken, input.title, input.body)),
    );
  }

  async listForUser(userId: string): Promise<IRuntimeAlertRecord[]> {
    return this.prisma.notification.findMany({
      where: { userId, type: 'RUNTIME_ALERT' },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
  }
}
