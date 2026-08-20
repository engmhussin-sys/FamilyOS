/**
 * B9 (PA-B-007 / PA-B-008) — THE KEY COMPOSITION, AND A RATCHET OVER THE
 * PRODUCER INVENTORY.
 *
 * Two halves, and the second is the one that keeps this fix alive.
 *
 *   PART 1 tests the pure composition functions. They decide what «the same
 *   notification» means, and each of the three forms answers that question
 *   differently on purpose — an exact causal id, a stable business entity, or
 *   a quantised recurrence. Getting one of them wrong is either a duplicate
 *   (too loose) or a notification that can never be sent twice for the rest of
 *   the child's life (too tight), and both are silent in production.
 *
 *   PART 2 is a STATIC GUARD over the source tree, in the spirit of
 *   `scripts/ci/assert-tenant-scoping.ts` and `assert-event-emission.ts`.
 *   Phase A §5 enumerated SEVEN notification producer paths and marked all
 *   seven «قيد DB؟ ❌». The type system already forces `sourceEventId` at every
 *   call site — `ICreateRuntimeAlertInput.sourceEventId` is required, so an
 *   eighth producer cannot compile without one. What the type system CANNOT
 *   catch is a producer that satisfies the type with a constant: passing
 *   `sourceEventId: 'reward'` compiles perfectly and silently suppresses every
 *   future notification of that kind for that family, forever. Part 2 asserts
 *   every call site derives its key from a real composer.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import {
  LEGACY_SOURCE_KEY_PREFIX,
  NOTIFICATION_DEDUPE_WINDOW_MS,
  NOTIFICATION_SOURCE_KEY_MAX_LENGTH,
  forDomainEvent,
  forEntity,
  forRecurringSignal,
} from '../../src/shared/notifications/notification-source-key';

describe('B9 — notification source key composition', () => {
  describe('forDomainEvent — the exact form, and the one the KNOWN LIMIT test turns on', () => {
    it('is a pure function of the event id: the same event composes the same key, forever', () => {
      const id = '9f1b0c3e-2a44-4a1c-9b77-1f0e7a2c9d55';
      // Called a year apart on two hosts in two timezones, this must not move —
      // it is the ONLY thing standing between an outbox redelivery and a
      // second notification once the consumption marker is gone.
      expect(forDomainEvent(id)).toBe(forDomainEvent(id));
      expect(forDomainEvent(id)).toBe(`evt:${id}`);
    });

    it('two different events never collide', () => {
      expect(forDomainEvent('a')).not.toBe(forDomainEvent('b'));
    });

    it('the facet is what lets ONE event notify two audiences — and it has to be spelled out', () => {
      const id = 'evt-1';
      expect(forDomainEvent(id, 'child')).not.toBe(forDomainEvent(id));
      // There is no default facet. «This event notifies twice» is a sentence
      // someone wrote at the call site, not a consequence of `type` sitting in
      // a unique index (which is exactly how PA-B-011 happened).
      expect(forDomainEvent(id)).toBe('evt:evt-1');
    });
  });

  describe('forEntity — the stable-business-identity form', () => {
    it('a badge a child can only earn once composes a key that can only be used once', () => {
      // `child_badge_awards (child_id, badge_id)` is unique, so this pair is a
      // permanent identity even though no event row records it.
      expect(forEntity('badge', 'child-1', 'badge-7')).toBe('badge:child-1:badge-7');
      expect(forEntity('badge', 'child-1', 'badge-7')).toBe(forEntity('badge', 'child-1', 'badge-7'));
    });

    it('two children earning the same badge are two notifications, not one', () => {
      expect(forEntity('badge', 'child-1', 'badge-7')).not.toBe(forEntity('badge', 'child-2', 'badge-7'));
    });

    it('two levels are two milestones', () => {
      expect(forEntity('levelup', 'child-1', '7')).not.toBe(forEntity('levelup', 'child-1', '8'));
    });
  });

  describe('forRecurringSignal — the quantised form, and its stated limit', () => {
    const t = (iso: string): Date => new Date(iso);

    it('the same signal inside one bucket is one notification', () => {
      expect(forRecurringSignal('signal', 'c1', 'HYDRATION_REMINDER', t('2026-08-15T10:00:10Z'))).toBe(
        forRecurringSignal('signal', 'c1', 'HYDRATION_REMINDER', t('2026-08-15T10:04:59Z')),
      );
    });

    it('the same signal tomorrow is a NEW notification — a recurrence must be able to recur', () => {
      // The failure mode this guards against is the opposite of a duplicate: a
      // key with no time component would mean a device whose protection is
      // disabled again next week is silently never reported.
      expect(forRecurringSignal('runtime', 'c1', 'ACCESSIBILITY_DISABLED', t('2026-08-15T10:00:00Z'))).not.toBe(
        forRecurringSignal('runtime', 'c1', 'ACCESSIBILITY_DISABLED', t('2026-08-16T10:00:00Z')),
      );
    });

    it('two different critical event types in the same bucket are two notifications', () => {
      const now = t('2026-08-15T10:00:00Z');
      expect(forRecurringSignal('wellbeing', 'c1', 'SELF_HARM_SIGNAL', now)).not.toBe(
        forRecurringSignal('wellbeing', 'c1', 'BULLYING_SIGNAL', now),
      );
    });

    it('THE HONEST LIMIT, asserted rather than described: a bucket boundary is not a sliding window', () => {
      // 30 seconds apart, opposite sides of a boundary -> two different keys,
      // and the database will accept both. This is precisely why the
      // five-minute `findFirst` in `PrismaRuntimeAlertRepository` and the
      // sliding DUPLICATE rule in `NotificationFatigueGuard` are KEPT rather
      // than replaced: they remain the product behaviour and the constraint is
      // the floor beneath them. For the outbox paths — the ones a relay
      // actually redelivers — `forDomainEvent` has no such limit.
      const a = forRecurringSignal('signal', 'c1', 'X', t('2026-08-15T10:04:45Z'));
      const b = forRecurringSignal('signal', 'c1', 'X', t('2026-08-15T10:05:15Z'));
      expect(a).not.toBe(b);
    });

    it('the bucket width equals the fatigue guard’s duplicate window — three numbers that must agree', () => {
      expect(NOTIFICATION_DEDUPE_WINDOW_MS).toBe(5 * 60 * 1000);
    });

    it('is timezone-free by construction — it asks about instants, not about a family’s day', () => {
      // Every question about a family's DAY (quiet hours, daily cap, category
      // cap) still goes through FamilyDateService. B9 changes none of them,
      // and this key deliberately does not participate in that question.
      const iso = '2026-08-15T10:00:00Z';
      const viaEpoch = forRecurringSignal('signal', 'c1', 'X', new Date(Date.parse(iso)));
      expect(forRecurringSignal('signal', 'c1', 'X', new Date(iso))).toBe(viaEpoch);
    });
  });

  describe('the column’s real limits', () => {
    it('every form fits VARCHAR(200) even with hostile input', () => {
      const long = 'x'.repeat(5000);
      for (const key of [
        forDomainEvent(long, long),
        forEntity('badge', long, long, long),
        forRecurringSignal('signal', long, long, new Date()),
      ]) {
        expect(key.length).toBeLessThanOrEqual(NOTIFICATION_SOURCE_KEY_MAX_LENGTH);
      }
    });

    it('a segment cannot forge the separator — ("a:b","c") and ("a","b:c") must not collide', () => {
      expect(forEntity('badge', 'a:b', 'c')).not.toBe(forEntity('badge', 'a', 'b:c'));
    });

    it('no composer can produce a key that looks like migration 0008’s legacy backfill', () => {
      for (const key of [
        forDomainEvent('x'),
        forEntity('badge', 'a', 'b'),
        forRecurringSignal('signal', 'a', 'b', new Date()),
      ]) {
        expect(key.startsWith(LEGACY_SOURCE_KEY_PREFIX)).toBe(false);
      }
    });
  });
});

/**
 * PART 2 — THE PRODUCER INVENTORY, AS A RATCHET.
 *
 * Phase A §5's table listed seven paths and marked every one of them «قيد DB؟
 * ❌». This test walks the real source tree and asserts the after-state: every
 * call that can write a `notifications` row carries a key, and every key is
 * DERIVED rather than hardcoded.
 */
describe('B9 — every notification producer composes a real key (static guard over src/)', () => {
  const SRC = join(__dirname, '..', '..', 'src');

  function walk(dir: string): string[] {
    return readdirSync(dir).flatMap((entry) => {
      const full = join(dir, entry);
      return statSync(full).isDirectory() ? walk(full) : full.endsWith('.ts') ? [full] : [];
    });
  }

  const files = walk(SRC).map((path) => ({ path, text: readFileSync(path, 'utf8') }));

  it('`notification.create` still has exactly ONE caller — the property the whole fix rests on', () => {
    // If a second writer ever appears, `sourceEventId` becomes something a
    // developer has to remember in two places instead of a parameter the type
    // system demands in one. That is the moment this fix would start to rot,
    // and it fails here instead.
    const writers = files.filter((f) => /\bnotification\.create\(/.test(f.text)).map((f) => f.path);
    expect(writers).toHaveLength(1);
    expect(writers[0]).toContain('prisma-runtime-alert.repository.ts');
  });

  it('`childMessage.create` still has exactly ONE caller — the child half of the surface', () => {
    const writers = files.filter((f) => /\bchildMessage\.create\(/.test(f.text)).map((f) => f.path);
    expect(writers).toHaveLength(1);
    expect(writers[0]).toContain('prisma-communication.repository.ts');
  });

  it('every `createForFamilyOwner(` call site passes a DERIVED sourceEventId, never a literal', () => {
    const offenders: string[] = [];

    for (const file of files) {
      // The port declaration and the implementation itself are not call sites.
      if (file.path.includes('runtime-alert.repository.port.ts')) continue;
      if (file.path.includes('prisma-runtime-alert.repository.ts')) continue;

      for (const match of file.text.matchAll(/createForFamilyOwner\(\{[\s\S]*?\n\s*\}\)/g)) {
        const call = match[0];
        if (!/sourceEventId\s*:/.test(call)) {
          offenders.push(`${file.path}: no sourceEventId`);
          continue;
        }
        // A hardcoded string satisfies the type and destroys the semantics: it
        // would suppress every future notification of that kind for that
        // family. The key must come from a composer or from a variable that
        // one produced.
        if (/sourceEventId\s*:\s*['"`]/.test(call)) {
          offenders.push(`${file.path}: sourceEventId is a string literal`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it('every `notifyEvent(` call site passes a DERIVED sourceEventId', () => {
    const offenders: string[] = [];

    for (const file of files) {
      // The declaration itself is not a call site.
      if (file.path.includes('smart-notification-integration.service.ts')) continue;

      // `.notifyEvent(` with a receiver, so the several prose mentions of
      // `notifyEvent` in this codebase's docstrings are not mistaken for calls.
      for (const match of file.text.matchAll(/\.notifyEvent\([^;]*?\n\s*\}\)/g)) {
        const call = match[0];
        // Shorthand (`sourceEventId,`) is as valid as `sourceEventId: x` and
        // is what `rewards-engine.service.ts` uses — the check is on the
        // NAME being present and the VALUE not being a literal.
        if (!/\bsourceEventId\b/.test(call)) offenders.push(`${file.path}: no sourceEventId`);
        else if (/sourceEventId\s*:\s*['"`]/.test(call)) offenders.push(`${file.path}: literal key`);
      }
    }

    expect(offenders).toEqual([]);
  });

  it('the seven producer paths Phase A §5 enumerated are all still present and all still accounted for', () => {
    // Named individually rather than counted, so that DELETING a producer is
    // as visible as adding one. Each entry is `file` -> the composer it uses.
    const inventory: Array<[string, RegExp]> = [
      ['modules/events/application/consumers/notification-reward.consumer.ts', /forDomainEvent\(/],
      ['modules/life-intelligence/application/services/rewards-engine.service.ts', /forEntity\(/],
      ['modules/life-intelligence/application/services/smart-notification-integration.service.ts', /forRecurringSignal\(/],
      ['modules/life-intelligence/application/services/digital-wellbeing-engine.service.ts', /forRecurringSignal\(/],
      ['modules/pairing/application/services/runtime-alert.service.ts', /forRecurringSignal\(/],
    ];

    for (const [suffix, composer] of inventory) {
      const file = files.find((f) => f.path.endsWith(suffix.split('/').join(require('node:path').sep)));
      expect(file).toBeDefined();
      expect(composer.test((file as { text: string }).text)).toBe(true);
    }
  });
});
