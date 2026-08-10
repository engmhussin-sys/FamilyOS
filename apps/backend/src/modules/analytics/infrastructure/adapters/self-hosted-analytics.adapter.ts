import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

import { PrismaService } from '../../../../common/prisma/prisma.service';
import type { IAnalyticsEventInput, IAnalyticsProviderAdapter } from '../../domain/analytics.types';

/** The real, no-external-dependency default \u2014 same role
 * `ManualPaymentAdapter` plays for Billing. */
@Injectable()
export class SelfHostedAnalyticsAdapter implements IAnalyticsProviderAdapter {
  readonly providerName = 'SELF_HOSTED';

  constructor(private readonly prisma: PrismaService) {}

  async track(event: IAnalyticsEventInput): Promise<void> {
    await this.prisma.analyticsEvent.create({
      data: {
        familyId: event.familyId,
        userId: event.userId,
        sessionId: event.sessionId,
        eventName: event.eventName,
        payload: event.payload as Prisma.InputJsonValue | undefined,
      },
    });
  }
}
