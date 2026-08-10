import { Injectable } from '@nestjs/common';

import { PrismaDigitalWellbeingRepository } from '../../infrastructure/repositories/prisma-digital-wellbeing.repository';
import type { IChildBaseline } from '../../domain/digital-wellbeing.types';

const BASELINE_WINDOW_DAYS = 14;
const MIN_DAYS_FOR_BASELINE = 2;

/**
 * Sprint 14 (Behavioral Intelligence Engine) — CLOSES A REAL GAP: no
 * baseline mechanism existed. The brief's own core requirement,
 * stated plainly: "no fixed rules like 'more than 2 hours = risk' —
 * each child has their own baseline." Computed from a ROLLING window
 * of this specific child's own real history (DailyBehavioralSnapshot
 * rows), recalculated fresh on every call rather than cached/stored —
 * per the "don't create a table if you don't need one" discipline: a
 * simple average over at most 14 rows is cheap enough to compute on
 * demand, and a stored baseline risks silently going stale if the
 * recalculation trigger is ever missed.
 */
@Injectable()
export class BaselineCalculatorService {
  constructor(private readonly repository: PrismaDigitalWellbeingRepository) {}

  /** Returns null for a child with too little history to form a
   * meaningful baseline (a single day is not a "pattern," it's just
   * one data point) — the brief's own "new child with no history"
   * test case, handled by returning null rather than a baseline
   * computed from an unrepresentative sample of one. */
  async compute(childId: string, asOfDate: Date = new Date()): Promise<IChildBaseline | null> {
    const windowStart = new Date(asOfDate);
    windowStart.setDate(windowStart.getDate() - BASELINE_WINDOW_DAYS);

    const snapshots = await this.repository.findSnapshotsInWindow(childId, windowStart);
    // Exclude the day being evaluated itself, if present — a
    // baseline must never include the very day it's about to be
    // compared against, or "today" would always look partially like
    // its own baseline.
    const asOfDateStr = asOfDate.toISOString().split('T')[0];
    const historyOnly = snapshots.filter((s) => s.usageDate.toISOString().split('T')[0] !== asOfDateStr);

    if (historyOnly.length < MIN_DAYS_FOR_BASELINE) {
      return null;
    }

    const avg = (values: number[]): number => (values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length);

    return {
      childId,
      daysOfHistory: historyOnly.length,
      averageScreenMinutes: avg(historyOnly.map((s) => s.totalScreenMinutes)),
      averageGamingMinutes: avg(historyOnly.map((s) => s.gamingMinutes ?? 0)),
      averageSocialMinutes: avg(historyOnly.map((s) => s.socialMinutes ?? 0)),
      averageEducationMinutes: avg(historyOnly.map((s) => s.educationMinutes ?? 0)),
      averageEntertainmentMinutes: avg(historyOnly.map((s) => s.entertainmentMinutes ?? 0)),
      averageNightUsageMinutes: avg(historyOnly.map((s) => s.nightUsageMinutes)),
      averagePickups: avg(historyOnly.map((s) => s.pickupCount)),
    };
  }
}
