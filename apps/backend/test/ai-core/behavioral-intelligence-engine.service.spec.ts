import { NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { BehavioralIntelligenceEngineService } from '../../src/modules/ai-core/application/services/behavioral-intelligence-engine.service';
import { TRUST_SIGNAL_PROVIDER } from '../../src/modules/pairing/application/ports/device-trust.repository.port';
import { RISK_SIGNAL_PROVIDER } from '../../src/modules/pairing/application/ports/device-risk.repository.port';
import { PairingOrchestratorService } from '../../src/modules/pairing/application/services/pairing-orchestrator.service';

describe('BehavioralIntelligenceEngineService', () => {
  const trustSignalProviderMock = { getTrustHistory: jest.fn() };
  const riskSignalProviderMock = { getRiskHistory: jest.fn() };
  const pairingOrchestratorMock = { assertDeviceBelongsToFamily: jest.fn() };

  let service: BehavioralIntelligenceEngineService;

  beforeEach(async () => {
    jest.clearAllMocks();
    pairingOrchestratorMock.assertDeviceBelongsToFamily.mockResolvedValue({ childId: 'child-1' });
    const moduleRef = await Test.createTestingModule({
      providers: [
        BehavioralIntelligenceEngineService,
        { provide: TRUST_SIGNAL_PROVIDER, useValue: trustSignalProviderMock },
        { provide: RISK_SIGNAL_PROVIDER, useValue: riskSignalProviderMock },
        { provide: PairingOrchestratorService, useValue: pairingOrchestratorMock },
      ],
    }).compile();
    service = moduleRef.get(BehavioralIntelligenceEngineService);
  });

  it('SECURITY: checks device ownership before reading any history', async () => {
    pairingOrchestratorMock.assertDeviceBelongsToFamily.mockRejectedValue(new NotFoundException());

    await expect(service.computeTrend('device-1', 'child-1', 'family-1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(riskSignalProviderMock.getRiskHistory).not.toHaveBeenCalled();
  });

  it('returns INSUFFICIENT_DATA with fewer than 2 risk assessments', async () => {
    riskSignalProviderMock.getRiskHistory.mockResolvedValue([{ overallLevel: 'LOW' }]);
    trustSignalProviderMock.getTrustHistory.mockResolvedValue([]);

    const trend = await service.computeTrend('device-1', 'child-1', 'family-1');

    expect(trend.riskTrend).toBe('INSUFFICIENT_DATA');
  });

  it('detects WORSENING when risk level increases from first to last assessment', async () => {
    riskSignalProviderMock.getRiskHistory.mockResolvedValue([
      { overallLevel: 'LOW' },
      { overallLevel: 'MEDIUM' },
      { overallLevel: 'HIGH' },
    ]);
    trustSignalProviderMock.getTrustHistory.mockResolvedValue([]);

    const trend = await service.computeTrend('device-1', 'child-1', 'family-1');

    expect(trend.riskTrend).toBe('WORSENING');
  });

  it('detects IMPROVING when risk level decreases from first to last assessment', async () => {
    riskSignalProviderMock.getRiskHistory.mockResolvedValue([
      { overallLevel: 'HIGH' },
      { overallLevel: 'LOW' },
    ]);
    trustSignalProviderMock.getTrustHistory.mockResolvedValue([]);

    const trend = await service.computeTrend('device-1', 'child-1', 'family-1');

    expect(trend.riskTrend).toBe('IMPROVING');
  });

  it('detects STABLE when first and last risk levels match', async () => {
    riskSignalProviderMock.getRiskHistory.mockResolvedValue([
      { overallLevel: 'LOW' },
      { overallLevel: 'MEDIUM' },
      { overallLevel: 'LOW' },
    ]);
    trustSignalProviderMock.getTrustHistory.mockResolvedValue([]);

    const trend = await service.computeTrend('device-1', 'child-1', 'family-1');

    expect(trend.riskTrend).toBe('STABLE');
  });
});
