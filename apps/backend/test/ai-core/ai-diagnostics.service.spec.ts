import { NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AiDiagnosticsService } from '../../src/modules/ai-core/application/services/ai-diagnostics.service';
import { AI_PROVIDER } from '../../src/modules/ai-core/domain/ai-provider.port';
import { TRUST_SIGNAL_PROVIDER } from '../../src/modules/pairing/application/ports/device-trust.repository.port';
import { RISK_SIGNAL_PROVIDER } from '../../src/modules/pairing/application/ports/device-risk.repository.port';
import { PairingOrchestratorService } from '../../src/modules/pairing/application/services/pairing-orchestrator.service';

describe('AiDiagnosticsService', () => {
  const trustSignalProviderMock = { getCurrentTrustLevel: jest.fn() };
  const riskSignalProviderMock = { getLatestRiskAssessment: jest.fn() };
  const aiProviderMock = { complete: jest.fn() };
  const pairingOrchestratorMock = { assertDeviceBelongsToFamily: jest.fn() };

  let service: AiDiagnosticsService;

  beforeEach(async () => {
    jest.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [
        AiDiagnosticsService,
        { provide: TRUST_SIGNAL_PROVIDER, useValue: trustSignalProviderMock },
        { provide: RISK_SIGNAL_PROVIDER, useValue: riskSignalProviderMock },
        { provide: AI_PROVIDER, useValue: aiProviderMock },
        { provide: PairingOrchestratorService, useValue: pairingOrchestratorMock },
      ],
    }).compile();
    service = moduleRef.get(AiDiagnosticsService);
  });

  it('checks device ownership FIRST — never queries signals for a device outside the caller family', async () => {
    pairingOrchestratorMock.assertDeviceBelongsToFamily.mockRejectedValue(new NotFoundException());

    await expect(service.diagnoseDeviceHealth('device-1', 'family-1')).rejects.toBeInstanceOf(
      NotFoundException,
    );

    expect(trustSignalProviderMock.getCurrentTrustLevel).not.toHaveBeenCalled();
    expect(riskSignalProviderMock.getLatestRiskAssessment).not.toHaveBeenCalled();
  });

  it('returns real trust/risk data plus an AI summary on success', async () => {
    pairingOrchestratorMock.assertDeviceBelongsToFamily.mockResolvedValue({ childId: 'child-1' });
    trustSignalProviderMock.getCurrentTrustLevel.mockResolvedValue('L3_ATTESTED');
    riskSignalProviderMock.getLatestRiskAssessment.mockResolvedValue({
      overallLevel: 'LOW',
      reasons: [],
    });
    aiProviderMock.complete.mockResolvedValue('This device looks healthy and fully verified.');

    const result = await service.diagnoseDeviceHealth('device-1', 'family-1');

    expect(result.trustLevel).toBe('L3_ATTESTED');
    expect(result.riskLevel).toBe('LOW');
    expect(result.summary).toBe('This device looks healthy and fully verified.');
  });

  it('DISTINCT FAILURE CONTRACT: degrades to a fallback summary on AI failure, does NOT throw (unlike AiAssistantService)', async () => {
    pairingOrchestratorMock.assertDeviceBelongsToFamily.mockResolvedValue({ childId: 'child-1' });
    trustSignalProviderMock.getCurrentTrustLevel.mockResolvedValue('L2_VERIFIED');
    riskSignalProviderMock.getLatestRiskAssessment.mockResolvedValue({
      overallLevel: 'MEDIUM',
      reasons: ['Developer Mode enabled'],
    });
    aiProviderMock.complete.mockRejectedValue(new Error('Anthropic API timeout'));

    const result = await service.diagnoseDeviceHealth('device-1', 'family-1');

    // The call succeeds — real data is still returned.
    expect(result.trustLevel).toBe('L2_VERIFIED');
    expect(result.riskLevel).toBe('MEDIUM');
    expect(result.riskReasons).toEqual(['Developer Mode enabled']);
    expect(result.summary).toContain('temporarily unavailable');
  });

  it('degrades to the fallback summary on an empty AI response too', async () => {
    pairingOrchestratorMock.assertDeviceBelongsToFamily.mockResolvedValue({ childId: 'child-1' });
    trustSignalProviderMock.getCurrentTrustLevel.mockResolvedValue('L1_REGISTERED');
    riskSignalProviderMock.getLatestRiskAssessment.mockResolvedValue(null);
    aiProviderMock.complete.mockResolvedValue('   ');

    const result = await service.diagnoseDeviceHealth('device-1', 'family-1');

    expect(result.riskLevel).toBe('UNKNOWN');
    expect(result.summary).toContain('temporarily unavailable');
  });
});
