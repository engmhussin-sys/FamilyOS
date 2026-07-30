import { Injectable, Logger } from '@nestjs/common';

import { PrismaService } from '../../../common/prisma/prisma.service';

export interface IRetentionEnforcementResult {
  category: string;
  action: string;
  affectedRows: number;
}

/**
 * The executable half of DataRetentionPolicyService \u2014 deliberately
 * covers only the two categories whose policy is unambiguous enough to
 * automate safely: Notifications (hard delete, purely transient) and
 * Analytics Events (anonymize, already PII-filtered). Every other
 * category in the policy table requires a human decision before
 * deletion (audit/compliance data) or has nothing to delete (cached
 * state, on-demand reports) \u2014 this class does NOT attempt those, on
 * purpose, per DataRetentionPolicyService's own docstring.
 */
@Injectable()
export class DataRetentionEnforcementService {
  private readonly logger = new Logger(DataRetentionEnforcementService.name);

  constructor(private readonly prisma: PrismaService) {}

  async enforceNotificationRetention(retentionDays = 90): Promise<IRetentionEnforcementResult> {
    const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
    const result = await this.prisma.notification.deleteMany({
      where: { createdAt: { lt: cutoff } },
    });
    this.logger.log(`Retention: deleted ${result.count} notification(s) older than ${retentionDays} days.`);
    return { category: 'Notifications', action: 'HARD_DELETE', affectedRows: result.count };
  }

  async enforceAnalyticsRetention(retentionDays = 180): Promise<IRetentionEnforcementResult> {
    const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
    const result = await this.prisma.analyticsEvent.updateMany({
      where: { occurredAt: { lt: cutoff }, familyId: { not: null } },
      data: { familyId: null, userId: null },
    });
    this.logger.log(`Retention: anonymized ${result.count} analytics event(s) older than ${retentionDays} days.`);
    return { category: 'Analytics Events', action: 'ANONYMIZE', affectedRows: result.count };
  }

  /** Runs both \u2014 the method a future scheduler (once chosen) would
   * call. Not scheduled anywhere itself. */
  async enforceAll(): Promise<IRetentionEnforcementResult[]> {
    return [await this.enforceNotificationRetention(), await this.enforceAnalyticsRetention()];
  }
}
