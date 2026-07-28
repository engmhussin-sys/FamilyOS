import { calculateAge } from '../../src/common/utils/age';

describe('calculateAge', () => {
  it('calculates age when the birthday already passed this year', () => {
    expect(calculateAge(new Date('2015-03-01'), new Date('2026-07-28'))).toBe(11);
  });

  it('does not count this year yet when the birthday has not happened', () => {
    expect(calculateAge(new Date('2015-12-25'), new Date('2026-07-28'))).toBe(10);
  });

  it('counts the birthday itself as already turned', () => {
    expect(calculateAge(new Date('2015-07-28'), new Date('2026-07-28'))).toBe(11);
  });
});
