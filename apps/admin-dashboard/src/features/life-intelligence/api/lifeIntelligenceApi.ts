import { httpClient } from '../../../shared/lib/httpClient';

export interface ExplainableSubScore {
  score: number;
  inputs: Record<string, unknown>;
  confidence: 'LOW' | 'MEDIUM' | 'HIGH';
}

export interface DigitalTwin {
  childId: string;
  safety: ExplainableSubScore | null;
  health: ExplainableSubScore | null;
  learning: ExplainableSubScore | null;
  faith: ExplainableSubScore | null;
  behavior: ExplainableSubScore | null;
  habits: ExplainableSubScore | null;
  social: ExplainableSubScore | null;
  growthScore: ExplainableSubScore | null;
  updatedAt: string;
}

export interface TimelineEvent {
  id: string;
  childId: string;
  sourceEngine: string;
  category: 'HEALTH' | 'LEARNING' | 'FAITH' | 'REWARDS' | 'SAFETY' | 'HABITS' | 'FAMILY';
  eventType: string;
  title: string;
  occurredAt: string;
  metadata: Record<string, unknown> | null;
}

export interface Habit {
  id: string;
  childId: string;
  title: string;
  category: string;
  isShared: boolean;
  isActive: boolean;
}

export interface CoachingRecommendation {
  track: 'PARENT' | 'CHILD' | 'FAMILY';
  title: string;
  body: string;
  reasoningPath: string[];
}

export interface RewardsAccount {
  id: string;
  childId: string;
  xp: number;
  coins: number;
  stars: number;
  level: number;
}

export interface FaithPractice {
  id: string;
  childId: string;
  type: string;
  title: string;
  isActive: boolean;
}

export interface HealthScoreBreakdown {
  childId: string;
  date: string;
  score: number;
  breakdown: {
    hydration: { targetMl: number; actualMl: number; ratio: number };
    activity: { totalMinutes: number; groupMinutes: number };
    sleepHours: number | null;
    nutritionLogsCount: number;
  };
}

/** CLOSES A REAL GAP — mirrors the backend's ILearningProgressSummary exactly. */
export interface LearningProgressSummary {
  childId: string;
  windowDays: number;
  totalSessions: number;
  totalMinutes: number;
  averageAssessmentScore: number | null;
  streakDays: number;
}

export interface RewardCatalogItem {
  id: string;
  familyId: string;
  title: string;
  costCoins: number;
  isActive: boolean;
}

export interface WellbeingSnapshot {
  windowDays: number;
  averageDailyScreenMinutes: number;
  averagePickups: number;
  averageNightUsageMinutes: number;
  totalBlockedAttempts: number;
  daysWithData: number;
}

export const digitalTwinQueryKey = (childId: string) => ['life-intelligence', 'digital-twin', childId] as const;
export const wellbeingQueryKey = (childId: string) => ['life-intelligence', 'wellbeing', childId] as const;
export const timelineQueryKey = (childId: string, category?: string) => ['life-intelligence', 'timeline', childId, category] as const;
export const habitsQueryKey = (childId: string) => ['life-intelligence', 'habits', childId] as const;
export const coachingQueryKey = (childId: string) => ['life-intelligence', 'coaching', childId] as const;
export const rewardsAccountQueryKey = (childId: string) => ['life-intelligence', 'rewards-account', childId] as const;
export const faithPracticesQueryKey = (childId: string) => ['life-intelligence', 'faith-practices', childId] as const;
export const healthScoreQueryKey = (childId: string) => ['life-intelligence', 'health-score', childId] as const;
export const learningProgressQueryKey = (childId: string) => ['life-intelligence', 'learning-progress', childId] as const;
export const familyStoreQueryKey = (familyId: string) => ['life-intelligence', 'family-store', familyId] as const;

export const lifeIntelligenceApi = {
  getDigitalTwin(childId: string): Promise<DigitalTwin> {
    return httpClient<DigitalTwin>(`/life-intelligence/digital-twin/${childId}`);
  },

  getTimeline(childId: string, category?: string): Promise<TimelineEvent[]> {
    const query = category ? `?category=${category}` : '';
    return httpClient<TimelineEvent[]>(`/life-intelligence/timeline/${childId}${query}`);
  },

  getHabits(childId: string): Promise<Habit[]> {
    return httpClient<Habit[]>(`/life-intelligence/habits/${childId}`);
  },

  completeHabit(childId: string, habitId: string): Promise<void> {
    return httpClient<void>(`/life-intelligence/habits/${childId}/${habitId}/complete`, { method: 'POST', body: {} });
  },

  getCoachingRecommendations(childId: string): Promise<CoachingRecommendation[]> {
    return httpClient<CoachingRecommendation[]>(`/life-intelligence/coaching/${childId}`);
  },

  getRewardsAccount(childId: string): Promise<RewardsAccount> {
    return httpClient<RewardsAccount>(`/life-intelligence/rewards/${childId}/account`);
  },

  getFaithPractices(childId: string): Promise<FaithPractice[]> {
    return httpClient<FaithPractice[]>(`/life-intelligence/faith/${childId}/practices`);
  },

  logFaithPractice(childId: string, practiceId: string): Promise<void> {
    return httpClient<void>(`/life-intelligence/faith/${childId}/${practiceId}/log`, { method: 'POST', body: {} });
  },

  getHealthScore(childId: string): Promise<HealthScoreBreakdown> {
    return httpClient<HealthScoreBreakdown>(`/life-intelligence/health/${childId}/score`);
  },

  /** CLOSES A REAL GAP: LearningEngineService (Goals/Sessions/
   * Assessments/Progress/Streak) had zero Admin Dashboard consumer —
   * same gap already found and fixed in the Parent App (Flutter),
   * independently missing here since these are separate apps. */
  getLearningProgress(childId: string): Promise<LearningProgressSummary> {
    return httpClient<LearningProgressSummary>(`/life-intelligence/learning/${childId}/progress`);
  },

  getFamilyStore(familyId: string): Promise<RewardCatalogItem[]> {
    return httpClient<RewardCatalogItem[]>(`/life-intelligence/rewards/store/${familyId}`);
  },

  approveRedemption(redemptionId: string): Promise<void> {
    return httpClient<void>(`/life-intelligence/rewards/redemptions/${redemptionId}/approve`, { method: 'POST', body: {} });
  },

  denyRedemption(redemptionId: string): Promise<void> {
    return httpClient<void>(`/life-intelligence/rewards/redemptions/${redemptionId}/deny`, { method: 'POST', body: {} });
  },

  getWellbeingSnapshot(childId: string): Promise<WellbeingSnapshot | null> {
    return httpClient<WellbeingSnapshot | null>(`/life-intelligence/wellbeing/${childId}/snapshot`);
  },
};
