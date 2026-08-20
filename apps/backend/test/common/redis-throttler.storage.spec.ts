/**
 * SA-004, half two: the throttler counters must live in Redis, not in an
 * in-process Map, or every limit silently multiplies by the replica count
 * and resets on each deploy.
 *
 * This suite runs the real Lua script against a real Redis server when
 * INTEGRATION_REDIS_URL is set (CI's compose stack already provides one),
 * and is skipped — not silently passed — otherwise.
 */
import Redis from 'ioredis';

import { RedisThrottlerStorage } from '../../src/common/throttler/redis-throttler.storage';

const REDIS_URL = process.env.INTEGRATION_REDIS_URL;
const describeIfRedis = REDIS_URL ? describe : describe.skip;

describeIfRedis('RedisThrottlerStorage (real Redis)', () => {
  let client: Redis;
  let storage: RedisThrottlerStorage;
  let prefix: string;

  beforeAll(() => {
    client = new Redis(REDIS_URL as string);
  });

  afterAll(async () => {
    await client?.quit();
  });

  beforeEach(async () => {
    prefix = `throttle-test-${Date.now()}-${Math.random()}:`;
    storage = new RedisThrottlerStorage(client, prefix);
  });

  afterEach(async () => {
    const keys = await client.keys(`${prefix}*`);
    if (keys.length) await client.del(...keys);
  });

  it('counts hits per key and blocks only past the limit', async () => {
    const first = await storage.increment('client-a', 60_000, 2, 0, 'default');
    expect(first.totalHits).toBe(1);
    expect(first.isBlocked).toBe(false);

    const second = await storage.increment('client-a', 60_000, 2, 0, 'default');
    expect(second.totalHits).toBe(2);
    expect(second.isBlocked).toBe(false);

    const third = await storage.increment('client-a', 60_000, 2, 0, 'default');
    expect(third.totalHits).toBe(3);
    expect(third.isBlocked).toBe(true);
  });

  it('keeps two client keys in independent buckets', async () => {
    await storage.increment('client-a', 60_000, 2, 0, 'default');
    await storage.increment('client-a', 60_000, 2, 0, 'default');
    const aBlocked = await storage.increment('client-a', 60_000, 2, 0, 'default');
    expect(aBlocked.isBlocked).toBe(true);

    const b = await storage.increment('client-b', 60_000, 2, 0, 'default');
    expect(b.totalHits).toBe(1);
    expect(b.isBlocked).toBe(false);
  });

  it('is shared across instances — this is the whole point vs the in-memory Map', async () => {
    // Two storage objects stand in for two replicas of the API pointing at
    // the same Redis. With the default in-process storage each would count
    // to the limit separately, doubling the effective limit.
    const replicaOne = new RedisThrottlerStorage(client, prefix);
    const replicaTwo = new RedisThrottlerStorage(client, prefix);

    await replicaOne.increment('client-a', 60_000, 2, 0, 'default');
    await replicaTwo.increment('client-a', 60_000, 2, 0, 'default');
    const third = await replicaTwo.increment('client-a', 60_000, 2, 0, 'default');

    expect(third.totalHits).toBe(3);
    expect(third.isBlocked).toBe(true);
  });

  it('counts atomically under 50 concurrent increments (no lost updates)', async () => {
    const results = await Promise.all(
      Array.from({ length: 50 }, () => storage.increment('client-race', 60_000, 100, 0, 'default')),
    );
    const hits = results.map((r) => r.totalHits).sort((a, b) => a - b);
    expect(hits).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));
  });

  it('separates throttler names so a named @Throttle does not eat the default budget', async () => {
    await storage.increment('client-a', 60_000, 2, 0, 'default');
    await storage.increment('client-a', 60_000, 2, 0, 'default');
    const other = await storage.increment('client-a', 60_000, 2, 0, 'strict');
    expect(other.totalHits).toBe(1);
    expect(other.isBlocked).toBe(false);
  });

  it('expires the bucket so a client eventually recovers', async () => {
    const record = await storage.increment('client-ttl', 1_000, 5, 0, 'default');
    expect(record.timeToExpire).toBeGreaterThan(0);
    expect(record.timeToExpire).toBeLessThanOrEqual(1);

    await new Promise((resolve) => setTimeout(resolve, 1_200));
    const afterExpiry = await storage.increment('client-ttl', 1_000, 5, 0, 'default');
    expect(afterExpiry.totalHits).toBe(1);
  });
});
