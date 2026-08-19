import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';

import { Role } from '../authz/principal-role';
import { assertRoleAllowedFor } from '../authz/route-authorizer';

/**
 * A per-process HMAC key. It never leaves this module and is regenerated on
 * every boot, so it is not a secret anyone has to manage — it exists only to
 * turn two strings of ARBITRARY, DIFFERENT length into two digests of the SAME
 * length, which is the one thing `timingSafeEqual` refuses to do for you.
 */
const LENGTH_BLINDING_KEY = randomBytes(32);

/**
 * CONSTANT-TIME COMPARISON OF THE OPERATOR KEY.
 *
 * `!==` on strings short-circuits at the first differing byte, so how long the
 * answer takes is a function of how many leading bytes the caller guessed
 * right. On an endpoint an attacker may call as often as they like that is a
 * byte-at-a-time oracle for the operator key: recovery in O(alphabet × length)
 * requests instead of O(alphabet ^ length).
 *
 * `timingSafeEqual` throws on unequal lengths, and the obvious guard —
 * `if (a.length !== b.length) return false` — puts the early return back, this
 * time leaking the LENGTH of the real key. HMAC-ing both sides first removes
 * the problem rather than moving it: both digests are 32 bytes whatever went
 * in, so exactly one fixed-width constant-time comparison runs on every call
 * for every input, and neither the length nor any prefix of the expected key is
 * observable in the timing. The blinding key is per-process and random, so the
 * digests are not precomputable offline either.
 */
function operatorKeyMatches(provided: unknown, expected: string): boolean {
  // A missing header is `undefined` and a repeated one is `string[]`; both are
  // compared as the empty string rather than short-circuited, so even "did you
  // send the header at all" costs the same as a wrong key.
  const candidate = typeof provided === 'string' ? provided : '';
  const digest = (value: string): Buffer =>
    createHmac('sha256', LENGTH_BLINDING_KEY).update(value, 'utf8').digest();
  return timingSafeEqual(digest(candidate), digest(expected));
}

/**
 * CLOSES A CRITICAL GAP found during a proactive business audit:
 * `GET /analytics/dashboard-metrics` was protected by JwtAuthGuard
 * ONLY — meaning ANY authenticated user (including a free-tier
 * signup created moments ago) could read this platform's total
 * family count, trial-to-paid conversion rate, and active device
 * counts. A competitor or curious user could simply register a free
 * account and read this endpoint directly.
 *
 * DELIBERATE SCOPE, stated plainly: this is a minimal, fast fix — a
 * single shared secret checked via header, not a full internal
 * admin-role system (a real future upgrade: per-person internal
 * accounts, audit-logged admin actions, granular permissions). That
 * is a genuine product/security investment decision, not guessed at
 * here. Without `INTERNAL_ADMIN_API_KEY` set, this guard fails
 * closed (denies everything) rather than failing open — an unset
 * secret must never accidentally mean "open to everyone."
 *
 * PHASE C: the key holder is now a NAMED principal — `Role.SUPER_ADMIN` — and
 * the routes behind this guard must say so with `@PlatformAdminSurface()`.
 * Before, "internal admin" was an unnamed capability implied by possession of
 * a header; now it is one value in the same closed role vocabulary as OWNER,
 * PARENT and CHILD, checked by the same function. That is what stops the
 * platform surface from becoming the parallel authorization system this sprint
 * was told not to build.
 */
@Injectable()
export class InternalAdminGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const providedKey = request.headers['x-internal-admin-key'];
    const expectedKey = process.env.INTERNAL_ADMIN_API_KEY;

    // FAIL CLOSED, unchanged: an unset secret denies everything. This is the
    // one early return left, and it is safe — it depends on the DEPLOYMENT's
    // configuration, never on what the caller sent, so it reveals nothing
    // about the key that an attacker could not learn from a single request.
    if (!expectedKey) {
      throw new UnauthorizedException('Internal admin access is not configured on this environment.');
    }
    if (!operatorKeyMatches(providedKey, expectedKey)) {
      throw new UnauthorizedException('Invalid internal admin credentials.');
    }

    // Deliberately does NOT write `request.user`. The global
    // TenantContextInterceptor reads that object to bind a tenant, and a
    // platform operator has no family; inventing one there would put a false
    // tenant on the request. The role is passed directly instead.
    return assertRoleAllowedFor(this.reflector, context, Role.SUPER_ADMIN);
  }
}
