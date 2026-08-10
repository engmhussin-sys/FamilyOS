export type HabitPriority = 'LOW' | 'NORMAL' | 'HIGH';
export type HabitRecurrence = 'DAILY' | 'WEEKLY' | 'SPECIFIC_DAYS';
/** Sprint 16 — CLOSES A REAL GAP explicitly flagged in Sprint 15's
 * own final report ("Missed Habit tracking" did not exist). A SIGNAL
 * for Coaching, never a punishment mechanism — the brief's own
 * explicit instruction. */
export type HabitCompletionStatus = 'COMPLETED' | 'COMPLETED_LATE' | 'SKIPPED' | 'MISSED';

export interface IHabit {
  id: string;
  childId: string;
  title: string;
  category: string;
  description: string | null;
  scheduledStartTime: string | null;
  scheduledEndTime: string | null;
  recurrence: HabitRecurrence;
  recurrenceDaysOfWeek: number[];
  priority: HabitPriority;
  isCustom: boolean;
  isShared: boolean;
  isActive: boolean;
  createdAt: Date;
  /** CLOSES A REAL GAP found while building the Child App's design
   * (a visual daily-progress ring needed real per-item completion
   * state, which nothing exposed before this). True when a
   * HabitCompletion exists for today's date — computed at read time,
   * never stored redundantly on Habit itself. */
  completedToday: boolean;
}

export interface IHabitCompletion {
  id: string;
  habitId: string;
  childId: string;
  date: Date;
  completedAt: Date;
  status: HabitCompletionStatus;
}

export interface ICreateHabitInput {
  childId: string;
  title: string;
  category: string;
  description?: string;
  scheduledStartTime?: string;
  scheduledEndTime?: string;
  recurrence?: HabitRecurrence;
  recurrenceDaysOfWeek?: number[];
  priority?: HabitPriority;
  isShared?: boolean;
  createdByUserId: string;
}

/** Contribution to Architecture 1.0's Habits Score (Digital Twin §6.2) —
 * a plain completion-rate over a trailing window, deliberately the
 * same "pure function over stored data" shape as ai-core's
 * RuleEngineService.evaluate(), not a shared class (Architecture 1.0
 * §0/§2: reuse the pattern, never force-couple to the Digital Safety
 * engine's concretely-typed IKnowledgeSnapshot). */
export interface IHabitScoreBreakdown {
  childId: string;
  windowDays: number;
  totalHabitDays: number;
  completedHabitDays: number;
  completionRate: number;
  sharedTaskCompletionRate: number;
  /** CLOSES A REAL GAP found in the Digital Twin audit: Habits was
   * the FIRST streak feature built this session (Sprint 15/16), yet
   * getScoreBreakdown — the exact method Digital Twin already calls
   * — never exposed it. Reuses computeCurrentStreak exactly as
   * tested, same "across ALL habits, at least one completed that
   * day" definition HabitEngineService's own completeHabit already
   * uses for its own STREAK_ACHIEVED reward trigger. */
  streakDays: number;
}
