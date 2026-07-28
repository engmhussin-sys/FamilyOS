export const RISK_LEVELS = ['UNKNOWN', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const;
export type RiskLevelValue = (typeof RISK_LEVELS)[number];

/** The six categories from risk-score-framework.md §3. Only `security`
 * has real, measurable signals today (§3a of that doc) — the other five
 * default to 0 ("no negative signal observed", not "unknown") until
 * their dependency steps (Permission Manager, Policy Engine,
 * Observability, Sync Engine, on-device IRiskDetector) exist. */
export interface IRiskCategoryScores {
  security: number;
  privacy: number;
  compliance: number;
  stability: number;
  connectivity: number;
  behavioral: number;
}

/** Raw signals feeding the Security Risk category — mirrors
 * risk-score-framework.md §2/§4's nine signals exactly (Missing
 * Attestation's suppression rule is applied inside the calculation, not
 * encoded here). */
export interface IRiskSignalInput {
  isEmulator: boolean;
  isRooted: boolean;
  hasTamperIndicators: boolean;
  isUnsupportedDevice: boolean;
  missingAttestation: boolean;
  mockLocationEnabled: boolean;
  developerModeEnabled: boolean;
  usbDebuggingEnabled: boolean;
  isOldAndroidVersion: boolean;
}

export interface IRiskAssessmentResult {
  overallRisk: number;
  overallLevel: RiskLevelValue;
  categoryScores: IRiskCategoryScores;
  /** Never omitted, even when empty (Decision-047's binding
   * explainability rule, restated in risk-score-framework.md §6). */
  reasons: string[];
}

export interface IRiskAssessmentRecord extends IRiskAssessmentResult {
  id: string;
  deviceId: string;
  assessedAt: Date;
}

/**
 * Sprint 2's Risk Engine → AI Context Layer → Recommendation Engine
 * design, made concrete: a future AI consumer depends on THIS interface
 * (bound via RISK_SIGNAL_PROVIDER), not on RiskEvaluationService
 * directly or on a bare number — every method here returns the full,
 * explainable shape, never a naked score.
 */
export interface IRiskSignalProvider {
  getLatestRiskAssessment(deviceId: string): Promise<IRiskAssessmentRecord | null>;
  getRiskHistory(deviceId: string): Promise<IRiskAssessmentRecord[]>;
}
