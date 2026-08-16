import { Injectable, Logger } from '@nestjs/common';

import { GrowthAlertsService } from '../../../analytics/application/growth-alerts.service';
import type { JobOutcome, PlatformJobContext, PlatformJobDefinition } from '../../domain/job.types';

export const GROWTH_ALERT_SCAN_JOB = 'growth-alert-scan';

/**
 * PHASE D (GROWTH) — THE HOURLY SCAN FOR THE EIGHT CONDITIONS AN OPERATOR MUST
 * NOT LEARN ABOUT FROM A CUSTOMER.
 *
 * WHY HOURLY AND NOT DAILY. Six of the eight rules are trends and would be
 * perfectly well served by a daily scan. Two are not: a payment-failure spike
 * and an AI-safety incident are both things where the difference between
 * finding out in one hour and finding out in twenty-four is the difference
 * between an incident and a headline. Running all eight hourly costs a handful
 * of counting queries and removes the need to decide, per rule, how urgent it
 * is — a decision that would be wrong for at least one of them.
 *
 * HOURLY SCANNING WOULD NORMALLY MEAN 24 ALERTS A DAY FOR ONE CONDITION. It
 * does not, because `growth_alerts (alert_type, scope_key, business_date)` is
 * UNIQUE: the second scan of a persisting condition inserts nothing and the
 * job reports `raised: 0`. The dedupe is a database constraint rather than an
 * in-memory cooldown precisely so it survives a deploy and a second replica —
 * and a deploy during an incident is exactly when a cooldown map would reset.
 *
 * IT DOES NOT PAGE ANYONE. It writes rows. Routing them to a human is the
 * notification layer's job and deliberately not this one's: an alerting rule
 * that also owns delivery is an alerting rule that cannot be tested without a
 * delivery channel, and the eight rules here are worth testing.
 */
@Injectable()
export class GrowthAlertScanJob {
  private readonly logger = new Logger(GrowthAlertScanJob.name);

  constructor(private readonly alerts: GrowthAlertsService) {}

  definition(): PlatformJobDefinition {
    return {
      name: GROWTH_ALERT_SCAN_JOB,
      scope: 'PLATFORM',
      description:
        'مسح كل ساعة لثمانية شروط تشغيلية: هبوط التحويل، ارتفاع التسرّب، قفزة فشل المدفوعات، فشل المكافآت، فشل الإشعارات، حادثة سلامة AI، هبوط الاحتفاظ، وتحوّل أداء بلد.',
      handler: (ctx) => this.run(ctx),
    };
  }

  async run(ctx: PlatformJobContext): Promise<JobOutcome> {
    const results = await this.alerts.scan(ctx.now);
    const raised = results.filter((r) => r.created);

    if (raised.length > 0) {
      this.logger.warn(`growth.alerts_raised count=${raised.length} types=${raised.map((r) => r.alertType).join(',')}`);
    }

    const byType: Record<string, number> = {};
    for (const alert of raised) {
      byType[alert.alertType.toLowerCase()] = (byType[alert.alertType.toLowerCase()] ?? 0) + 1;
    }

    return {
      affectedRows: raised.length,
      details: {
        conditions_evaluated: results.length,
        alerts_raised: raised.length,
        alerts_deduped: results.length - raised.length,
        ...byType,
      },
    };
  }
}
