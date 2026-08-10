/** Every sub-score is explainable \u2014 inputs and confidence, never a
 * bare number \u2014 same IExplainableDecision-style shape ai-core's
 * Digital Safety engines already use, reused as a PATTERN (Architecture
 * 1.0 \u00a70), not a shared class. */
export interface IExplainableSubScore {
  score: number;
  inputs: Record<string, unknown>;
  confidence: 'LOW' | 'MEDIUM' | 'HIGH';
}

export interface IDigitalTwin {
  childId: string;
  safety: IExplainableSubScore | null;
  health: IExplainableSubScore | null;
  learning: IExplainableSubScore | null;
  faith: IExplainableSubScore | null;
  behavior: IExplainableSubScore | null;
  habits: IExplainableSubScore | null;
  social: IExplainableSubScore | null;
  /** The composite/overall indicator \u2014 Architecture 1.0 Decision 2:
   * this IS the "Growth Score," explicitly NOT physical growth. */
  growthScore: IExplainableSubScore | null;
  updatedAt: Date;
}
