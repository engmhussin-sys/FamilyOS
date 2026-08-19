/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * ===========================================================================
 * F1 — «رؤى» ANSWERED A CAIRO PARENT WITH YESTERDAY, EVERY NIGHT, FOR THREE
 * HOURS.
 * ===========================================================================
 *
 * TWO SITES SURVIVED B1+B2's SWEEP OF THE UTC CLASS, both spelled
 * `new Date().toISOString().split('T')[0]`:
 *
 *   life-intelligence.controller.ts:744 — the `?date=` default on
 *     `GET /life-intelligence/wellbeing/:childId/insights`;
 *   digital-twin.service.ts:156 — the day `todaysPatterns` is read for.
 *
 * `common/time/family-date.ts` states the UTC class was replaced "and by
 * nothing else", and `digital-wellbeing-engine.service.ts:464` already had
 * `todayColumn(familyId)` one layer down — so the storage side was already on
 * the family's calendar and only these two callers were not.
 *
 * THE CONCRETE FAILURE. `DailyBehavioralSnapshot.usageDate` is a `@db.Date`
 * holding a business date. Between local midnight and 03:00 (02:00 in winter)
 * UTC still reads YESTERDAY in both launch markets, so:
 *
 *   - a parent opening «رؤى» at 01:30 got yesterday's insight, or `null` where
 *     today's row already existed;
 *   - Digital Twin's `todaysPatterns` silently vanished for the same window —
 *     the `catch` around it is best-effort, so an absent field is
 *     indistinguishable from "the device has not synced yet". Nothing looked
 *     broken.
 *
 * WHY JANUARY, AND WHY THE PREMISE IS ASSERTED FIRST. Africa/Cairo is
 * GMT+02:00 in January and GMT+03:00 in August (Egypt reintroduced DST in
 * 2023); Asia/Riyadh is GMT+03:00 year-round. A January instant is used so the
 * offsets in play are unambiguous, and every case below PROVES that UTC and
 * the family disagree before asserting which one the code followed — a suite
 * here once passed by day and failed by night for exactly the want of that.
 *
 * THE CLOCK IS FROZEN with `freezeGoldenClock` (`test/golden/golden-world.ts`),
 * the project's one clock-freezing helper, because both sites read `new Date()`
 * with no argument: on the real clock these tests would assert nothing 21 hours
 * out of 24 and fail in the other three.
 */
import { Test } from '@nestjs/testing';

import { LifeIntelligenceController } from '../../src/modules/life-intelligence/presentation/controllers/life-intelligence.controller';
import { HabitEngineService } from '../../src/modules/life-intelligence/application/services/habit-engine.service';
import { LifeTimelineService } from '../../src/modules/life-intelligence/application/services/life-timeline.service';
import { HealthEngineService } from '../../src/modules/life-intelligence/application/services/health-engine.service';
import { FaithEngineService } from '../../src/modules/life-intelligence/application/services/faith-engine.service';
import { LearningEngineService } from '../../src/modules/life-intelligence/application/services/learning-engine.service';
import { SmartTaskEngineService } from '../../src/modules/life-intelligence/application/services/smart-task-engine.service';
import { RewardsEngineService } from '../../src/modules/life-intelligence/application/services/rewards-engine.service';
import { FamilyCommunicationService } from '../../src/modules/life-intelligence/application/services/family-communication.service';
import { CoachingEngineService } from '../../src/modules/life-intelligence/application/services/coaching-engine.service';
import { DigitalTwinService } from '../../src/modules/life-intelligence/application/services/digital-twin.service';
import { FamilyInsightService } from '../../src/modules/life-intelligence/application/services/family-insight.service';
import { DigitalWellbeingEngineService } from '../../src/modules/life-intelligence/application/services/digital-wellbeing-engine.service';
import { PairingOrchestratorService } from '../../src/modules/pairing/application/services/pairing-orchestrator.service';
import { ChildrenService } from '../../src/modules/children/application/services/children.service';
import { PrismaDigitalTwinRepository } from '../../src/modules/life-intelligence/infrastructure/repositories/prisma-digital-twin.repository';
import { RiskEvaluationService } from '../../src/modules/pairing/application/services/risk-evaluation.service';
import { BehavioralIntelligenceEngineService } from '../../src/modules/ai-core/application/services/behavioral-intelligence-engine.service';
import { getBusinessDate } from '../../src/common/time/family-date';
import { familyDateProvider } from '../common/family-date.testing';
import { freezeGoldenClock } from '../golden/golden-world';

/**
 * 23:30 UTC on 15 January 2026. In Africa/Cairo (GMT+02:00 in January) the
 * family's wall clock reads 01:30 on the SIXTEENTH — inside the window a
 * parent actually opens the app in, and on the other side of a date boundary
 * from UTC.
 */
const AFTER_LOCAL_MIDNIGHT = new Date('2026-01-15T23:30:00.000Z');
const UTC_DAY = '2026-01-15';
const CAIRO_DAY = '2026-01-16';

const childId = 'child-1';
const familyId = 'family-cairo';

/** Anything the controller holds that this suite does not decide. */
const noop = (): Record<string, jest.Mock> =>
  new Proxy({} as Record<string, jest.Mock>, {
    get: (target, prop: string) => {
      if (prop === 'then') return undefined;
      if (!target[prop]) target[prop] = jest.fn().mockResolvedValue({});
      return target[prop];
    },
  });

describe('F1 — «today» in the wellbeing surfaces is the family’s day, not UTC’s', () => {
  beforeEach(() => {
    freezeGoldenClock(AFTER_LOCAL_MIDNIGHT);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('THE PREMISE: at this instant a Cairo family and UTC are on different calendar days', () => {
    expect(new Date().toISOString().split('T')[0]).toBe(UTC_DAY);
    expect(getBusinessDate(new Date(), 'Africa/Cairo')).toBe(CAIRO_DAY);
    expect(UTC_DAY).not.toBe(CAIRO_DAY);
  });

  // =======================================================================
  // SITE 1 — the `?date=` default on GET /wellbeing/:childId/insights
  // =======================================================================
  describe('LifeIntelligenceController.getWellbeingInsight', () => {
    const digitalWellbeingMock = { getWellbeingInsight: jest.fn() };
    let controller: LifeIntelligenceController;

    beforeEach(async () => {
      digitalWellbeingMock.getWellbeingInsight.mockReset();
      digitalWellbeingMock.getWellbeingInsight.mockResolvedValue(null);

      const moduleRef = await Test.createTestingModule({
        controllers: [LifeIntelligenceController],
        providers: [
          { provide: HabitEngineService, useValue: noop() },
          { provide: LifeTimelineService, useValue: noop() },
          { provide: HealthEngineService, useValue: noop() },
          { provide: FaithEngineService, useValue: noop() },
          { provide: LearningEngineService, useValue: noop() },
          { provide: SmartTaskEngineService, useValue: noop() },
          { provide: RewardsEngineService, useValue: noop() },
          { provide: FamilyCommunicationService, useValue: noop() },
          { provide: CoachingEngineService, useValue: noop() },
          { provide: DigitalTwinService, useValue: noop() },
          { provide: FamilyInsightService, useValue: noop() },
          { provide: PairingOrchestratorService, useValue: noop() },
          { provide: ChildrenService, useValue: noop() },
          { provide: DigitalWellbeingEngineService, useValue: digitalWellbeingMock },
          // The REAL FamilyDateService over a one-row stub Prisma — the real
          // `Intl`-backed calendar, with only the `Family.timezone` read faked.
          familyDateProvider('Africa/Cairo'),
        ],
      }).compile();

      controller = moduleRef.get(LifeIntelligenceController);
    });

    it('defaults `?date=` to the FAMILY’s calendar day, not UTC’s', async () => {
      await controller.getWellbeingInsight(childId, undefined, { sub: 'u1', familyId } as any);

      expect(digitalWellbeingMock.getWellbeingInsight).toHaveBeenCalledWith(
        childId,
        familyId,
        CAIRO_DAY,
      );
      // The exact string the defect produced. Asserted by name, so a partial
      // fix that merely moves the truncation is still caught.
      expect(digitalWellbeingMock.getWellbeingInsight).not.toHaveBeenCalledWith(
        childId,
        familyId,
        UTC_DAY,
      );
    });

    it('an EXPLICIT ?date= is passed through untouched — a parent asking for a day gets that day', async () => {
      await controller.getWellbeingInsight(childId, '2025-12-31', { sub: 'u1', familyId } as any);

      expect(digitalWellbeingMock.getWellbeingInsight).toHaveBeenCalledWith(
        childId,
        familyId,
        '2025-12-31',
      );
    });
  });

  // =======================================================================
  // SITE 2 — Digital Twin's `todaysPatterns`
  // =======================================================================
  describe('DigitalTwinService.todaysPatterns', () => {
    const repositoryMock = { getSocialScoreInputs: jest.fn(), upsertProjection: jest.fn() };
    const digitalWellbeingMock = {
      getBehavioralSnapshotSummary: jest.fn(),
      getWellbeingInsight: jest.fn(),
    };
    const pairingOrchestratorMock = { listFamilyDevices: jest.fn() };
    const habitEngineMock = { getScoreBreakdown: jest.fn() };
    const healthEngineMock = { computeAndStoreHealthScore: jest.fn() };
    const faithEngineMock = { getScoreBreakdown: jest.fn() };
    const learningEngineMock = { getProgressSummary: jest.fn() };
    let service: DigitalTwinService;

    beforeEach(async () => {
      jest.clearAllMocks();

      const moduleRef = await Test.createTestingModule({
        providers: [
          DigitalTwinService,
          { provide: PrismaDigitalTwinRepository, useValue: repositoryMock },
          { provide: ChildrenService, useValue: { assertChildBelongsToFamily: jest.fn() } },
          { provide: HabitEngineService, useValue: habitEngineMock },
          { provide: HealthEngineService, useValue: healthEngineMock },
          { provide: FaithEngineService, useValue: faithEngineMock },
          { provide: LearningEngineService, useValue: learningEngineMock },
          { provide: PairingOrchestratorService, useValue: pairingOrchestratorMock },
          { provide: RiskEvaluationService, useValue: { getLatestRiskAssessment: jest.fn() } },
          { provide: BehavioralIntelligenceEngineService, useValue: { computeTrend: jest.fn() } },
          { provide: DigitalWellbeingEngineService, useValue: digitalWellbeingMock },
          familyDateProvider('Africa/Cairo'),
        ],
      }).compile();

      service = moduleRef.get(DigitalTwinService);

      // The other six slices are not what this suite decides — they only have
      // to return a shape `refreshAndGet` can compose.
      habitEngineMock.getScoreBreakdown.mockResolvedValue({
        completionRate: 0.5, completedHabitDays: 5, totalHabitDays: 10, streakDays: 3,
      });
      healthEngineMock.computeAndStoreHealthScore.mockResolvedValue({ score: 60, breakdown: {} });
      faithEngineMock.getScoreBreakdown.mockResolvedValue({
        completionRate: 0.5, completedLogs: 5, activePractices: 2,
      });
      learningEngineMock.getProgressSummary.mockResolvedValue({
        totalSessions: 0, totalMinutes: 0, averageAssessmentScore: null, streakDays: 0,
      });
      repositoryMock.getSocialScoreInputs.mockResolvedValue({
        sharedHabitCompletions: 0, groupActivityCount: 0, groupBadgeCount: 0, challengeParticipations: 0,
      });
      pairingOrchestratorMock.listFamilyDevices.mockResolvedValue([]);
      digitalWellbeingMock.getBehavioralSnapshotSummary.mockResolvedValue({
        windowDays: 30, averageDailyScreenMinutes: 90, averagePickups: 20,
        averageNightUsageMinutes: 5, totalBlockedAttempts: 0, daysWithData: 10,
      });
    });

    /**
     * The insight EXISTS — but only under the family's date. A repository that
     * answers only the family's day is the honest simulation of the `@db.Date`
     * column, and it is what makes the old code's failure show up as the
     * silent disappearance it actually was.
     */
    it('reads today’s patterns on the FAMILY’s day, so they do not silently vanish after local midnight', async () => {
      digitalWellbeingMock.getWellbeingInsight.mockImplementation(async (_c: string, _f: string, date: string) =>
        date === CAIRO_DAY
          ? {
              childId,
              date: CAIRO_DAY,
              humanSummary: '…',
              baselineDeviationPercent: 40,
              patterns: [{ code: 'NIGHT_USAGE_INCREASE', confidence: 0.8, explanation: 'x', isPositive: false }],
              recommendation: '…',
            }
          : null,
      );

      const result = await service.refreshAndGet(childId, familyId);

      expect(digitalWellbeingMock.getWellbeingInsight).toHaveBeenCalledWith(childId, familyId, CAIRO_DAY);
      expect(result.wellbeing?.inputs.todaysPatterns).toEqual(['NIGHT_USAGE_INCREASE']);
      expect(result.wellbeing?.inputs.baselineDeviationPercent).toBe(40);
    });
  });
});
