/**
 * PHASE F (`F6-007`) — EVERY NOTIFICATION HAS A DESTINATION, AND THE CATALOGUE
 * IS THE LIST.
 *
 * THE PROPERTY THIS FILE EXISTS FOR is the first test below, and it is written
 * against `copyKeys()` rather than against a literal array of thirty strings on
 * purpose: a hand-written list rots in a week, and the failure it would hide —
 * «somebody added a sentence and forgot the tap» — is exactly the failure that
 * produced this feature (a repo-wide grep for `deepLink` returned nothing at
 * all). Enumerating the catalogue means a key added tomorrow fails a test today.
 *
 * Everything else here is a rule from `notification-destination.ts`'s header,
 * turned into an assertion.
 */
import {
  COPY_CATALOGUE,
  copyKeys,
} from '../../src/modules/notifications/domain/engine/notification-copy';
import {
  DEEP_LINK_SURFACES,
  NOTIFICATION_DEEP_LINK_DATA_KEY,
  NOTIFICATION_INBOX_LINK,
  destinationKeys,
  hasExplicitDestination,
  isUsableDeepLinkId,
  isValidDeepLink,
  resolveNotificationDestination,
} from '../../src/modules/notifications/domain/engine/notification-destination';
import type { ToneAudience } from '../../src/modules/notifications/domain/engine/notification-tone';

/** A real UUID, so the id-bearing branch is exercised with something the
 * validator accepts rather than with a shape that only looks right. */
const A_UUID = '3f9a1c62-5b6d-4a3e-9f2c-1d8e7b6a5c40';

const audienceOf = (key: string): ToneAudience => COPY_CATALOGUE[key].audience;

describe('PHASE F — the notification destination map', () => {
  // ==========================================================================
  // 1. EXHAUSTIVENESS — the whole point of the file
  // ==========================================================================
  describe('every copy key resolves to a destination', () => {
    it.each(copyKeys())('%s has an EXPLICIT destination rule', (key) => {
      // Not `resolve(...) !== null` — `resolve` is total, so it would pass for a
      // key nobody mapped. The assertion is that somebody DECIDED.
      expect(hasExplicitDestination(key)).toBe(true);
    });

    it.each(copyKeys())('%s resolves to a routable abny:// link for its own audience', (key) => {
      const link = resolveNotificationDestination({ copyKey: key, audience: audienceOf(key) });
      expect(typeof link).toBe('string');
      expect(link.length).toBeGreaterThan(0);
      expect(link.startsWith('abny://')).toBe(true);
      expect(isValidDeepLink(link)).toBe(true);
    });

    it('has no destination rule for a key that is not in the catalogue', () => {
      // The other direction: a rule nobody can reach is a rule that is silently
      // wrong, and it is how this table would drift away from the catalogue.
      const catalogue = new Set(copyKeys());
      expect(destinationKeys().filter((key) => !catalogue.has(key))).toEqual([]);
    });

    it('the catalogue is not empty and the two lists are the same size', () => {
      // Guards the guard: an `it.each([])` passes vacuously, and a catalogue
      // that failed to import would make every assertion above disappear.
      expect(copyKeys().length).toBeGreaterThanOrEqual(25);
      expect(destinationKeys().length).toBe(copyKeys().length);
    });
  });

  // ==========================================================================
  // 2. AUDIENCE — the same event, two readers, two destinations
  // ==========================================================================
  describe('the audience decides where the tap lands', () => {
    it('a granted reward sends the CHILD to the reward and the PARENT to the work', () => {
      // One cause — `REWARD_GRANTED` — produces two candidates and two copy
      // keys (`notification-reward.consumer.ts` fires both). They must not land
      // in the same place: the child collects, the parent encourages.
      const child = resolveNotificationDestination({
        copyKey: 'REWARD_GRANTED_CHILD',
        audience: 'CHILD',
      });
      const parentWithGoal = resolveNotificationDestination({
        copyKey: 'REWARD_GRANTED_WITH_GOAL',
        audience: 'PARENT',
      });
      const parentWithoutGoal = resolveNotificationDestination({
        copyKey: 'REWARD_GRANTED',
        audience: 'PARENT',
      });

      expect(child).toBe('abny://rewards');
      expect(parentWithGoal).toBe('abny://goals');
      expect(parentWithoutGoal).toBe('abny://progress');
      expect(parentWithGoal).not.toBe(child);
      expect(parentWithoutGoal).not.toBe(child);
    });

    it('a parent-only surface is never handed to a child, whatever the key says', () => {
      // `CHILD_REQUEST` and the two billing keys are PARENT entries. If a later
      // edit ever routed a child-audience candidate through one of them, the
      // child's app would be handed a screen it does not have — a silent no-op,
      // which is the defect this feature removes.
      for (const key of ['CHILD_REQUEST', 'SUBSCRIPTION_EXPIRING', 'PAYMENT_FAILED']) {
        expect(resolveNotificationDestination({ copyKey: key, audience: 'PARENT' })).not.toBe(
          NOTIFICATION_INBOX_LINK,
        );
        expect(resolveNotificationDestination({ copyKey: key, audience: 'CHILD' })).toBe(
          NOTIFICATION_INBOX_LINK,
        );
      }
    });

    it('every child-facing key resolves to a surface the child app can service', () => {
      const parentOnly = new Set(['child', 'approvals', 'approval', 'subscription']);
      for (const key of copyKeys().filter((k) => audienceOf(k) === 'CHILD')) {
        const link = resolveNotificationDestination({ copyKey: key, audience: 'CHILD' });
        const surface = link.replace('abny://', '').split('/')[0];
        expect(parentOnly.has(surface)).toBe(false);
      }
    });
  });

  // ==========================================================================
  // 3. IDS — only ones the server has, never a tenant's, never a payload's
  // ==========================================================================
  describe('identifiers', () => {
    it('produces NO identifier at all for any catalogue key on the real emission path', () => {
      // The engine passes `{ copyKey, audience }` and nothing else, because
      // `notifications.data` is pinned identifier-free by `e2e-13 STEP 14`. So
      // the whole map must be answerable without an id — asserted here over
      // every key rather than trusted.
      const tenantish = [
        '11111111-2222-3333-4444-555555555555', // a familyId shape
        'family',
        'child_id',
        '@',
      ];
      for (const key of copyKeys()) {
        const link = resolveNotificationDestination({ copyKey: key, audience: audienceOf(key) });
        // No path segment at all: `abny://<surface>` and nothing after it.
        expect(link.split('/').length).toBe(3);
        for (const needle of tenantish) expect(link).not.toContain(needle);
      }
    });

    it('emits the LIST form when the id is absent and the ITEM form when it is real', () => {
      expect(resolveNotificationDestination({ copyKey: 'GOAL_ALMOST_DONE', audience: 'CHILD' })).toBe(
        'abny://goals',
      );
      expect(
        resolveNotificationDestination({
          copyKey: 'GOAL_ALMOST_DONE',
          audience: 'CHILD',
          programId: A_UUID,
        }),
      ).toBe(`abny://goal/${A_UUID}`);
      expect(
        resolveNotificationDestination({
          copyKey: 'CHILD_REQUEST',
          audience: 'PARENT',
          achievementId: A_UUID,
        }),
      ).toBe(`abny://approval/${A_UUID}`);
      expect(
        resolveNotificationDestination({
          copyKey: 'SCREEN_TIME_EXCEEDED',
          audience: 'PARENT',
          alertId: A_UUID,
        }),
      ).toBe(`abny://safety/${A_UUID}`);
    });

    it('refuses anything that is not a UUID rather than escaping it', () => {
      // `DigitalWellbeingEngineService` spreads a DEVICE-supplied `metadata`
      // object into the notification payload. If a producer-shaped string ever
      // reached this layer as an id, it must not become a path segment.
      const hostile = [
        '../../admin',
        'abc/def',
        'goals?token=secret',
        'https://evil.example',
        'صفحة',
        '',
        '   ',
        A_UUID.toUpperCase().replace('-', ''),
        null,
        undefined,
        42 as unknown as string,
        { toString: () => A_UUID } as unknown as string,
      ];
      for (const programId of hostile) {
        const link = resolveNotificationDestination({
          copyKey: 'GOAL_ALMOST_DONE',
          audience: 'CHILD',
          programId: programId as string,
        });
        expect(link).toBe('abny://goals');
        expect(isValidDeepLink(link)).toBe(true);
      }
      expect(isUsableDeepLinkId(A_UUID)).toBe(true);
      expect(isUsableDeepLinkId('not-a-uuid')).toBe(false);
    });
  });

  // ==========================================================================
  // 4. TOTALITY — a tap always lands, and nothing here ever throws
  // ==========================================================================
  describe('an unknown or malformed key lands in the inbox and never throws', () => {
    const malformed: unknown[] = [
      'NOT_A_KEY',
      '',
      '   ',
      'generic',
      'GENERIC ',
      '__proto__',
      'constructor',
      'toString',
      'hasOwnProperty',
      null,
      undefined,
      42,
      {},
      [],
      Symbol('GENERIC'),
    ];

    it.each(malformed.map((k) => [String(typeof k === 'symbol' ? 'Symbol()' : k), k]))(
      'copyKey=%s resolves to the inbox',
      (_label, key) => {
        let link: string | undefined;
        expect(() => {
          link = resolveNotificationDestination({
            copyKey: key as string,
            audience: 'PARENT',
          });
        }).not.toThrow();
        expect(link).toBe(NOTIFICATION_INBOX_LINK);
      },
    );

    it('survives a request object with no fields at all', () => {
      expect(() =>
        resolveNotificationDestination({} as unknown as { copyKey: string; audience: ToneAudience }),
      ).not.toThrow();
      expect(
        resolveNotificationDestination({} as unknown as { copyKey: string; audience: ToneAudience }),
      ).toBe(NOTIFICATION_INBOX_LINK);
    });

    it('the fallback is the inbox surface, spelled once', () => {
      expect(NOTIFICATION_INBOX_LINK).toBe('abny://notifications');
      expect(isValidDeepLink(NOTIFICATION_INBOX_LINK)).toBe(true);
      expect(NOTIFICATION_DEEP_LINK_DATA_KEY).toBe('deepLink');
    });
  });

  // ==========================================================================
  // 5. THE SCHEME ITSELF
  // ==========================================================================
  describe('the URI scheme', () => {
    it('accepts exactly the canonical surfaces and nothing else', () => {
      for (const surface of DEEP_LINK_SURFACES) {
        const idBearing = ['goal', 'approval', 'safety', 'child'].includes(surface);
        expect(isValidDeepLink(`abny://${surface}`)).toBe(!idBearing);
        expect(isValidDeepLink(`abny://${surface}/${A_UUID}`)).toBe(idBearing);
      }
      expect(DEEP_LINK_SURFACES).toHaveLength(12);
    });

    it('rejects anything that is not a bare abny:// surface link', () => {
      for (const bad of [
        'https://abny.app/goals',
        'abny://goals?token=abc',
        'abny://goals#top',
        'abny://GOALS',
        'abny://unknown-surface',
        'abny://goal/not-a-uuid',
        'abny://goals/extra',
        'abny:/goals',
        'abny://',
        '',
        null,
        undefined,
        7,
      ]) {
        expect(isValidDeepLink(bad)).toBe(false);
      }
    });
  });
});
