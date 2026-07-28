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

  async get(key: string): Promise<string | null> {
    return this.client.get(key);
  }

  /** Atomically read-and-delete — used for one-time pairing codes. */
  async getAndDelete(key: string): Promise<string | null> {
    const value = await this.client.get(key);
    if (value !== null) {
      await this.client.del(key);
    }
    return value;
  }

  async onModuleDestroy(): Promise<void> {
    await this.client.quit();
  }
}
