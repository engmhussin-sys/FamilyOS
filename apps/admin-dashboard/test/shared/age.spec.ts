import { describe, expect, it } from 'vitest';
import { calculateAge } from '@/shared/lib/age';

describe('calculateAge', () => {
  it('calculates a straightforward age when the birthday has already passed this year', () => {
    expect(calculateAge('2015-03-01', new Date('2026-07-28'))).toBe(11);
  });

  it('does not count this year yet when the birthday has not happened', () => {
    expect(calculateAge('2015-12-25', new Date('2026-07-28'))).toBe(10);
  });

  it('counts the birthday itself as already turned', () => {
    expect(calculateAge('2015-07-28', new Date('2026-07-28'))).toBe(11);
  });

  it('handles the day before a birthday correctly', () => {
    expect(calculateAge('2015-07-29', new Date('2026-07-28'))).toBe(10);
  });
});
