/**
 * B2 (PA-B-002) — THE SERVER-LOCAL CLASS, WHICH IS A DIFFERENT BUG.
 *
 * Fourteen of the twenty migrated sites answered "which day is it?" in UTC.
 * THREE did something else and worse: they read the CONTAINER's timezone.
 *
 *   `notification-fatigue-guard.ts:91`  `todayStart.setHours(0, 0, 0, 0)`
 *   `smart-notification-integration.service.ts:117`  `now.getHours()`
 *   `habit-engine.service.ts:240`  `scheduledEnd.setHours(h, m, 0, 0)`
 *
 * `process.env.TZ` is unset in this image, so the container is UTC and those
 * three happened to agree with the other fourteen — TODAY, ON THIS HOST, BY
 * ACCIDENT. Deploy the same image to a host configured for `Africa/Cairo` and
 * quiet hours and the daily notification caps change meaning with no code
 * change and nothing in the code to suggest they could.
 *
 * The measured consequence, from Phase A §6.4: the default policy is
 * 21:00-07:00. Evaluated against UTC for a Cairo family in summer that is
 * 00:00-10:00 LOCAL — notifications muted through the entire school morning and
 * fully permitted in the three hours before a child's bedtime. Not merely
 * imprecise: INVERTED, exactly at the boundary the feature exists to protect.
 */
import {
  DEFAULT_FATIGUE_POLICY,
  evaluateFatigue,
  type ICandidateNotification,
  type IRecentNotification,
} from '../../src/modules/life-intelligence/application/services/notification-fatigue-guard';
import {
  getBusinessTimeHHMM,
  getStartOfBusinessDay,
} from '../../src/common/time/family-date';

const CAIRO = 'Africa/Cairo';
const RIYADH = 'Asia/Riyadh';

const candidate: ICandidateNotification = {
  type: 'REWARD_GRANTED',
  priority: 'NORMAL',
  title: 't',
  body: 'b',
  targetAudience: 'PARENT',
};

/** Exactly what `SmartNotificationIntegrationService.evaluateAndDeliver` now
 * builds before calling the guard. Kept here so this suite tests the same two
 * derived values production passes, not a convenient approximation. */
function decide(now: Date, timeZone: string, history: IRecentNotification[] = []) {
  return evaluateFatigue(
    candidate,
    history,
    now,
    getBusinessTimeHHMM(now, timeZone),
    getStartOfBusinessDay(now, timeZone),
  );
}

describe('B2 — quiet hours and daily caps on the family calendar', () => {
  it('the default policy is still 21:00-07:00 — B2 changed the CLOCK, not the policy', () => {
    expect(DEFAULT_FATIGUE_POLICY.quietHoursStart).toBe('21:00');
    expect(DEFAULT_FATIGUE_POLICY.quietHoursEnd).toBe('07:00');
    expect(DEFAULT_FATIGUE_POLICY.dailyMax).toBe(6);
    expect(DEFAULT_FATIGUE_POLICY.categoryDailyMax).toBe(2);
  });

  describe('quiet hours crossing midnight', () => {
    it('THE INVERSION, demonstrated: 19:00 UTC in summer is 22:00 in Cairo — quiet there, awake in UTC', () => {
      const instant = new Date('2026-08-15T19:00:00.000Z');
      expect(getBusinessTimeHHMM(instant, 'UTC')).toBe('19:00');
      expect(getBusinessTimeHHMM(instant, CAIRO)).toBe('22:00');

      expect(decide(instant, 'UTC').allowed).toBe(true);
      expect(decide(instant, CAIRO)).toEqual({ allowed: false, blockedReason: 'QUIET_HOURS' });
    });

    it('THE INVERSION, the other half: 08:00 UTC is 11:00 in Cairo — allowed there, and allowed in UTC', () => {
      const instant = new Date('2026-08-15T08:00:00.000Z');
      expect(decide(instant, CAIRO).allowed).toBe(true);
      expect(decide(instant, 'UTC').allowed).toBe(true);
    });

    it('05:00 UTC is 08:00 in Cairo: past the family’s quiet hours, still inside a UTC family’s', () => {
      const instant = new Date('2026-08-15T05:00:00.000Z');
      expect(decide(instant, CAIRO).allowed).toBe(true);
      expect(decide(instant, 'UTC')).toEqual({ allowed: false, blockedReason: 'QUIET_HOURS' });
    });

    it('the window really does wrap midnight, on the family’s clock, in every zone', () => {
      const cases: Array<[string, string, boolean]> = [
        // [family local time, zone, expected to be QUIET]
        ['20:59', CAIRO, false],
        ['21:00', CAIRO, true],
        ['23:59', CAIRO, true],
        ['00:00', CAIRO, true], // the wrap itself
        ['06:59', CAIRO, true],
        ['07:00', CAIRO, false],
        ['21:00', RIYADH, true],
        ['03:00', RIYADH, true],
        ['12:00', RIYADH, false],
      ];

      for (const [local, tz, quiet] of cases) {
        // Build the UTC instant that reads as `local` in `tz` on this date.
        const dayStart = getStartOfBusinessDay('2026-08-15', tz);
        const [h, m] = local.split(':').map(Number);
        const instant = new Date(dayStart.getTime() + (h * 60 + m) * 60_000);
        expect(getBusinessTimeHHMM(instant, tz)).toBe(local);
        expect(decide(instant, tz).blockedReason === 'QUIET_HOURS').toBe(quiet);
      }
    });

    /**
     * PHASE E (`PD-N-004`) — THIS TEST WAS CORRECT AND IS NOW SPLIT IN TWO,
     * because the rule it described has been narrowed on purpose.
     *
     * B2 wrote it against `candidate`, whose type is `REWARD_GRANTED`, at a
     * time when `priority === 'CRITICAL'` WAS the whole quiet-hours escalation
     * rule and no notification type had been classified. Phase D then wrote
     * `notification-class.ts`, which classifies `REWARD_GRANTED` as `DEFER`
     * with a written justification, and whose own docstring says an explicit
     * classification wins «including when it DOWNGRADES a CRITICAL type».
     * Those two statements contradict each other, and until Phase E the
     * `priority` shortcut silently won — which is how a `SCREEN_TIME_EXCEEDED`
     * alert, classified DEFER and raised CRITICAL by its producer, went
     * through at 02:00.
     *
     * So the escalation policy is asserted on an UNCLASSIFIED type, where it
     * still holds byte for byte, and the new narrowing is asserted beside it
     * rather than replacing it silently.
     */
    it('CRITICAL still pierces quiet hours for an UNCLASSIFIED type — the escalation policy is untouched', () => {
      const instant = new Date('2026-08-15T19:00:00.000Z'); // 22:00 Cairo
      const critical: ICandidateNotification = {
        ...candidate,
        // Not in `NOTIFICATION_CLASSES`; `quietHoursClassOf` falls back to the
        // pre-matrix rule for exactly this case.
        type: 'PROTECTION_ALERT',
        priority: 'CRITICAL',
      };
      const result = evaluateFatigue(
        critical,
        [],
        instant,
        getBusinessTimeHHMM(instant, CAIRO),
        getStartOfBusinessDay(instant, CAIRO),
      );
      expect(result.allowed).toBe(true);
    });

    it('but a CLASSIFIED DEFER type does NOT pierce quiet hours, even at CRITICAL priority', () => {
      const instant = new Date('2026-08-15T19:00:00.000Z'); // 22:00 Cairo
      // Classified DEFER in `notification-class.ts` with a written reason, and
      // raised CRITICAL by `DigitalWellbeingEngineService`. This exact
      // combination is `PD-N-004`.
      const classifiedButLoud: ICandidateNotification = {
        ...candidate,
        type: 'SCREEN_TIME_EXCEEDED',
        priority: 'CRITICAL',
      };
      const result = evaluateFatigue(
        classifiedButLoud,
        [],
        instant,
        getBusinessTimeHHMM(instant, CAIRO),
        getStartOfBusinessDay(instant, CAIRO),
      );
      expect(result.allowed).toBe(false);
      expect(result.blockedReason).toBe('QUIET_HOURS');
    });

    it('and a DELIVER-classified type pierces them at NORMAL priority — the axis is the type, not the volume', () => {
      const instant = new Date('2026-08-15T19:00:00.000Z'); // 22:00 Cairo
      const safety: ICandidateNotification = {
        ...candidate,
        type: 'ACCESSIBILITY_DISABLED',
        priority: 'NORMAL',
      };
      const result = evaluateFatigue(
        safety,
        [],
        instant,
        getBusinessTimeHHMM(instant, CAIRO),
        getStartOfBusinessDay(instant, CAIRO),
      );
      expect(result.allowed).toBe(true);
    });
  });

  describe('daily and category caps crossing midnight', () => {
    /** `n` notifications of distinct types, all at `instant`. */
    const history = (instant: Date, n: number): IRecentNotification[] =>
      Array.from({ length: n }, (_, i) => ({
        type: `SEED_${i}`,
        priority: 'NORMAL' as const,
        createdAt: instant,
      }));

    it('the daily cap resets at the FAMILY’s midnight, not the container’s', () => {
      // Six notifications sent at 18:00 UTC (21:00 Cairo) on the 15th. In Cairo
      // that is the evening of the 15th.
      const sentAt = new Date('2026-08-15T18:00:00.000Z');
      const sixToday = history(sentAt, 6);

      // Now it is 22:30 UTC — which is 01:30 on the 16th in Cairo. A NEW day
      // for that family: the six belong to yesterday and the cap is clear.
      const now = new Date('2026-08-15T22:30:00.000Z');
      expect(getBusinessTimeHHMM(now, CAIRO)).toBe('01:30');

      // Cairo: a new business day => not DAILY_MAX. (It is QUIET_HOURS, which
      // is the correct answer at 01:30 and a different rule — asserted so the
      // test cannot pass for the wrong reason.)
      expect(decide(now, CAIRO, sixToday).blockedReason).toBe('QUIET_HOURS');

      // The same six, evaluated at 12:00 Cairo the same business day, ARE the
      // cap.
      const noonNextDay = new Date('2026-08-16T09:00:00.000Z'); // 12:00 Cairo, 16th
      expect(decide(noonNextDay, CAIRO, history(new Date('2026-08-16T06:00:00.000Z'), 6)).blockedReason).toBe(
        'DAILY_MAX',
      );
    });

    it('a UTC family still counts the same six against the same UTC day — no behaviour changed for them', () => {
      // 12:00 and 20:00 on the same UTC day, both outside quiet hours, so the
      // only rule that can fire is the daily cap.
      const sentAt = new Date('2026-08-15T12:00:00.000Z');
      const now = new Date('2026-08-15T20:00:00.000Z');
      expect(decide(now, 'UTC', history(sentAt, 6)).blockedReason).toBe('DAILY_MAX');
      // ...and for a Cairo family the very same instant is 23:00, still the
      // SAME family day, so the cap fires there too — only its RESET moved.
      expect(decide(now, CAIRO, history(sentAt, 6)).blockedReason).toBe('QUIET_HOURS');
    });

    it('the CATEGORY cap resets at the family’s midnight too', () => {
      const twoRewardsYesterdayEvening: IRecentNotification[] = [
        { type: 'REWARD_GRANTED', priority: 'NORMAL', createdAt: new Date('2026-08-15T14:00:00.000Z') },
        { type: 'REWARD_GRANTED', priority: 'NORMAL', createdAt: new Date('2026-08-15T15:00:00.000Z') },
      ];

      // 09:00 UTC on the 16th == 12:00 Cairo on the 16th: a new family day, so
      // the two from the 15th no longer count.
      const now = new Date('2026-08-16T09:00:00.000Z');
      expect(decide(now, CAIRO, twoRewardsYesterdayEvening).allowed).toBe(true);

      // Two on the SAME family day still cap.
      const sameDay: IRecentNotification[] = [
        { type: 'REWARD_GRANTED', priority: 'NORMAL', createdAt: new Date('2026-08-16T05:00:00.000Z') },
        { type: 'REWARD_GRANTED', priority: 'NORMAL', createdAt: new Date('2026-08-16T06:00:00.000Z') },
      ];
      expect(decide(now, CAIRO, sameDay).blockedReason).toBe('CATEGORY_MAX');
    });

    it('the 5-minute duplicate window is real time, correctly UNCHANGED by B2', () => {
      // A duplicate is "the same thing twice in five minutes". That is a
      // DURATION, not a calendar fact, so it must not be projected through a
      // timezone — left alone deliberately.
      const now = new Date('2026-08-16T09:00:00.000Z');
      const twoMinutesAgo: IRecentNotification[] = [
        { type: 'REWARD_GRANTED', priority: 'NORMAL', createdAt: new Date(now.getTime() - 2 * 60_000) },
      ];
      expect(decide(now, CAIRO, twoMinutesAgo).blockedReason).toBe('DUPLICATE');
      expect(decide(now, 'UTC', twoMinutesAgo).blockedReason).toBe('DUPLICATE');
    });
  });
});
