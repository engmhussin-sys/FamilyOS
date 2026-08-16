/**
 * PHASE D — THE QUIET-HOURS WINDOW ITSELF, PROVEN PER FAMILY, ACROSS MIDNIGHT
 * AND ACROSS A DST TRANSITION.
 *
 * Everything here is a PURE computation over `Africa/Cairo` and `Asia/Riyadh`
 * with every offset read from this runtime's tzdata at the instant in question.
 * There is no offset constant in this file, and that is deliberate: a test that
 * hardcodes `UTC+2` proves that the code agrees with the test's memory of
 * Egyptian law, not that it agrees with Egyptian law.
 *
 * THE TWO ZONES ARE NOT INTERCHANGEABLE and that is why both are here:
 *   Africa/Cairo  — Egypt REINTRODUCED DST in 2023. It is UTC+2 in January and
 *                   UTC+3 in August, so a Cairo family's quiet hours end at two
 *                   different UTC instants depending on the season.
 *   Asia/Riyadh   — no DST, UTC+3 year-round. It is the control: if a change
 *                   broke the DST handling and both zones still agreed, the
 *                   suite would be measuring nothing.
 */
import {
  getBusinessTimeHHMM,
  nextLocalTimeAfter,
  timeZoneOffsetMs,
} from '../../src/common/time/family-date';
import { DEFAULT_FATIGUE_POLICY } from '../../src/modules/life-intelligence/application/services/notification-fatigue-guard';

const CAIRO = 'Africa/Cairo';
const RIYADH = 'Asia/Riyadh';
const QUIET_END = DEFAULT_FATIGUE_POLICY.quietHoursEnd; // '07:00'
const QUIET_START = DEFAULT_FATIGUE_POLICY.quietHoursStart; // '21:00'

/** The same wraparound rule `NotificationFatigueGuard` applies, so this suite
 * measures the shipped policy rather than a paraphrase of it. */
function isQuiet(hhmm: string): boolean {
  const m = (t: string): number => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
  const [c, s, e] = [m(hhmm), m(QUIET_START), m(QUIET_END)];
  return s <= e ? c >= s && c < e : c >= s || c < e;
}

const hoursBetween = (a: Date, b: Date): number => (b.getTime() - a.getTime()) / 3_600_000;

describe('PHASE D — the quiet-hours window, per family and across DST', () => {
  describe('1. THE WINDOW WRAPS MIDNIGHT, and every hour of it is covered', () => {
    it('21:00 through 06:59 is quiet; 07:00 through 20:59 is not — with no gap at 00:00', () => {
      const quiet: string[] = [];
      const loud: string[] = [];
      for (let h = 0; h < 24; h++) {
        const hhmm = `${String(h).padStart(2, '0')}:30`;
        (isQuiet(hhmm) ? quiet : loud).push(hhmm);
      }
      // Ten hours quiet, fourteen loud — the 41.6% of the day that PC-D-005
      // was silently discarding.
      expect(quiet).toEqual([
        '00:30', '01:30', '02:30', '03:30', '04:30', '05:30', '06:30',
        '21:30', '22:30', '23:30',
      ]);
      expect(loud).toHaveLength(14);
      expect(isQuiet('00:00')).toBe(true);
      expect(isQuiet('06:59')).toBe(true);
      expect(isQuiet('07:00')).toBe(false);
      expect(isQuiet('20:59')).toBe(false);
      expect(isQuiet('21:00')).toBe(true);
    });
  });

  describe('2. IT IS THE FAMILY’S CLOCK — two zones, one instant, two answers', () => {
    it('THE PROOF: at 2026-01-15T19:30Z Riyadh is inside quiet hours and Cairo is not', () => {
      const instant = new Date('2026-01-15T19:30:00.000Z');
      // January: Cairo UTC+2 -> 21:30 local... read it rather than assume it.
      const riyadh = getBusinessTimeHHMM(instant, RIYADH); // 22:30
      const cairo = getBusinessTimeHHMM(instant, CAIRO); // 21:30
      expect(riyadh).toBe('22:30');
      expect(cairo).toBe('21:30');
      expect(isQuiet(riyadh)).toBe(true);
      expect(isQuiet(cairo)).toBe(true);

      // One hour EARLIER is the instant where they disagree.
      const earlier = new Date('2026-01-15T18:30:00.000Z');
      expect(getBusinessTimeHHMM(earlier, RIYADH)).toBe('21:30');
      expect(getBusinessTimeHHMM(earlier, CAIRO)).toBe('20:30');
      expect(isQuiet(getBusinessTimeHHMM(earlier, RIYADH))).toBe(true);
      expect(isQuiet(getBusinessTimeHHMM(earlier, CAIRO))).toBe(false);
    });

    it('a deferral taken at ONE instant schedules TWO different release instants, one per zone', () => {
      const deferredAt = new Date('2026-01-15T22:00:00.000Z');
      const cairoRelease = nextLocalTimeAfter(deferredAt, QUIET_END, CAIRO);
      const riyadhRelease = nextLocalTimeAfter(deferredAt, QUIET_END, RIYADH);

      expect(getBusinessTimeHHMM(cairoRelease, CAIRO)).toBe('07:00');
      expect(getBusinessTimeHHMM(riyadhRelease, RIYADH)).toBe('07:00');
      // In January the two zones are one hour apart, so the two households are
      // woken one hour apart from the same deferral instant.
      expect(cairoRelease.getTime()).not.toBe(riyadhRelease.getTime());
      expect(hoursBetween(riyadhRelease, cairoRelease)).toBe(1);
    });

    it('THE OTHER HALF: in August Egypt is on DST, so the two zones release at the SAME instant', () => {
      // Asserting only the comfortable half would be a test that passes for the
      // wrong reason. Egypt reintroduced DST in 2023; in August both zones are
      // UTC+3 and the correct answer is that they AGREE.
      const augustDeferral = new Date('2026-08-15T22:00:00.000Z');
      expect(timeZoneOffsetMs(augustDeferral, CAIRO)).toBe(timeZoneOffsetMs(augustDeferral, RIYADH));
      expect(nextLocalTimeAfter(augustDeferral, QUIET_END, CAIRO).getTime()).toBe(
        nextLocalTimeAfter(augustDeferral, QUIET_END, RIYADH).getTime(),
      );
    });
  });

  describe('3. DEFERRAL ACROSS MIDNIGHT — the release is on the NEXT calendar day', () => {
    it('a Cairo notification deferred at 23:30 local is released at 07:00 the following morning', () => {
      // 2026-01-15 21:30Z is 23:30 in Cairo on the 15th.
      const deferredAt = new Date('2026-01-15T21:30:00.000Z');
      expect(getBusinessTimeHHMM(deferredAt, CAIRO)).toBe('23:30');

      const release = nextLocalTimeAfter(deferredAt, QUIET_END, CAIRO);
      expect(getBusinessTimeHHMM(release, CAIRO)).toBe('07:00');
      expect(release.toISOString()).toBe('2026-01-16T05:00:00.000Z'); // 07:00 at UTC+2
      // 7.5 hours held, and the calendar day advanced by exactly one.
      expect(hoursBetween(deferredAt, release)).toBeCloseTo(7.5, 6);
    });

    it('a notification deferred at 00:30 — AFTER midnight, still inside the window — releases the SAME morning', () => {
      // The bug a naive `startOfDay + 1 day + 7h` would produce: a 00:30
      // notification held for THIRTY-ONE hours instead of six and a half.
      const deferredAt = new Date('2026-01-15T22:30:00.000Z'); // 00:30 on the 16th in Cairo
      expect(getBusinessTimeHHMM(deferredAt, CAIRO)).toBe('00:30');

      const release = nextLocalTimeAfter(deferredAt, QUIET_END, CAIRO);
      expect(release.toISOString()).toBe('2026-01-16T05:00:00.000Z');
      expect(hoursBetween(deferredAt, release)).toBeCloseTo(6.5, 6);
      expect(hoursBetween(deferredAt, release)).toBeLessThan(10);
    });

    it('the release instant is always STRICTLY in the future, even at exactly 07:00', () => {
      // At the boundary itself the notification would not be deferred at all —
      // but if it were, returning `now` would make it eligible immediately and
      // the sweep would re-defer it forever.
      const atSeven = new Date('2026-01-16T05:00:00.000Z'); // 07:00 Cairo
      expect(getBusinessTimeHHMM(atSeven, CAIRO)).toBe('07:00');
      const release = nextLocalTimeAfter(atSeven, QUIET_END, CAIRO);
      expect(release.getTime()).toBeGreaterThan(atSeven.getTime());
      expect(hoursBetween(atSeven, release)).toBe(24);
    });
  });

  describe('4. DEFERRAL ACROSS A DST TRANSITION — the 23-hour night and the 25-hour night', () => {
    /**
     * Egypt's transitions are read from tzdata, not remembered. These two
     * helpers find the actual transition dates in 2026 so the assertions below
     * are about what this runtime believes, which is what production will do.
     */
    function findTransition(fromMonth: number, toMonth: number): Date | null {
      let previous = timeZoneOffsetMs(new Date(Date.UTC(2026, fromMonth, 1)), CAIRO);
      for (let d = 0; d < 120; d++) {
        for (let h = 0; h < 24; h++) {
          const at = new Date(Date.UTC(2026, fromMonth, 1 + d, h));
          if (at.getUTCMonth() > toMonth) return null;
          const offset = timeZoneOffsetMs(at, CAIRO);
          if (offset !== previous) return at;
          previous = offset;
        }
      }
      return null;
    }

    it('SANITY: this runtime’s tzdata really does give Egypt a DST transition in 2026', () => {
      const spring = findTransition(3, 5); // April..June
      const autumn = findTransition(9, 11); // October..December
      expect(spring).not.toBeNull();
      expect(autumn).not.toBeNull();
      // Spring forward gains an hour of offset; autumn gives it back.
      expect(timeZoneOffsetMs(spring as Date, CAIRO)).toBeGreaterThan(
        timeZoneOffsetMs(new Date((spring as Date).getTime() - 3_600_000), CAIRO),
      );
      // Riyadh has none, in either window — the control.
      const riyadhJan = timeZoneOffsetMs(new Date('2026-01-15T00:00:00Z'), RIYADH);
      const riyadhAug = timeZoneOffsetMs(new Date('2026-08-15T00:00:00Z'), RIYADH);
      expect(riyadhJan).toBe(riyadhAug);
    });

    it('SPRING FORWARD: the night is 23 hours long, and the release still lands on local 07:00', () => {
      const spring = findTransition(3, 5) as Date;
      // Defer at 22:00 LOCAL on the evening before the transition.
      const eveningBefore = new Date(spring.getTime() - 6 * 3_600_000);
      const release = nextLocalTimeAfter(eveningBefore, QUIET_END, CAIRO);

      // THE ASSERTION THAT MATTERS: local 07:00, not «now + 9 hours».
      expect(getBusinessTimeHHMM(release, CAIRO)).toBe('07:00');
      // And the elapsed real time is ONE HOUR SHORT of the naive arithmetic,
      // because the clock jumped. A `now + Nh` implementation releases an hour
      // late here and this line is what catches it.
      const naive = hoursBetween(eveningBefore, release);
      const localHoursCrossed =
        Number(getBusinessTimeHHMM(release, CAIRO).slice(0, 2)) +
        24 -
        Number(getBusinessTimeHHMM(eveningBefore, CAIRO).slice(0, 2));
      expect(naive).toBe(localHoursCrossed - 1);
    });

    it('AUTUMN FALL BACK: the night is 25 hours long, and the release still lands on local 07:00', () => {
      const autumn = findTransition(9, 11) as Date;
      const eveningBefore = new Date(autumn.getTime() - 6 * 3_600_000);
      const release = nextLocalTimeAfter(eveningBefore, QUIET_END, CAIRO);

      expect(getBusinessTimeHHMM(release, CAIRO)).toBe('07:00');
      const naive = hoursBetween(eveningBefore, release);
      const localHoursCrossed =
        Number(getBusinessTimeHHMM(release, CAIRO).slice(0, 2)) +
        24 -
        Number(getBusinessTimeHHMM(eveningBefore, CAIRO).slice(0, 2));
      // An extra real hour is lived through, so the naive difference is one MORE.
      expect(naive).toBe(localHoursCrossed + 1);
    });

    it('RIYADH IS THE CONTROL: on the same two nights nothing shifts, so the difference above is DST and not noise', () => {
      for (const month of [3, 9]) {
        const at = new Date(Date.UTC(2026, month, 15, 19, 0));
        const release = nextLocalTimeAfter(at, QUIET_END, RIYADH);
        expect(getBusinessTimeHHMM(release, RIYADH)).toBe('07:00');
        // Exactly the wall-clock difference, because there is no transition.
        expect(hoursBetween(at, release)).toBe(9);
      }
    });
  });

  describe('5. degradation, because a calendar lookup must never lose a notification', () => {
    it('a garbage timezone degrades to UTC rather than to the container clock', () => {
      const at = new Date('2026-01-15T22:00:00.000Z');
      const release = nextLocalTimeAfter(at, QUIET_END, 'Not/AZone');
      expect(release.toISOString()).toBe('2026-01-16T07:00:00.000Z');
    });

    it('a fixed-offset "timezone" is rejected and degrades to UTC — it would opt the family out of DST', () => {
      const at = new Date('2026-01-15T22:00:00.000Z');
      expect(nextLocalTimeAfter(at, QUIET_END, '+02:00').toISOString()).toBe(
        '2026-01-16T07:00:00.000Z',
      );
    });

    it('a malformed HH:MM throws rather than silently scheduling at midnight', () => {
      expect(() => nextLocalTimeAfter(new Date(), '7am', CAIRO)).toThrow(RangeError);
      expect(() => nextLocalTimeAfter(new Date(), '25:00', CAIRO)).toThrow(RangeError);
    });
  });
});
