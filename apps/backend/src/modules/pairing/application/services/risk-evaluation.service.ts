import { Inject, Injectable } from '@nestjs/common';

import {
  DEVICE_RISK_REPOSITORY,
  type IDeviceRiskRepository,
} from '../ports/device-risk.repository.port';
import type {
  IRiskAssessmentRecord,
  IRiskAssessmentResult,
  IRiskCategoryScores,
  IRiskSignalInput,
  IRiskSignalProvider,
  RiskLevelValue,
} from '../../domain/risk.types';

/**
 * Service 5 (Sprint 2). Implements `IRiskSignalProvider` — the
 * "Risk Engine → AI Context Layer → Recommendation Engine" design from
 * the reviewer's brief, made concrete: every method returns the full
 * explainable shape (category scores + reasons), never a bare number a
 * Recommendation Engine would have to reverse-engineer meaning from.
 *
 * Per Decision-043 (Risk is dynamic): unlike TrustEvaluationService,
 * this is expected to be called frequently (every Capability re-scan,
 * every Tamper signal — risk-score-framework.md §8) — nothing here
 * assumes infrequent invocation the way Trust's derivation does.
 */
@Injectable()
export class RiskEvaluationService implements IRiskSignalProvider {
  constructor(
    @Inject(DEVICE_RISK_REPOSITORY) private readonly deviceRiskRepository: IDeviceRiskRepository,
  ) {}

  /**
   * Computes the assessment (pure) and persists it as a new append-only
   * row (never an update — risk-score-framework.md §7's history
   * requirement). Every assessment is recorded, even a LOW one — the
   * trend (risk-score-framework.md §7's worked example,
   * `10:01 LOW → 10:25 MEDIUM → ...`) only exists if every point is kept,
   * not just the "interesting" ones.
   */
  async assessAndRecord(
    deviceId: string,
    signals: IRiskSignalInput,
  ): Promise<IRiskAssessmentResult> {
    const result = this.calculateRisk(signals);
    await this.deviceRiskRepository.record({ deviceId, ...result });
    return result;
  }

  // --- IRiskSignalProvider ---

  getLatestRiskAssessment(deviceId: string): Promise<IRiskAssessmentRecord | null> {
    return this.deviceRiskRepository.findLatestByDevice(deviceId);
  }

  getRiskHistory(deviceId: string): Promise<IRiskAssessmentRecord[]> {
    return this.deviceRiskRepository.findHistoryByDevice(deviceId);
  }

  // --- Pure calculation (risk-score-framework.md §2/§4/§5) ---

  calculateRisk(signals: IRiskSignalInput): IRiskAssessmentResult {
    const { score: securityScore, reasons } = this.computeSecurityScore(signals);

    // Only Security Risk has real signals today (risk-score-framework.md
    // §3a's honesty note) — the other five categories are structurally
    // present (so the shape never needs to change when they DO get real
    // signals) but score 0: "no negative signal observed," not "unknown."
    const categoryScores: IRiskCategoryScores = {
      security: securityScore,
      privacy: 0,
      compliance: 0,
      stability: 0,
      connectivity: 0,
      behavioral: 0,
    };

    // Overall Risk = the MAX category score, not an average
    // (risk-score-framework.md §5) — a single severely risky category
    // must surface as high overall risk rather than being diluted.
    const overallRisk = Math.max(...Object.values(categoryScores));

    return {
      overallRisk,
      overallLevel: this.levelForScore(overallRisk),
      categoryScores,
      reasons,
    };
  }

  private computeSecurityScore(signals: IRiskSignalInput): { score: number; reasons: string[] } {
    let score = 0;
    const reasons: string[] = [];
    const rootOrEmulatorFlagged = signals.isRooted || signals.isEmulator;

    if (signals.isEmulator) {
      score += 30;
      reasons.push('Emulator detected');
    }
    if (signals.isRooted) {
      score += 20;
      reasons.push('Root detected');
    }
    if (signals.hasTamperIndicators) {
      score += 25;
      reasons.push('Tamper indicators present');
    }
    if (signals.isUnsupportedDevice) {
      score += 15;
      reasons.push('Unsupported device (below minimum Android version)');
    }
    // Missing Attestation is suppressed when Root or Emulator is already
    // flagged — risk-score-framework.md §2's explicit anti-double-counting
    // rule (a rooted/emulated device almost always also fails
    // attestation, so counting both would compound the same fact twice).
    if (signals.missingAttestation && !rootOrEmulatorFlagged) {
      score += 10.5; // 15 base * Medium confidence (0.7)
      reasons.push('Missing hardware attestation');
    }
    if (signals.mockLocationEnabled) {
      score += 7; // 10 base * Medium confidence (0.7)
      reasons.push('Mock Location enabled');
    }
    if (signals.developerModeEnabled) {
      score += 3.5; // 5 base * Medium confidence (0.7)
      reasons.push('Developer Mode enabled');
    }
    if (signals.usbDebuggingEnabled) {
      score += 2; // 5 base * Low confidence (0.4)
      reasons.push('USB Debugging enabled');
    }
    if (signals.isOldAndroidVersion) {
      score += 5; // High confidence — SDK_INT is exact, not inferred
      reasons.push('Old Android version');
    }

    return { score: Math.min(Math.round(score * 10) / 10, 100), reasons };
  }

  private levelForScore(score: number): RiskLevelValue {
    if (score >= 75) return 'CRITICAL';
    if (score >= 50) return 'HIGH';
    if (score >= 25) return 'MEDIUM';
    return 'LOW';
  }
}
