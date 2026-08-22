import { Injectable, OnModuleDestroy, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

/**
 * Thin, typed wrapper around ioredis. Kept deliberately minimal — only the
 * operations the app actually uses (set-with-ttl, get, delete) — rather than
 * exposing the raw client everywhere, so call sites stay easy to grep and
 * the underlying Redis client could be swapped later without touching
 * every consumer.
 */
@Injectable()
export class RedisService implements OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  private readonly client: Redis;

  constructor(configService: ConfigService) {
    const url = configService.getOrThrow<string>('REDIS_URL');
    this.client = new Redis(url, { lazyConnect: false });
    this.client.on('error', (err) => this.logger.error('Redis connection error', err));
  }

  async setWithTtl(key: string, value: string, ttlSeconds: number): Promise<void> {
    await this.client.set(key, value, 'EX', ttlSeconds);
  }

  /** Sprint 9 \u2014 the Health Controller's readiness check. Throws if Redis
   * is unreachable; the caller (HealthController) catches it. */
  async ping(): Promise<void> {
    await this.client.ping();
  }

  async get(key: string): Promise<string | null> {
    return this.client.get(key);
  }

  /** Atomically read-and-delete — used for one-time pairing codes. */
  /** CRITICAL FIX (Beta Validation Phase 6 — Replay Attacks): this used
   * to be a plain `GET` followed by a separate `DEL` — NOT atomic. Two
   * concurrent calls with the same key (a network retry racing the
   * original request, or a deliberate double-submit) could both
   * successfully `GET` the value before either `DEL`'d it, meaning a
   * single-use pairing invitation code or registration token
   * (`InvitationService`/`RegistrationTokenService`, both built
   * specifically on the assumption this method is atomic) could be
   * consumed TWICE. Fixed with a Lua script — `EVAL` scripts run
   * atomically on the Redis server itself, the standard way to get a
   * true compare-and-delete without a client-side round-trip gap.
   * (Redis 6.2+'s native `GETDEL` command would also solve this, but a
   * Lua script works on any Redis version without needing to confirm
   * the deployed server's version.) */
  private static readonly GET_AND_DELETE_SCRIPT = `
    local v = redis.call('GET', KEYS[1])
    if v then redis.call('DEL', KEYS[1]) end
    return v
  `;

  async getAndDelete(key: string): Promise<string | null> {
    const result = await this.client.eval(RedisService.GET_AND_DELETE_SCRIPT, 1, key);
    return result as string | null;
  }

  /**
   * SPRINT F2. A plain delete, which this class's own header has claimed to
   * offer since it was written («set-with-ttl, get, delete») and did not: the
   * only removal available was `getAndDelete`, whose atomic read-and-consume is
   * right for a one-time pairing code and wrong for signing an operator out —
   * there, the read is pointless and the delete must happen whether or not a
   * value was there.
   */
  async delete(key: string): Promise<void> {
    await this.client.del(key);
  }

  /**
   * ===========================================================================
   * A SET THAT KEEPS ITS TTL — and a drain that leaves nothing behind.
   * ===========================================================================
   *
   * Built for the operator-session reverse index, which was a JSON array under
   * one key: read it, add a hash, write it back. That is read-modify-write, and
   * two sign-ins by the same person landing together lose one of the two hashes
   * — leaving a LIVE SESSION THAT `revokeAll` CANNOT SEE. A revocation control
   * that silently misses a session is worse than none, because it reports
   * success.
   *
   * `SADD` is atomic, so the concurrent sign-in cannot lose anything. `EXPIRE`
   * rides along in the same script so the index can never outlive its sessions
   * and become a set of dangling hashes.
   *
   * NOTE FOR A FUTURE REDIS CLUSTER: `deleteSetAndItsMembers` touches keys it
   * did not declare in KEYS, which a cluster forbids. It is correct here because
   * this deployment is a single Redis, and the alternative — drain, then delete
   * in a loop — reopens a window in which a hash has left the index and its
   * session key still resolves. For a control whose entire job is «this person
   * is out, now», that window is the thing being removed.
   */
  private static readonly SET_ADD_WITH_TTL_SCRIPT = `
    redis.call('SADD', KEYS[1], ARGV[1])
    redis.call('EXPIRE', KEYS[1], ARGV[2])
    return 1
  `;

  async addToSetWithTtl(key: string, member: string, ttlSeconds: number): Promise<void> {
    await this.client.eval(RedisService.SET_ADD_WITH_TTL_SCRIPT, 1, key, member, String(ttlSeconds));
  }

  private static readonly DELETE_SET_AND_MEMBERS_SCRIPT = `
    local members = redis.call('SMEMBERS', KEYS[1])
    redis.call('DEL', KEYS[1])
    for i = 1, #members do
      redis.call('DEL', ARGV[1] .. members[i])
    end
    return #members
  `;

  /**
   * Deletes the set at `key` AND the key `prefix .. member` for every member,
   * in one atomic server-side step. Returns how many members there were.
   */
  async deleteSetAndItsMembers(key: string, memberKeyPrefix: string): Promise<number> {
    const result = await this.client.eval(
      RedisService.DELETE_SET_AND_MEMBERS_SCRIPT,
      1,
      key,
      memberKeyPrefix,
    );
    return Number(result ?? 0);
  }

  /** Removes ONE member from a set. Sign-out, when the person still holds
   * other sessions that must stay alive. */
  async removeFromSet(key: string, member: string): Promise<void> {
    await this.client.srem(key, member);
  }

  /** SA-004. The one deliberate exception to this class's "don't expose
   * the raw client" rule: `RedisThrottlerStorage` implements Nest's
   * `ThrottlerStorage` interface with a Lua script, which needs the
   * client itself. Kept as an explicit, greppable accessor rather than
   * making the field public. */
  getRawClient(): Redis {
    return this.client;
  }

  async onModuleDestroy(): Promise<void> {
    await this.client.quit();
  }
}
