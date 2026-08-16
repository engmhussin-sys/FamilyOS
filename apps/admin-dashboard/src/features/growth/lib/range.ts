export type RangePreset = 'last7' | 'last30' | 'last90';

export const RANGE_PRESETS: readonly RangePreset[] = ['last7', 'last30', 'last90'] as const;

const DAYS: Record<RangePreset, number> = { last7: 7, last30: 30, last90: 90 };

export interface DateRange {
  from: string;
  to: string;
}

/**
 * The window every growth query is scoped by.
 *
 * Deliberately ends at `now` and lets the BACKEND decide the business-day
 * boundary: day boundaries are computed on the country's own calendar
 * (`Africa/Cairo`, `Asia/Riyadh`) from tzdata, and Egypt reintroduced DST in
 * 2023 — a browser-side "midnight" would silently disagree with the stored
 * `reportingTimeZone` on the rows it is asking for.
 */
export function rangeFor(preset: RangePreset, now: Date = new Date()): DateRange {
  const to = new Date(now);
  const from = new Date(now);
  from.setUTCDate(from.getUTCDate() - DAYS[preset]);
  return { from: from.toISOString(), to: to.toISOString() };
}

/** Trailing calendar days as `YYYY-MM-DD`, for labelling a daily series. */
export function businessDateLabel(isoDate: string): string {
  return isoDate.slice(0, 10);
}
