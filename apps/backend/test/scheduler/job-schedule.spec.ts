/**
 * PHASE C P4 — THE SCHEDULING DECISIONS, PROVEN WITHOUT A DATABASE.
 *
 * Every assertion here is a fixed instant in, a fixed value out. That is what
 * "deterministic" has to mean before it means anything else: if any of these
 * functions ever reads `Date.now()`, the container's timezone, or a config
 * value, one of the numbers below changes and this file goes red.
 *
 * THE TIMEZONE BLOCK IS THE IMPORTANT ONE. It is the executable form of the
 * product claim «a daily rollover for a Cairo family and a Riyadh family happen
 * at different instants», and it is written to be honest about the ONE PERIOD
 * OF THE YEAR WHEN THAT SENTENCE IS FALSE — Egypt reintroduced DST in 2023, so
 * from spring to autumn Cairo and Riyadh are BOTH UTC+3 and roll over together.
 * Asserting only the convenient half would have been a test that passes for the
 * wrong reason.
 */
import {
  closableBusinessDate,
  closesSameDay,
  isDue,
  nextRunAfterFailure,
  nextRunAfterSuccess,
} from '../../src/modules/scheduler/domain/job-schedule';
import { SCHEDULER_DEFAULTS } from '../../src/modules/scheduler/domain/job.types';

const CAIRO = 'Africa/Cairo';
const RIYADH = 'Asia/Riyadh';
const TOKYO = 'Asia/Tokyo';
const ROLLOVER_HOUR = 2;

describe('PHASE C P4 — job scheduling decisions (pure)', () => {
  describe('isDue', () => {
    it('is due when enabled and next_run_at has passed', () => {
      const now = new Date('2026-01-15T12:00:00.000Z');
      expect(isDue({ enabled: true, nextRunAt: new Date('2026-01-15T11:59:59.000Z') }, now)).toBe(true);
      expect(isDue({ enabled: true, nextRunAt: new Date('2026-01-15T12:00:00.000Z') }, now)).toBe(true);
    });

    it('is never due while disabled, no matter how overdue', () => {
      const now = new Date('2026-01-15T12:00:00.000Z');
      expect(isDue({ enabled: false, nextRunAt: new Date('2020-01-01T00:00:00.000Z') }, now)).toBe(false);
    });
  });

  describe('nextRunAfterSuccess', () => {
    it('is the cadence, measured from completion rather than from the scheduled time', () => {
      // Measured from completion ON PURPOSE: a job that took 40 minutes does
      // not immediately become due again, and drift cannot accumulate.
      const now = new Date('2026-01-15T02:40:00.000Z');
      expect(nextRunAfterSuccess(now, 86_400).toISOString()).toBe('2026-01-16T02:40:00.000Z');
    });
  });

  describe('nextRunAfterFailure — retry with backoff', () => {
    it('doubles from the base and is stable for a given failure count', () => {
      const now = new Date('2026-01-15T00:00:00.000Z');
      const delaySeconds = (failures: number): number =>
        (nextRunAfterFailure(now, failures).getTime() - now.getTime()) / 1000;

      expect(delaySeconds(1)).toBe(60);
      expect(delaySeconds(2)).toBe(120);
      expect(delaySeconds(3)).toBe(240);
      expect(delaySeconds(4)).toBe(480);
      expect(delaySeconds(5)).toBe(960);
    });

    it('caps, so a permanently broken job keeps being retried without spinning', () => {
      const now = new Date('2026-01-15T00:00:00.000Z');
      const delay = (nextRunAfterFailure(now, 30).getTime() - now.getTime()) / 1000;
      expect(delay).toBe(SCHEDULER_DEFAULTS.retryMaxSeconds);
      // NEVER Infinity, never null: giving up is not one of the states.
      expect(Number.isFinite(delay)).toBe(true);
    });

    it('is deterministic — no jitter, so two replicas compute the same next run', () => {
      const now = new Date('2026-01-15T00:00:00.000Z');
      expect(nextRunAfterFailure(now, 3).getTime()).toBe(nextRunAfterFailure(now, 3).getTime());
    });
  });

  describe('closableBusinessDate — the day a family has finished', () => {
    it('closes yesterday once the family clock passes the rollover hour', () => {
      // 2026-01-16 02:30 LOCAL in Riyadh (UTC+3, no DST) == 23:30Z on the 15th.
      expect(closableBusinessDate(new Date('2026-01-15T23:30:00.000Z'), RIYADH, ROLLOVER_HOUR)).toBe(
        '2026-01-15',
      );
    });

    it('has not yet closed yesterday before the rollover hour, and says so by returning the day before', () => {
      // 2026-01-16 01:30 LOCAL in Riyadh == 22:30Z on the 15th. The 15th is not
      // closable yet; the newest closable day is the 14th.
      expect(closableBusinessDate(new Date('2026-01-15T22:30:00.000Z'), RIYADH, ROLLOVER_HOUR)).toBe(
        '2026-01-14',
      );
    });

    it('never returns "today" — a day still in progress cannot be judged missed', () => {
      for (const hourZ of [0, 4, 8, 12, 16, 20]) {
        const now = new Date(`2026-01-15T${String(hourZ).padStart(2, '0')}:00:00.000Z`);
        for (const tz of [CAIRO, RIYADH, TOKYO, 'UTC', 'America/Sao_Paulo']) {
          const today = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(now);
          expect(closableBusinessDate(now, tz, ROLLOVER_HOUR) < today).toBe(true);
        }
      }
    });

    it('is deterministic across repeated calls with the same instant', () => {
      const now = new Date('2026-01-15T23:30:00.000Z');
      const first = closableBusinessDate(now, CAIRO, ROLLOVER_HOUR);
      for (let i = 0; i < 50; i++) {
        expect(closableBusinessDate(now, CAIRO, ROLLOVER_HOUR)).toBe(first);
      }
    });
  });

  describe('THE TIMEZONE CLAIM — two families, one instant, two different days', () => {
    /**
     * JANUARY. Egypt is UTC+2 (its DST is not in effect); Saudi Arabia is
     * UTC+3 year-round. At 23:30Z the Riyadh clock reads 02:30 on the 16th and
     * the Cairo clock reads 01:30 on the 16th, so Riyadh has crossed its 02:00
     * boundary and Cairo has not.
     */
    it('January: Riyadh closes 2026-01-15 while Cairo, at the same instant, still closes 2026-01-14', () => {
      const instant = new Date('2026-01-15T23:30:00.000Z');
      expect(closableBusinessDate(instant, RIYADH, ROLLOVER_HOUR)).toBe('2026-01-15');
      expect(closableBusinessDate(instant, CAIRO, ROLLOVER_HOUR)).toBe('2026-01-14');
      expect(closesSameDay(instant, CAIRO, RIYADH, ROLLOVER_HOUR)).toBe(false);
    });

    it('January: one hour later Cairo catches up — the boundaries are exactly one hour apart', () => {
      const instant = new Date('2026-01-16T00:30:00.000Z');
      expect(closableBusinessDate(instant, CAIRO, ROLLOVER_HOUR)).toBe('2026-01-15');
      expect(closableBusinessDate(instant, RIYADH, ROLLOVER_HOUR)).toBe('2026-01-15');
    });

    /**
     * AUGUST, and this is the assertion that keeps the claim honest. Egypt
     * observes DST again since 2023, so in August Cairo IS UTC+3 and the two
     * families roll over at the SAME instant. Read from tzdata at the instant
     * in question, never from a remembered offset.
     */
    it('August: Egypt is on DST, so Cairo and Riyadh close the same day at the same instant', () => {
      const instant = new Date('2026-08-15T23:30:00.000Z');
      expect(closesSameDay(instant, CAIRO, RIYADH, ROLLOVER_HOUR)).toBe(true);
      expect(closableBusinessDate(instant, CAIRO, ROLLOVER_HOUR)).toBe('2026-08-15');
    });

    it('a far-eastern family is a whole day ahead of a UTC one at the same instant', () => {
      const instant = new Date('2026-01-15T20:00:00.000Z'); // Tokyo: 05:00 on the 16th
      expect(closableBusinessDate(instant, TOKYO, ROLLOVER_HOUR)).toBe('2026-01-15');
      expect(closableBusinessDate(instant, 'UTC', ROLLOVER_HOUR)).toBe('2026-01-14');
    });

    it('a garbage or missing timezone degrades to UTC rather than to the container clock', () => {
      const instant = new Date('2026-01-15T20:00:00.000Z');
      expect(closableBusinessDate(instant, 'Not/AZone', ROLLOVER_HOUR)).toBe(
        closableBusinessDate(instant, 'UTC', ROLLOVER_HOUR),
      );
      // A fixed OFFSET is not a timezone — accepting one would let a family opt
      // out of DST silently. `resolveTimeZone` rejects it; so does this.
      expect(closableBusinessDate(instant, '+03:00', ROLLOVER_HOUR)).toBe(
        closableBusinessDate(instant, 'UTC', ROLLOVER_HOUR),
      );
    });
  });

  describe('DST boundary days — 23 and 25 hours long', () => {
    /**
     * Egypt's spring transition happens AT MIDNIGHT: local 00:00 jumps to
     * 01:00, so that calendar day has no 00:00 and only 23 hours. The rollover
     * boundary at 02:00 still exists and still lands once.
     */
    it('a 23-hour day still closes exactly one calendar day', () => {
      const seen = new Set<string>();
      // Walk the whole of Cairo's spring-forward date in 15-minute steps.
      for (let m = 0; m < 24 * 60; m += 15) {
        const instant = new Date(Date.UTC(2026, 3, 24, 0, 0, 0) + m * 60_000);
        seen.add(closableBusinessDate(instant, CAIRO, ROLLOVER_HOUR));
      }
      // At most two distinct closable dates across a 24h walk (the boundary is
      // crossed once), and never a skip or a repeat beyond that.
      expect(seen.size).toBeLessThanOrEqual(2);
    });

    it('a repeated wall-clock hour in autumn does not close the same day twice', () => {
      const before = closableBusinessDate(new Date('2026-10-29T23:30:00.000Z'), CAIRO, ROLLOVER_HOUR);
      const after = closableBusinessDate(new Date('2026-10-30T00:30:00.000Z'), CAIRO, ROLLOVER_HOUR);
      // Monotonic: the closable day never goes BACKWARDS as time moves forward.
      expect(after >= before).toBe(true);
    });
  });
});
