import { Inject, Injectable } from '@nestjs/common';

import {
  TRUST_SIGNAL_PROVIDER,
} from '../../../pairing/application/ports/device-trust.repository.port';
import type { ITrustSignalProvider } from '../../../pairing/domain/trust.types';
import {
  RISK_SIGNAL_PROVIDER,
} from '../../../pairing/application/ports/device-risk.repository.port';
import type { IRiskSignalProvider } from '../../../pairing/domain/risk.types';
import { PairingOrchestratorService } from '../../../pairing/application/services/pairing-orchestrator.service';

const RISK_LEVEL_ORDER: Record<string, number> = { LOW: 0, MEDIUM: 1, HIGH: 2, CRITICAL: 3, UNKNOWN: -1 };

export interface IBehavioralTrend {
  riskTrend: 'IMPROVING' | 'WORSENING' | 'STABLE' | 'INSUFFICIENT_DATA';
  riskAssessmentCount: number;
  trustChangeCount: number;
  summary: string;
}

/**
 * Sprint 7's Behavioral Intelligence Engine, first pass. Deliberately
 * scoped to what real data already exists for: Risk Assessment history
 * (Sprint 2's `IRiskSignalProvider.getRiskHistory`, already populated
 * every time `/pairing/verify` runs) and Trust change history (Sprint
 * 2's `ITrustSignalProvider.getTrustHistory`). Genuine app-usage
 * behavioral pattern detection (Decision-068's own "180% increase in
 * night-time usage" example) needs the App Usage Collection pipeline,
 * which doesn't exist yet (`docs/architecture/child-runtime-engine.md`'s
 * `IBehaviorPatternDetector` remains a declared-not-implemented
 * contract for exactly this reason) \u2014 this engine does NOT pretend to
 * cover that; it computes a real trend from what's actually collected today.
 */
@Injectable()
export class BehavioralIntelligenceEngineService {
  constructor(
    @Inject(TRUST_SIGNAL_PROVIDER) private readonly trustSignalProvider: ITrustSignalProvider,
    @Inject(RISK_SIGNAL_PROVIDER) private readonly riskSignalProvider: IRiskSignalProvider,
    private readonly pairingOrchestrator: PairingOrchestratorService,
  ) {}

  async computeTrend(deviceId: string, childId: string, familyId: string): Promise<IBehavioralTrend> {
    // SECURITY: ownership check first, same pattern this session already
    // fixed once for /pairing/device/:id/status \u2014 not repeating that gap here.
    await this.pairingOrchestrator.assertDeviceBelongsToFamily(deviceId, familyId);

    const [riskHistory, trustHistory] = await Promise.all([
      this.riskSignalProvider.getRiskHistory(deviceId),
      this.trustSignalProvider.getTrustHistory(childId),
    ]);

    if (riskHistory.length < 2) {
      return {
        riskTrend: 'INSUFFICIENT_DATA',
        riskAssessmentCount: riskHistory.length,
        trustChangeCount: trustHistory.length,
        summary: 'Not enough risk assessment history yet to establish a trend.',
      };
    }

    const first = RISK_LEVEL_ORDER[riskHistory[0].overallLevel] ?? -1;
    const last = RISK_LEVEL_ORDER[riskHistory[riskHistory.length - 1].overallLevel] ?? -1;

    let riskTrend: IBehavioralTrend['riskTrend'] = 'STABLE';
    if (last > first) riskTrend = 'WORSENING';
    else if (last < first) riskTrend = 'IMPROVING';

    return {
      riskTrend,
      riskAssessmentCount: riskHistory.length,
      trustChangeCount: trustHistory.length,
      summary: this.summarize(riskTrend, riskHistory.length, trustHistory.length),
    };
  }

  private summarize(trend: IBehavioralTrend['riskTrend'], riskCount: number, trustCount: number): string {
    const trendText =
      trend === 'WORSENING'
        ? 'Risk level has trended upward'
        : trend === 'IMPROVING'
          ? 'Risk level has trended downward'
          : 'Risk level has stayed stable';
    return `${trendText} across ${riskCount} assessments. ${trustCount} trust-level change(s) recorded.`;
  }
}
