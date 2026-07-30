import { httpClient } from '../../../shared/lib/httpClient';

export interface RecommendationResult {
  title: string;
  body: string;
  wasPhrasedByAI: boolean;
  decision: {
    confidence: number;
    reasoningPath: string[];
    recommendationType: string | null;
  };
}

export interface BehavioralTrend {
  riskTrend: 'IMPROVING' | 'WORSENING' | 'STABLE' | 'INSUFFICIENT_DATA';
  riskAssessmentCount: number;
  trustChangeCount: number;
  summary: string;
}

export interface FamilyInsights {
  recommendation: RecommendationResult;
  behavioralTrend: BehavioralTrend;
}

export interface DecisionHistoryEntry {
  id: string;
  value: {
    recommendationType: string;
    confidence: number;
    title: string;
    rulesApplied?: { ruleId: string; triggered: boolean; reason: string }[];
    reasoningPath?: string[];
  };
  createdAt: string;
}

export const insightsQueryKey = (childId: string, deviceId: string) =>
  ['family-insights', childId, deviceId] as const;
export const decisionHistoryQueryKey = (childId: string) => ['decision-history', childId] as const;

export const insightsApi = {
  getInsights(childId: string, deviceId: string): Promise<FamilyInsights> {
    return httpClient<FamilyInsights>(`/ai-core/insights/${childId}?deviceId=${deviceId}`);
  },

  getDecisionHistory(childId: string): Promise<DecisionHistoryEntry[]> {
    return httpClient<DecisionHistoryEntry[]>(`/ai-core/decision-history/${childId}`);
  },
};
