/**
 * PHASE D — THE ANTI-FLOOD POLICY, PROVEN AS A PURE FUNCTION.
 *
 * The brief's own scenario is the first test: eleven notifications defer
 * overnight, and the parent must NOT receive eleven at 07:00. Everything below
 * is deterministic — no clock, no database — so the policy is a property that
 * can be reasoned about rather than a behaviour that has to be observed.
 */
import {
  digestText,
  planRelease,
} from '../../src/modules/notifications/domain/coalesce-and-digest';
import {
  RELEASE_DEFAULTS,
  type DeferredNotificationRow,
} from '../../src/modules/notifications/domain/notification-delivery.types';

const BASE = new Date('2026-01-15T21:00:00.000Z').getTime();

let seq = 0;
function row(
  overrides: Partial<DeferredNotificationRow> & Pick<DeferredNotificationRow, 'type'>,
): DeferredNotificationRow {
  seq += 1;
  return {
    id: `row-${String(seq).padStart(3, '0')}`,
    familyId: 'fam-1',
    childId: 'child-1',
    category: 'REWARD',
    priority: 'NORMAL',
    targetAudience: 'PARENT',
    title: `t-${seq}`,
    body: `b-${seq}`,
    sourceEventId: `evt:${seq}`,
    scheduledFor: new Date(BASE + 36_000_000),
    businessDate: '2026-01-15',
    attemptCount: 1,
    createdAt: new Date(BASE + seq * 60_000),
    ...overrides,
  };
}

beforeEach(() => {
  seq = 0;
});

describe('PHASE D — coalescing and the morning digest', () => {
  describe('1. THE BRIEF’S SCENARIO: eleven overnight notifications', () => {
    it('eleven rows of ONE type collapse to exactly ONE delivery and zero digest', () => {
      const rows = Array.from({ length: 11 }, () => row({ type: 'REWARD_GRANTED' }));
      const plan = planRelease(rows, 'PARENT');

      expect(plan.deliver).toHaveLength(1);
      expect(plan.digestOf).toHaveLength(0);
      expect(plan.resolve).toHaveLength(10);
      expect(new Set(plan.resolve.map((r) => r.reason))).toEqual(new Set(['COALESCED']));
      // NEWEST WINS: the content of a repeated notification is a snapshot, and
      // the most recent snapshot is the only true one at release.
      expect(plan.deliver[0].id).toBe('row-011');
    });

    it('eleven rows of ELEVEN DIFFERENT types produce 3 deliveries + 1 digest — four, not eleven', () => {
      const rows = Array.from({ length: 11 }, (_, i) => row({ type: `TYPE_${i}` }));
      const plan = planRelease(rows, 'PARENT');

      expect(plan.deliver).toHaveLength(RELEASE_DEFAULTS.maxIndividualPerAudience);
      expect(plan.digestOf).toHaveLength(8);
      expect(plan.resolve.every((r) => r.reason === 'DIGESTED')).toBe(true);
      // What the parent's phone actually does at 07:00.
      expect(plan.deliver.length + (plan.digestOf.length > 0 ? 1 : 0)).toBe(4);
    });

    it('the realistic mixed night: 11 rows, 4 types, still four notifications', () => {
      const rows = [
        ...Array.from({ length: 5 }, () => row({ type: 'HYDRATION_REMINDER' })),
        ...Array.from({ length: 3 }, () => row({ type: 'REWARD_GRANTED' })),
        ...Array.from({ length: 2 }, () => row({ type: 'BADGE_EARNED' })),
        row({ type: 'SCREEN_TIME_EXCEEDED' }),
      ];
      const plan = planRelease(rows, 'PARENT');
      // Coalescing alone takes 11 -> 4; the cap then leaves 3 + a 1-row tail,
      // and a 1-row tail is DELIVERED rather than digested (see below).
      expect(plan.deliver).toHaveLength(4);
      expect(plan.digestOf).toHaveLength(0);
      expect(plan.resolve.filter((r) => r.reason === 'COALESCED')).toHaveLength(7);
    });
  });

  describe('2. ORDERING — priority first, then the night in the order it happened', () => {
    it('a CRITICAL that was somehow deferred is never third', () => {
      const rows = [
        row({ type: 'A', priority: 'LOW' }),
        row({ type: 'B', priority: 'NORMAL' }),
        row({ type: 'C', priority: 'CRITICAL' }),
      ];
      const plan = planRelease(rows, 'PARENT');
      expect(plan.deliver.map((r) => r.type)).toEqual(['C', 'B', 'A']);
    });

    it('inside one priority band the order is CHRONOLOGICAL, oldest first', () => {
      const rows = [row({ type: 'A' }), row({ type: 'B' }), row({ type: 'C' })];
      const plan = planRelease(rows, 'PARENT');
      expect(plan.deliver.map((r) => r.type)).toEqual(['A', 'B', 'C']);
    });

    it('IS DETERMINISTIC: two rows written in the same millisecond always plan the same way', () => {
      const at = new Date(BASE);
      const a = row({ type: 'A', createdAt: at });
      const b = row({ type: 'B', createdAt: at });
      const one = planRelease([a, b], 'PARENT');
      const two = planRelease([b, a], 'PARENT');
      expect(one.deliver.map((r) => r.id)).toEqual(two.deliver.map((r) => r.id));
    });

    it('a same-millisecond COALESCE tie is broken by id, so two replicas keep the same survivor', () => {
      const at = new Date(BASE);
      const a = row({ type: 'SAME', createdAt: at });
      const b = row({ type: 'SAME', createdAt: at });
      expect(planRelease([a, b], 'PARENT').deliver[0].id).toBe(
        planRelease([b, a], 'PARENT').deliver[0].id,
      );
    });
  });

  describe('3. THE DIGEST IS ONLY WORTH IT WHEN IT REPLACES SOMETHING', () => {
    it('a one-row tail is DELIVERED, not summarised — «1 more update» is never better than the update', () => {
      const rows = Array.from({ length: 4 }, (_, i) => row({ type: `T${i}` }));
      const plan = planRelease(rows, 'PARENT');
      expect(plan.deliver).toHaveLength(4);
      expect(plan.digestOf).toHaveLength(0);
    });

    it('a two-row tail IS summarised', () => {
      const rows = Array.from({ length: 5 }, (_, i) => row({ type: `T${i}` }));
      const plan = planRelease(rows, 'PARENT');
      expect(plan.deliver).toHaveLength(3);
      expect(plan.digestOf).toHaveLength(2);
    });

    it('at or below the cap nothing is resolved at all', () => {
      const rows = [row({ type: 'A' }), row({ type: 'B' }), row({ type: 'C' })];
      const plan = planRelease(rows, 'PARENT');
      expect(plan.deliver).toHaveLength(3);
      expect(plan.resolve).toHaveLength(0);
      expect(plan.digestOf).toHaveLength(0);
    });
  });

  describe('4. THE TWO AUDIENCES NEVER CAP EACH OTHER', () => {
    it('a parent’s queue and a child’s queue are planned independently', () => {
      const rows = [
        ...Array.from({ length: 5 }, (_, i) => row({ type: `P${i}`, targetAudience: 'PARENT' })),
        ...Array.from({ length: 5 }, (_, i) => row({ type: `C${i}`, targetAudience: 'CHILD' })),
      ];
      const parent = planRelease(rows, 'PARENT');
      const child = planRelease(rows, 'CHILD');

      expect(parent.deliver).toHaveLength(3);
      expect(child.deliver).toHaveLength(3);
      // Neither plan touched the other audience's rows.
      expect(parent.deliver.every((r) => r.targetAudience === 'PARENT')).toBe(true);
      expect(child.deliver.every((r) => r.targetAudience === 'CHILD')).toBe(true);
      expect(parent.resolve.every((r) => r.row.targetAudience === 'PARENT')).toBe(true);
    });

    it('the same type for two audiences is TWO facts, not one — coalescing does not cross the boundary', () => {
      const rows = [
        row({ type: 'REWARD_GRANTED', targetAudience: 'PARENT' }),
        row({ type: 'REWARD_GRANTED', targetAudience: 'CHILD' }),
      ];
      expect(planRelease(rows, 'PARENT').deliver).toHaveLength(1);
      expect(planRelease(rows, 'CHILD').deliver).toHaveLength(1);
    });
  });

  describe('5. NOTHING IS LOST WITHOUT A REASON', () => {
    it('every row is accounted for exactly once — delivered, resolved, or in the digest', () => {
      const rows = [
        ...Array.from({ length: 4 }, () => row({ type: 'HYDRATION_REMINDER' })),
        ...Array.from({ length: 6 }, (_, i) => row({ type: `T${i}` })),
      ];
      const plan = planRelease(rows, 'PARENT');

      const accounted = new Set([
        ...plan.deliver.map((r) => r.id),
        ...plan.resolve.map((r) => r.row.id),
      ]);
      expect(accounted.size).toBe(rows.length);
      // The digest members are a subset of the resolved ones, not a third bucket
      // that could silently swallow a row.
      const resolvedIds = new Set(plan.resolve.map((r) => r.row.id));
      expect(plan.digestOf.every((r) => resolvedIds.has(r.id))).toBe(true);
    });

    it('every resolution carries one of the two documented reasons and never an empty one', () => {
      const rows = Array.from({ length: 9 }, (_, i) => row({ type: `T${i % 4}` }));
      const plan = planRelease(rows, 'PARENT');
      for (const { reason } of plan.resolve) {
        expect(['COALESCED', 'DIGESTED']).toContain(reason);
      }
    });

    it('an empty input plans nothing rather than an empty digest', () => {
      const plan = planRelease([], 'PARENT');
      expect(plan.deliver).toHaveLength(0);
      expect(plan.resolve).toHaveLength(0);
      expect(plan.digestOf).toHaveLength(0);
    });
  });

  describe('6. the digest text', () => {
    it('is Arabic, carries the count, and carries NOTHING ELSE about the child', () => {
      const text = digestText(8);
      expect(text.body).toContain('8');
      expect(/[؀-ۿ]/.test(text.title)).toBe(true);
      expect(/[؀-ۿ]/.test(text.body)).toBe(true);
      // docs/06 §8.3 — the push is a pointer; the app fetches the content over
      // an authenticated GET. No name, no habit title, no reward amount.
      expect(text.body).not.toMatch(/child|habit|reward/i);
    });
  });
});
