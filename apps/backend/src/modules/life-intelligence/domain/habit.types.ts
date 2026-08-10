export interface IHabit {
  id: string;
  childId: string;
  title: string;
  category: string;
  isCustom: boolean;
  isShared: boolean;
  isActive: boolean;
  createdAt: Date;
  /** CLOSES A REAL GAP found while building the Child App's design
   * (a visual daily-progress ring needed real per-item completion
   * state, which nothing exposed before this). True when a
   * HabitCompletion exists for today's date \u2014 computed at read time,
   * never stored redundantly on Habit itself. */
  completedToday: boolean;
}

export interface IHabitCompletion {
  id: string;
  habitId: string;
  childId: string;
  date: Date;
  completedAt: Date;
}

export interface ICreateHabitInput {
  childId: string;
  title: string;
  category: string;
  isShared?: boolean;
  createdByUserId: string;
}

/** Contribution to Architecture 1.0's Habits Score (Digital Twin \u00a76.2) \u2014
 * a plain completion-rate over a trailing window, deliberately the
 * same "pure function over stored data" shape as ai-core's
 * RuleEngineService.evaluate(), not a shared class (Architecture 1.0
 * \u00a70/\u00a72: reuse the pattern, never force-couple to the Digital Safety
 * engine's concretely-typed IKnowledgeSnapshot). */
export interface IHabitScoreBreakdown {
  childId: string;
  windowDays: number;
  totalHabitDays: number;
  completedHabitDays: number;
  completionRate: number;
  sharedTaskCompletionRate: number;
}
