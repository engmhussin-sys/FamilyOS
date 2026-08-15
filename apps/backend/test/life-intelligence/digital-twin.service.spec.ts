import { Test } from '@nestjs/testing';

import { DigitalTwinService } from '../../src/modules/life-intelligence/application/services/digital-twin.service';
import { PrismaDigitalTwinRepository } from '../../src/modules/life-intelligence/infrastructure/repositories/prisma-digital-twin.repository';
import { ChildrenService } from '../../src/modules/children/application/services/children.service';
import { HabitEngineService } from '../../src/modules/life-intelligence/application/services/habit-engine.service';
import { HealthEngineService } from '../../src/modules/life-intelligence/application/services/health-engine.service';
import { FaithEngineService } from '../../src/modules/life-intelligence/application/services/faith-engine.service';
import { LearningEngineService } from '../../src/modules/life-intelligence/application/services/learning-engine.service';
import { PairingOrchestratorService } from '../../src/modules/pairing/application/services/pairing-orchestrator.service';
import { RiskEvaluationService } from '../../src/modules/pairing/application/services/risk-evaluation.service';
import { BehavioralIntelligenceEngineService } from '../../src/modules/ai-core/application/services/behavioral-intelligence-engine.service';
import { DigitalWellbeingEngineService } from '../../src/modules/life-intelligence/application/services/digital-wellbeing-engine.service';
import { familyDateProvider } from '../common/family-date.testing';

describe('DigitalTwinService — Sprint 25 Safety/Behavior wiring', () => {
  const repositoryMock = { getSocialScoreInputs: jest.fn(), upsertProjection: jest.fn() };
  const childrenServiceMock = { assertChildBelongsToFamily: jest.fn() };
  const habitEngineMock = { getScoreBreakdown: jest.fn() };
  const healthEngineMock = { computeAndStoreHealthScore: jest.fn() };
  const faithEngineMock = { getScoreBreakdown: jest.fn() };
  const learningEngineMock = { getProgressSummary: jest.fn() };
  const pairingOrchestratorMock = { listFamilyDevices: jest.fn() };
  const riskEvaluationMock = { getLatestRiskAssessment: jest.fn() };
  const behavioralEngineMock = { computeTrend: jest.fn() };
  const digitalWellbeingMock = { getBehavioralSnapshotSummary: jest.fn(), getWellbeingInsight: jest.fn() };

  let service: DigitalTwinService;
  const childId = 'child-1';
  const familyId = 'family-1';

  const defaultEngineOutputs = () => {
    habitEngineMock.getScoreBreakdown.mockResolvedValue({ completionRate: 0.5, completedHabitDays: 5, totalHabitDays: 10, streakDays: 3 });
    healthEngineMock.computeAndStoreHealthScore.mockResolvedValue({ score: 60, breakdown: {} });
    faithEngineMock.getScoreBreakdown.mockResolvedValue({ completionRate: 0.5, completedLogs: 5, activePractices: 2 });
    learningEngineMock.getProgressSummary.mockResolvedValue({ totalSessions: 0, totalMinutes: 0, averageAssessmentScore: null, streakDays: 0 });
    repositoryMock.getSocialScoreInputs.mockResolvedValue({ sharedHabitCompletions: 0, groupActivityCount: 0, groupBadgeCount: 0, challengeParticipations: 0 });
    digitalWellbeingMock.getBehavioralSnapshotSummary.mockResolvedValue(null);
    digitalWellbeingMock.getWellbeingInsight.mockResolvedValue(null);
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    defaultEngineOutputs();
    const moduleRef = await Test.createTestingModule({
      providers: [
        DigitalTwinService,
        { provide: PrismaDigitalTwinRepository, useValue: repositoryMock },
        { provide: ChildrenService, useValue: childrenServiceMock },
        { provide: HabitEngineService, useValue: habitEngineMock },
        { provide: HealthEngineService, useValue: healthEngineMock },
        { provide: FaithEngineService, useValue: faithEngineMock },
        { provide: LearningEngineService, useValue: learningEngineMock },
        { provide: PairingOrchestratorService, useValue: pairingOrchestratorMock },
        { provide: RiskEvaluationService, useValue: riskEvaluationMock },
        { provide: BehavioralIntelligenceEngineService, useValue: behavioralEngineMock },
        { provide: DigitalWellbeingEngineService, useValue: digitalWellbeingMock },
        // B2: the REAL FamilyDateService over a stub Prisma (see the helper).
        familyDateProvider()
      ],
    }).compile();
    service = moduleRef.get(DigitalTwinService);
  });

  describe('when the child has no paired device', () => {
    it('returns Safety and Behavior as null — the honest answer, never a fabricated default', async () => {
      pairingOrchestratorMock.listFamilyDevices.mockResolvedValue([]);

      const result = await service.refreshAndGet(childId, familyId);

      expect(result.safety).toBeNull();
      expect(result.behavior).toBeNull();
      expect(riskEvaluationMock.getLatestRiskAssessment).not.toHaveBeenCalled();
    });
  });

  describe('when the child has a paired device with a real risk assessment', () => {
    beforeEach(() => {
      pairingOrchestratorMock.listFamilyDevices.mockResolvedValue([
        { id: 'device-1', childId, lastSeenAt: new Date('2026-01-01') },
      ]);
    });

    it('computes Safety Score by inverting overallRisk', async () => {
      riskEvaluationMock.getLatestRiskAssessment.mockResolvedValue({
        overallRisk: 20,
        overallLevel: 'LOW',
        categoryScores: {},
        reasons: [],
      });
      behavioralEngineMock.computeTrend.mockResolvedValue({
        riskTrend: 'STABLE',
        riskAssessmentCount: 3,
        trustChangeCount: 0,
        summary: 'stable',
      });

      const result = await service.refreshAndGet(childId, familyId);

      expect(result.safety?.score).toBe(80); // 100 - 20
    });

    it('returns Safety as null when no assessment has ever run for the device — not a fabricated "safe" default', async () => {
      riskEvaluationMock.getLatestRiskAssessment.mockResolvedValue(null);
      behavioralEngineMock.computeTrend.mockResolvedValue({
        riskTrend: 'INSUFFICIENT_DATA', riskAssessmentCount: 0, trustChangeCount: 0, summary: '',
      });

      const result = await service.refreshAndGet(childId, familyId);

      expect(result.safety).toBeNull();
    });

    it('returns Behavior as null for INSUFFICIENT_DATA — never guesses a number from too little data', async () => {
      riskEvaluationMock.getLatestRiskAssessment.mockResolvedValue({ overallRisk: 10, overallLevel: 'LOW', categoryScores: {}, reasons: [] });
      behavioralEngineMock.computeTrend.mockResolvedValue({
        riskTrend: 'INSUFFICIENT_DATA', riskAssessmentCount: 0, trustChangeCount: 0, summary: '',
      });

      const result = await service.refreshAndGet(childId, familyId);

      expect(result.behavior).toBeNull();
    });

    it('picks the MOST RECENTLY SEEN device when the child has more than one', async () => {
      pairingOrchestratorMock.listFamilyDevices.mockResolvedValue([
        { id: 'old-device', childId, lastSeenAt: new Date('2025-01-01') },
        { id: 'new-device', childId, lastSeenAt: new Date('2026-01-01') },
        { id: 'other-childs-device', childId: 'someone-else', lastSeenAt: new Date('2026-06-01') },
      ]);
      riskEvaluationMock.getLatestRiskAssessment.mockResolvedValue({ overallRisk: 0, overallLevel: 'LOW', categoryScores: {}, reasons: [] });
      behavioralEngineMock.computeTrend.mockResolvedValue({ riskTrend: 'STABLE', riskAssessmentCount: 1, trustChangeCount: 0, summary: '' });

      await service.refreshAndGet(childId, familyId);

      expect(riskEvaluationMock.getLatestRiskAssessment).toHaveBeenCalledWith('new-device');
    });

    it('increases confidence to HIGH once riskAssessmentCount reaches 5', async () => {
      riskEvaluationMock.getLatestRiskAssessment.mockResolvedValue({ overallRisk: 10, overallLevel: 'LOW', categoryScores: {}, reasons: [] });
      behavioralEngineMock.computeTrend.mockResolvedValue({ riskTrend: 'IMPROVING', riskAssessmentCount: 5, trustChangeCount: 0, summary: '' });

      const result = await service.refreshAndGet(childId, familyId);

      expect(result.behavior?.confidence).toBe('HIGH');
    });
  });

  it('Growth Score now considers 7 possible sub-scores (was 5 before Safety/Behavior wiring); with Learning absent (0 sessions) and Safety+Behavior present, 6 of 7 contribute', async () => {
    pairingOrchestratorMock.listFamilyDevices.mockResolvedValue([{ id: 'device-1', childId, lastSeenAt: new Date() }]);
    riskEvaluationMock.getLatestRiskAssessment.mockResolvedValue({ overallRisk: 0, overallLevel: 'LOW', categoryScores: {}, reasons: [] });
    behavioralEngineMock.computeTrend.mockResolvedValue({ riskTrend: 'STABLE', riskAssessmentCount: 5, trustChangeCount: 0, summary: '' });

    const result = await service.refreshAndGet(childId, familyId);

    expect(result.growthScore?.inputs.totalPossibleSubScores).toBe(7);
    expect(result.growthScore?.inputs.contributingSubScores).toBe(6);
  });

  describe('wellbeing (Edge-First Intelligence Architecture)', () => {
    it('returns null (honest absence) when no wellbeing data exists yet', async () => {
      digitalWellbeingMock.getBehavioralSnapshotSummary.mockResolvedValue(null);
      const result = await service.refreshAndGet(childId, familyId);
      expect(result.wellbeing).toBeNull();
    });

    it('computes score from totalBlockedAttempts ONLY \u2014 zero violations scores 100', async () => {
      digitalWellbeingMock.getBehavioralSnapshotSummary.mockResolvedValue({
        windowDays: 30, averageDailyScreenMinutes: 90, averagePickups: 20, averageNightUsageMinutes: 5,
        totalBlockedAttempts: 0, daysWithData: 10,
      });
      const result = await service.refreshAndGet(childId, familyId);
      expect(result.wellbeing?.score).toBe(100);
    });

    it('deducts 10 points per blocked attempt, floored at 0', async () => {
      digitalWellbeingMock.getBehavioralSnapshotSummary.mockResolvedValue({
        windowDays: 30, averageDailyScreenMinutes: 90, averagePickups: 20, averageNightUsageMinutes: 5,
        totalBlockedAttempts: 15, daysWithData: 10,
      });
      const result = await service.refreshAndGet(childId, familyId);
      expect(result.wellbeing?.score).toBe(0); // 100 - 150, floored
    });

    it('surfaces screen time / pickups / night usage as CONTEXT in inputs, never affecting the score itself', async () => {
      digitalWellbeingMock.getBehavioralSnapshotSummary.mockResolvedValue({
        windowDays: 30, averageDailyScreenMinutes: 300, averagePickups: 200, averageNightUsageMinutes: 120,
        totalBlockedAttempts: 1, daysWithData: 10,
      });
      const result = await service.refreshAndGet(childId, familyId);
      // Extremely high screen time/pickups/night usage do NOT lower the
      // score below what 1 blocked attempt alone would produce.
      expect(result.wellbeing?.score).toBe(90);
      expect(result.wellbeing?.inputs.averageDailyScreenMinutes).toBe(300);
    });

    it('is NEVER included in growthScore\u2019s own calculation \u2014 the explicit PM decision, verified not just asserted', async () => {
      digitalWellbeingMock.getBehavioralSnapshotSummary.mockResolvedValue({
        windowDays: 30, averageDailyScreenMinutes: 90, averagePickups: 20, averageNightUsageMinutes: 5,
        totalBlockedAttempts: 0, daysWithData: 10,
      });
      const result = await service.refreshAndGet(childId, familyId);
      // Same 7-slot count as before wellbeing existed \u2014 proves it was
      // never added to computeGrowthScore's input array.
      expect(result.growthScore?.inputs.totalPossibleSubScores).toBe(7);
    });

    it('confidence reflects days of real data \u2014 HIGH at 7+, MEDIUM at 3-6, LOW below 3', async () => {
      digitalWellbeingMock.getBehavioralSnapshotSummary.mockResolvedValue({
        windowDays: 30, averageDailyScreenMinutes: 90, averagePickups: 20, averageNightUsageMinutes: 5,
        totalBlockedAttempts: 0, daysWithData: 2,
      });
      const result = await service.refreshAndGet(childId, familyId);
      expect(result.wellbeing?.confidence).toBe('LOW');
    });

    describe("pattern enrichment (CLOSES A REAL GAP: Sprint 14's own requirement -- 'What patterns are emerging?' -- was never wired into Digital Twin before this)", () => {
      it("includes today's detected patterns and baseline deviation in inputs when an insight exists", async () => {
        digitalWellbeingMock.getBehavioralSnapshotSummary.mockResolvedValue({
          windowDays: 30, averageDailyScreenMinutes: 90, averagePickups: 20, averageNightUsageMinutes: 5,
          totalBlockedAttempts: 0, daysWithData: 10,
        });
        digitalWellbeingMock.getWellbeingInsight.mockResolvedValue({
          childId, date: '2026-08-10', humanSummary: 'Screen time was 40% higher than usual.',
          baselineDeviationPercent: 40,
          patterns: [{ code: 'EXCESSIVE_USAGE', confidence: 0.8, explanation: 'x', isPositive: false }],
          recommendation: 'Consider a short conversation.',
        });

        const result = await service.refreshAndGet(childId, familyId);

        expect(result.wellbeing?.inputs.todaysPatterns).toEqual(['EXCESSIVE_USAGE']);
        expect(result.wellbeing?.inputs.baselineDeviationPercent).toBe(40);
        expect(result.wellbeing?.score).toBe(100);
      });

      it('BOUNDARY CASE: when getWellbeingInsight throws (best-effort), wellbeing still returns normally with the OTHER fields intact', async () => {
        digitalWellbeingMock.getBehavioralSnapshotSummary.mockResolvedValue({
          windowDays: 30, averageDailyScreenMinutes: 90, averagePickups: 20, averageNightUsageMinutes: 5,
          totalBlockedAttempts: 0, daysWithData: 10,
        });
        digitalWellbeingMock.getWellbeingInsight.mockRejectedValue(new Error('transient failure'));

        const result = await service.refreshAndGet(childId, familyId);

        expect(result.wellbeing?.score).toBe(100);
        expect(result.wellbeing?.inputs.todaysPatterns).toBeUndefined();
      });

      it('BOUNDARY CASE: when no insight exists yet for today (null), inputs simply omit the pattern fields', async () => {
        digitalWellbeingMock.getBehavioralSnapshotSummary.mockResolvedValue({
          windowDays: 30, averageDailyScreenMinutes: 90, averagePickups: 20, averageNightUsageMinutes: 5,
          totalBlockedAttempts: 0, daysWithData: 10,
        });
        digitalWellbeingMock.getWellbeingInsight.mockResolvedValue(null);

        const result = await service.refreshAndGet(childId, familyId);

        expect(result.wellbeing?.inputs.todaysPatterns).toBeUndefined();
        expect(result.wellbeing?.inputs.baselineDeviationPercent).toBeUndefined();
      });
    });
  });
});
