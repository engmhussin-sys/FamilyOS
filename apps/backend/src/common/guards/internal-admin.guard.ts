import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';

import { Role } from '../authz/principal-role';
import { assertRoleAllowedFor } from '../authz/route-authorizer';

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

    if (!expectedKey) {
      throw new UnauthorizedException('Internal admin access is not configured on this environment.');
    }
    if (providedKey !== expectedKey) {
      throw new UnauthorizedException('Invalid internal admin credentials.');
    }

    // Deliberately does NOT write `request.user`. The global
    // TenantContextInterceptor reads that object to bind a tenant, and a
    // platform operator has no family; inventing one there would put a false
    // tenant on the request. The role is passed directly instead.
    return assertRoleAllowedFor(this.reflector, context, Role.SUPER_ADMIN);
  }
}
