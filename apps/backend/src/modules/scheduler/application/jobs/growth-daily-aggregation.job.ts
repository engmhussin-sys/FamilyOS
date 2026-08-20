import { Injectable, Logger } from '@nestjs/common';

import { GrowthAggregationService } from '../../../analytics/application/growth-aggregation.service';
import { ReferralRewardService } from '../../../analytics/application/referral-reward.service';
import type { JobOutcome, PlatformJobContext, PlatformJobDefinition } from '../../domain/job.types';

export const GROWTH_DAILY_AGGREGATION_JOB = 'growth-daily-aggregation';

/**
 * PHASE D (GROWTH) — THE DAILY AGGREGATE AND THE REFERRAL QUALIFICATION SWEEP,
 * IN ONE JOB.
 *
 * WHY THEY ARE ONE JOB AND NOT TWO. Both close the same day for the same
 * reason, both are idempotent by a unique index, and both are bounded. Two jobs
 * would mean two leases, two histories and two places for an operator to look
 * when "did last night's growth work run?" — and the failure mode of splitting
 * them is that the aggregate reports a conversion the referral sweep has not
 * yet credited, which is a number that changes when you refresh it.
 *
 * IDEMPOTENCY, TWICE OVER AND BOTH TIMES AT THE DATABASE:
 *   - the aggregate UPSERTs on `(business_date, country_code)`, so ten runs
 *     produce one row with today's numbers;
 *   - the referral sweep INSERTs a reward keyed on `referral_event_id` UNIQUE,
 *     so ten runs produce one payout.
 * Neither depends on this job running exactly once, which is what makes a
 * manual re-run after an incident safe — and a manual re-run after an incident
 * is exactly what an operator will want.
 *
 * NO DUPLICATE EXECUTION ACROSS REPLICAS is the scheduler's own property, not
 * this job's: `JobRunner` claims a `scheduled_jobs` lease with
 * `pg_try_advisory_xact_lock` before invoking a handler (Phase C `PA-B-031`).
 * This job inherits it and adds the two constraints above as defence in depth,
 * because a lease is a lock and a lock is not a guarantee about what happened
 * before it was acquired.
 *
 * IT IS A PLATFORM JOB WITH NO `localHour`. A per-family local hour would be
 * meaningless: a platform-wide aggregate has no family calendar. The day
 * boundary each country's row is computed on comes from
 * `reporting.timezone.<CC>`, read at run time.
 */
@Injectable()
export class GrowthDailyAggregationJob {
  private readonly logger = new Logger(GrowthDailyAggregationJob.name);

  constructor(
    private readonly aggregation: GrowthAggregationService,
    private readonly referralRewards: ReferralRewardService,
  ) {}

  definition(): PlatformJobDefinition {
    return {
      name: GROWTH_DAILY_AGGREGATION_JOB,
      scope: 'PLATFORM',
      description:
        'يُغلق اليوم المرجعي لكل سوق: يحسب مؤشرات النمو اليومية ويكتبها كصف واحد لكل (يوم، بلد)، ثم يمرّ على الإحالات المسجَّلة ويؤهّل ما تجاوز نافذة الاسترداد.',
      handler: (ctx) => this.run(ctx),
    };
  }

  async run(ctx: PlatformJobContext): Promise<JobOutcome> {
    const aggregated = await this.aggregation.run(ctx.now);
    const qualified = await this.referralRewards.sweep(ctx.now);

    const rowsCreated = aggregated.filter((a) => a.created).length;
    const rowsUpdated = aggregated.length - rowsCreated;
    const referralsQualified = qualified.filter((q) => q.qualified).length;

    this.logger.log(
      `growth.aggregation scopes=${aggregated.length} created=${rowsCreated} updated=${rowsUpdated} referralsQualified=${referralsQualified}`,
    );

    return {
      affectedRows: aggregated.length + referralsQualified,
      // COUNTS AND ONLY COUNTS, per `JobOutcome`'s own contract. A growth job
      // that logged WHICH households converted would put marketing-relevant
      // per-family data into a table with a longer retention period than the
      // analytics it was derived from.
      details: {
        metric_rows_created: rowsCreated,
        metric_rows_updated: rowsUpdated,
        referrals_evaluated: qualified.length,
        referrals_qualified: referralsQualified,
      },
    };
  }
}
