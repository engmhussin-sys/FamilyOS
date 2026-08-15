/**
 * B2 (PA-B-001) — THE TIMEZONE MATRIX.
 *
 * Phase A §6.6 made a specific, non-negotiable demand of any implementation:
 * ">= 21 cases", covering `Africa/Cairo`, `Asia/Riyadh` and `UTC` at 23:59->00:00,
 * at 00:30 local (the three-hour window that was broken), at 12:00 local (the
 * control), across BOTH Egyptian DST transitions, `maxPerDay` on either side of
 * local midnight, and a streak spanning a DST boundary.
 *
 * It also made a demand about HOW: "DST rules are read from tzdata AT RUNTIME
 * and never pinned as an offset. Egypt changed its rules TWICE in a decade; any
 * `UTC+2` written into the code will be wrong twice a year."
 *
 * This file honours the second demand literally. It contains no offset
 * constants and no hardcoded transition dates. The transitions are DISCOVERED
 * from the runtime's own tz database by `findTransitions` below, and then
 * asserted against. If tzdata is updated and Egypt moves its transition again,
 * these tests follow it; if Egypt ABOLISHES DST again (as it did in 2014), the
 * first assertion in the DST block fails loudly and tells the reader that the
 * world changed rather than the code.
 */
import {
  DEFAULT_FAMILY_TIMEZONE,
  addBusinessDays,
  businessAgeInYears,
  businessDateDaysAgo,
  canonicalTimeZone,
  getBusinessDate,
  getBusinessDayOfWeek,
  getBusinessDayRange,
  getBusinessTimeHHMM,
  getEndOfBusinessDay,
  getStartOfBusinessDay,
  isSameBusinessDay,
  isValidTimeZone,
  resolveTimeZone,
  timeZoneOffsetMs,
} from '../../src/common/time/family-date';
import { computeCurrentStreak } from '../../src/modules/life-intelligence/application/services/streak-calculator';

const CAIRO = 'Africa/Cairo';
const RIYADH = 'Asia/Riyadh';
const HOUR = 3_600_000;

/** Every UTC instant in `year` at which `timeZone`'s offset changes. Read from
 * the runtime's tz database, never assumed. */
function findTransitions(timeZone: string, year: number): Array<{ at: Date; fromHours: number; toHours: number }> {
  const out: Array<{ at: Date; fromHours: number; toHours: number }> = [];
  let previous = timeZoneOffsetMs(new Date(Date.UTC(year, 0, 1)), timeZone);
  for (let t = Date.UTC(year, 0, 1); t < Date.UTC(year + 1, 0, 1); t += HOUR) {
    const offset = timeZoneOffsetMs(new Date(t), timeZone);
    if (offset !== previous) {
      out.push({ at: new Date(t), fromHours: previous / HOUR, toHours: offset / HOUR });
      previous = offset;
    }
  }
  return out;
}

describe('B2 — the family business date', () => {
  // =========================================================================
  // 1. TIMEZONE VALIDATION
  // =========================================================================
  describe('timezone validation', () => {
    it('accepts the zones this product actually launches in', () => {
      expect(isValidTimeZone(CAIRO)).toBe(true);
      expect(isValidTimeZone(RIYADH)).toBe(true);
      expect(isValidTimeZone('UTC')).toBe(true);
    });

    it('REJECTS a fixed UTC offset — it cannot follow a DST rule change', () => {
      expect(isValidTimeZone('+03:00')).toBe(false);
      expect(isValidTimeZone('-0500')).toBe(false);
      expect(isValidTimeZone('02:00')).toBe(false);
    });

    it('rejects garbage instead of silently storing it', () => {
      expect(isValidTimeZone('Not/AZone')).toBe(false);
      expect(isValidTimeZone('')).toBe(false);
      expect(isValidTimeZone(null)).toBe(false);
      expect(isValidTimeZone(42)).toBe(false);
    });

    it('canonicalises tzdata links, so what is stored is what tzdata looks up', () => {
      expect(canonicalTimeZone('egypt')).toBe(CAIRO);
      expect(canonicalTimeZone('africa/cairo')).toBe(CAIRO);
    });

    it('degrades to the schema default rather than throwing on a hot path', () => {
      expect(resolveTimeZone('nonsense')).toBe(DEFAULT_FAMILY_TIMEZONE);
      expect(resolveTimeZone(undefined)).toBe(DEFAULT_FAMILY_TIMEZONE);
      expect(DEFAULT_FAMILY_TIMEZONE).toBe('UTC');
    });
  });

  // =========================================================================
  // 2. THE MATRIX — the same instant, three calendars
  // =========================================================================
  describe('the matrix: one instant, three family calendars', () => {
    it('12:00 UTC — the CONTROL: every zone agrees, so a passing control proves the rest is not noise', () => {
      const noon = '2026-08-15T12:00:00.000Z';
      expect(getBusinessDate(noon, 'UTC')).toBe('2026-08-15');
      expect(getBusinessDate(noon, CAIRO)).toBe('2026-08-15');
      expect(getBusinessDate(noon, RIYADH)).toBe('2026-08-15');
    });

    it('21:30 UTC in summer — UTC midnight is still yesterday LOCALLY in neither market: both are already tomorrow', () => {
      const instant = '2026-08-15T21:30:00.000Z';
      expect(getBusinessDate(instant, 'UTC')).toBe('2026-08-15');
      expect(getBusinessDate(instant, CAIRO)).toBe('2026-08-16'); // 00:30 EEST
      expect(getBusinessDate(instant, RIYADH)).toBe('2026-08-16'); // 00:30 +03
      expect(getBusinessTimeHHMM(instant, CAIRO)).toBe('00:30');
      expect(getBusinessTimeHHMM(instant, RIYADH)).toBe('00:30');
    });

    it('THE BROKEN WINDOW, measured: 21:00-23:59 UTC is the NEXT local day in both markets', () => {
      const brokenHours = ['21:00', '22:00', '23:00', '23:59'];
      for (const hhmm of brokenHours) {
        const instant = `2026-08-15T${hhmm}:00.000Z`;
        expect(getBusinessDate(instant, 'UTC')).toBe('2026-08-15');
        expect(getBusinessDate(instant, CAIRO)).toBe('2026-08-16');
        expect(getBusinessDate(instant, RIYADH)).toBe('2026-08-16');
      }
      // 20:59 is NOT in the window — the boundary is exact, not approximate.
      expect(getBusinessDate('2026-08-15T20:59:00.000Z', CAIRO)).toBe('2026-08-15');
    });

    it('WINTER in Cairo is a DIFFERENT window (22:00, not 21:00) — because the offset is read, not assumed', () => {
      expect(getBusinessDate('2026-01-15T21:30:00.000Z', CAIRO)).toBe('2026-01-15');
      expect(getBusinessDate('2026-01-15T22:30:00.000Z', CAIRO)).toBe('2026-01-16');
      // Riyadh has no seasons: the window is 21:00 all year.
      expect(getBusinessDate('2026-01-15T21:30:00.000Z', RIYADH)).toBe('2026-01-16');
    });

    it('23:59 -> 00:00 LOCAL rolls the business date by exactly one, in each zone', () => {
      for (const tz of [CAIRO, RIYADH, 'UTC']) {
        const dayStart = getStartOfBusinessDay('2026-08-16', tz);
        const lastMinute = new Date(dayStart.getTime() - 60_000);
        expect(getBusinessTimeHHMM(lastMinute, tz)).toBe('23:59');
        expect(getBusinessDate(lastMinute, tz)).toBe('2026-08-15');
        expect(getBusinessDate(dayStart, tz)).toBe('2026-08-16');
      }
    });

    it('UTC MIDNIGHT while the family is still on the PREVIOUS day (a zone west of UTC)', () => {
      const utcMidnight = '2026-08-16T00:00:00.000Z';
      expect(getBusinessDate(utcMidnight, 'UTC')).toBe('2026-08-16');
      expect(getBusinessDate(utcMidnight, 'America/New_York')).toBe('2026-08-15');
    });

    it('UTC MIDNIGHT while the family is already on the NEXT day (both launch markets)', () => {
      const utcMidnight = '2026-08-15T00:00:00.000Z';
      expect(getBusinessDate(utcMidnight, 'UTC')).toBe('2026-08-15');
      expect(getBusinessDate(utcMidnight, CAIRO)).toBe('2026-08-15');
      // 23:30 UTC on the 15th is the 16th in both markets.
      expect(getBusinessDate('2026-08-15T23:30:00.000Z', CAIRO)).toBe('2026-08-16');
      expect(getBusinessDate('2026-08-15T23:30:00.000Z', RIYADH)).toBe('2026-08-16');
    });

    it('isSameBusinessDay disagrees with UTC exactly where it should', () => {
      const before = '2026-08-15T20:00:00.000Z';
      const after = '2026-08-15T22:00:00.000Z';
      expect(isSameBusinessDay(before, after, 'UTC')).toBe(true);
      expect(isSameBusinessDay(before, after, CAIRO)).toBe(false);
    });
  });

  // =========================================================================
  // 3. DAY BOUNDARIES
  // =========================================================================
  describe('business day boundaries', () => {
    it('start and end bracket the day, in real UTC instants', () => {
      const { start, endExclusive } = getBusinessDayRange('2026-08-16', CAIRO);
      expect(start.toISOString()).toBe('2026-08-15T21:00:00.000Z');
      expect(endExclusive.toISOString()).toBe('2026-08-16T21:00:00.000Z');
      expect(getEndOfBusinessDay('2026-08-16', CAIRO).toISOString()).toBe('2026-08-16T20:59:59.999Z');
    });

    it('a UTC family gets exactly the old behaviour — the migration is a no-op for them', () => {
      const { start, endExclusive } = getBusinessDayRange('2026-08-16', 'UTC');
      expect(start.toISOString()).toBe('2026-08-16T00:00:00.000Z');
      expect(endExclusive.toISOString()).toBe('2026-08-17T00:00:00.000Z');
    });

    it('accepts an instant as well as a date and resolves to that instant’s own day', () => {
      expect(getStartOfBusinessDay('2026-08-15T21:30:00.000Z', CAIRO).toISOString()).toBe(
        '2026-08-15T21:00:00.000Z',
      );
    });
  });

  // =========================================================================
  // 4. DST — DISCOVERED FROM tzdata, NOT ASSUMED
  // =========================================================================
  describe('DST, read from the runtime tz database', () => {
    const cairo2026 = findTransitions(CAIRO, 2026);
    const riyadh2026 = findTransitions(RIYADH, 2026);

    it('EGYPT OBSERVES DST IN 2026 — verified against tzdata, not remembered', () => {
      // Egypt abolished DST in 2014 and REINTRODUCED it in 2023. Asserting this
      // from the tz database is the whole point: if the rule changes again this
      // test fails and says so, instead of the calendar quietly drifting.
      expect(cairo2026).toHaveLength(2);
      expect(cairo2026[0].fromHours).toBe(2);
      expect(cairo2026[0].toHours).toBe(3);
      expect(cairo2026[1].fromHours).toBe(3);
      expect(cairo2026[1].toHours).toBe(2);
    });

    it('SAUDI ARABIA HAS NO DST — also verified, not assumed', () => {
      expect(riyadh2026).toHaveLength(0);
      expect(timeZoneOffsetMs(new Date('2026-01-15T00:00:00Z'), RIYADH)).toBe(3 * HOUR);
      expect(timeZoneOffsetMs(new Date('2026-08-15T00:00:00Z'), RIYADH)).toBe(3 * HOUR);
    });

    it('THE 23-HOUR DAY: the spring-forward date is short, and its day still starts at its first real moment', () => {
      const springDay = getBusinessDate(cairo2026[0].at, CAIRO);
      const { start, endExclusive } = getBusinessDayRange(springDay, CAIRO);
      expect((endExclusive.getTime() - start.getTime()) / HOUR).toBe(23);
      // Egypt's transition is AT midnight: 00:00 becomes 01:00, so that day has
      // no 00:00 at all and legitimately begins at 01:00 local.
      expect(getBusinessTimeHHMM(start, CAIRO)).toBe('01:00');
      expect(getBusinessDate(start, CAIRO)).toBe(springDay);
    });

    it('THE 25-HOUR DAY: the fall-back date is long, and the REPEATED hour is ONE business day', () => {
      const autumnDay = getBusinessDate(new Date(cairo2026[1].at.getTime() - HOUR), CAIRO);
      const { start, endExclusive } = getBusinessDayRange(autumnDay, CAIRO);
      expect((endExclusive.getTime() - start.getTime()) / HOUR).toBe(25);

      // Two achievements inside the repeated wall-clock hour: same local time,
      // one hour apart in real time. Phase A §6.6 case (e): ONE day, not two.
      const firstPass = new Date(cairo2026[1].at.getTime() - 30 * 60_000);
      const secondPass = new Date(cairo2026[1].at.getTime() + 30 * 60_000);
      expect(getBusinessTimeHHMM(firstPass, CAIRO)).toBe(getBusinessTimeHHMM(secondPass, CAIRO));
      expect(isSameBusinessDay(firstPass, secondPass, CAIRO)).toBe(true);
    });

    it('day arithmetic crosses both transitions without losing or gaining a day', () => {
      const spring = getBusinessDate(cairo2026[0].at, CAIRO);
      expect(addBusinessDays(addBusinessDays(spring, -1), 1)).toBe(spring);
      const autumn = getBusinessDate(cairo2026[1].at, CAIRO);
      expect(addBusinessDays(addBusinessDays(autumn, -1), 1)).toBe(autumn);
      // The 23-hour day is still ONE day back from its successor.
      expect(addBusinessDays(spring, -1)).toBe(
        getBusinessDate(new Date(cairo2026[0].at.getTime() - 2 * HOUR), CAIRO),
      );
    });

    it('A STREAK SURVIVES A DST BOUNDARY — the case the old setUTCDate(-1) broke', () => {
      const spring = getBusinessDate(cairo2026[0].at, CAIRO);
      const autumn = getBusinessDate(cairo2026[1].at, CAIRO);

      for (const boundary of [spring, autumn]) {
        const days = [
          addBusinessDays(boundary, -3),
          addBusinessDays(boundary, -2),
          addBusinessDays(boundary, -1),
          boundary,
        ];
        expect(computeCurrentStreak(days, boundary)).toBe(4);
      }
    });

    it('a real gap still breaks the streak — the fix did not make streaks unbreakable', () => {
      const spring = getBusinessDate(cairo2026[0].at, CAIRO);
      const withGap = [addBusinessDays(spring, -3), addBusinessDays(spring, -1), spring];
      expect(computeCurrentStreak(withGap, spring)).toBe(2);
    });
  });

  // =========================================================================
  // 5. maxPerDay AND AGE ON THE FAMILY CALENDAR
  // =========================================================================
  describe('the decisions that depend on the day', () => {
    it('maxPerDay=1: two completions either side of LOCAL midnight are two different days', () => {
      const before = '2026-08-15T20:00:00.000Z'; // 23:00 Cairo, the 15th
      const after = '2026-08-15T22:00:00.000Z'; // 01:00 Cairo, the 16th
      expect(getBusinessDate(before, CAIRO)).toBe('2026-08-15');
      expect(getBusinessDate(after, CAIRO)).toBe('2026-08-16');
      // ... and under UTC they were the SAME day, which is why a Cairo child
      // completing at 01:00 hit "you already did this today".
      expect(getBusinessDate(before, 'UTC')).toBe(getBusinessDate(after, 'UTC'));
    });

    it('maxPerDay=1: two completions either side of UTC midnight are the SAME local day', () => {
      const before = '2026-08-15T23:00:00.000Z'; // 02:00 Cairo, the 16th
      const after = '2026-08-16T01:00:00.000Z'; // 04:00 Cairo, the 16th
      expect(isSameBusinessDay(before, after, CAIRO)).toBe(true);
      expect(isSameBusinessDay(before, after, 'UTC')).toBe(false);
    });

    it('businessDateDaysAgo walks the calendar for the maxPerWeek window', () => {
      expect(businessDateDaysAgo('2026-08-15T21:30:00.000Z', 6, CAIRO)).toBe('2026-08-10');
      expect(businessDateDaysAgo('2026-08-15T21:30:00.000Z', 6, 'UTC')).toBe('2026-08-09');
    });

    it('day-of-week is the family’s, so a "weekend" rule fires on the family’s weekend', () => {
      // 2026-08-15 is a Saturday.
      expect(getBusinessDayOfWeek('2026-08-15', 'UTC')).toBe(6);
      // 21:30Z that Saturday is already SUNDAY in Cairo.
      expect(getBusinessDayOfWeek('2026-08-15T21:30:00.000Z', CAIRO)).toBe(0);
    });

    it('a birthday arrives on the family calendar, not three hours late', () => {
      const instant = '2026-08-15T21:30:00.000Z'; // 00:30 on the 16th in Cairo
      expect(businessAgeInYears('2015-08-16', instant, CAIRO)).toBe(11);
      expect(businessAgeInYears('2015-08-16', instant, 'UTC')).toBe(10);
    });
  });
});
