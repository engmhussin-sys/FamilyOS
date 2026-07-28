import { Test } from '@nestjs/testing';
import { RiskEvaluationService } from '../../src/modules/pairing/application/services/risk-evaluation.service';
import { DEVICE_RISK_REPOSITORY } from '../../src/modules/pairing/application/ports/device-risk.repository.port';
import type { IRiskSignalInput } from '../../src/modules/pairing/domain/risk.types';

const NO_SIGNALS: IRiskSignalInput = {
  isEmulator: false,
  isRooted: false,
  hasTamperIndicators: false,
  isUnsupportedDevice: false,
  missingAttestation: false,
  mockLocationEnabled: false,
  developerModeEnabled: false,
  usbDebuggingEnabled: false,
  isOldAndroidVersion: false,
};

describe('RiskEvaluationService', () => {
  const deviceRiskRepositoryMock = {
    record: jest.fn(),
    findLatestByDevice: jest.fn(),
    findHistoryByDevice: jest.fn(),
  };

  let service: RiskEvaluationService;

  beforeEach(async () => {
    jest.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [
        RiskEvaluationService,
        { provide: DEVICE_RISK_REPOSITORY, useValue: deviceRiskRepositoryMock },
      ],
    }).compile();
    service = moduleRef.get(RiskEvaluationService);
  });

  describe('calculateRisk — pure scoring (risk-score-framework.md §2/§4)', () => {
    it('returns 0/LOW with no reasons when nothing is flagged', () => {
      const result = service.calculateRisk(NO_SIGNALS);
      expect(result.overallRisk).toBe(0);
      expect(result.overallLevel).toBe('LOW');
      expect(result.reasons).toEqual([]);
    });

    it('weights emulator detection at the full 30 points (High confidence)', () => {
      const result = service.calculateRisk({ ...NO_SIGNALS, isEmulator: true });
      expect(result.categoryScores.security).toBe(30);
      expect(result.reasons).toContain('Emulator detected');
    });

    it('applies Medium-confidence weighting (0.7x) to mock location: 10 base -> 7', () => {
      const result = service.calculateRisk({ ...NO_SIGNALS, mockLocationEnabled: true });
      expect(result.categoryScores.security).toBe(7);
    });

    it('applies Low-confidence weighting (0.4x) to USB debugging: 5 base -> 2', () => {
      const result = service.calculateRisk({ ...NO_SIGNALS, usbDebuggingEnabled: true });
      expect(result.categoryScores.security).toBe(2);
    });

    it('suppresses Missing Attestation points when Root is already flagged (anti-double-counting rule)', () => {
      const withBoth = service.calculateRisk({ ...NO_SIGNALS, isRooted: true, missingAttestation: true });
      const rootOnly = service.calculateRisk({ ...NO_SIGNALS, isRooted: true });
      expect(withBoth.categoryScores.security).toBe(rootOnly.categoryScores.security);
      expect(withBoth.reasons).not.toContain('Missing hardware attestation');
    });

    it('suppresses Missing Attestation points when Emulator is already flagged', () => {
      const result = service.calculateRisk({ ...NO_SIGNALS, isEmulator: true, missingAttestation: true });
      expect(result.reasons).not.toContain('Missing hardware attestation');
    });

    it('counts Missing Attestation on its own (10.5 pts) when neither root nor emulator is flagged', () => {
      const result = service.calculateRisk({ ...NO_SIGNALS, missingAttestation: true });
      expect(result.categoryScores.security).toBe(10.5);
      expect(result.reasons).toContain('Missing hardware attestation');
    });

    it('caps the total score at 100 even if signals would sum higher', () => {
      const result = service.calculateRisk({
        isEmulator: true, // 30
        isRooted: true, // 20
        hasTamperIndicators: true, // 25
        isUnsupportedDevice: true, // 15
        missingAttestation: true, // suppressed (root/emulator present)
        mockLocationEnabled: true, // 7
        developerModeEnabled: true, // 3.5
        usbDebuggingEnabled: true, // 2
        isOldAndroidVersion: true, // 5
      });
      // 30+20+25+15+7+3.5+2+5 = 107.5, capped at 100
      expect(result.overallRisk).toBe(100);
    });

    it('Overall Risk = the MAX category score (only security populated today), not an average', () => {
      const result = service.calculateRisk({ ...NO_SIGNALS, isEmulator: true });
      expect(result.overallRisk).toBe(result.categoryScores.security);
      expect(result.categoryScores.privacy).toBe(0);
      expect(result.categoryScores.behavioral).toBe(0);
    });
  });

  describe('level bands', () => {
    it('0 -> LOW, 30 (emulator) -> MEDIUM, 55 (emulator+tamper) -> HIGH, 75 (emulator+root+tamper) -> CRITICAL', () => {
      expect(service.calculateRisk(NO_SIGNALS).overallLevel).toBe('LOW');
      expect(service.calculateRisk({ ...NO_SIGNALS, isEmulator: true }).overallLevel).toBe('MEDIUM');
      expect(
        service.calculateRisk({ ...NO_SIGNALS, isEmulator: true, hasTamperIndicators: true }).overallLevel,
      ).toBe('HIGH'); // 30 + 25 = 55
      expect(
        service.calculateRisk({ ...NO_SIGNALS, isEmulator: true, isRooted: true, hasTamperIndicators: true })
          .overallLevel,
      ).toBe('CRITICAL'); // 30 + 20 + 25 = 75
    });
  });

  describe('assessAndRecord', () => {
    it('persists every assessment as a new append-only row, even a LOW one', async () => {
      deviceRiskRepositoryMock.record.mockResolvedValue({ id: 'assessment-1' });

      await service.assessAndRecord('device-1', NO_SIGNALS);

      expect(deviceRiskRepositoryMock.record).toHaveBeenCalledWith(
        expect.objectContaining({ deviceId: 'device-1', overallRisk: 0, overallLevel: 'LOW' }),
      );
    });
  });

  describe('IRiskSignalProvider', () => {
    it('getLatestRiskAssessment delegates to the repository', async () => {
      deviceRiskRepositoryMock.findLatestByDevice.mockResolvedValue({ id: 'a1' });
      await expect(service.getLatestRiskAssessment('device-1')).resolves.toEqual({ id: 'a1' });
    });

    it('getRiskHistory delegates to the repository', async () => {
      deviceRiskRepositoryMock.findHistoryByDevice.mockResolvedValue([{ id: 'a1' }, { id: 'a2' }]);
      await expect(service.getRiskHistory('device-1')).resolves.toHaveLength(2);
    });
  });
});
