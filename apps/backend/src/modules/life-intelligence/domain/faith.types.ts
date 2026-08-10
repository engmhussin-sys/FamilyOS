export type FaithPracticeType = 'QURAN_MEMORIZATION' | 'QURAN_REVIEW' | 'AZKAR' | 'SALAH' | 'ISLAMIC_VALUE' | 'OCCASION';

export interface IFaithPractice {
  id: string;
  childId: string;
  type: FaithPracticeType;
  title: string;
  config: Record<string, unknown> | null;
  isActive: boolean;
  /** CLOSES A REAL GAP found while building the Child App's design —
   * mirrors IHabit.completedToday exactly, same reasoning. */
  completedToday: boolean;
}

export interface IFaithPracticeLog {
  id: string;
  practiceId: string;
  childId: string;
  date: Date;
  progress: Record<string, unknown> | null;
  completedAt: Date;
}

export interface ICreateFaithPracticeInput {
  childId: string;
  type: FaithPracticeType;
  title: string;
  config?: Record<string, unknown>;
}

export interface IFaithScoreBreakdown {
  childId: string;
  windowDays: number;
  activePractices: number;
  completedLogs: number;
  completionRate: number;
}
