import { Injectable } from '@nestjs/common';
import { createHash, randomBytes } from 'crypto';

import { RedisService } from '../../../../common/redis/redis.service';
import type {
  IConsumedRegistrationToken,
  IIssueRegistrationTokenInput,
  IRegistrationTokenTicket,
} from '../../domain/registration-token.types';
import { InvalidOrConsumedRegistrationTokenException } from '../../domain/registration-token.errors';

// 5 minutes — matches pairing-backend-domain-architecture.md's mid-flow
// timeout for the AUTHENTICATING -> CAPABILITIES_UPLOADED window.
const REGISTRATION_TOKEN_TTL_SECONDS = 5 * 60;
const REDIS_PREFIX = 'pairing-registration-token:';

/**
 * Decision-054's third token type: `Generated -> Device Registered ->
 * Consumed -> Invalid`. Single-use in the strictest sense — `getAndDelete`
 * makes consumption and invalidation the same atomic operation, so there
 * is no window (even within the TTL) where the token could be used twice.
 * This is the mechanism, not just the policy, behind
 * pairing-backend-domain-architecture.md §4.2's binding rule.
 *
 * The raw token is never stored — only its SHA-256 hash, as the Redis
 * key — mirroring TokenService's refresh-token-hashing precedent
 * (auth-module.md §3): a Redis read alone can never yield a usable token.
 */
@Injectable()
export class RegistrationTokenService {
  constructor(private readonly redisService: RedisService) {}

  async issue(input: IIssueRegistrationTokenInput): Promise<IRegistrationTokenTicket> {
    const token = randomBytes(32).toString('hex');
    await this.redisService.setWithTtl(
      this.redisKeyFor(token),
      JSON.stringify({ childId: input.childId, familyId: input.familyId }),
      REGISTRATION_TOKEN_TTL_SECONDS,
    );
    return { token, expiresInSeconds: REGISTRATION_TOKEN_TTL_SECONDS };
  }

  async consume(token: string): Promise<IConsumedRegistrationToken> {
    const raw = await this.redisService.getAndDelete(this.redisKeyFor(token));
    if (!raw) {
      throw new InvalidOrConsumedRegistrationTokenException();
    }
    return JSON.parse(raw) as IConsumedRegistrationToken;
  }

  private redisKeyFor(token: string): string {
    return `${REDIS_PREFIX}${createHash('sha256').update(token).digest('hex')}`;
  }
}
