import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';

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
 */
@Injectable()
export class InternalAdminGuard implements CanActivate {
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
    return true;
  }
}
