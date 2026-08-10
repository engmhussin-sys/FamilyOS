export type SmartTaskStatus = 'SUGGESTED' | 'ACCEPTED' | 'COMPLETED' | 'DISMISSED';

export interface ISmartTask {
  id: string;
  childId: string;
  title: string;
  category: string;
  generatedReason: string;
  sourceSignals: Record<string, unknown>;
  suggestedDate: Date;
  status: SmartTaskStatus;
}

/** The input this engine reasons over \u2014 a small, explicit snapshot of
 * cross-engine signals, deliberately NOT the Digital Safety domain's
 * IKnowledgeSnapshot (Architecture 1.0 \u00a70: reuse the pattern, not the
 * class \u2014 this is a new, LIP-scoped snapshot shape). */
export interface ISmartTaskContext {
  childId: string;
  lateSleepLastNight: boolean;
  lowHydrationToday: boolean;
  missedHabitsYesterday: string[];
  screenTimeOverLimit: boolean;
}

export interface IGeneratedSmartTask {
  title: string;
  category: string;
  reason: string;
}
