import { Inject, Injectable, Logger } from '@nestjs/common';

import { AI_PROVIDER, type IAIProvider } from '../../domain/ai-provider.port';
import type { IDeviceHealthDiagnosis } from '../../domain/device-health-diagnosis.types';
import {
  TRUST_SIGNAL_PROVIDER,
} from '../../../pairing/application/ports/device-trust.repository.port';
import type { ITrustSignalProvider } from '../../../pairing/domain/trust.types';
import {
  RISK_SIGNAL_PROVIDER,
} from '../../../pairing/application/ports/device-risk.repository.port';
import type { IRiskSignalProvider } from '../../../pairing/domain/risk.types';
import { PairingOrchestratorService } from '../../../pairing/application/services/pairing-orchestrator.service';

const DIAGNOSTICS_SYSTEM_PROMPT = `You are summarizing a child's device security/trust status for a parent
using a family safety app. You will be given structured trust and risk
data. Write 2-3 short sentences in plain, non-technical language a
parent can act on. Do not lecture or alarm — state what's true and, if
risk is elevated, what it likely means in practical terms. Never suggest
the parent do anything invasive or secretive.`;

/**
 * Sprint 4's "AI Diagnostics" / "AI analyzes device health." Deliberately
 * NOT part of AiCoreOrchestratorService — that service's existing
 * failure contract (throw AiCoreUnavailableException on any AI failure)
 * is correct for the Parenting Assistant, where the AI answer IS the
 * entire point of the call. Here, the real trust/risk data is the
 * primary value and is always returned; the AI-generated summary is
 * strictly additive. Conflating the two failure contracts would have
 * meant either the Assistant silently tolerating empty answers (wrong)
 * or Diagnostics failing entirely just because the LLM timed out, when
 * real security data was available the whole time (also wrong) — hence
 * a separate service with its own, deliberately different, contract.
 */
@Injectable()
export class AiDiagnosticsService {
  private readonly logger = new Logger(AiDiagnosticsService.name);

  constructor(
    @Inject(TRUST_SIGNAL_PROVIDER) private readonly trustSignalProvider: ITrustSignalProvider,
    @Inject(RISK_SIGNAL_PROVIDER) private readonly riskSignalProvider: IRiskSignalProvider,
    @Inject(AI_PROVIDER) private readonly aiProvider: IAIProvider,
    private readonly pairingOrchestrator: PairingOrchestratorService,
  ) {}

  async diagnoseDeviceHealth(deviceId: string, familyId: string): Promise<IDeviceHealthDiagnosis> {
    // Ownership check FIRST, and allowed to throw NotFoundException
    // directly — a 404 for "not your device," never masked as an
    // AI-availability failure. Reuses PairingOrchestratorService's
    // now-fixed assertDeviceBelongsToFamily rather than duplicating the
    // check (see the security fix this same session made to `getStatus`).
    await this.pairingOrchestrator.assertDeviceBelongsToFamily(deviceId, familyId);

    const [trustLevel, riskAssessment] = await Promise.all([
      this.trustSignalProvider.getCurrentTrustLevel(deviceId),
      this.riskSignalProvider.getLatestRiskAssessment(deviceId),
    ]);

    const riskLevel = riskAssessment?.overallLevel ?? 'UNKNOWN';
    const riskReasons = riskAssessment?.reasons ?? [];

    const summary = await this.generateSummary(trustLevel, riskLevel, riskReasons);

    return {
      deviceId,
      trustLevel,
      riskLevel,
      riskReasons,
      summary,
      generatedAt: new Date(),
    };
  }

  private async generateSummary(
    trustLevel: string | null,
    riskLevel: string,
    riskReasons: string[],
  ): Promise<string> {
    const userMessage = [
      `Trust level: ${trustLevel ?? 'not yet established'}.`,
      `Risk level: ${riskLevel}.`,
      riskReasons.length > 0 ? `Risk factors: ${riskReasons.join(', ')}.` : 'No risk factors currently flagged.',
    ].join('\n');

    try {
      const summary = await this.aiProvider.complete({
        systemPrompt: DIAGNOSTICS_SYSTEM_PROMPT,
        userMessage,
      });
      return summary.trim() || this.fallbackSummary();
    } catch (err) {
      this.logger.warn(
        'AI diagnostics summary unavailable — returning raw trust/risk data without it',
        err instanceof Error ? err.message : err,
      );
      return this.fallbackSummary();
    }
  }

  private fallbackSummary(): string {
    return 'AI summary temporarily unavailable — the trust and risk data above is still accurate.';
  }
}
