import { Injectable } from '@nestjs/common';

import { ChildrenService } from '../../children/application/services/children.service';
import { ScreenTimeService } from '../../screen-time/application/services/screen-time.service';
import { PairingOrchestratorService } from '../../pairing/application/services/pairing-orchestrator.service';
import {
  TRUST_SIGNAL_PROVIDER,
} from '../../pairing/application/ports/device-trust.repository.port';
import type { ITrustSignalProvider } from '../../pairing/domain/trust.types';
import {
  RISK_SIGNAL_PROVIDER,
} from '../../pairing/application/ports/device-risk.repository.port';
import type { IRiskSignalProvider } from '../../pairing/domain/risk.types';
import { MemoryEngineService } from '../../ai-core/application/services/memory-engine.service';
import { Inject } from '@nestjs/common';

export interface IChildReport {
  childId: string;
  childFirstName: string;
  generatedAt: string;
  screenTimePolicy: { dailyLimitMinutes: number | null; focusModeEnabled: boolean } | null;
  trustLevel: string | null;
  trustHistory: { fromLevel: string | null; toLevel: string; reason: string; occurredAt: string }[];
  riskHistory: { overallLevel: string; overallRisk: number; assessedAt: string }[];
  recentViolationCount: number;
  decisionHistory: { title: string; confidence: number; createdAt: string }[];
}

/**
 * Sprint 8's Reports module. Deliberately built ONLY on data that
 * genuinely already exists (Screen Time policy, Trust/Risk history,
 * Memory Engine's violation/decision records) \u2014 no per-app usage
 * breakdown, since that data pipeline (UsageStatsManager aggregation)
 * isn't built yet, same honesty this project has kept throughout.
 * Composition-only, same pattern as KnowledgeEngineService \u2014 no new
 * business logic invented here, only assembly + CSV serialization.
 */
@Injectable()
export class ReportsService {
  constructor(
    private readonly childrenService: ChildrenService,
    private readonly screenTimeService: ScreenTimeService,
    private readonly pairingOrchestrator: PairingOrchestratorService,
    @Inject(TRUST_SIGNAL_PROVIDER) private readonly trustSignalProvider: ITrustSignalProvider,
    @Inject(RISK_SIGNAL_PROVIDER) private readonly riskSignalProvider: IRiskSignalProvider,
    private readonly memoryEngine: MemoryEngineService,
  ) {}

  async generateChildReport(childId: string, familyId: string, deviceId: string): Promise<IChildReport> {
    const child = await this.childrenService.getChildOrThrow(childId, familyId);
    await this.pairingOrchestrator.assertDeviceBelongsToFamily(deviceId, familyId);

    const [policy, trustLevel, trustHistory, riskHistory, violationCount, decisionHistory] = await Promise.all([
      this.screenTimeService.getPolicy(childId, familyId),
      this.trustSignalProvider.getCurrentTrustLevel(deviceId),
      this.trustSignalProvider.getTrustHistory(childId),
      this.riskSignalProvider.getRiskHistory(deviceId),
      this.memoryEngine.getRecentViolationCount(childId),
      this.memoryEngine.getDecisionHistory(childId),
    ]);

    return {
      childId,
      childFirstName: child.firstName,
      generatedAt: new Date().toISOString(),
      screenTimePolicy: policy
        ? { dailyLimitMinutes: policy.dailyLimitMinutes, focusModeEnabled: policy.focusModeEnabled }
        : null,
      trustLevel,
      trustHistory: trustHistory.map((t) => ({
        fromLevel: t.fromLevel,
        toLevel: t.toLevel,
        reason: t.reason,
        occurredAt: t.occurredAt.toISOString(),
      })),
      riskHistory: riskHistory.map((r) => ({
        overallLevel: r.overallLevel,
        overallRisk: r.overallRisk,
        assessedAt: r.assessedAt.toISOString(),
      })),
      recentViolationCount: violationCount,
      decisionHistory: decisionHistory.map((d: any) => ({
        title: d.value?.title ?? 'Unknown',
        confidence: d.value?.confidence ?? 0,
        createdAt: d.createdAt.toISOString(),
      })),
    };
  }

  toCsv(report: IChildReport): string {
    const lines: string[] = [];
    lines.push('Section,Field,Value');
    lines.push(`Summary,Child,${report.childFirstName}`);
    lines.push(`Summary,Generated At,${report.generatedAt}`);
    lines.push(`Summary,Trust Level,${report.trustLevel ?? 'N/A'}`);
    lines.push(`Summary,Daily Limit (min),${report.screenTimePolicy?.dailyLimitMinutes ?? 'N/A'}`);
    lines.push(`Summary,Recent Violations (30d),${report.recentViolationCount}`);

    for (const entry of report.riskHistory) {
      lines.push(`Risk History,${entry.assessedAt},${entry.overallLevel} (${entry.overallRisk})`);
    }
    for (const entry of report.trustHistory) {
      lines.push(`Trust History,${entry.occurredAt},${entry.fromLevel ?? 'none'} -> ${entry.toLevel}`);
    }
    for (const entry of report.decisionHistory) {
      lines.push(`AI Decisions,${entry.createdAt},"${entry.title}" (confidence ${entry.confidence})`);
    }

    return lines.join('\n');
  }
}
