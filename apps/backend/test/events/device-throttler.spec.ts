/**
 * F3 — the one assumption `DeviceEventsThrottlerGuard` makes about a third-party
 * library, pinned by a test.
 *
 * The guard restates `@nestjs/throttler`'s `THROTTLER:SKIP` metadata prefix
 * because the package does not export it publicly. If an upgrade renames that
 * key, the guard's `SkipBlindReflector` would stop neutralising `@SkipThrottle`
 * and the per-device rate limit on `POST /events/batch` would silently switch
 * itself off — which is exactly the failure this whole arrangement exists to
 * fix. So the copy is verified against the real decorator rather than trusted.
 */
import { SkipThrottle, Throttle } from '@nestjs/throttler';

import { THROTTLER_SKIP_METADATA_PREFIX } from '../../src/modules/events/presentation/guards/device-events-throttler.guard';
import { EVENTS_RATE_LIMIT } from '../../src/shared/events/events-batch.contract';
import { EventsController } from '../../src/modules/events/presentation/controllers/events.controller';

describe('F3 — DeviceEventsThrottlerGuard assumptions', () => {
  it("the real @SkipThrottle() writes metadata under the prefix the guard hard-codes", () => {
    class Probe {
      @SkipThrottle()
      handler(): void {
        /* no-op */
      }
    }

    const keys = Reflect.getMetadataKeys(Probe.prototype.handler) as unknown[];
    const skipKeys = keys.filter(
      (k) => typeof k === 'string' && k.startsWith(THROTTLER_SKIP_METADATA_PREFIX),
    );

    expect(skipKeys.length).toBeGreaterThan(0);
  });

  it('@Throttle writes limit/ttl metadata the guard then reads normally — it is not blinded to those', () => {
    class Probe {
      @Throttle({ default: { limit: 7, ttl: 1000 } })
      handler(): void {
        /* no-op */
      }
    }
    const keys = (Reflect.getMetadataKeys(Probe.prototype.handler) as unknown[]).filter(
      (k) => typeof k === 'string',
    ) as string[];
    expect(keys.some((k) => k.startsWith('THROTTLER:LIMIT'))).toBe(true);
    expect(keys.some((k) => k.startsWith('THROTTLER:TTL'))).toBe(true);
  });

  it('the events route really carries BOTH decorators — skip for the global guard, limit for this one', () => {
    const handler = EventsController.prototype.ingestBatch;
    const keys = (Reflect.getMetadataKeys(handler) as unknown[]).filter(
      (k) => typeof k === 'string',
    ) as string[];

    expect(keys.some((k) => k.startsWith(THROTTLER_SKIP_METADATA_PREFIX))).toBe(true);

    const limitKey = keys.find((k) => k.startsWith('THROTTLER:LIMIT')) as string;
    expect(limitKey).toBeDefined();
    expect(Reflect.getMetadata(limitKey, handler)).toBe(EVENTS_RATE_LIMIT.limit);
  });
});
