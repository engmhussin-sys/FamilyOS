import { computeCurrentStreak } from '../../src/modules/life-intelligence/application/services/streak-calculator';

describe('computeCurrentStreak (Sprint 15 — CLOSES A REAL GAP: no streak logic existed anywhere before this)', () => {
  it('BOUNDARY CASE: no qualifying days at all returns 0', () => {
    expect(computeCurrentStreak([], '2026-08-10')).toBe(0);
  });

  it('a single qualifying day (today) returns a streak of 1', () => {
    expect(computeCurrentStreak(['2026-08-10'], '2026-08-10')).toBe(1);
  });

  it('counts consecutive days correctly ending today', () => {
    const days = ['2026-08-08', '2026-08-09', '2026-08-10'];
    expect(computeCurrentStreak(days, '2026-08-10')).toBe(3);
  });

  it('CRITICAL: a gap breaks the streak — only counts back from asOfDate until the first missing day', () => {
    // 08-07 and 08-08 qualify, but 08-09 is MISSING, then 08-10 qualifies.
    // The streak as of 08-10 must be 1 (just today), not 3 — the gap
    // on 08-09 breaks continuity even though earlier days qualified.
    const days = ['2026-08-07', '2026-08-08', '2026-08-10'];
    expect(computeCurrentStreak(days, '2026-08-10')).toBe(1);
  });

  it('today NOT qualifying returns a streak of 0, even with a long prior streak', () => {
    const days = ['2026-08-07', '2026-08-08', '2026-08-09'];
    expect(computeCurrentStreak(days, '2026-08-10')).toBe(0);
  });

  it('handles duplicate dates in the input without over-counting', () => {
    const days = ['2026-08-10', '2026-08-10', '2026-08-09'];
    expect(computeCurrentStreak(days, '2026-08-10')).toBe(2);
  });

  it('is order-independent — works the same regardless of input array order', () => {
    const inOrder = ['2026-08-08', '2026-08-09', '2026-08-10'];
    const reversed = ['2026-08-10', '2026-08-09', '2026-08-08'];
    expect(computeCurrentStreak(inOrder, '2026-08-10')).toBe(computeCurrentStreak(reversed, '2026-08-10'));
  });

  it('BOUNDARY CASE: correctly crosses a month boundary', () => {
    const days = ['2026-07-30', '2026-07-31', '2026-08-01'];
    expect(computeCurrentStreak(days, '2026-08-01')).toBe(3);
  });

  it('a real 7-day streak (the exact milestone this Sprint explicitly references) computes correctly', () => {
    const days = ['2026-08-04', '2026-08-05', '2026-08-06', '2026-08-07', '2026-08-08', '2026-08-09', '2026-08-10'];
    expect(computeCurrentStreak(days, '2026-08-10')).toBe(7);
  });
});
