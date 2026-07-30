import { Inject, Injectable } from '@nestjs/common';

import { AiContextManagerService } from './ai-context-manager.service';
import {
  TRUST_SIGNAL_PROVIDER,
} from '../../../pairing/application/ports/device-trust.repository.port';
import type { ITrustSignalProvider } from '../../../pairing/domain/trust.types';
import {
  RISK_SIGNAL_PROVIDER,
} from '../../../pairing/application/ports/device-risk.repository.port';
import type { IRiskSignalProvider } from '../../../pairing/domain/risk.types';
import { PairingOrchestratorService } from '../../../pairing/application/services/pairing-orchestrator.service';
import { MemoryEngineService } from './memory-engine.service';
import type { IKnowledgeSnapshot } from '../../domain/knowledge.types';

/**
 * Sprint 7's Knowledge Engine. "The AI Core should query internal
 * knowledge before calling any provider" — this class IS that query.
 * Composes only already-existing signal sources (Sprint 2's
 * TRUST_SIGNAL_PROVIDER/RISK_SIGNAL_PROVIDER tokens, Sprint 4's
 * AiContextManagerService, Sprint 6's Memory Engine) — no new signal
 * collection lives here, only aggregation. This is deliberately the
 * ONLY place that assembles the full picture; every downstream engine
 * (Rule/Decision/Recommendation) takes an `IKnowledgeSnapshot` as input
 * rather than independently querying these services itself.
 */
@Injectable()
export class KnowledgeEngineService {
  constructor(
    private readonly contextManager: AiContextManagerService,
    @Inject(TRUST_SIGNAL_PROVIDER) private readonly trustSignalProvider: ITrustSignalProvider,
    @Inject(RISK_SIGNAL_PROVIDER) private readonly riskSignalProvider: IRiskSignalProvider,
    private readonly pairingOrchestrator: PairingOrchestratorService,
    private readonly memoryEngine: MemoryEngineService,
  ) {}

  async buildSnapshot(childId: string, familyId: string, deviceId: string): Promise<IKnowledgeSnapshot> {
    await this.pairingOrchestrator.assertDeviceBelongsToFamily(deviceId, familyId);

    const [childContext, trustLevel, riskAssessment, runtimeStatus, violationCount] = await Promise.all([
      this.contextManager.buildChildContext(childId, familyId),
      this.trustSignalProvider.getCurrentTrustLevel(deviceId),
      this.riskSignalProvider.getLatestRiskAssessment(deviceId),
      this.pairingOrchestrator.getRuntimeStatus(deviceId),
      this.memoryEngine.getRecentViolationCount(childId),
    ]);

    return {
      childId,
      familyId,
      ageYears: childContext.ageYears,
      trustLevel,
      riskLevel: riskAssessment?.overallLevel ?? 'UNKNOWN',
      riskReasons: riskAssessment?.reasons ?? [],
      dailyLimitMinutes: childContext.screenTime.dailyLimitMinutes,
      focusModeEnabled: childContext.screenTime.focusModeEnabled,
      accessibilityServiceEnabled: runtimeStatus.accessibilityServiceEnabled,
      enforcementActive: runtimeStatus.enforcementActive,
      recentViolationCount: violationCount,
    };
  }
}
