/**
 * Decision-070's unifying contract. Every intelligence module (Trust,
 * Risk today; Behavior/Health/Education in future sprints) implements
 * this ALONGSIDE its own full-fidelity domain interface
 * (ITrustSignalProvider, IRiskSignalProvider — pairing/domain/*.types.ts).
 * A future AI Context Manager aggregates across modules via THIS
 * lowest-common-denominator shape; a consumer that needs one module's
 * complete detail still uses that module's specific interface.
 *
 * Deliberately placed in ai-core/domain/ (not pairing/domain/) since
 * this contract belongs to whichever module is the eventual aggregator,
 * not to any one signal producer — but this is a TYPE-ONLY export.
 * Implementing it (as TrustEvaluationService/RiskEvaluationService do)
 * requires importing this file for its types, NOT importing AiCoreModule
 * or any of its runtime services — no DI wiring, no module dependency,
 * no violation of Decision-070 rule 2 ("لا يعتمد على Module آخر مباشرة")
 * or rule 5 (no direct LLM provider calls). A type import has zero
 * runtime footprint.
 */
export type IntelligenceSignalDomain = 'TRUST' | 'RISK' | 'BEHAVIOR' | 'HEALTH' | 'EDUCATION';

export interface IIntelligenceSignal {
  domain: IntelligenceSignalDomain;
  /** Meaning is domain-specific and documented per producer: childId for
   * TRUST (Decision-066's timeline key), deviceId for RISK (assessments
   * are inherently per-device), childId for future BEHAVIOR/HEALTH. */
  subjectId: string;
  /** Domain-specific payload — e.g. `{ trustLevel: 'L3_ATTESTED' }` or
   * `{ overallRisk: 65, overallLevel: 'MEDIUM' }`. Opaque at this shared
   * layer, same reasoning as IAIEvent.context. */
  value: Record<string, unknown>;
  /** 0–1: how confident THIS signal itself is — distinct from what the
   * value says. See each producer's own docstring for its confidence
   * derivation (Trust's reflects genuine identity-verification
   * uncertainty; Risk's reflects that its score is a deterministic
   * calculation, not an inference). */
  confidence: number;
  reasons: string[];
  assessedAt: Date;
}

export interface IIntelligenceSignalProvider {
  getSignals(subjectId: string): Promise<IIntelligenceSignal[]>;
}
