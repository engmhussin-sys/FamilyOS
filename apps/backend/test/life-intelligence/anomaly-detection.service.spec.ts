import { AnomalyDetectionService } from '../../src/modules/life-intelligence/application/services/anomaly-detection.service';
import type { BehaviorPatternCode } from '../../src/modules/life-intelligence/domain/digital-wellbeing.types';

describe('AnomalyDetectionService (Sprint 14) — recurrence layer', () => {
  let service: AnomalyDetectionService;

  beforeEach(() => {
    service = new AnomalyDetectionService();
  });

  it('BOUNDARY CASE: empty history returns empty array, never crashes', () => {
    expect(service.detectRecurrence([])).toEqual([]);
  });

  it('a single-day occurrence is NOT escalated', () => {
    const result = service.detectRecurrence([['NIGHT_USAGE_INCREASE'] as BehaviorPatternCode[]]);
    expect(result[0].consecutiveDays).toBe(1);
    expect(result[0].isEscalated).toBe(false);
    expect(result[0].explanation).toContain('single occurrence');
  });

  it("brief's OWN worked example: night usage increased for 4 consecutive days is escalated", () => {
    const history: BehaviorPatternCode[][] = [
      ['NIGHT_USAGE_INCREASE'],
      ['NIGHT_USAGE_INCREASE'],
      ['NIGHT_USAGE_INCREASE'],
      ['NIGHT_USAGE_INCREASE'],
    ];
    const result = service.detectRecurrence(history);
    expect(result[0].consecutiveDays).toBe(4);
    expect(result[0].isEscalated).toBe(true);
    expect(result[0].explanation).toContain('4 consecutive days');
  });

  it('stops counting at the FIRST day the pattern is absent — a broken streak, not a total count', () => {
    const history: BehaviorPatternCode[][] = [
      ['GAMING_SPIKE'],
      ['GAMING_SPIKE'],
      [],
      ['GAMING_SPIKE'],
    ];
    const result = service.detectRecurrence(history);
    expect(result[0].consecutiveDays).toBe(2);
  });

  it('escalation threshold is exactly 3 consecutive days', () => {
    const twoDay = service.detectRecurrence([['LONG_SESSION'], ['LONG_SESSION']] as BehaviorPatternCode[][]);
    expect(twoDay[0].isEscalated).toBe(false);

    const threeDay = service.detectRecurrence([['LONG_SESSION'], ['LONG_SESSION'], ['LONG_SESSION']] as BehaviorPatternCode[][]);
    expect(threeDay[0].isEscalated).toBe(true);
  });

  it('tracks multiple different patterns independently on the same day', () => {
    const history: BehaviorPatternCode[][] = [
      ['GAMING_SPIKE', 'NIGHT_USAGE_INCREASE'],
      ['GAMING_SPIKE'],
    ];
    const result = service.detectRecurrence(history);
    const gaming = result.find((r) => r.code === 'GAMING_SPIKE');
    const night = result.find((r) => r.code === 'NIGHT_USAGE_INCREASE');
    expect(gaming!.consecutiveDays).toBe(2);
    expect(night!.consecutiveDays).toBe(1);
  });

  it('a day with zero patterns returns an empty array', () => {
    const result = service.detectRecurrence([[], ['GAMING_SPIKE']] as BehaviorPatternCode[][]);
    expect(result).toEqual([]);
  });
});
