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
  /** Edge-First Intelligence Architecture (Digital Wellbeing Engine).
   * DELIBERATELY SEPARATE from `behavior` above, not blended into it
   * and NOT included in growthScore's own calculation \u2014 a PM decision
   * made explicitly rather than silently: blending screen-time/pickup
   * data with ai-core's Risk/Trust-derived behavior score would need
   * a real weighting formula with no product/UX basis to invent one
   * responsibly. Still satisfies "connect results to Digital Twin" by
   * surfacing it in the same primary parent-facing view. */
  wellbeing: IExplainableSubScore | null;
  /** The composite/overall indicator \u2014 Architecture 1.0 Decision 2:
   * this IS the "Growth Score," explicitly NOT physical growth. */
  growthScore: IExplainableSubScore | null;
  updatedAt: Date;
}
