import { Injectable } from '@nestjs/common';

import { ChildrenService } from '../../../children/application/services/children.service';
import { HabitEngineService } from './habit-engine.service';
import { HealthEngineService } from './health-engine.service';
import { FaithEngineService } from './faith-engine.service';
import { ICoachingRecommendation, ICoachingSignals } from '../../domain/coaching.types';
import { generateChildCoachRecommendations, generateFamilyCoachRecommendations, generateParentCoachRecommendations } from './coaching-rules';

/**
 * Architecture 1.0 \u00a79: generalizes "Parenting Coach" into three
 * tracks \u2014 Parent / Child / Family \u2014 one engine, three deterministic
 * strategies (coaching-rules.ts).
 *
 * Deliberately composes the ALREADY-BUILT engines (Habit, Health,
 * Faith) rather than querying their repositories directly \u2014 respects
 * each engine's own ownership boundary and business logic.
 *
 * Future-Engine Contract (Architecture 1.0 \u00a72): no Memory/Audit/Safety/
 * AI-Provider usage yet \u2014 an LLM would reword the deterministic
 * `body` text from coaching-rules.ts in a future sprint, routed
 * through SafetyEngineService first. Not duplicated here.
 */
@Injectable()
export class CoachingEngineService {
  constructor(
    private readonly childrenService: ChildrenService,
    private readonly habitEngine: HabitEngineService,
    private readonly healthEngine: HealthEngineService,
    private readonly faithEngine: FaithEngineService,
  ) {}

  async getRecommendations(childId: string, familyId: string): Promise<ICoachingRecommendation[]> {
    await this.childrenService.assertChildBelongsToFamily(childId, familyId);

    const signals = await this.gatherSignals(childId, familyId);

    return [
      ...generateParentCoachRecommendations(signals),
      ...generateChildCoachRecommendations(signals),
      ...generateFamilyCoachRecommendations(signals),
    ];
  }

  private async gatherSignals(childId: string, familyId: string): Promise<ICoachingSignals> {
    const [habitScore, healthScore, faithScore] = await Promise.all([
      this.habitEngine.getScoreBreakdown(childId, familyId),
      this.healthEngine.computeAndStoreHealthScore(childId, familyId),
      this.faithEngine.getScoreBreakdown(childId, familyId),
    ]);

    return {
      childId,
      habitCompletionRate: habitScore.completionRate,
      healthScore: healthScore.score,
      faithCompletionRate: faithScore.completionRate,
      missedHabitsCount: Math.round((1 - habitScore.completionRate) * habitScore.totalHabitDays),
    };
  }
}
