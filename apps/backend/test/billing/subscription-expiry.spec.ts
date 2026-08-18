/**
 * SPRINT F1 — THE «IS THIS SUBSCRIPTION EXPIRING?» RULE, ARGUED WITHOUT A
 * DATABASE.
 *
 * `billing-notifications.e2e.spec.ts` proves the whole chain against a real
 * PostgreSQL. This file proves the DECISION, which is a pure function of
 * (status, `current_period_end`, instant, timezone) and should be readable as
 * one. The split is the same one `stalled-goal.types.ts` and its e2e make: a
 * suite that needs a database to answer «four days or three?» is a suite
 * nobody re-reads when the number changes.
 *
 * The three properties that actually matter, and each has its own section:
 *   1. WHICH STATUS may have a renewal approaching at all.
 *   2. WHERE the window's two edges are, and that both are closed.
 *   3. THAT THE DAY IS THE FAMILY'S — including on the two pathological days
 *      of the year, which is where an elapsed-milliseconds implementation
 *      silently gives the wrong answer.
 */
import {
  EXPIRY_NOTICE_STATUSES,
  SUBSCRIPTION_EXPIRY_LEAD_DAYS,
  subscriptionExpiryNotice,
} from '../../src/modules/billing/domain/subscription-expiry';
import { CANONICAL_SUBSCRIPTION_STATUSES, toPersistedStatus } from '../../src/modules/billing/domain/subscription-status';
import type { SubscriptionStatusValue } from '../../src/modules/billing/domain/billing.types';

const CAIRO = 'Africa/Cairo';
const RIYADH = 'Asia/Riyadh';

/** 12:00 Cairo / 13:00 Riyadh on 16 January 2026 — the same calendar day in both. */
const MIDDAY = new Date('2026-01-16T10:00:00.000Z');

const ask = (
  status: SubscriptionStatusValue,
  currentPeriodEnd: Date | null,
  now: Date = MIDDAY,
  timeZone: string = CAIRO,
) => subscriptionExpiryNotice({ status, currentPeriodEnd }, now, timeZone);

describe('SPRINT F1 — which subscriptions have a renewal approaching', () => {
  it('ACTIVE is the only status a renewal notice can be produced from', () => {
    // Read from the production constant rather than restated, so widening the
    // set is a decision someone has to defend here rather than a diff nobody
    // notices.
    expect([...EXPIRY_NOTICE_STATUSES]).toEqual(['ACTIVE']);
  });

  it('every OTHER persisted status is silent, three days out, with the renewal date present', () => {
    const threeDaysOut = new Date('2026-01-19T10:00:00.000Z');
    const others = CANONICAL_SUBSCRIPTION_STATUSES.map(toPersistedStatus).filter((s) => s !== 'ACTIVE');

    // Derived from `subscription-status.ts`'s own total map, so a NINTH status
    // added to the enum lands here as a new case rather than as a gap: it will
    // be silent by default, which is the safe direction, and this assertion
    // will still be the place that says so.
    expect(others).toHaveLength(7);
    for (const status of others) {
      expect([status, ask(status, threeDaysOut)]).toEqual([status, null]);
    }
  });

  it('a TRIAL ending in three days is not a renewal — different column, different fact', () => {
    // `trial_ends_at` is what a trial has, and the catalogue has no trial
    // sentence. Borrowing «يتبقى ٣ أيام على تجديد اشتراكك» would tell a parent
    // their subscription renews when they have never paid for one.
    expect(ask('TRIALING', new Date('2026-01-19T10:00:00.000Z'))).toBeNull();
  });

  it('no renewal date means no notice — the one number the sentence states is not guessed', () => {
    expect(ask('ACTIVE', null)).toBeNull();
  });
});

describe('SPRINT F1 — the window, and both of its edges', () => {
  const at = (iso: string) => ask('ACTIVE', new Date(iso));

  it('the default lead time is three days, and it is the number production exports', () => {
    expect(SUBSCRIPTION_EXPIRY_LEAD_DAYS).toBe(3);
  });

  it('one, two and three days out all produce a notice, and each states its own number', () => {
    expect(at('2026-01-17T10:00:00.000Z')?.daysRemaining).toBe(1);
    expect(at('2026-01-18T10:00:00.000Z')?.daysRemaining).toBe(2);
    expect(at('2026-01-19T10:00:00.000Z')?.daysRemaining).toBe(3);
  });

  it('FOUR days out is silence — the upper edge is closed', () => {
    expect(at('2026-01-20T10:00:00.000Z')).toBeNull();
  });

  it('the renewal day ITSELF is silence — the lower edge is closed at ONE, not zero', () => {
    // «يتبقى ٠ يومًا» is not a sentence anyone writes, and the charge is
    // happening today: what the parent needs now is its OUTCOME.
    expect(at('2026-01-16T18:00:00.000Z')).toBeNull();
  });

  it('a renewal already in the past is silence, not a negative countdown', () => {
    expect(at('2026-01-10T10:00:00.000Z')).toBeNull();
  });

  it('the notice carries the renewal day itself — which is what the dedupe key is built on', () => {
    const notice = at('2026-01-19T10:00:00.000Z');
    expect(notice?.renewalBusinessDate).toBe('2026-01-19');
    expect(notice?.todayBusinessDate).toBe('2026-01-16');
  });

  it('a WIDER lead time is a parameter, not an edit — three days is a default, not a law', () => {
    const seven = subscriptionExpiryNotice(
      { status: 'ACTIVE', currentPeriodEnd: new Date('2026-01-21T10:00:00.000Z') },
      MIDDAY,
      CAIRO,
      7,
    );
    expect(seven?.daysRemaining).toBe(5);
  });
});

describe('SPRINT F1 — the day belongs to the family, not to the server', () => {
  it('ONE instant and ONE renewal timestamp give Cairo four days and Riyadh three', () => {
    // 21:30Z is 23:30 on the 15th in Cairo and 00:30 on the 16th in Riyadh.
    // Egypt observes DST and Saudi Arabia does not, so in January the two
    // launch markets are an hour apart — read from tzdata, never written down.
    const now = new Date('2026-01-15T21:30:00.000Z');
    const renewal = new Date('2026-01-19T10:00:00.000Z');

    expect(ask('ACTIVE', renewal, now, CAIRO)).toBeNull();
    expect(ask('ACTIVE', renewal, now, RIYADH)?.daysRemaining).toBe(3);

    // AND THE UTC ANSWER IS THE CAIRO ONE, which is the failure this guards
    // against: a producer that derived its day from
    // `toISOString().slice(0, 10)` would silence the Riyadh household and
    // never be noticed, because it would be right for the other market.
    expect(now.toISOString().slice(0, 10)).toBe('2026-01-15');
  });

  it('the count survives Cairo’s 23-hour day — the spring-forward that has no 00:00', () => {
    // Egypt's DST transition happens AT MIDNIGHT: local 00:00 jumps to 01:00,
    // so the last Friday of April is 23 hours long. An implementation that
    // divided elapsed milliseconds by 86,400,000 reads 2.96 days here and
    // floors to two; walking the calendar reads three, which is what the
    // parent's own calendar says.
    const now = new Date('2026-04-22T09:00:00.000Z');
    const renewal = new Date('2026-04-25T09:00:00.000Z');
    const notice = ask('ACTIVE', renewal, now, CAIRO);
    expect(notice?.daysRemaining).toBe(3);
    expect(notice?.renewalBusinessDate).toBe('2026-04-25');
  });

  it('and Cairo’s 25-hour day, the autumn fall-back, counts the same three days', () => {
    const now = new Date('2026-10-27T09:00:00.000Z');
    const renewal = new Date('2026-10-30T09:00:00.000Z');
    expect(ask('ACTIVE', renewal, now, CAIRO)?.daysRemaining).toBe(3);
  });

  it('Riyadh, which has no DST at all, gives the same three days across the same dates', () => {
    // The point is the CONTRAST: nothing in the rule special-cases either zone,
    // and the two answers agree here because tzdata says they should.
    expect(
      ask('ACTIVE', new Date('2026-04-25T09:00:00.000Z'), new Date('2026-04-22T09:00:00.000Z'), RIYADH)
        ?.daysRemaining,
    ).toBe(3);
  });
});
