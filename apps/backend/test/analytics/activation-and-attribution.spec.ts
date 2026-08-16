/**
 * PHASE D (GROWTH) — THE ACTIVATION DEFINITION AND THE ATTRIBUTION
 * NORMALISER, PINNED AS SPECIFICATIONS.
 *
 * Both are pure functions on purpose, so the definition can be tested AS a
 * definition — no database, no clock, no DI container. A test that has to boot
 * Nest to find out what "meaningful" means is a test nobody reads when the
 * meaning is what is in dispute.
 */
import {
  ACTIVATION_RULE_VERSION,
  MEANINGFUL_COMPLETION_KINDS,
  evaluateActivation,
} from '../../src/modules/analytics/domain/activation';
import {
  ACQUISITION_CHANNELS,
  normaliseAttribution,
  resolveChannel,
} from '../../src/modules/analytics/domain/attribution';
import {
  ALLOWED_PAYLOAD_KEYS,
  CLIENT_INGESTIBLE_GROWTH_EVENTS,
  FUNNEL_STEPS,
  GROWTH_EVENT_CATALOGUE,
  GROWTH_EVENT_NAMES,
} from '../../src/modules/analytics/domain/growth-events';

const HOUR = 60 * 60 * 1000;
const MINUTE = 60 * 1000;

const REGISTERED_AT = new Date('2026-08-01T09:00:00.000Z');
const CHILD_CREATED_AT = new Date('2026-08-01T09:30:00.000Z');

function candidate(over: Partial<Parameters<typeof evaluateActivation>[0]> = {}) {
  return {
    familyId: 'fam-1',
    completionKind: 'HABIT' as const,
    grantCount: 1,
    childCreatedAt: CHILD_CREATED_AT,
    occurredAt: new Date(CHILD_CREATED_AT.getTime() + 2 * HOUR),
    familyCreatedAt: REGISTERED_AT,
    ...over,
  };
}

describe('PHASE D (GROWTH) — CHILD_COMPLETES_FIRST_MEANINGFUL_GOAL', () => {
  const MIN_MINUTES = 60;

  it('the happy path: a rewarded habit completed 2h after the child was added, 2.5h after registration', () => {
    const decision = evaluateActivation(candidate(), MIN_MINUTES);
    expect(decision.qualifies).toBe(true);
    expect(decision.rejection).toBeNull();
    // 09:00 registration -> 11:30 completion = 150 minutes.
    expect(decision.timeToValueMinutes).toBe(150);
    expect(decision.ruleVersion).toBe(ACTIVATION_RULE_VERSION);
  });

  describe('GATE 1 — REAL: the ledger must have granted something', () => {
    it('rejects a completion that produced zero grants', () => {
      const decision = evaluateActivation(candidate({ grantCount: 0 }), MIN_MINUTES);
      expect(decision.qualifies).toBe(false);
      expect(decision.rejection).toBe('NO_REWARD_GRANTED');
    });

    it('rejects a fractional or negative grant count — a malformed payload is not an activation', () => {
      expect(evaluateActivation(candidate({ grantCount: 0.5 }), MIN_MINUTES).rejection).toBe('NO_REWARD_GRANTED');
      expect(evaluateActivation(candidate({ grantCount: -1 }), MIN_MINUTES).rejection).toBe('NO_REWARD_GRANTED');
    });
  });

  describe('GATE 2 — A GOAL, not an artefact of one', () => {
    it('admits all five product completion kinds plus ACHIEVEMENT', () => {
      for (const kind of ['HABIT', 'TASK', 'HEALTH_GOAL', 'LEARNING_SESSION', 'FAITH_SESSION', 'ACHIEVEMENT'] as const) {
        expect(MEANINGFUL_COMPLETION_KINDS.has(kind)).toBe(true);
        expect(evaluateActivation(candidate({ completionKind: kind }), MIN_MINUTES).qualifies).toBe(true);
      }
    });

    it('REJECTS STREAK — it is derived from completions that were already counted', () => {
      expect(MEANINGFUL_COMPLETION_KINDS.has('STREAK')).toBe(false);
      const decision = evaluateActivation(candidate({ completionKind: 'STREAK' }), MIN_MINUTES);
      expect(decision.qualifies).toBe(false);
      expect(decision.rejection).toBe('NOT_A_MEANINGFUL_KIND');
    });
  });

  describe('GATE 3 — NOT A DEMONSTRATION', () => {
    it('rejects a completion 59 minutes after the child was added, when the threshold is 60', () => {
      const decision = evaluateActivation(
        candidate({ occurredAt: new Date(CHILD_CREATED_AT.getTime() + 59 * MINUTE) }),
        MIN_MINUTES,
      );
      expect(decision.qualifies).toBe(false);
      expect(decision.rejection).toBe('TOO_SOON_AFTER_CHILD_CREATED');
    });

    it('admits it at exactly 60 minutes — the boundary is inclusive', () => {
      const decision = evaluateActivation(
        candidate({ occurredAt: new Date(CHILD_CREATED_AT.getTime() + 60 * MINUTE) }),
        MIN_MINUTES,
      );
      expect(decision.qualifies).toBe(true);
    });

    it('THE THRESHOLD IS CONFIGURABLE, not baked in: the same candidate flips when it changes', () => {
      const c = candidate({ occurredAt: new Date(CHILD_CREATED_AT.getTime() + 90 * MINUTE) });
      expect(evaluateActivation(c, 60).qualifies).toBe(true);
      expect(evaluateActivation(c, 120).qualifies).toBe(false);
      // A threshold of 0 disables the gate entirely, which an operator may
      // legitimately want during a pilot.
      expect(evaluateActivation(candidate({ occurredAt: CHILD_CREATED_AT }), 0).qualifies).toBe(true);
    });
  });

  describe('CLOCK SANITY — rejected rather than clamped', () => {
    it('a completion BEFORE the child existed is a clock problem, not a fast family', () => {
      const decision = evaluateActivation(
        candidate({ occurredAt: new Date(CHILD_CREATED_AT.getTime() - HOUR) }),
        MIN_MINUTES,
      );
      expect(decision.rejection).toBe('CLOCK_INCONSISTENT');
      // Clamping to 0 would put a 0-minute time-to-value into the median.
      expect(decision.timeToValueMinutes).toBeNull();
    });

    it('a completion BEFORE the family registered is rejected too', () => {
      const decision = evaluateActivation(
        candidate({
          childCreatedAt: new Date(REGISTERED_AT.getTime() - 10 * HOUR),
          occurredAt: new Date(REGISTERED_AT.getTime() - HOUR),
        }),
        MIN_MINUTES,
      );
      expect(decision.rejection).toBe('CLOCK_INCONSISTENT');
    });
  });

  it('time-to-value FLOORS to whole minutes so a stored integer is never rounded up past a boundary', () => {
    const decision = evaluateActivation(
      candidate({ occurredAt: new Date(REGISTERED_AT.getTime() + 150 * MINUTE + 59_000) }),
      MIN_MINUTES,
    );
    expect(decision.timeToValueMinutes).toBe(150);
  });
});

describe('PHASE D (GROWTH) — acquisition attribution', () => {
  it('resolves the fourteen channels from the strings the world actually sends', () => {
    expect(resolveChannel({ source: 'tiktok' })).toBe('TIKTOK');
    expect(resolveChannel({ source: 'TikTok' })).toBe('TIKTOK');
    expect(resolveChannel({ source: 'tik-tok' })).toBe('TIKTOK');
    expect(resolveChannel({ source: 'IG' })).toBe('INSTAGRAM');
    expect(resolveChannel({ source: 'meta' })).toBe('FACEBOOK');
    expect(resolveChannel({ source: 'googleads' })).toBe('GOOGLE');
    expect(resolveChannel({ source: 'schools' })).toBe('SCHOOL');
    expect(resolveChannel({ source: 'parent_community' })).toBe('PARENT_COMMUNITY');
    expect(resolveChannel({ source: 'appstore' })).toBe('APP_STORE');
    expect(resolveChannel({ source: 'android' })).toBe('GOOGLE_PLAY');
  });

  it('A REFERRAL CODE BEATS EVERY OTHER SIGNAL — the channel that gets charged is the channel that gets credited', () => {
    expect(resolveChannel({ source: 'tiktok', referralCode: 'ABCD2345' })).toBe('REFERRAL');
  });

  it('an UNRECOGNISED source is OTHER, never ORGANIC', () => {
    // Filing unknown paid traffic as organic is how a channel report starts
    // lying in the direction that flatters it.
    expect(resolveChannel({ source: 'some-new-network' })).toBe('OTHER');
    expect(resolveChannel({ medium: 'billboard' })).toBe('OTHER');
  });

  it('only a completely empty input is ORGANIC', () => {
    expect(resolveChannel({})).toBe('ORGANIC');
    expect(resolveChannel({ source: '   ' })).toBe('ORGANIC');
    expect(resolveChannel({ source: 'direct' })).toBe('ORGANIC');
  });

  it('falls back to `medium` for clients that send only utm_medium', () => {
    expect(resolveChannel({ medium: 'youtube' })).toBe('YOUTUBE');
  });

  it('captures every field the brief names, normalised', () => {
    const result = normaliseAttribution({
      source: 'TikTok',
      campaign: 'ramadan-2026',
      medium: 'cpc',
      content: 'video-a',
      countryCode: 'eg',
      platform: 'android',
      referralCode: 'abcd2345',
      referrer: 'https://ads.tiktok.com/x',
      landingPage: 'https://abny.app/ar/parents',
      sessionId: 'sess-123',
    });

    expect(result.channel).toBe('REFERRAL'); // the code wins, per the rule above
    expect(result.source).toBe('TikTok');
    expect(result.campaign).toBe('ramadan-2026');
    expect(result.medium).toBe('cpc');
    expect(result.content).toBe('video-a');
    expect(result.countryCode).toBe('EG');
    expect(result.platform).toBe('ANDROID');
    expect(result.referralCode).toBe('ABCD2345');
    expect(result.referrer).toBe('https://ads.tiktok.com/x');
    expect(result.landingPage).toBe('https://abny.app/ar/parents');
    expect(result.sessionId).toBe('sess-123');
  });

  it('DOES NOT TRUST THE CLIENT: control characters stripped, over-length truncated, bad country dropped', () => {
    const result = normaliseAttribution({
      source: 'tik\ntok ',
      campaign: 'x'.repeat(500),
      countryCode: 'EGYPT',
      platform: 'PLAYSTATION',
      referrer: 'y'.repeat(900),
    });

    expect(result.source).toBe('tiktok');
    expect(result.campaign).toHaveLength(120);
    // An invalid country is DROPPED, not defaulted to a launch market — a
    // wrong country would silently move a household into the wrong P&L.
    expect(result.countryCode).toBeNull();
    expect(result.platform).toBe('UNKNOWN');
    expect(result.referrer).toHaveLength(400);
  });

  it('an absent attribution is a valid one — a direct install has no UTM at all', () => {
    const result = normaliseAttribution({});
    expect(result.channel).toBe('ORGANIC');
    expect(result.source).toBeNull();
    expect(result.countryCode).toBeNull();
    expect(result.platform).toBe('UNKNOWN');
  });

  it('the channel vocabulary is exactly the fourteen the brief names', () => {
    expect([...ACQUISITION_CHANNELS].sort()).toEqual(
      [
        'APP_STORE', 'FACEBOOK', 'GOOGLE', 'GOOGLE_PLAY', 'INFLUENCER', 'INSTAGRAM',
        'ORGANIC', 'OTHER', 'PARENT_COMMUNITY', 'PARTNERSHIP', 'REFERRAL', 'SCHOOL',
        'TIKTOK', 'YOUTUBE',
      ].sort(),
    );
  });
});

describe('PHASE D (GROWTH) — the event catalogue and the funnel', () => {
  it('declares all nineteen events the brief names', () => {
    const required = [
      'APP_INSTALLED', 'ACCOUNT_CREATED', 'FAMILY_CREATED', 'CHILD_ADDED', 'DEVICE_PAIRED',
      'GOAL_CREATED', 'GOAL_STARTED', 'GOAL_COMPLETED', 'REWARD_GRANTED', 'REWARD_REDEEMED',
      'AI_MESSAGE_SENT', 'AI_MESSAGE_RECEIVED', 'TRIAL_STARTED', 'SUBSCRIPTION_STARTED',
      'PAYMENT_SUCCESS', 'PAYMENT_FAILED', 'SUBSCRIPTION_CANCELLED', 'REFERRAL_SENT',
      'REFERRAL_CONVERTED',
    ];
    for (const name of required) expect(GROWTH_EVENT_NAMES).toContain(name);
    // Plus the activation event, which the brief names separately.
    expect(GROWTH_EVENT_NAMES).toContain('CHILD_COMPLETES_FIRST_MEANINGFUL_GOAL');
    expect(GROWTH_EVENT_NAMES).toHaveLength(20);
  });

  it('every event names its producer and says whether it had a prior domain signal', () => {
    for (const name of GROWTH_EVENT_NAMES) {
      const d = GROWTH_EVENT_CATALOGUE[name];
      expect(d.producer.length).toBeGreaterThan(5);
      if (d.hadPriorDomainSignal) expect(d.priorSignal).not.toBeNull();
      else expect(d.priorSignal).toBeNull();
    }
  });

  it('APP_INSTALLED is the ONLY event a client may originate', () => {
    expect([...CLIENT_INGESTIBLE_GROWTH_EVENTS]).toEqual(['APP_INSTALLED']);
    // Everything else describes a fact the server wrote. Accepting a client's
    // word for a payment or a referral conversion would be an API for
    // manufacturing revenue markers and reward credit.
    expect(CLIENT_INGESTIBLE_GROWTH_EVENTS.has('PAYMENT_SUCCESS')).toBe(false);
    expect(CLIENT_INGESTIBLE_GROWTH_EVENTS.has('REFERRAL_CONVERTED')).toBe(false);
  });

  it('APP_INSTALLED is the only ANONYMOUS event — everything else is family-scoped', () => {
    const anonymous = GROWTH_EVENT_NAMES.filter((n) => GROWTH_EVENT_CATALOGUE[n].tenancy === 'ANONYMOUS');
    expect(anonymous).toEqual(['APP_INSTALLED']);
  });

  it('the funnel has the eleven steps of the brief, in order', () => {
    expect([...FUNNEL_STEPS]).toEqual([
      'IMPRESSION', 'VISIT', 'INSTALL', 'REGISTRATION', 'FAMILY_CREATED',
      'CHILD_ADDED', 'FIRST_GOAL', 'FIRST_REWARD', 'TRIAL', 'PAID', 'RENEWAL',
    ]);
  });

  describe('PRIVACY — the payload allow-list (CONTEXT §3 principle 8)', () => {
    it('contains no child identifier, no name, no birth date, no message content', () => {
      for (const forbidden of [
        'childId', 'childName', 'firstName', 'lastName', 'dateOfBirth', 'messageText',
        'email', 'phone', 'deviceId', 'ipAddress', 'appPackage', 'url',
      ]) {
        expect(ALLOWED_PAYLOAD_KEYS.has(forbidden)).toBe(false);
      }
    });

    it('contains the dimensions a funnel genuinely needs, and they are counts or enums', () => {
      for (const allowed of ['countryCode', 'channel', 'campaign', 'planTier', 'childCount', 'completionKind']) {
        expect(ALLOWED_PAYLOAD_KEYS.has(allowed)).toBe(true);
      }
    });
  });
});
