import { Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

/** Protects routes that require a valid parent (USER) access token. */
@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {}

/** Protects routes that require a valid paired child-device access token. */
@Injectable()
export class DeviceJwtAuthGuard extends AuthGuard('device-jwt') {}

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
 */
@Injectable()
export class OptionalJwtAuthGuard extends AuthGuard('jwt') {
  handleRequest<TUser>(_err: unknown, user: TUser): TUser | undefined {
    return (user as TUser) || undefined;
  }
}
