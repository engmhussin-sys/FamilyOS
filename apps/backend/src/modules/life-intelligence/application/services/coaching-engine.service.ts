import { Injectable } from '@nestjs/common';

import { ChildrenService } from '../../../children/application/services/children.service';
import { HabitEngineService } from './habit-engine.service';
import { HealthEngineService } from './health-engine.service';
import { FaithEngineService } from './faith-engine.service';
import { LearningEngineService } from './learning-engine.service';
import { ICoachingRecommendation, ICoachingSignals } from '../../domain/coaching.types';
import { generateChildCoachRecommendations, generateFamilyCoachRecommendations, generateParentCoachRecommendations } from './coaching-rules';

/**
 * Architecture 1.0 §9: generalizes "Parenting Coach" into three
 * tracks — Parent / Child / Family — one engine, three deterministic
 * strategies (coaching-rules.ts).
 *
 * Deliberately composes the ALREADY-BUILT engines (Habit, Health,
 * Faith, Learning) rather than querying their repositories directly —
 * respects each engine's own ownership boundary and business logic.
 * Sprint 16.1 Phase 6: Learning added to this list — CLOSES A REAL
 * GAP (Education signals were entirely absent from Coaching despite
 * the brief's own explicit requirement).
 *
 * Future-Engine Contract (Architecture 1.0 §2): no Memory/Audit/Safety/
 * AI-Provider usage yet — an LLM would reword the deterministic
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
    private readonly learningEngine: LearningEngineService,
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
    const [habitScore, healthScore, faithScore, missedHabits, educationProgress, dailyProgress] = await Promise.all([
      this.habitEngine.getScoreBreakdown(childId, familyId),
      this.healthEngine.computeAndStoreHealthScore(childId, familyId),
      this.faithEngine.getScoreBreakdown(childId, familyId),
      // FIXES A REAL BUG: previously approximated via
      // Math.round((1-rate)*totalDays) — now the real, exact figure
      // from HabitEngineService's own Sprint 16 Missed Habit tracking.
      this.habitEngine.getMissedHabitsSignal(childId, familyId, 7),
      this.learningEngine.getProgressSummary(childId, familyId),
      this.healthEngine.getDailyProgress(childId, familyId),
    ]);

    return {
      childId,
      habitCompletionRate: habitScore.completionRate,
      healthScore: healthScore.score,
      faithCompletionRate: faithScore.completionRate,
      missedHabitsCount: missedHabits.length,
      educationSessionCount: educationProgress.totalSessions,
      educationStreakDays: educationProgress.streakDays,
      hydrationAchievedToday: dailyProgress.hydration.isAchieved,
      activityAchievedToday: dailyProgress.activity.isAchieved,
    };
  }
}
