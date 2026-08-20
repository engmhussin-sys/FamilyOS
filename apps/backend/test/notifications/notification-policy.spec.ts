/**
 * PHASE F (`F6-002` §4) — THE POLICY, AND THE PROOF THAT IT REUSES THE GUARD
 * RATHER THAN REPLACING IT.
 *
 * THE CLAIM: the caps, cooldowns and quiet hours become per-family
 * configuration, `evaluateFatigue` stays the one function that refuses a
 * candidate, and EVERY CALLER WRITTEN BEFORE F6 KEEPS ITS EXACT PREVIOUS
 * BEHAVIOUR. The last clause is the one worth testing hardest, because it is the
 * one a refactor breaks silently: `QuietHoursReleaseService` and
 * `SmartNotificationIntegrationService` both call `evaluateFatigue` with no
 * policy argument at all, and if `DEFAULT_FATIGUE_POLICY` had changed under
 * them, three deferral suites would have started asserting a different product.
 */
import {
  DEFAULT_FATIGUE_POLICY,
  evaluateFatigue,
  type ICandidateNotification,
  type IRecentNotification,
} from '../../src/modules/life-intelligence/application/services/notification-fatigue-guard';
import {
  DEFAULT_NOTIFICATION_POLICY,
  NOTIFICATION_POLICY_SCHEMAS,
  NotificationPolicySettingError,
  UNSUPPRESSABLE_CATEGORIES,
  parsePolicySetting,
  resolveNotificationPolicy,
  toFatiguePolicy,
} from '../../src/modules/notifications/domain/engine/notification-policy';

const NOW = new Date('2026-03-10T14:00:00.000Z');
const DAY_START = new Date('2026-03-10T00:00:00.000Z');
const AFTERNOON = '16:00';

const candidate: ICandidateNotification = {
  type: 'REWARD_GRANTED',
  priority: 'NORMAL',
  title: 'ت',
  body: 'ن',
  targetAudience: 'PARENT',
};

function history(count: number, minutesAgoEach: number, type = 'OTHER_TYPE'): IRecentNotification[] {
  return Array.from({ length: count }, (_, i) => ({
    type: `${type}_${i}`,
    priority: 'NORMAL' as const,
    createdAt: new Date(NOW.getTime() - (i + 1) * minutesAgoEach * 60_000),
  }));
}

describe('PHASE F — the notification policy is configuration, not constants', () => {
  it('the DEFAULTS are byte-for-byte the pre-F6 numbers — this release changes no behaviour by itself', () => {
    const bridged = toFatiguePolicy(DEFAULT_NOTIFICATION_POLICY);
    expect(bridged.dailyMax).toBe(DEFAULT_FATIGUE_POLICY.dailyMax);
    expect(bridged.categoryDailyMax).toBe(DEFAULT_FATIGUE_POLICY.categoryDailyMax);
    expect(bridged.quietHoursStart).toBe(DEFAULT_FATIGUE_POLICY.quietHoursStart);
    expect(bridged.quietHoursEnd).toBe(DEFAULT_FATIGUE_POLICY.quietHoursEnd);
    expect(bridged.cooldownMinutesByType).toEqual(DEFAULT_FATIGUE_POLICY.cooldownMinutesByType);
    expect(bridged.duplicateWindowMs).toBe(5 * 60_000);
  });

  it('the pre-F6 DEFAULT_FATIGUE_POLICY still declares NO hourly cap and NO default cooldown', () => {
    // The whole safety case for the guard's three new fields is that they are
    // absent for every existing caller. If a future edit gives
    // `DEFAULT_FATIGUE_POLICY` an `hourlyMax`, the release path's behaviour
    // changes without any release-path code changing — this assertion is what
    // makes that a failing test rather than a surprise.
    expect(DEFAULT_FATIGUE_POLICY.hourlyMax).toBeUndefined();
    expect(DEFAULT_FATIGUE_POLICY.defaultCooldownMinutes).toBeUndefined();
    expect(DEFAULT_FATIGUE_POLICY.duplicateWindowMs).toBeUndefined();
  });

  it('resolves per-family overrides, and falls back per KEY rather than wholesale', () => {
    const policy = resolveNotificationPolicy({
      'notification.cap.maxPerHour': '2',
      'notification.quietHours.start': '23:00',
    });
    expect(policy.maxPerHour).toBe(2);
    expect(policy.quietHoursStart).toBe('23:00');
    // Untouched keys keep the default; one override does not reset the rest.
    expect(policy.maxPerDay).toBe(DEFAULT_NOTIFICATION_POLICY.maxPerDay);
    expect(policy.quietHoursEnd).toBe('07:00');
  });

  it('a STALE stored value degrades to that key’s default instead of muting the household', () => {
    // A bound tightened after the row was written. The read path must not throw
    // — a household receiving nothing because one row is stale is the exact
    // failure this phase exists to remove.
    const policy = resolveNotificationPolicy({
      'notification.cap.maxPerDay': '9999',
      'notification.quietHours.start': 'not-a-time',
      'notification.unknown.key': '3',
    });
    expect(policy.maxPerDay).toBe(DEFAULT_NOTIFICATION_POLICY.maxPerDay);
    expect(policy.quietHoursStart).toBe('21:00');
  });

  it('the WRITE path refuses what the read path tolerates — an unknown key and a bad bound', () => {
    expect(() => parsePolicySetting('notification.unknown.key', '3')).toThrow(
      NotificationPolicySettingError,
    );
    expect(() => parsePolicySetting('notification.cap.maxPerDay', '0')).toThrow(/below minimum/);
    expect(() => parsePolicySetting('notification.cap.maxPerDay', '9999')).toThrow(/above maximum/);
    expect(() => parsePolicySetting('notification.quietHours.start', '25:00')).toThrow(/HH:MM/);
    expect(parsePolicySetting('notification.cap.maxPerDay', '8')).toBe(8);
  });

  it('SAFETY can never be switched off, whatever an operator types', () => {
    expect(UNSUPPRESSABLE_CATEGORIES.has('SAFETY')).toBe(true);
    const parsed = parsePolicySetting('notification.suppressedCategories', 'reward, safety ,REMINDER');
    expect(parsed).toEqual(['REWARD', 'REMINDER']);
    const policy = resolveNotificationPolicy({ 'notification.suppressedCategories': 'SAFETY' });
    expect(policy.suppressedCategories).toEqual([]);
  });

  it('every schema entry carries an Arabic description and a usable bound', () => {
    for (const schema of NOTIFICATION_POLICY_SCHEMAS) {
      expect(schema.descriptionAr.length).toBeGreaterThan(30);
      expect(schema.key.startsWith('notification.')).toBe(true);
      if (schema.type === 'INT') {
        expect(schema.min).not.toBeNull();
        expect(schema.max).not.toBeNull();
      }
    }
  });

  it('the priority-override list is exactly the DELIVER class — an operator cannot promote a nudge into an alarm', () => {
    expect([...DEFAULT_NOTIFICATION_POLICY.priorityOverrideTypes].sort()).toEqual(
      ['ACCESSIBILITY_DISABLED', 'CHILD_WELLBEING_CHECKIN', 'PROTECTION_BYPASS_ATTEMPT'].sort(),
    );
  });
});

describe('PHASE F — the fatigue guard, extended and NOT replaced', () => {
  it('HOURLY_MAX: three in the last hour refuses the fourth, while the daily cap is still far away', () => {
    const policy = toFatiguePolicy(DEFAULT_NOTIFICATION_POLICY);
    const recent = history(3, 5);
    const decision = evaluateFatigue(candidate, recent, NOW, AFTERNOON, DAY_START, policy);
    expect(decision).toEqual({ allowed: false, blockedReason: 'HOURLY_MAX' });

    // THE GAP THIS CLOSES: with the pre-F6 policy the exact same burst is legal.
    const before = evaluateFatigue(candidate, recent, NOW, AFTERNOON, DAY_START, DEFAULT_FATIGUE_POLICY);
    expect(before.allowed).toBe(true);
  });

  it('HOURLY_MAX is a ROLLING hour — three at 10:58 do not reset at 11:00', () => {
    const policy = toFatiguePolicy(DEFAULT_NOTIFICATION_POLICY);
    // Three notifications 58, 56 and 54 minutes ago: still inside the rolling
    // window. A clock-hour implementation would have let this through.
    const recent: IRecentNotification[] = [58, 56, 54].map((m, i) => ({
      type: `T${i}`,
      priority: 'NORMAL' as const,
      createdAt: new Date(NOW.getTime() - m * 60_000),
    }));
    expect(evaluateFatigue(candidate, recent, NOW, AFTERNOON, DAY_START, policy).blockedReason).toBe(
      'HOURLY_MAX',
    );
    // Sixty-one minutes ago is outside it, and the fourth is allowed.
    const older = recent.map((r) => ({ ...r, createdAt: new Date(NOW.getTime() - 61 * 60_000) }));
    expect(evaluateFatigue(candidate, older, NOW, AFTERNOON, DAY_START, policy).allowed).toBe(true);
  });

  it('DAILY_MAX is still reported BEFORE HOURLY_MAX when a household is over both', () => {
    const policy = toFatiguePolicy(DEFAULT_NOTIFICATION_POLICY);
    const recent = history(6, 5);
    expect(evaluateFatigue(candidate, recent, NOW, AFTERNOON, DAY_START, policy).blockedReason).toBe(
      'DAILY_MAX',
    );
  });

  it('the DEFAULT COOLDOWN now protects an unlisted type — REWARD_GRANTED had none before F6', () => {
    const policy = toFatiguePolicy(DEFAULT_NOTIFICATION_POLICY);
    const recent: IRecentNotification[] = [
      { type: 'REWARD_GRANTED', priority: 'NORMAL', createdAt: new Date(NOW.getTime() - 20 * 60_000) },
    ];
    expect(evaluateFatigue(candidate, recent, NOW, AFTERNOON, DAY_START, policy).blockedReason).toBe(
      'COOLDOWN',
    );
    // Pre-F6: the same history, the same instant, ALLOWED — the three named
    // types were the only ones with a cooldown at all.
    expect(evaluateFatigue(candidate, recent, NOW, AFTERNOON, DAY_START, DEFAULT_FATIGUE_POLICY).allowed).toBe(
      true,
    );
  });

  it('the DUPLICATE window is configurable and still defaults to five minutes', () => {
    const recent: IRecentNotification[] = [
      { type: 'REWARD_GRANTED', priority: 'NORMAL', createdAt: new Date(NOW.getTime() - 4 * 60_000) },
    ];
    expect(evaluateFatigue(candidate, recent, NOW, AFTERNOON, DAY_START, DEFAULT_FATIGUE_POLICY).blockedReason).toBe(
      'DUPLICATE',
    );
    const wide = toFatiguePolicy(resolveNotificationPolicy({ 'notification.duplicate.windowMinutes': '2' }));
    // Four minutes is outside a two-minute window, so it falls through to the
    // cooldown rule rather than being called a duplicate — a different fact,
    // reported differently.
    expect(evaluateFatigue(candidate, recent, NOW, AFTERNOON, DAY_START, wide).blockedReason).toBe(
      'COOLDOWN',
    );
  });

  it('a family that RAISED its caps really gets more notifications', () => {
    const generous = toFatiguePolicy(
      resolveNotificationPolicy({
        'notification.cap.maxPerHour': '10',
        'notification.cap.maxPerDay': '20',
        'notification.cap.categoryMaxPerDay': '10',
        'notification.cooldown.defaultMinutes': '0',
      }),
    );
    const recent = history(6, 5);
    expect(evaluateFatigue(candidate, recent, NOW, AFTERNOON, DAY_START, generous).allowed).toBe(true);
  });

  it('quiet hours are still decided by the MATRIX, not by priority — the F6 policy does not reopen PD-N-004', () => {
    const policy = toFatiguePolicy(DEFAULT_NOTIFICATION_POLICY);
    const night = '23:30';
    // A DEFER-class type at CRITICAL priority is STILL held, exactly as Phase E
    // made it: the classification wins over `priority`.
    const screenTime: ICandidateNotification = { ...candidate, type: 'SCREEN_TIME_EXCEEDED', priority: 'CRITICAL' };
    expect(evaluateFatigue(screenTime, [], NOW, night, DAY_START, policy).blockedReason).toBe('QUIET_HOURS');
    // A DELIVER-class type passes.
    const accessibility: ICandidateNotification = { ...candidate, type: 'ACCESSIBILITY_DISABLED', priority: 'NORMAL' };
    expect(evaluateFatigue(accessibility, [], NOW, night, DAY_START, policy).allowed).toBe(true);
  });

  it('a family with CUSTOM quiet hours is judged on ITS OWN window', () => {
    const late = toFatiguePolicy(
      resolveNotificationPolicy({
        'notification.quietHours.start': '23:00',
        'notification.quietHours.end': '06:00',
      }),
    );
    // 22:00 is quiet under the default policy and awake under this family's.
    const standard = toFatiguePolicy(DEFAULT_NOTIFICATION_POLICY);
    expect(evaluateFatigue(candidate, [], NOW, '22:00', DAY_START, standard).blockedReason).toBe('QUIET_HOURS');
    expect(evaluateFatigue(candidate, [], NOW, '22:00', DAY_START, late).allowed).toBe(true);
    expect(evaluateFatigue(candidate, [], NOW, '23:30', DAY_START, late).blockedReason).toBe('QUIET_HOURS');
  });
});
