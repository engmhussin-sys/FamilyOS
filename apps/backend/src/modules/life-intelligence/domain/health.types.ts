export type SocialContext = 'SOLO' | 'GROUP' | 'TEAM';

export interface INutritionLog {
  id: string;
  childId: string;
  date: Date;
  mealType: string;
  items: Record<string, unknown>;
  calories: number | null;
  proteinG: number | null;
  calciumMg: number | null;
  ironMg: number | null;
  sugarG: number | null;
}

export interface IHydrationLog {
  id: string;
  childId: string;
  amountMl: number;
  loggedAt: Date;
}

export interface ISleepLog {
  id: string;
  childId: string;
  date: Date;
  sleepStart: Date;
  sleepEnd: Date;
  quality: number | null;
}

export interface IActivityLog {
  id: string;
  childId: string;
  date: Date;
  activityType: string;
  durationMinutes: number;
  socialContext: SocialContext;
}

export interface ICreateNutritionLogInput {
  childId: string;
  date: string;
  mealType: string;
  items: Record<string, unknown>;
  calories?: number;
  proteinG?: number;
  calciumMg?: number;
  ironMg?: number;
  sugarG?: number;
}

export interface ICreateHydrationLogInput {
  childId: string;
  amountMl: number;
}

export interface ICreateSleepLogInput {
  childId: string;
  date: string;
  sleepStart: string;
  sleepEnd: string;
  quality?: number;
}

export interface ICreateActivityLogInput {
  childId: string;
  date: string;
  activityType: string;
  durationMinutes: number;
  socialContext?: SocialContext;
}

/** Age-band hydration targets (ml/day) \u2014 a small, deterministic,
 * pure-function lookup table, same discipline as ai-core's RuleEngineService:
 * no I/O, fully explainable, easy to unit test exhaustively. Figures
 * are widely cited pediatric hydration guidelines (directional, not a
 * medical claim). */
export const HYDRATION_TARGET_ML_BY_AGE: ReadonlyArray<{ maxAge: number; targetMl: number }> = [
  { maxAge: 3, targetMl: 1300 },
  { maxAge: 8, targetMl: 1700 },
  { maxAge: 13, targetMl: 2100 },
  { maxAge: 18, targetMl: 2500 },
  { maxAge: Infinity, targetMl: 2700 },
];

export interface IHealthScoreBreakdown {
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
