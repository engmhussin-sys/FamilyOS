import type { Redis } from 'ioredis';
import type { ThrottlerStorage } from '@nestjs/throttler';
// Not re-exported from the package root in @nestjs/throttler 6.x — see
// node_modules/@nestjs/throttler/dist/index.d.ts, which exports
// throttler-storage.interface but not throttler-storage-record.interface.
import type { ThrottlerStorageRecord } from '@nestjs/throttler/dist/throttler-storage-record.interface';

/**
 * SA-004. `ThrottlerModule.forRoot()` with no `storage` uses
 * `ThrottlerStorageService`, an in-process `Map`. That has two failure
 * modes in the deployment this project actually targets:
 *
 *   - with N replicas every configured limit silently becomes N x limit,
 *     because each process counts only its own share of the traffic;
 *   - every deploy resets all counters to zero, so an attacker gets a
 *     fresh budget on each release.
 *
 * This storage keeps the counters in Redis instead, which the stack
 * already runs (docker-compose, CI, and production). All 27 `@Throttle`
 * decorators in the codebase become real limits shared across replicas.
 *
 * The whole increment is one Lua script so it is atomic on the Redis
 * server: N concurrent requests can never each read the same counter
 * value and write back the same +1 — the exact race the in-memory Map
 * also had, but which matters far more once the counter is shared.
 */
export class RedisThrottlerStorage implements ThrottlerStorage {
  /**
   * KEYS[1] hit counter · KEYS[2] block marker
   * ARGV[1] ttl (ms) · ARGV[2] limit · ARGV[3] blockDuration (ms)
   *
   * Returns { totalHits, timeToExpire(ms), isBlocked, timeToBlockExpire(ms) }
   * in the same shape ThrottlerStorageService produces, so the guard's
   * behaviour is identical apart from where the numbers live.
   */
  private static readonly INCREMENT_SCRIPT = `
    local hitsKey = KEYS[1]
    local blockKey = KEYS[2]
    local ttl = tonumber(ARGV[1])
    local limit = tonumber(ARGV[2])
    local blockDuration = tonumber(ARGV[3])

    local blockTtl = redis.call('PTTL', blockKey)
    if blockTtl > 0 then
      local hits = tonumber(redis.call('GET', hitsKey) or '0')
      return { hits, blockTtl, 1, blockTtl }
    end

    local hits = redis.call('INCR', hitsKey)
    if hits == 1 then
      redis.call('PEXPIRE', hitsKey, ttl)
    end
    local timeToExpire = redis.call('PTTL', hitsKey)
    if timeToExpire < 0 then
      redis.call('PEXPIRE', hitsKey, ttl)
      timeToExpire = ttl
    end

    if hits > limit then
      redis.call('SET', blockKey, '1', 'PX', blockDuration)
      return { hits, timeToExpire, 1, blockDuration }
    end

    return { hits, timeToExpire, 0, 0 }
  `;

  constructor(
    private readonly client: Redis,
    private readonly keyPrefix = 'throttle:',
  ) {}

  async increment(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    throttlerName: string,
  ): Promise<ThrottlerStorageRecord> {
    const hitsKey = `${this.keyPrefix}${throttlerName}:${key}`;
    const blockKey = `${hitsKey}:blocked`;

    const result = (await this.client.eval(
      RedisThrottlerStorage.INCREMENT_SCRIPT,
      2,
      hitsKey,
      blockKey,
      String(ttl),
      String(limit),
      String(blockDuration > 0 ? blockDuration : ttl),
    )) as [number, number, number, number];

    const [totalHits, timeToExpire, isBlocked, timeToBlockExpire] = result;

    return {
      totalHits: Number(totalHits),
      // The guard reports these to the client in seconds.
      timeToExpire: Math.ceil(Number(timeToExpire) / 1000),
      isBlocked: Number(isBlocked) === 1,
      timeToBlockExpire: Math.ceil(Number(timeToBlockExpire) / 1000),
    };
  }
}
