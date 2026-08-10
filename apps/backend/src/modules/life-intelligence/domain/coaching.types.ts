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
}
