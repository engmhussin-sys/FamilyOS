/**
 * F3 (R3) — the Domain Event Bus itself, plus the catalogue and the
 * idempotency-key composition it routes on.
 *
 * Pure unit tests: no database, no Redis, no Nest container. Everything here is
 * a property of the bus contract that must hold before any of the integration
 * evidence in `event-pipeline.e2e.spec.ts` means anything.
 */
import * as fs from 'fs';
import * as path from 'path';

import { InProcessEventBus } from '../../src/modules/events/infrastructure/in-process-event-bus';
import type { DomainEventEnvelope } from '../../src/shared/events/event-envelope';
import { ENVELOPE_VERSION } from '../../src/shared/events/event-envelope';
import {
  COMPLETION_EVENT_TYPES,
  DEVICE_INGESTIBLE_EVENT_TYPES,
  DOMAIN_EVENT_CATALOGUE,
  DOMAIN_EVENT_TYPES,
  isCompletionEventType,
  isDeviceIngestibleEventType,
  isDomainEventType,
} from '../../src/shared/events/event-types';
import {
  composeIdempotencyKey,
  composeRewardGrantedKey,
  IDEMPOTENCY_KEY_MAX_LENGTH,
  utcLocalDate,
} from '../../src/shared/events/idempotency';
import { currentTenant, runWithTenant } from '../../src/common/tenancy/tenant-context';

const CHILD = '11111111-1111-4111-8111-111111111111';
const FAMILY = '22222222-2222-4222-8222-222222222222';
const DEVICE = '33333333-3333-4333-8333-333333333333';
const SOURCE = '44444444-4444-4444-8444-444444444444';

function envelope(overrides: Partial<DomainEventEnvelope> = {}): DomainEventEnvelope {
  return {
    envelopeVersion: ENVELOPE_VERSION,
    id: '55555555-5555-4555-8555-555555555555',
    type: 'HABIT_COMPLETED',
    schemaVersion: 1,
    familyId: FAMILY,
    childId: CHILD,
    deviceId: DEVICE,
    aggregateType: 'HabitOccurrence',
    aggregateId: SOURCE,
    occurredAt: '2026-08-14T09:00:00.000Z',
    receivedAt: '2026-08-14T09:00:01.000Z',
    idempotencyKey: 'child:111111111111:habit:444444444444:2026-08-14',
    clientEventId: 'dev:seq:1',
    traceId: 'trace-1',
    payload: {},
    ...overrides,
  } as DomainEventEnvelope;
}

describe('F3 — the event catalogue', () => {
  /**
   * CONTEXT §5 names exactly these ten. If one is ever dropped, this fails
   * before anything downstream has a chance to fail quietly.
   */
  const CONTEXT_SECTION_5 = [
    'HABIT_COMPLETED',
    'STREAK_ACHIEVED',
    'DAILY_GOAL_COMPLETED',
    'HYDRATION_GOAL_COMPLETED',
    'ACTIVITY_GOAL_COMPLETED',
    'EDUCATION_PROGRESS',
    'REWARD_GRANTED',
    'DEVICE_PAIRED',
    'SCREEN_TIME_THRESHOLD',
    'IMPORTANT_SAFETY_EVENT',
  ];

  it.each(CONTEXT_SECTION_5)('%s from CONTEXT §5 exists in the catalogue', (type) => {
    expect(DOMAIN_EVENT_TYPES).toContain(type);
    expect(isDomainEventType(type)).toBe(true);
    expect(DOMAIN_EVENT_CATALOGUE[type as keyof typeof DOMAIN_EVENT_CATALOGUE]).toBeDefined();
  });

  it('every catalogued type has a catalogue entry, and every entry a type — no orphans either way', () => {
    expect(Object.keys(DOMAIN_EVENT_CATALOGUE).sort()).toEqual([...DOMAIN_EVENT_TYPES].sort());
    for (const type of DOMAIN_EVENT_TYPES) {
      const entry = DOMAIN_EVENT_CATALOGUE[type];
      expect(entry.type).toBe(type);
      expect(entry.producer.length).toBeGreaterThan(3);
      expect(entry.idempotencyKeyTemplate).toContain('{');
    }
  });

  it('the catalogue agrees with the two membership predicates — one source of truth, not three', () => {
    for (const type of DOMAIN_EVENT_TYPES) {
      expect(DOMAIN_EVENT_CATALOGUE[type].carriesCompletionEvent).toBe(isCompletionEventType(type));
      expect(DOMAIN_EVENT_CATALOGUE[type].deviceIngestible).toBe(isDeviceIngestibleEventType(type));
    }
  });

  /**
   * THE SECURITY PROPERTY, asserted rather than assumed. A device that could
   * post `REWARD_GRANTED` could manufacture a notification for a reward that
   * was never granted — which is precisely what CONTEXT §5's "no grant ⇒ no
   * notification" rule exists to prevent.
   */
  it('REWARD_GRANTED and STREAK_ACHIEVED are NOT device-ingestible — they are derived only', () => {
    expect(isDeviceIngestibleEventType('REWARD_GRANTED')).toBe(false);
    expect(isDeviceIngestibleEventType('STREAK_ACHIEVED')).toBe(false);
    expect(DEVICE_INGESTIBLE_EVENT_TYPES).not.toContain('REWARD_GRANTED');
    expect(DEVICE_INGESTIBLE_EVENT_TYPES).not.toContain('STREAK_ACHIEVED');
  });

  it('REWARD_GRANTED is not a completion — it must never reach the Rewards Engine and cause a loop', () => {
    expect(COMPLETION_EVENT_TYPES).not.toContain('REWARD_GRANTED');
    expect(COMPLETION_EVENT_TYPES).not.toContain('DEVICE_PAIRED');
    expect(COMPLETION_EVENT_TYPES).not.toContain('SCREEN_TIME_THRESHOLD');
    expect(COMPLETION_EVENT_TYPES).not.toContain('IMPORTANT_SAFETY_EVENT');
  });

  it('the Prisma EventType enum and the TypeScript catalogue are the same list', () => {
    const schema = fs.readFileSync(
      path.resolve(__dirname, '../../prisma/schema.prisma'),
      'utf8',
    );
    const block = /enum EventType \{([\s\S]*?)\}/.exec(schema);
    expect(block).not.toBeNull();
    const dbTypes = (block as RegExpExecArray)[1]
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith('/'));
    expect(dbTypes.sort()).toEqual([...DOMAIN_EVENT_TYPES].sort());
  });
});

describe('F3 — idempotency key composition (CONTEXT §3 principle 6)', () => {
  it('is DETERMINISTIC — the same real-world occurrence always produces the same key', () => {
    const parts = { childId: CHILD, sourceId: SOURCE, localDate: '2026-08-14' };
    const first = composeIdempotencyKey('HABIT_COMPLETED', parts);
    const second = composeIdempotencyKey('HABIT_COMPLETED', parts);
    expect(first).toBe(second);
    // The whole point: a device rebooting and regenerating the key tomorrow
    // still collides with today's row instead of minting a second reward.
    expect(first).toBe('child:111111111111:habit:444444444444:2026-08-14');
  });

  it('separates different days, different sources and different children', () => {
    const base = { childId: CHILD, sourceId: SOURCE, localDate: '2026-08-14' };
    expect(composeIdempotencyKey('HABIT_COMPLETED', base)).not.toBe(
      composeIdempotencyKey('HABIT_COMPLETED', { ...base, localDate: '2026-08-15' }),
    );
    expect(composeIdempotencyKey('HABIT_COMPLETED', base)).not.toBe(
      composeIdempotencyKey('HABIT_COMPLETED', { ...base, sourceId: FAMILY }),
    );
    expect(composeIdempotencyKey('HABIT_COMPLETED', base)).not.toBe(
      composeIdempotencyKey('HABIT_COMPLETED', { ...base, childId: FAMILY }),
    );
  });

  it.each([...DOMAIN_EVENT_TYPES])(
    '%s produces a key that fits the VARCHAR(80) column it is stored in',
    (type) => {
      const key = composeIdempotencyKey(type, {
        childId: CHILD,
        deviceId: DEVICE,
        sourceId: SOURCE,
        localDate: '2026-08-14',
        milestone: 100,
        kind: 'habits',
        hourBucket: '2026-08-14T09',
        sourceType: 'HabitOccurrence',
      });
      expect(key.length).toBeGreaterThan(0);
      expect(key.length).toBeLessThanOrEqual(IDEMPOTENCY_KEY_MAX_LENGTH);
    },
  );

  it('every catalogued type composes a DISTINCT key from the same inputs — no cross-type collision', () => {
    const keys = DOMAIN_EVENT_TYPES.map((type) =>
      composeIdempotencyKey(type, {
        childId: CHILD,
        deviceId: DEVICE,
        sourceId: SOURCE,
        localDate: '2026-08-14',
        milestone: 7,
        kind: 'habits',
        hourBucket: '2026-08-14T09',
        sourceType: 'HabitOccurrence',
      }),
    );
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('the derived REWARD_GRANTED key is a pure function of the originating key', () => {
    const source = 'child:111111111111:habit:444444444444:2026-08-14';
    expect(composeRewardGrantedKey(source)).toBe(`granted:${source}`);
    expect(composeRewardGrantedKey(source)).toBe(composeRewardGrantedKey(source));
    expect(composeRewardGrantedKey('x'.repeat(200)).length).toBeLessThanOrEqual(
      IDEMPOTENCY_KEY_MAX_LENGTH,
    );
  });

  it('utcLocalDate is the honest UTC fallback when a device sends no timezone', () => {
    expect(utcLocalDate('2026-08-14T23:59:59.000Z')).toBe('2026-08-14');
    expect(utcLocalDate(new Date('2026-08-15T00:00:00.000Z'))).toBe('2026-08-15');
  });
});

describe('F3 — InProcessEventBus', () => {
  let bus: InProcessEventBus;

  beforeEach(() => {
    bus = new InProcessEventBus();
  });

  it('delivers only to handlers registered for the event type', async () => {
    const habit: string[] = [];
    const reward: string[] = [];
    bus.register('HABIT_COMPLETED', 'A', async (e) => {
      habit.push(e.id);
    });
    bus.register('REWARD_GRANTED', 'B', async (e) => {
      reward.push(e.id);
    });

    const result = await bus.publish(envelope({ type: 'HABIT_COMPLETED' }));

    expect(result.handlersInvoked).toBe(1);
    expect(result.failures).toEqual([]);
    expect(habit).toHaveLength(1);
    expect(reward).toHaveLength(0);
  });

  it('publishing a type with no subscribers is a no-op success, not an error', async () => {
    const result = await bus.publish(envelope({ type: 'IMPORTANT_SAFETY_EVENT' }));
    expect(result.handlersInvoked).toBe(0);
    expect(result.failures).toEqual([]);
  });

  it('runs handlers SEQUENTIALLY in registration order — the ordering the docstring promises', async () => {
    const order: string[] = [];
    bus.register('HABIT_COMPLETED', 'first', async () => {
      await new Promise((r) => setTimeout(r, 20));
      order.push('first');
    });
    bus.register('HABIT_COMPLETED', 'second', async () => {
      order.push('second');
    });

    await bus.publish(envelope());

    // If they ran concurrently, 'second' would land first (it does no waiting).
    expect(order).toEqual(['first', 'second']);
  });

  /**
   * THE ISOLATION REQUIREMENT. One broken consumer must not swallow, block or
   * skip the others — otherwise a bug in Streaks silently stops Rewards.
   */
  it('one throwing handler neither blocks nor swallows the others, and IS reported', async () => {
    const ran: string[] = [];
    bus.register('HABIT_COMPLETED', 'ok-before', async () => {
      ran.push('ok-before');
    });
    bus.register('HABIT_COMPLETED', 'broken', async () => {
      throw new Error('consumer exploded');
    });
    bus.register('HABIT_COMPLETED', 'ok-after', async () => {
      ran.push('ok-after');
    });

    const result = await bus.publish(envelope());

    expect(ran).toEqual(['ok-before', 'ok-after']);
    expect(result.handlersInvoked).toBe(3);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].consumerName).toBe('broken');
    expect(result.failures[0].error.message).toBe('consumer exploded');
  });

  it('publish() never throws for a handler error — the relay decides, not the bus', async () => {
    bus.register('HABIT_COMPLETED', 'broken', async () => {
      throw new Error('boom');
    });
    await expect(bus.publish(envelope())).resolves.toBeDefined();
  });

  it('a non-Error throw is still reported as a failure rather than crashing the loop', async () => {
    bus.register('HABIT_COMPLETED', 'string-thrower', async () => {
      // eslint-disable-next-line @typescript-eslint/no-throw-literal
      throw 'not an Error object';
    });
    const result = await bus.publish(envelope());
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].error.message).toBe('not an Error object');
  });

  it('rejects a duplicate registration loudly — it would double every side effect', () => {
    bus.register('HABIT_COMPLETED', 'dup', async () => undefined);
    expect(() => bus.register('HABIT_COMPLETED', 'dup', async () => undefined)).toThrow(
      /already registered/,
    );
    // The SAME consumer on a DIFFERENT type is normal and must stay allowed:
    // RewardsCompletionConsumer subscribes to all eight completion types.
    expect(() => bus.register('TASK_COMPLETED', 'dup', async () => undefined)).not.toThrow();
  });

  it('exposes its registrations for the DI-graph and diagnostics surfaces', () => {
    bus.register('HABIT_COMPLETED', 'A', async () => undefined);
    bus.register('REWARD_GRANTED', 'B', async () => undefined);
    expect(bus.registrations()).toEqual(
      expect.arrayContaining([
        { type: 'HABIT_COMPLETED', consumerName: 'A' },
        { type: 'REWARD_GRANTED', consumerName: 'B' },
      ]),
    );
  });

  /**
   * THE ASYNCLOCALSTORAGE QUESTION, ANSWERED BY EXECUTION.
   *
   * The brief flags this as subtle, and it is: an event emitter that queued
   * handlers onto a later tick (setImmediate, process.nextTick, an unawaited
   * promise) would run them OUTSIDE the publisher's ALS scope, the tenant
   * context would be `undefined`, and every tenant-scoped Prisma call inside a
   * consumer would throw — or worse, in a design without deny-by-default,
   * return every family's rows.
   *
   * This bus awaits each handler inside `publish()`, so the scope is still on
   * the stack. That is a property of the implementation, not a promise, so it
   * is asserted here and again end-to-end through the relay.
   */
  it('the F2 AsyncLocalStorage tenant context SURVIVES into a handler', async () => {
    let seenFamilyId: string | undefined;
    let seenActor: string | undefined;
    bus.register('HABIT_COMPLETED', 'tenant-reader', async () => {
      seenFamilyId = currentTenant()?.familyId;
      seenActor = currentTenant()?.actorType;
    });

    await runWithTenant({ familyId: FAMILY, actorType: 'SYSTEM', actorId: 'test' }, () =>
      bus.publish(envelope()),
    );

    expect(seenFamilyId).toBe(FAMILY);
    expect(seenActor).toBe('SYSTEM');
  });

  it('the context survives ACROSS an await inside the handler, not just at its first line', async () => {
    let afterAwait: string | undefined;
    bus.register('HABIT_COMPLETED', 'async-tenant-reader', async () => {
      await new Promise((r) => setTimeout(r, 5));
      afterAwait = currentTenant()?.familyId;
    });

    await runWithTenant({ familyId: FAMILY, actorType: 'SYSTEM', actorId: 'test' }, () =>
      bus.publish(envelope()),
    );

    expect(afterAwait).toBe(FAMILY);
  });

  it('a handler that throws does not leak or corrupt the context for the NEXT handler', async () => {
    let seen: string | undefined;
    bus.register('HABIT_COMPLETED', 'thrower', async () => {
      throw new Error('boom');
    });
    bus.register('HABIT_COMPLETED', 'reader', async () => {
      seen = currentTenant()?.familyId;
    });

    await runWithTenant({ familyId: FAMILY, actorType: 'SYSTEM', actorId: 'test' }, () =>
      bus.publish(envelope()),
    );

    expect(seen).toBe(FAMILY);
  });

  it('two publishes under DIFFERENT tenants do not bleed into each other', async () => {
    const seen: string[] = [];
    bus.register('HABIT_COMPLETED', 'collector', async () => {
      seen.push(currentTenant()?.familyId ?? 'NONE');
    });

    await Promise.all([
      runWithTenant({ familyId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', actorType: 'SYSTEM', actorId: 'a' }, () =>
        bus.publish(envelope()),
      ),
      runWithTenant({ familyId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', actorType: 'SYSTEM', actorId: 'b' }, () =>
        bus.publish(envelope()),
      ),
    ]);

    expect(seen.sort()).toEqual([
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    ]);
  });
});

describe('F3 — the bus implementation is behind a token everywhere but its own module', () => {
  /**
   * The one-file swap path claimed in `events.module.ts` is only real if no
   * other file names the concrete class. Verified by walking `src/`, not by
   * asserting it in a comment.
   */
  it('no file outside src/modules/events imports InProcessEventBus directly', () => {
    const root = path.resolve(__dirname, '../../src');
    const offenders: string[] = [];

    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.isFile() && entry.name.endsWith('.ts')) {
          const rel = path.relative(root, full);
          if (rel.startsWith(path.join('modules', 'events'))) continue;
          if (/in-process-event-bus|InProcessEventBus/.test(fs.readFileSync(full, 'utf8'))) {
            offenders.push(rel);
          }
        }
      }
    };
    walk(root);

    expect(offenders).toEqual([]);
  });

  it('no consumer imports the concrete bus either — they depend on EVENT_SUBSCRIBER', () => {
    const consumers = path.resolve(__dirname, '../../src/modules/events/application/consumers');
    for (const file of fs.readdirSync(consumers)) {
      const body = fs.readFileSync(path.join(consumers, file), 'utf8');
      expect(body).not.toMatch(/InProcessEventBus/);
    }
  });
});
