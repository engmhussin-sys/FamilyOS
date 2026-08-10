import { Injectable } from '@nestjs/common';

import { ChildrenService } from '../../../children/application/services/children.service';
import { LifeTimelineService } from './life-timeline.service';
import { DigitalTwinService } from './digital-twin.service';

export interface IFamilyInsightWeeklySummary {
  childId: string;
  digitalTwin: Awaited<ReturnType<DigitalTwinService['refreshAndGet']>>;
  recentTimelineHighlights: Awaited<ReturnType<LifeTimelineService['getTimeline']>>;
}

/**
 * Architecture 1.0 \u00a75.9: mirrors `DashboardMetricsService`'s own
 * aggregation pattern (Sprint 8) \u2014 a read-only composer, no new
 * source-of-truth table, reusing the Digital Twin (already itself an
 * aggregate) and the Unified Timeline.
 */
@Injectable()
export class FamilyInsightService {
  constructor(
    private readonly childrenService: ChildrenService,
    private readonly digitalTwin: DigitalTwinService,
    private readonly timeline: LifeTimelineService,
  ) {}

  async getWeeklySummary(childId: string, familyId: string): Promise<IFamilyInsightWeeklySummary> {
    await this.childrenService.assertChildBelongsToFamily(childId, familyId);

    const [digitalTwinResult, recentTimelineHighlights] = await Promise.all([
      this.digitalTwin.refreshAndGet(childId, familyId),
      this.timeline.getTimeline(childId, familyId, undefined, 10),
    ]);

    return { childId, digitalTwin: digitalTwinResult, recentTimelineHighlights };
  }
}
