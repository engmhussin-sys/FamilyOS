import { Injectable } from '@nestjs/common';

import { ChildrenService } from '../../../children/application/services/children.service';
import { PrismaDigitalTwinRepository } from '../../infrastructure/repositories/prisma-digital-twin.repository';
import { HabitEngineService } from './habit-engine.service';
import { HealthEngineService } from './health-engine.service';
import { FaithEngineService } from './faith-engine.service';
import { LearningEngineService } from './learning-engine.service';
import { IDigitalTwin, IExplainableSubScore } from '../../domain/digital-twin.types';
import { computeGrowthScore } from './digital-twin-rules';
import { mapBehavioralTrendToScore, mapRiskToSafetyScore } from './safety-behavior-rules';
import { PairingOrchestratorService } from '../../../pairing/application/services/pairing-orchestrator.service';
import { RiskEvaluationService } from '../../../pairing/application/services/risk-evaluation.service';
import { BehavioralIntelligenceEngineService } from '../../../ai-core/application/services/behavioral-intelligence-engine.service';
import { DigitalWellbeingEngineService } from './digital-wellbeing-engine.service';
import { FamilyDateService } from '../../../../common/time/family-date.service';
import { getBusinessDate } from '../../../../common/time/family-date';

const SOCIAL_SCORE_WINDOW_DAYS = 30;

/**
 * Architecture 1.0 \u00a76: an aggregated READ PROJECTION, NOT a second
 * source of truth. Every slice is recomputed from the real engines'
 * own data on each refresh \u2014 upsertProjection caches the result for
 * fast reads elsewhere, but this service always trusts the source
 * tables, never the cache, when computing.
 *
 * SPRINT 25: Safety Score and Behavior Score are now wired \u2014 both
 * read through Digital Safety's ALREADY-BUILT, already-exported
 * public methods (`RiskEvaluationService`, `BehavioralIntelligenceEngineService`),
 * never touching ai-core or pairing's own files (Code Freeze fully
 * respected: this is a new consumer of an existing public API, not a
 * modification). See safety-behavior-rules.ts for the explainable
 * score mapping.
 *
 * EDGE-FIRST INTELLIGENCE ARCHITECTURE SPRINT: `wellbeing` is a NEW,
 * separate field (see digital-twin.types.ts's own docstring for the
 * explicit PM decision on why it is NOT blended into `behavior` or
 * `growthScore`).
 */
@Injectable()
export class DigitalTwinService {
  constructor(
    private readonly repository: PrismaDigitalTwinRepository,
    private readonly childrenService: ChildrenService,
    private readonly habitEngine: HabitEngineService,
    private readonly healthEngine: HealthEngineService,
    private readonly faithEngine: FaithEngineService,
    private readonly learningEngine: LearningEngineService,
    private readonly pairingOrchestrator: PairingOrchestratorService,
    private readonly riskEvaluation: RiskEvaluationService,
    private readonly behavioralEngine: BehavioralIntelligenceEngineService,
    private readonly digitalWellbeing: DigitalWellbeingEngineService,
    private readonly familyDate: FamilyDateService,
  ) {}

  async refreshAndGet(childId: string, familyId: string): Promise<IDigitalTwin> {
    await this.childrenService.assertChildBelongsToFamily(childId, familyId);

    // B2: the social-score window starts at a FAMILY calendar boundary, so the
    // Digital Twin's inputs agree with the engines it aggregates.
    const socialSince = await this.daysAgo(familyId, SOCIAL_SCORE_WINDOW_DAYS);

    const [habitScore, healthScore, faithScore, learningProgress, socialInputs, primaryDeviceId] = await Promise.all([
      this.habitEngine.getScoreBreakdown(childId, familyId),
      this.healthEngine.computeAndStoreHealthScore(childId, familyId),
      this.faithEngine.getScoreBreakdown(childId, familyId),
      this.learningEngine.getProgressSummary(childId, familyId),
      this.repository.getSocialScoreInputs(childId, socialSince),
      this.findPrimaryDeviceId(childId, familyId),
    ]);

    const habits: IExplainableSubScore = {
      score: Math.round(habitScore.completionRate * 100),
      inputs: { completedHabitDays: habitScore.completedHabitDays, totalHabitDays: habitScore.totalHabitDays, streakDays: habitScore.streakDays },
      confidence: habitScore.totalHabitDays > 0 ? 'HIGH' : 'LOW',
    };

    const health: IExplainableSubScore = {
      score: healthScore.score,
      inputs: healthScore.breakdown as unknown as Record<string, unknown>,
      confidence: 'HIGH',
    };

    const faith: IExplainableSubScore = {
      score: Math.round(faithScore.completionRate * 100),
      inputs: { completedLogs: faithScore.completedLogs, activePractices: faithScore.activePractices },
      confidence: faithScore.activePractices > 0 ? 'HIGH' : 'LOW',
    };

    const learning: IExplainableSubScore | null = learningProgress.totalSessions > 0
      ? {
          score: learningProgress.averageAssessmentScore !== null
            ? Math.round(learningProgress.averageAssessmentScore)
            : Math.min(100, Math.round((learningProgress.totalMinutes / (SOCIAL_SCORE_WINDOW_DAYS * 20)) * 100)),
          inputs: { totalSessions: learningProgress.totalSessions, totalMinutes: learningProgress.totalMinutes, averageAssessmentScore: learningProgress.averageAssessmentScore, streakDays: learningProgress.streakDays },
          confidence: learningProgress.averageAssessmentScore !== null ? 'HIGH' : 'MEDIUM',
        }
      : null;

    // Social Score: purely legitimate in-platform participation
    // signals (Architecture 1.0 Decision 1) — zero surveillance, zero
    // conversation/contact data.
    const socialRawTotal = socialInputs.sharedHabitCompletions + socialInputs.groupActivityCount + socialInputs.groupBadgeCount * 5 + socialInputs.challengeParticipations * 10;
    const social: IExplainableSubScore = {
      score: Math.min(100, socialRawTotal * 2),
      inputs: { ...socialInputs },
      confidence: 'MEDIUM',
    };

    const { safety, behavior } = await this.computeSafetyAndBehavior(childId, familyId, primaryDeviceId);
    const wellbeing = await this.computeWellbeing(childId, familyId);

    const growthScore = computeGrowthScore([safety, health, learning, faith, behavior, habits, social]);

    await this.repository.upsertProjection(childId, {
      healthSlice: health,
      learningSlice: learning,
      faithSlice: faith,
      behaviorSlice: behavior,
      habitsSlice: habits,
      socialSlice: social,
      safetySlice: safety,
    });

    return { childId, safety, health, learning, faith, behavior, habits, social, wellbeing, growthScore, updatedAt: new Date() };
  }

  /** EDGE-FIRST INTELLIGENCE ARCHITECTURE SPRINT: score is derived
   * ONLY from `totalBlockedAttempts` \u2014 the one number in the
   * behavioral snapshot with an objectively directional meaning
   * (fewer circumvention attempts is unambiguously better; there is
   * no equivalent clinical consensus for "how much screen time is
   * too much," so that and pickups/night-usage are surfaced honestly
   * as CONTEXT in `inputs`, never folded into `score` itself \u2014 the
   * same discipline already applied to NOT blending this into
   * `behavior`, applied consistently here too). */
  private async computeWellbeing(childId: string, familyId: string): Promise<IExplainableSubScore | null> {
    const summary = await this.digitalWellbeing.getBehavioralSnapshotSummary(childId, familyId);
    if (!summary) return null;

    // 0 violations = 100. Each violation costs 10 points, floor 0 —
    // directional and simple, not a precision claim.
    const score = Math.max(0, 100 - summary.totalBlockedAttempts * 10);

    // CLOSES A REAL GAP found in a follow-up review: Sprint 14's own
    // explicit requirement ("a parent should be able to see... What
    // patterns are emerging?" via Digital Twin) was never wired —
    // this only ever surfaced pre-Sprint-14 averages. Best-effort:
    // today's insight may not exist yet (e.g. the device hasn't
    // synced today), in which case this stays undefined rather than
    // failing the whole Digital Twin refresh over one optional field.
    //
    // F1 — AND `todaysPatterns` MEANS THE FAMILY'S TODAY. This was the second
    // surviving site of the UTC class (`new Date().toISOString().split('T')[0]`),
    // and the `catch` above is what hid it: for a Cairo family between local
    // midnight and 03:00, UTC still reads yesterday, `getWellbeingInsight`
    // answers `null` for a day whose row exists, and the field simply does not
    // appear in the Digital Twin — indistinguishable from "the device has not
    // synced yet". A silently absent field is worse than a wrong one, because
    // nothing looks broken. The family's calendar decides the day, exactly as
    // `digital-wellbeing-engine.service.ts:todayColumn(familyId)` already does.
    let todaysPatterns: string[] | undefined;
    let baselineDeviationPercent: number | null | undefined;
    try {
      const today = await this.familyDate.getBusinessDate(familyId);
      const insight = await this.digitalWellbeing.getWellbeingInsight(childId, familyId, today);
      if (insight) {
        todaysPatterns = insight.patterns.map((p) => p.code);
        baselineDeviationPercent = insight.baselineDeviationPercent;
      }
    } catch {
      // Best-effort, see comment above — score/other inputs still
      // return normally.
    }

    return {
      score,
      inputs: {
        totalBlockedAttempts: summary.totalBlockedAttempts,
        averageDailyScreenMinutes: summary.averageDailyScreenMinutes,
        averagePickups: summary.averagePickups,
        averageNightUsageMinutes: summary.averageNightUsageMinutes,
        windowDays: summary.windowDays,
        ...(todaysPatterns !== undefined && { todaysPatterns }),
        ...(baselineDeviationPercent !== undefined && { baselineDeviationPercent }),
      },
      confidence: summary.daysWithData >= 7 ? 'HIGH' : summary.daysWithData >= 3 ? 'MEDIUM' : 'LOW',
    };
  }

  /** A child with no paired device yet (early onboarding) genuinely
   * has no Safety/Behavior data — `null` is the honest answer, not a
   * fallback score. If a child ever has more than one device, the
   * most recently active one is used; averaging risk across a
   * retired and an active device has no clear real meaning, so this
   * doesn't attempt it. */
  private async findPrimaryDeviceId(childId: string, familyId: string): Promise<string | null> {
    const devices = await this.pairingOrchestrator.listFamilyDevices(familyId);
    const childDevices = devices.filter((d) => d.childId === childId);
    if (childDevices.length === 0) return null;

    const mostRecent = childDevices.reduce((latest, d) => {
      if (!latest.lastSeenAt) return d;
      if (!d.lastSeenAt) return latest;
      return d.lastSeenAt > latest.lastSeenAt ? d : latest;
    });
    return mostRecent.id;
  }

  private async computeSafetyAndBehavior(
    childId: string,
    familyId: string,
    deviceId: string | null,
  ): Promise<{ safety: IExplainableSubScore | null; behavior: IExplainableSubScore | null }> {
    if (!deviceId) {
      return { safety: null, behavior: null };
    }

    const [riskAssessment, behavioralTrend] = await Promise.all([
      this.riskEvaluation.getLatestRiskAssessment(deviceId),
      this.behavioralEngine.computeTrend(deviceId, childId, familyId),
    ]);

    const safety: IExplainableSubScore | null = riskAssessment
      ? {
          score: mapRiskToSafetyScore(riskAssessment.overallRisk),
          inputs: { overallRisk: riskAssessment.overallRisk, overallLevel: riskAssessment.overallLevel, reasons: riskAssessment.reasons },
          confidence: 'HIGH', // RiskEvaluationService's own getSignals() reasoning: an exact, deterministic calculation, not an inference
        }
      : null; // no assessment has ever run for this device — honest null, not a fabricated "safe" default

    const behaviorScore = mapBehavioralTrendToScore(behavioralTrend.riskTrend);
    const behavior: IExplainableSubScore | null = behaviorScore !== null
      ? {
          score: behaviorScore,
          inputs: { riskTrend: behavioralTrend.riskTrend, riskAssessmentCount: behavioralTrend.riskAssessmentCount, trustChangeCount: behavioralTrend.trustChangeCount, summary: behavioralTrend.summary },
          confidence: behavioralTrend.riskAssessmentCount >= 5 ? 'HIGH' : 'MEDIUM',
        }
      : null;

    return { safety, behavior };
  }

  private async daysAgo(familyId: string, days: number): Promise<Date> {
    const tz = await this.familyDate.timeZoneOf(familyId);
    return FamilyDateService.toDateColumn(
      FamilyDateService.addDays(getBusinessDate(new Date(), tz), -days),
    );
  }
}
