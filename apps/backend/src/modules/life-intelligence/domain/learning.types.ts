export type LearningGoalStatus = 'ACTIVE' | 'COMPLETED' | 'ABANDONED';

export interface ILearningGoal {
  id: string;
  childId: string;
  subject: string;
  title: string;
  targetDate: Date | null;
  status: LearningGoalStatus;
}

export interface ILearningSession {
  id: string;
  childId: string;
  goalId: string | null;
  subject: string;
  durationMinutes: number;
  progressNote: string | null;
  date: Date;
}

export interface ILearningAssessment {
  id: string;
  childId: string;
  subject: string;
  scorePercent: number;
  source: string;
  takenAt: Date;
}

export interface ICreateLearningGoalInput {
  childId: string;
  subject: string;
  title: string;
  targetDate?: string;
}

export interface ICreateLearningSessionInput {
  childId: string;
  goalId?: string;
  subject: string;
  durationMinutes: number;
  progressNote?: string;
  date: string;
}

export interface ILearningProgressSummary {
  childId: string;
  windowDays: number;
  totalSessions: number;
  totalMinutes: number;
  averageAssessmentScore: number | null;
  streakDays: number;
}
