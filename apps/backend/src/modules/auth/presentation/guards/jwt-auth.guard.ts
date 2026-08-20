import { ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';

import { assertRoleAllowed } from '../../../../common/authz/route-authorizer';

/**
 * PHASE C (A4 §SA-005) — WHERE THE ROLE CHECK LIVES, AND WHY IT LIVES HERE.
 *
 * The obvious design was a separate `RolesGuard` appended to every
 * `@UseGuards(...)` array. It was rejected for two concrete reasons:
 *
 *   1. It would have edited the guard chain of 183 authenticated routes, and
 *      `life-intelligence.guards.spec.ts` — the SA-001 regression suite, which
 *      exists because a class-level parent guard once got stacked with a
 *      route-level device guard and made 22 routes permanently 401 — asserts
 *      the exact composition of those arrays. Churning them is how SA-001
 *      happened in the first place.
 *   2. It would have made "authenticated" and "authorized" two things a new
 *      route can get independently wrong. Here they are one object: a route
 *      cannot authenticate and forget to authorize, because the authentication
 *      guard itself refuses a request whose route declared no roles.
 *
 * So the check is bolted to the INSIDE of the existing guards. The chain
 * produced by `@UseGuards(JwtAuthGuard)` is byte-identical to before; what
 * changed is what that guard does after Passport says the signature is good.
 * This is the existing guard chain extended — not a second authorization
 * system running beside it.
 */
@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  constructor(private readonly reflector: Reflector) {
    super();
  }

  /** Requires a valid parent (USER) access token AND a permitted role. */
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const authenticated = (await super.canActivate(context)) as boolean;
    if (!authenticated) return false;
    return assertRoleAllowed(this.reflector, context);
  }
}

/** Requires a valid paired child-device access token AND a permitted role. */
@Injectable()
export class DeviceJwtAuthGuard extends AuthGuard('device-jwt') {
  constructor(private readonly reflector: Reflector) {
    super();
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const authenticated = (await super.canActivate(context)) as boolean;
    if (!authenticated) return false;
    return assertRoleAllowed(this.reflector, context);
  }
}

/**
 * F2 (CONTEXT §3.3). For routes that must stay reachable WITHOUT a token but
 * that should still know who the caller is when one is present — today only
 * `POST /support`, which exists precisely so someone who cannot log in can
 * still reach a human.
 *
 * It never rejects: `handleRequest` swallows the error and returns `undefined`,
 * so an anonymous request proceeds with `request.user` unset. What it buys is
 * that when a VALID token IS presented, `request.user` is populated from it —
 * and the global TenantContextInterceptor therefore binds a real tenant.
 *
 * This replaces the previous design, where `familyId` and `userId` were fields
 * on the request DTO. That made the tenant client-supplied, which CONTEXT.md
 * principle 3 forbids outright, and it let anyone claim any family's
 * `priority_support` entitlement by typing its UUID into the body.
 *
 * PHASE C: deliberately does NOT call `assertRoleAllowed`. A guard that never
 * rejects cannot enforce a role, and putting the call here would be a check
 * that does nothing. The control that actually applies to this route is its
 * entry in `PUBLIC_ROUTES`, with a written reason.
 */
@Injectable()
export class OptionalJwtAuthGuard extends AuthGuard('jwt') {
  handleRequest<TUser>(_err: unknown, user: TUser): TUser | undefined {
    return (user as TUser) || undefined;
  }
}
