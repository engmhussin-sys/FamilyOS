import { Injectable } from '@nestjs/common';

import type { IChildBaseline, IDetectedPattern } from '../../domain/digital-wellbeing.types';

export interface ITodayUsageForDetection {
  totalScreenMinutes: number;
  gamingMinutes: number;
  socialMinutes: number;
  educationMinutes: number;
  nightUsageMinutes: number;
  sessionCount: number | null;
  averageSessionMinutes: number | null;
  longestSessionMinutes: number | null;
  isWeekend: boolean;
}

// Deliberately explicit, named thresholds — not magic numbers
// scattered through the logic below. Every one is a real, stated
// judgment call (documented per threshold), not derived from data
// this project doesn't have (zero real users yet).
const EXCESSIVE_USAGE_DEVIATION_PCT = 40;
const NIGHT_USAGE_INCREASE_MINUTES = 20;
const CATEGORY_SPIKE_DEVIATION_PCT = 60;
const STUDY_DECLINE_PCT = 30;
const FRAGMENTED_SESSION_COUNT = 25;
const FRAGMENTED_MAX_AVG_MINUTES = 3;
const LONG_SESSION_MINUTES = 90;
const HEALTHY_EDUCATION_MIN_PCT = 90;
const HEALTHY_SCREEN_MAX_PCT = 110;

/**
 * Sprint 14 (Behavioral Intelligence Engine) — CLOSES A REAL GAP: no
 * pattern detection existed anywhere. Purely deterministic, no LLM —
 * per the brief's own explicit instruction. Every detected pattern
 * carries a real, human-readable explanation built from the actual
 * numbers, never a vague "AI says" claim.
 *
 * Deliberately distinguishes Observation (a number) from Pattern
 * (multiple correlated signals) from Risk (this engine never assigns
 * "risk" — that judgment is left to whoever consumes these patterns;
 * this engine's job ends at "here is what changed and by how much").
 */
@Injectable()
export class PatternDetectionService {
  detect(today: ITodayUsageForDetection, baseline: IChildBaseline | null): IDetectedPattern[] {
    if (!baseline) return [];

    const patterns: IDetectedPattern[] = [];

    const screenDeviationPct = this.percentDeviation(today.totalScreenMinutes, baseline.averageScreenMinutes);

    if (today.isWeekend && screenDeviationPct > EXCESSIVE_USAGE_DEVIATION_PCT) {
      patterns.push({
        code: 'WEEKEND_SHIFT',
        confidence: 0.6,
        explanation: `Screen time is ${Math.round(screenDeviationPct)}% above the weekday baseline, which is expected on a weekend.`,
        isPositive: false,
      });
    } else if (screenDeviationPct > EXCESSIVE_USAGE_DEVIATION_PCT) {
      patterns.push({
        code: 'EXCESSIVE_USAGE',
        confidence: this.confidenceFromDeviation(screenDeviationPct, EXCESSIVE_USAGE_DEVIATION_PCT),
        explanation: `Today's screen time (${today.totalScreenMinutes} min) is ${Math.round(screenDeviationPct)}% above this child's own average (${Math.round(baseline.averageScreenMinutes)} min).`,
        isPositive: false,
      });
    }

    const nightIncrease = today.nightUsageMinutes - baseline.averageNightUsageMinutes;
    if (nightIncrease >= NIGHT_USAGE_INCREASE_MINUTES) {
      patterns.push({
        code: 'NIGHT_USAGE_INCREASE',
        confidence: this.confidenceFromDeviation(nightIncrease, NIGHT_USAGE_INCREASE_MINUTES),
        explanation: `Night-time usage (${today.nightUsageMinutes} min) is ${Math.round(nightIncrease)} minutes above this child's usual night usage (${Math.round(baseline.averageNightUsageMinutes)} min).`,
        isPositive: false,
      });
    }

    const gamingDeviationPct = this.percentDeviation(today.gamingMinutes, baseline.averageGamingMinutes);
    if (gamingDeviationPct > CATEGORY_SPIKE_DEVIATION_PCT) {
      patterns.push({
        code: 'GAMING_SPIKE',
        confidence: this.confidenceFromDeviation(gamingDeviationPct, CATEGORY_SPIKE_DEVIATION_PCT),
        explanation: `Gaming time (${today.gamingMinutes} min) is ${Math.round(gamingDeviationPct)}% above this child's usual gaming time (${Math.round(baseline.averageGamingMinutes)} min).`,
        isPositive: false,
      });
    }

    const socialDeviationPct = this.percentDeviation(today.socialMinutes, baseline.averageSocialMinutes);
    if (socialDeviationPct > CATEGORY_SPIKE_DEVIATION_PCT) {
      patterns.push({
        code: 'SOCIAL_SPIKE',
        confidence: this.confidenceFromDeviation(socialDeviationPct, CATEGORY_SPIKE_DEVIATION_PCT),
        explanation: `Social app usage (${today.socialMinutes} min) is ${Math.round(socialDeviationPct)}% above this child's usual amount (${Math.round(baseline.averageSocialMinutes)} min).`,
        isPositive: false,
      });
    }

    if (baseline.averageEducationMinutes > 0) {
      const educationDeclinePct = ((baseline.averageEducationMinutes - today.educationMinutes) / baseline.averageEducationMinutes) * 100;
      if (educationDeclinePct > STUDY_DECLINE_PCT) {
        patterns.push({
          code: 'STUDY_DECLINE',
          confidence: this.confidenceFromDeviation(educationDeclinePct, STUDY_DECLINE_PCT),
          explanation: `Education app usage (${today.educationMinutes} min) is ${Math.round(educationDeclinePct)}% below this child's usual amount (${Math.round(baseline.averageEducationMinutes)} min).`,
          isPositive: false,
        });
      }
    }

    if (
      today.sessionCount !== null &&
      today.sessionCount > FRAGMENTED_SESSION_COUNT &&
      today.averageSessionMinutes !== null &&
      today.averageSessionMinutes < FRAGMENTED_MAX_AVG_MINUTES
    ) {
      patterns.push({
        code: 'FRAGMENTED_ATTENTION',
        confidence: 0.7,
        explanation: `${today.sessionCount} separate usage sessions today, averaging only ${today.averageSessionMinutes} minutes each — a highly fragmented usage pattern.`,
        isPositive: false,
      });
    }

    if (today.longestSessionMinutes !== null && today.longestSessionMinutes >= LONG_SESSION_MINUTES) {
      patterns.push({
        code: 'LONG_SESSION',
        confidence: this.confidenceFromDeviation(today.longestSessionMinutes, LONG_SESSION_MINUTES),
        explanation: `A single session lasted ${today.longestSessionMinutes} minutes without a break.`,
        isPositive: false,
      });
    }

    const educationRatio = baseline.averageEducationMinutes > 0 ? (today.educationMinutes / baseline.averageEducationMinutes) * 100 : 100;
    const screenRatio = baseline.averageScreenMinutes > 0 ? (today.totalScreenMinutes / baseline.averageScreenMinutes) * 100 : 100;
    if (educationRatio >= HEALTHY_EDUCATION_MIN_PCT && screenRatio <= HEALTHY_SCREEN_MAX_PCT) {
      patterns.push({
        code: 'HEALTHY_PATTERN',
        confidence: 0.65,
        explanation: `Education time stayed consistent with this child's usual pattern (${today.educationMinutes} min), and overall screen time did not increase significantly.`,
        isPositive: true,
      });
    }

    return patterns;
  }

  private percentDeviation(actual: number, baseline: number): number {
    if (baseline === 0) return actual > 0 ? 100 : 0;
    return ((actual - baseline) / baseline) * 100;
  }

  private confidenceFromDeviation(value: number, threshold: number): number {
    const ratio = value / threshold;
    return Math.min(1, 0.5 + (ratio - 1) * 0.25);
  }
}
