/**
 * Pure functions — zero I/O. Closes the honest gap DigitalTwinService
 * itself flagged: "Safety Score and Behavior Score are NOT computed
 * this sprint." Reuses Digital Safety's ALREADY-BUILT
 * `RiskEvaluationService`/`BehavioralIntelligenceEngineService`
 * outputs (read-only, through their existing exported public methods
 * — zero modification to ai-core or pairing, Code Freeze fully
 * respected) and maps them into the same 0-100 explainable shape
 * every other Digital Twin sub-score uses.
 */

/** Risk (0-100, higher = riskier) inverted into Safety Score
 * (0-100, higher = safer) — the two are the same measurement, just
 * framed for opposite audiences. */
export function mapRiskToSafetyScore(overallRisk: number): number {
  return Math.max(0, Math.min(100, Math.round(100 - overallRisk)));
}

/** IMPROVING/STABLE/WORSENING/INSUFFICIENT_DATA doesn't carry a
 * number today — this is a deliberate, documented mapping, not a
 * discovered one. INSUFFICIENT_DATA returns null on purpose: guessing
 * a score from too little data would be a false-precision number, the
 * exact thing this Digital Twin design has avoided everywhere else. */
export function mapBehavioralTrendToScore(
  riskTrend: 'IMPROVING' | 'WORSENING' | 'STABLE' | 'INSUFFICIENT_DATA',
): number | null {
  switch (riskTrend) {
    case 'IMPROVING':
      return 90;
    case 'STABLE':
      return 70;
    case 'WORSENING':
      return 30;
    case 'INSUFFICIENT_DATA':
      return null;
  }
}
