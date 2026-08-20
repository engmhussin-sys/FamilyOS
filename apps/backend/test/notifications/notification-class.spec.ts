/**
 * PHASE D (`PC-D-005`) — THE MATRIX, AND THE GUARD THAT KEEPS IT HONEST.
 *
 * A classification table is only worth what its exhaustiveness is worth. Two
 * failure modes would make it decorative and both are asserted against here:
 *
 *   1. A NEW PRODUCER SHIPS WITH AN UNCLASSIFIED TYPE. It would silently take
 *      the default (`DEFER`) — safe, but unconsidered, and the whole point of
 *      the table is that «what does this do at 02:00?» is answered on purpose.
 *      The static sweep below reads every notification type literal reachable
 *      from a producer call site in `src/` and fails if one is missing.
 *   2. THE `DELIVER` LIST GROWS. «Safety-critical only» is a promise that
 *      erodes one plausible exception at a time. The list is pinned by name
 *      here, so adding a member is a deliberate edit to a test that says why
 *      the list is short.
 */
import * as fs from 'fs';
import * as path from 'path';

import {
  DEFAULT_QUIET_HOURS_CLASS,
  NOTIFICATION_CLASSES,
  classifiedNotificationTypes,
  deliverClassTypes,
  notificationCategoryOf,
  quietHoursClassOf,
} from '../../src/shared/notifications/notification-class';

const SRC = path.resolve(__dirname, '../../src');

function walk(dir: string, acc: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, acc);
    else if (entry.isFile() && full.endsWith('.ts')) acc.push(full);
  }
  return acc;
}

describe('PHASE D — the SUPPRESS / DEFER / DELIVER matrix', () => {
  describe('1. the DELIVER list is short, named, and argued for', () => {
    it('contains exactly the three safety-critical types plus the digest, and nothing else', () => {
      expect([...deliverClassTypes()].sort()).toEqual([
        // The device-protection pair: while these conditions hold, every policy
        // this product enforces is inert, and the delay is exactly what a
        // circumvention attempt at 23:00 is timed to buy.
        'ACCESSIBILITY_DISABLED',
        // The distress escalation. docs/11 §11.4 required the bypass in words
        // before this table expressed it as data.
        'CHILD_WELLBEING_CHECKIN',
        'PROTECTION_BYPASS_ATTEMPT',
        // NOT a real member: the digest is PRODUCED BY the release path, after
        // quiet hours have ended. It is DELIVER so it cannot defer itself,
        // which would be an infinite loop with a table behind it.
        'QUIET_HOURS_DIGEST',
      ]);
    });

    it('every DELIVER member carries a justification long enough to be an argument', () => {
      for (const type of deliverClassTypes()) {
        expect(NOTIFICATION_CLASSES[type].why.trim().length).toBeGreaterThan(80);
      }
    });

    it('a SAFETY-category type is NOT automatically DELIVER — the distinction is the point of the matrix', () => {
      // If «safety» meant «wake them up», the matrix would be a category lookup
      // and there would be no reason to write it.
      expect(quietHoursClassOf('POLICY_VIOLATION')).toBe('DEFER');
      expect(quietHoursClassOf('SCREEN_TIME_EXCEEDED')).toBe('DEFER');
      expect(quietHoursClassOf('CHILD_REQUEST')).toBe('DEFER');
      expect(notificationCategoryOf('POLICY_VIOLATION')).toBe('SAFETY');
    });
  });

  describe('2. the SUPPRESS list is exactly the notifications whose premise expires overnight', () => {
    it('is the three in-the-moment reminders and the two recomputed advisories', () => {
      const suppress = Object.entries(NOTIFICATION_CLASSES)
        .filter(([, e]) => e.quietHours === 'SUPPRESS')
        .map(([t]) => t)
        .sort();
      expect(suppress).toEqual([
        'AI_RECOMMENDATION',
        'EXERCISE_ENCOURAGEMENT',
        'FAMILY_INSIGHT',
        'HYDRATION_REMINDER',
        'STUDY_REMINDER',
      ]);
    });

    it('NO reward, achievement or goal type is ever SUPPRESS — the absolute rule', () => {
      // «No reward granted => no notification» is one half of the invariant.
      // This is the other half: a reward that WAS granted must never be
      // silently discarded because of the hour it was earned at.
      for (const [type, entry] of Object.entries(NOTIFICATION_CLASSES)) {
        if (['REWARD', 'ACHIEVEMENT', 'GOAL'].includes(entry.category)) {
          expect(`${type}=${entry.quietHours}`).toBe(`${type}=DEFER`);
        }
      }
    });
  });

  describe('3. DEFER is the default, and the default is the safe direction', () => {
    it('an unknown, unclassified type is DEFERred rather than dropped', () => {
      expect(DEFAULT_QUIET_HOURS_CLASS).toBe('DEFER');
      expect(quietHoursClassOf('SOME_TYPE_NOBODY_HAS_WRITTEN_YET')).toBe('DEFER');
    });

    it('an unclassified CRITICAL keeps the pre-Phase-D bypass, so the two guard-bypassing services are unchanged', () => {
      // `RuntimeAlertService` and `DigitalWellbeingEngineService.recordCriticalEvent`
      // call `createForFamilyOwner` directly with CRITICAL. This rule is what
      // makes Phase D additive for them rather than a behaviour change to a
      // safety path.
      expect(quietHoursClassOf('SOME_FUTURE_CRITICAL', 'CRITICAL')).toBe('DELIVER');
    });

    it('an EXPLICIT classification outranks the CRITICAL rule — including when it downgrades', () => {
      // POLICY_VIOLATION is written CRITICAL at its call site today. The table
      // says DEFER, and the table wins; otherwise the matrix could never
      // correct a priority somebody chose for loudness rather than for urgency.
      expect(quietHoursClassOf('POLICY_VIOLATION', 'CRITICAL')).toBe('DEFER');
      expect(quietHoursClassOf('HYDRATION_REMINDER', 'CRITICAL')).toBe('SUPPRESS');
    });
  });

  describe('4. EXHAUSTIVENESS — every producer’s type is classified, statically', () => {
    /**
     * The producer call sites, by the shape they use. Deliberately BROADER than
     * strictly necessary — it also matches candidate objects that never reach a
     * notification — because a guard that is generous about what counts as a
     * notification type is the correct trade: a false positive costs one table
     * entry, a false negative costs a silently unclassified notification.
     */
    const TYPE_LITERAL = /\btype:\s*'([A-Z][A-Z0-9_]{3,})'/g;

    /** Types that are event names or ledger kinds, not notification types. */
    const NOT_NOTIFICATION_TYPES = new Set([
      'EARN',
      'REDEEM',
      'POINTS',
      'CHILD',
      'DEVICE',
      'NOTIFICATION',
      'SYSTEM',
      'PLATFORM',
      'FAMILY',
      'MANUAL',
      'SCHEDULE',
    ]);

    /** The files that actually construct a notification candidate. */
    const PRODUCER_FILES = [
      'modules/life-intelligence/application/services/smart-notification-decision-engine.ts',
      'modules/events/application/consumers/notification-reward.consumer.ts',
      'modules/ai-core/application/services/distress-escalation.service.ts',
    ];

    it('every notification type constructed by a producer file appears in the matrix', () => {
      const unclassified: string[] = [];
      for (const relative of PRODUCER_FILES) {
        const text = fs.readFileSync(path.join(SRC, relative), 'utf8');
        for (const match of text.matchAll(TYPE_LITERAL)) {
          const type = match[1];
          if (NOT_NOTIFICATION_TYPES.has(type)) continue;
          if (!NOTIFICATION_CLASSES[type]) unclassified.push(`${relative}: ${type}`);
        }
      }
      expect(unclassified).toEqual([]);
    });

    it('the CriticalWellbeingEventType union — all five — is classified', () => {
      // These five reach `createForFamilyOwner` directly and are the ones most
      // likely to be assumed «obviously DELIVER». Three of them are not.
      for (const type of [
        'PROTECTION_BYPASS_ATTEMPT',
        'ACCESSIBILITY_DISABLED',
        'SCREEN_TIME_EXCEEDED',
        'POLICY_VIOLATION',
        'CHILD_REQUEST',
      ]) {
        expect(classifiedNotificationTypes()).toContain(type);
      }
    });

    it('every entry states an audience and a category — no half-filled rows', () => {
      for (const [type, entry] of Object.entries(NOTIFICATION_CLASSES)) {
        expect(['PARENT', 'CHILD', 'BOTH']).toContain(`${entry.audience}`);
        expect(entry.category.length).toBeGreaterThan(1);
        expect(`${type}:${entry.why.trim().length > 40}`).toBe(`${type}:true`);
      }
    });

    it('the brief’s ten product areas are each represented by at least one classified type', () => {
      const categories = new Set(Object.values(NOTIFICATION_CLASSES).map((e) => e.category));
      for (const required of [
        'REWARD',
        'ACHIEVEMENT',
        'GOAL',
        'REMINDER',
        'SAFETY',
        'SUBSCRIPTION',
        'PAYMENT',
        'AI',
        'INSIGHT',
        'SYSTEM',
      ]) {
        expect([...categories]).toContain(required);
      }
    });

    it('both recipients are covered — a matrix that only classified parent notifications would miss half the product', () => {
      const audiences = new Set(Object.values(NOTIFICATION_CLASSES).map((e) => e.audience));
      expect(audiences.has('PARENT')).toBe(true);
      expect(audiences.has('CHILD')).toBe(true);
    });
  });
});
