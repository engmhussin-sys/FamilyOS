import { Injectable } from '@nestjs/common';

import type { BehaviorPatternCode } from '../../domain/digital-wellbeing.types';

export interface IAnomalyResult {
  code: BehaviorPatternCode;
  consecutiveDays: number;
  isEscalated: boolean;
  explanation: string;
}

const ESCALATION_THRESHOLD_DAYS = 3;

/**
 * Sprint 14 (Behavioral Intelligence Engine) — CLOSES A REAL GAP: the
 * brief's own explicit formula — "baseline + deviation + duration +
 * recurrence + context = anomaly confidence" — names RECURRENCE as a
 * real, distinct dimension PatternDetectionService alone doesn't
 * cover (that service reasons about ONE day at a time). This is that
 * missing dimension: the SAME pattern code appearing on multiple
 * CONSECUTIVE recent days is a materially different, stronger signal
 * than a single one-off day — the brief's own worked example ("Night
 * usage increased 180% for 4 consecutive days") is exactly this.
 *
 * Deliberately simple and inspectable — counts consecutive days a
 * pattern code appears in the recent history array, most-recent-first.
 * No LLM, no black-box scoring.
 */
@Injectable()
export class AnomalyDetectionService {
  /** recentPatternsByDay is ordered MOST RECENT FIRST (today at
   * index 0) — each entry is the set of pattern codes detected that
   * day. Returns one IAnomalyResult per pattern code present today,
   * with how many consecutive days (including today) it has recurred. */
  detectRecurrence(recentPatternsByDay: BehaviorPatternCode[][]): IAnomalyResult[] {
    if (recentPatternsByDay.length === 0) return [];

    const today = recentPatternsByDay[0];
    const results: IAnomalyResult[] = [];

    for (const code of today) {
      let consecutiveDays = 0;
      for (const dayPatterns of recentPatternsByDay) {
        if (dayPatterns.includes(code)) {
          consecutiveDays++;
        } else {
          break;
        }
      }

      const isEscalated = consecutiveDays >= ESCALATION_THRESHOLD_DAYS;
      results.push({
        code,
        consecutiveDays,
        isEscalated,
        explanation: this.buildExplanation(code, consecutiveDays, isEscalated),
      });
    }

    return results;
  }

  private buildExplanation(code: BehaviorPatternCode, consecutiveDays: number, isEscalated: boolean): string {
    const readableCode = code.replace(/_/g, ' ').toLowerCase();
    if (consecutiveDays === 1) {
      return `${readableCode} detected today — a single occurrence, not yet a recurring pattern.`;
    }
    const escalationNote = isEscalated ? ' — this has now recurred enough days in a row to be worth real attention.' : '.';
    return `${readableCode} has now occurred for ${consecutiveDays} consecutive days${escalationNote}`;
  }
}
