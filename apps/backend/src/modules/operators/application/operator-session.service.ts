import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import { Injectable, Logger } from '@nestjs/common';
import type { OperatorRole } from '@prisma/client';

import { RedisService } from '../../../common/redis/redis.service';

/**
 * ===========================================================================
 * AN OPERATOR SESSION — OPAQUE, SERVER-SIDE, AND KILLABLE IN ONE ROUND TRIP.
 * ===========================================================================
 *
 * ── WHY NOT A JWT, WHEN THIS CODEBASE ALREADY HAS ONE ──────────────────
 *
 * Two reasons, and the first is the whole purpose of the sprint.
 *
 *   A JWT CANNOT BE REVOKED. It is a signed claim that stays true until it
 *   expires. The single defect this work exists to fix is that one person's
 *   access could not be removed without removing everyone's — shipping a
 *   stateless token would fix the naming and leave the revocation exactly as
 *   broken. Here, revoking is deleting one Redis key, and the very next request
 *   is refused.
 *
 *   THE EXISTING JWT IS FAMILY-SHAPED. Its payload carries `familyId` and
 *   `familyRole`, and `principalRoleFromToken` DEFAULTS AN UNKNOWN ROLE TO
 *   `PARENT`. An operator token minted through that machinery would be one
 *   forged claim away from being a household parent. Two different populations
 *   must not share a token format; a separate opaque credential cannot be
 *   confused for a family token by any code path, because it carries no claims
 *   at all — it is a lookup key and nothing else.
 *
 * ── WHAT IS STORED, AND WHAT IS NOT ────────────────────────────────────
 *
 * REDIS HOLDS THE SHA-256 OF THE TOKEN AS THE KEY, never the token. A dump of
 * the session store therefore does not let anyone sign in, which is the same
 * property `RefreshToken` already relies on in this codebase.
 *
 * The VALUE is the operator's id, email and role — denormalised, so a request
 * costs one Redis read rather than a Redis read plus a Postgres read. The cost
 * of that choice is stated rather than hidden: a role change does not reach a
 * live session. `revokeAll` exists for exactly that, and the operator service
 * calls it on every role change and every suspension, so the window is the
 * length of one write, not the length of a TTL.
 *
 * ── THE TTL IS EIGHT HOURS, NOT THIRTY DAYS ────────────────────────────
 *
 * A working day. An operator console is not a consumer app: the cost of signing
 * in again each morning is one password, and the benefit is that a laptop left
 * open overnight is not an open console. Sliding renewal is deliberately absent
 * — a session that renews itself on activity never expires for the person who
 * is always active, which is the person whose session is most worth bounding.
 */
export interface OperatorSession {
  readonly operatorId: string;
  readonly email: string;
  readonly role: OperatorRole;
  /** ISO instant the session was opened. Carried so a UI can show it. */
  readonly issuedAt: string;
}

/** One working day. */
export const OPERATOR_SESSION_TTL_SECONDS = 8 * 60 * 60;

/** 32 bytes of CSPRNG, base64url — 256 bits, not guessable, not enumerable. */
const TOKEN_BYTES = 32;

const KEY_PREFIX = 'operator-session:';
/** Reverse index, so «log this person out everywhere» is one read. */
const INDEX_PREFIX = 'operator-sessions-of:';

@Injectable()
export class OperatorSessionService {
  private readonly logger = new Logger(OperatorSessionService.name);

  constructor(private readonly redis: RedisService) {}

  private static hash(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  private static key(token: string): string {
    return `${KEY_PREFIX}${OperatorSessionService.hash(token)}`;
  }

  /**
   * Mints a session and returns the ONLY copy of the token that will ever
   * exist. It is never logged, never stored in plaintext and never returned
   * again.
   */
  async open(session: Omit<OperatorSession, 'issuedAt'>, now: Date = new Date()): Promise<string> {
    const token = randomBytes(TOKEN_BYTES).toString('base64url');
    const value: OperatorSession = { ...session, issuedAt: now.toISOString() };

    await this.redis.setWithTtl(
      OperatorSessionService.key(token),
      JSON.stringify(value),
      OPERATOR_SESSION_TTL_SECONDS,
    );

    // The reverse index carries HASHES, so it is no more dangerous than the
    // session store itself. Its own TTL matches, so it cannot outlive the
    // sessions it points at and become a set of dangling hashes.
    const indexKey = `${INDEX_PREFIX}${session.operatorId}`;
    const existing = await this.redis.get(indexKey);
    const hashes = new Set<string>(existing ? (JSON.parse(existing) as string[]) : []);
    hashes.add(OperatorSessionService.hash(token));
    await this.redis.setWithTtl(indexKey, JSON.stringify([...hashes]), OPERATOR_SESSION_TTL_SECONDS);

    return token;
  }

  /**
   * Resolves a presented token, or null. NEVER throws on a bad token: the
   * caller turns null into one uniform 401, so a malformed token, an expired
   * one and an unknown one are indistinguishable from outside.
   */
  async resolve(token: string | undefined): Promise<OperatorSession | null> {
    if (!token || token.length < 16) return null;

    const raw = await this.redis.get(OperatorSessionService.key(token));
    if (raw === null) return null;

    try {
      const parsed = JSON.parse(raw) as OperatorSession;
      if (!parsed.operatorId || !parsed.role) return null;
      return parsed;
    } catch {
      // A value that will not parse is a corrupt session, not a valid one.
      return null;
    }
  }

  /** Sign-out. Idempotent: a token that is already gone is not an error. */
  async close(token: string): Promise<void> {
    await this.redis.delete(OperatorSessionService.key(token));
  }

  /**
   * KILL EVERY SESSION THIS PERSON HOLDS. Called on suspension, on revocation
   * and on any role change — the three moments at which a live session is
   * carrying a claim that is no longer true.
   */
  async revokeAll(operatorId: string): Promise<number> {
    const indexKey = `${INDEX_PREFIX}${operatorId}`;
    const raw = await this.redis.getAndDelete(indexKey);
    if (raw === null) return 0;

    let hashes: string[];
    try {
      hashes = JSON.parse(raw) as string[];
    } catch {
      return 0;
    }

    for (const hash of hashes) {
      await this.redis.delete(`${KEY_PREFIX}${hash}`);
    }
    this.logger.log(JSON.stringify({ event: 'operator.sessions_revoked', operatorId, count: hashes.length }));
    return hashes.length;
  }
}

/**
 * Constant-time comparison for any secret an operator presents alongside a
 * session. Exported here rather than duplicated, and used by the guard so that
 * a wrong value costs the same time as a right one of the same length.
 */
export function secretsMatch(presented: string, expected: string): boolean {
  const a = createHash('sha256').update(presented).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}
