import { PatternDetectionService, type ITodayUsageForDetection } from '../../src/modules/life-intelligence/application/services/pattern-detection.service';
import type { IChildBaseline } from '../../src/modules/life-intelligence/domain/digital-wellbeing.types';

describe('PatternDetectionService (Sprint 14) — pure, deterministic, no LLM', () => {
  let service: PatternDetectionService;

  beforeEach(() => {
    service = new PatternDetectionService();
  });

  const baseline: IChildBaseline = {
    childId: 'child-1',
    daysOfHistory: 14,
    averageScreenMinutes: 200,
    averageGamingMinutes: 50,
    averageSocialMinutes: 30,
    averageEducationMinutes: 40,
    averageEntertainmentMinutes: 20,
    averageNightUsageMinutes: 10,
    averagePickups: 40,
  };

  function normalDay(overrides: Partial<ITodayUsageForDetection> = {}): ITodayUsageForDetection {
    return {
      totalScreenMinutes: 200,
      gamingMinutes: 50,
      socialMinutes: 30,
      educationMinutes: 40,
      nightUsageMinutes: 10,
      sessionCount: 10,
      averageSessionMinutes: 15,
      longestSessionMinutes: 30,
      isWeekend: false,
      ...overrides,
    };
  }

  it('BOUNDARY CASE (brief-required): new child with no baseline (null) produces ZERO patterns', () => {
    const result = service.detect(normalDay(), null);
    expect(result).toEqual([]);
  });

  it('a perfectly average day produces no negative patterns', () => {
    const result = service.detect(normalDay(), baseline);
    expect(result.filter((p) => !p.isPositive)).toEqual([]);
  });

  describe('EXCESSIVE_USAGE', () => {
    it('detects screen time 40%+ above baseline on a weekday', () => {
      const result = service.detect(normalDay({ totalScreenMinutes: 300 }), baseline);
      const pattern = result.find((p) => p.code === 'EXCESSIVE_USAGE');
      expect(pattern).toBeDefined();
      expect(pattern!.explanation).toContain('300 min');
      expect(pattern!.explanation).toContain('200 min');
    });

    it('does NOT fire below the 40% threshold', () => {
      const result = service.detect(normalDay({ totalScreenMinutes: 260 }), baseline);
      expect(result.find((p) => p.code === 'EXCESSIVE_USAGE')).toBeUndefined();
    });
  });

  describe('WEEKEND_SHIFT — deliberately NOT treated as risk', () => {
    it('reclassifies an excessive-usage-sized deviation as WEEKEND_SHIFT on a weekend, never EXCESSIVE_USAGE', () => {
      const result = service.detect(normalDay({ totalScreenMinutes: 300, isWeekend: true }), baseline);
      expect(result.find((p) => p.code === 'WEEKEND_SHIFT')).toBeDefined();
      expect(result.find((p) => p.code === 'EXCESSIVE_USAGE')).toBeUndefined();
    });
  });

  describe('NIGHT_USAGE_INCREASE', () => {
    it('detects a 20+ minute increase over baseline night usage', () => {
      const result = service.detect(normalDay({ nightUsageMinutes: 35 }), baseline);
      const pattern = result.find((p) => p.code === 'NIGHT_USAGE_INCREASE');
      expect(pattern).toBeDefined();
      expect(pattern!.explanation).toContain('35 min');
    });
  });

  describe('GAMING_SPIKE / SOCIAL_SPIKE', () => {
    it('detects gaming 60%+ above baseline', () => {
      const result = service.detect(normalDay({ gamingMinutes: 90 }), baseline);
      expect(result.find((p) => p.code === 'GAMING_SPIKE')).toBeDefined();
    });

    it('detects social 60%+ above baseline', () => {
      const result = service.detect(normalDay({ socialMinutes: 55 }), baseline);
      expect(result.find((p) => p.code === 'SOCIAL_SPIKE')).toBeDefined();
    });
  });

  describe('STUDY_DECLINE', () => {
    it('detects education time 30%+ below baseline', () => {
      const result = service.detect(normalDay({ educationMinutes: 20 }), baseline);
      expect(result.find((p) => p.code === 'STUDY_DECLINE')).toBeDefined();
    });

    it('does NOT fire when baseline education is already 0', () => {
      const zeroEducationBaseline = { ...baseline, averageEducationMinutes: 0 };
      const result = service.detect(normalDay({ educationMinutes: 0 }), zeroEducationBaseline);
      expect(result.find((p) => p.code === 'STUDY_DECLINE')).toBeUndefined();
    });
  });

  describe('FRAGMENTED_ATTENTION', () => {
    it('detects many short sessions', () => {
      const result = service.detect(normalDay({ sessionCount: 30, averageSessionMinutes: 2 }), baseline);
      expect(result.find((p) => p.code === 'FRAGMENTED_ATTENTION')).toBeDefined();
    });

    it('BOUNDARY CASE: missing session data (null) never fires this pattern', () => {
      const result = service.detect(normalDay({ sessionCount: null, averageSessionMinutes: null }), baseline);
      expect(result.find((p) => p.code === 'FRAGMENTED_ATTENTION')).toBeUndefined();
    });
  });

  describe('LONG_SESSION', () => {
    it('detects a single session 90+ minutes', () => {
      const result = service.detect(normalDay({ longestSessionMinutes: 120 }), baseline);
      expect(result.find((p) => p.code === 'LONG_SESSION')).toBeDefined();
    });

    it('BOUNDARY CASE: missing longestSessionMinutes (null) never fires this pattern', () => {
      const result = service.detect(normalDay({ longestSessionMinutes: null }), baseline);
      expect(result.find((p) => p.code === 'LONG_SESSION')).toBeUndefined();
    });
  });

  describe('HEALTHY_PATTERN', () => {
    it('fires when education held steady and screen time is not elevated', () => {
      const result = service.detect(normalDay({ educationMinutes: 45, totalScreenMinutes: 190 }), baseline);
      const pattern = result.find((p) => p.code === 'HEALTHY_PATTERN');
      expect(pattern).toBeDefined();
      expect(pattern!.isPositive).toBe(true);
    });

    it('does NOT fire when screen time is elevated even if education is fine', () => {
      const result = service.detect(normalDay({ educationMinutes: 45, totalScreenMinutes: 350 }), baseline);
      expect(result.find((p) => p.code === 'HEALTHY_PATTERN')).toBeUndefined();
    });
  });

  it('every pattern has a real, non-empty, human-readable explanation — never a placeholder', () => {
    const result = service.detect(
      normalDay({ totalScreenMinutes: 400, nightUsageMinutes: 60, gamingMinutes: 150 }),
      baseline,
    );
    expect(result.length).toBeGreaterThan(0);
    for (const pattern of result) {
      expect(pattern.explanation.length).toBeGreaterThan(10);
      expect(pattern.explanation).not.toContain('AI says');
      expect(pattern.confidence).toBeGreaterThanOrEqual(0);
      expect(pattern.confidence).toBeLessThanOrEqual(1);
    }
  });

  it('BOUNDARY CASE: baseline of exactly 0 for a category never produces Infinity/NaN', () => {
    const zeroBaseline: IChildBaseline = { ...baseline, averageGamingMinutes: 0, averageSocialMinutes: 0 };
    const result = service.detect(normalDay({ gamingMinutes: 30, socialMinutes: 20 }), zeroBaseline);
    for (const pattern of result) {
      expect(Number.isFinite(pattern.confidence)).toBe(true);
      expect(pattern.explanation).not.toContain('NaN');
      expect(pattern.explanation).not.toContain('Infinity');
    }
  });
});
