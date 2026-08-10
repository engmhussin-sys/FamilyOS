import { Injectable, ForbiddenException } from '@nestjs/common';

import { ChildrenService } from '../../../children/application/services/children.service';
import { LifeTimelineService } from './life-timeline.service';
import { DigitalTwinService } from './digital-twin.service';
import { EntitlementsService } from '../../../billing/application/services/entitlements.service';

export interface IFamilyInsightWeeklySummary {
  childId: string;
  digitalTwin: Awaited<ReturnType<DigitalTwinService['refreshAndGet']>>;
  recentTimelineHighlights: Awaited<ReturnType<LifeTimelineService['getTimeline']>>;
}

/**
 * Architecture 1.0 §5.9: mirrors `DashboardMetricsService`'s own
 * aggregation pattern (Sprint 8) — a read-only composer, no new
 * source-of-truth table, reusing the Digital Twin (already itself an
 * aggregate) and the Unified Timeline.
 */
@Injectable()
export class FamilyInsightService {
  constructor(
    private readonly childrenService: ChildrenService,
    private readonly digitalTwin: DigitalTwinService,
    private readonly timeline: LifeTimelineService,
    private readonly entitlements: EntitlementsService,
  ) {}

  async getWeeklySummary(childId: string, familyId: string): Promise<IFamilyInsightWeeklySummary> {
    await this.childrenService.assertChildBelongsToFamily(childId, familyId);

    // CLOSES A REAL GAP (proactive business/code audit): EntitlementsService
    // has existed since Sprint 8 with a docstring explicitly noting
    // "no existing feature currently calls this" — the billing system
    // enforced nothing anywhere. This is the first real wiring, on the
    // one feature already flagged 'family_insights' in the seeded plan
    // definitions. Fails closed (403), matching every other
    // authorization check in this codebase.
    const entitled = await this.entitlements.hasFeature(familyId, 'family_insights');
    if (!entitled) {
      throw new ForbiddenException('Family Insights requires a Premium, Family, or Enterprise plan.');
    }

    const [digitalTwinResult, recentTimelineHighlights] = await Promise.all([
      this.digitalTwin.refreshAndGet(childId, familyId),
      this.timeline.getTimeline(childId, familyId, undefined, 10),
    ]);

    return { childId, digitalTwin: digitalTwinResult, recentTimelineHighlights };
  }
}
