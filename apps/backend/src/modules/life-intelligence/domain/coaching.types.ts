export type CoachingTrack = 'PARENT' | 'CHILD' | 'FAMILY';

export interface ICoachingRecommendation {
  track: CoachingTrack;
  title: string;
  body: string;
  reasoningPath: string[];
}

/** The cross-engine signal snapshot Coaching reasons over \u2014 small and
 * explicit, same "new snapshot per LIP concern, never the Digital
 * Safety domain's IKnowledgeSnapshot" discipline as every other engine
 * this platform has built (Architecture 1.0 \u00a70). */
export interface ICoachingSignals {
  childId: string;
  habitCompletionRate: number;
  healthScore: number;
  faithCompletionRate: number;
  missedHabitsCount: number;
  /** Sprint 16.1 Phase 6 — CLOSES A REAL GAP: Education was entirely
   * absent from coaching signals despite LearningEngineService
   * existing since an earlier sprint. */
  educationSessionCount: number;
  educationStreakDays: number;
  /** Sprint 16.1 Phase 6 — CLOSES A REAL GAP: Hydration/Activity
   * goal-achievement was entirely absent despite
   * HealthEngineService.getDailyProgress (Sprint 15/16.1) already
   * computing exactly this. */
  hydrationAchievedToday: boolean;
  activityAchievedToday: boolean;
}
