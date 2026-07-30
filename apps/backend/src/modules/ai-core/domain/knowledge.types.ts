export interface IKnowledgeSnapshot {
  childId: string;
  familyId: string;
  ageYears: number;
  trustLevel: string | null;
  riskLevel: string;
  riskReasons: string[];
  dailyLimitMinutes: number | null;
  focusModeEnabled: boolean;
  accessibilityServiceEnabled: boolean | null;
  enforcementActive: boolean | null;
  recentViolationCount: number;
}
