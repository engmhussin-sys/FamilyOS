import type { ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';

import {
  ResourceNotVisibleException,
  RoleNotPermittedException,
  RouteRoleUndeclaredException,
} from './authz.errors';
import { BREAK_GLASS_METADATA, type BreakGlassMetadata } from './break-glass.decorator';
import { isFamilyScopedRole, principalRoleFromToken, Role, type PrincipalRole } from './principal-role';
import { ROLES_METADATA } from './roles.decorator';

/**
 * The one and only intra-family authorization decision in this codebase.
 *
 * DELIBERATELY NOT A NEW GUARD. `JwtAuthGuard` and `DeviceJwtAuthGuard` call
 * this immediately after Passport has verified the token, so:
 *
 *   - the guard CHAIN is unchanged — no route gains a second guard, and
 *     `life-intelligence.guards.spec.ts` (SA-001: never stack a parent guard
 *     with a device guard) keeps asserting exactly what it asserted before;
 *   - there is no way to have authentication without authorization, because
 *     it is the same object doing both. A route cannot be written that
 *     authenticates and forgets to authorize;
 *   - the role is read from `request.user`, which Passport built from a
 *     SIGNATURE-VERIFIED payload. Never from the body, the query, the params
 *     or a header — the same rule CONTEXT §3 principle 3 imposes on `familyId`,
 *     applied to the role.
 *
 * FRESHNESS, stated honestly: the claim is signed, so it cannot be forged, but
 * it CAN be up to 15 minutes stale after a role change. That is acceptable for
 * the read/write parenting surface and NOT acceptable for the three destructive
 * operations, which therefore re-read `family_members` inside their own
 * transaction (`FamilyMembershipService`) rather than trusting this claim.
 * Guard = cheap fail-fast; service = authoritative, race-free.
 */
export interface AuthorizedPrincipal {
  readonly sub: string;
  readonly actorType?: string;
  readonly familyId?: string;
  readonly familyRole?: string;
}

export function resolveRequiredRoles(
  reflector: Reflector,
  context: ExecutionContext,
): PrincipalRole[] | undefined {
  return reflector.getAllAndOverride<PrincipalRole[] | undefined>(ROLES_METADATA, [
    context.getHandler(),
    context.getClass(),
  ]);
}

export function resolveBreakGlass(
  reflector: Reflector,
  context: ExecutionContext,
): BreakGlassMetadata | undefined {
  return reflector.getAllAndOverride<BreakGlassMetadata | undefined>(BREAK_GLASS_METADATA, [
    context.getHandler(),
    context.getClass(),
  ]);
}

function routeLabel(context: ExecutionContext): string {
  return `${context.getClass()?.name ?? '?'}.${context.getHandler()?.name ?? '?'}`;
}

/**
 * Throws on denial, returns `true` on success. Never returns `false`: a bare
 * `false` from a Nest guard produces a bodyless 403 that bypasses the B3 error
 * contract, and every response in this system carries `{ code, messageAr }`.
 */
export function assertRoleAllowed(reflector: Reflector, context: ExecutionContext): true {
  const principal = context.switchToHttp().getRequest()?.user as AuthorizedPrincipal | undefined;
  return assertRoleAllowedFor(
    reflector,
    context,
    principal ? principalRoleFromToken(principal) : undefined,
    principal,
  );
}

/**
 * The same decision, for a principal whose role does NOT come from a JWT.
 * Today that is exactly one caller: `InternalAdminGuard`, which authenticates
 * a platform operator with a shared API key and therefore holds `SUPER_ADMIN`
 * with no token and no family.
 */
export function assertRoleAllowedFor(
  reflector: Reflector,
  context: ExecutionContext,
  held: PrincipalRole | undefined,
  principal?: AuthorizedPrincipal,
): true {
  const required = resolveRequiredRoles(reflector, context);

  // Fail closed. A route behind an auth guard that never said who may call it
  // is not "open by omission" — it is broken, and CI says so before a client
  // ever sees this.
  if (!required || required.length === 0) {
    throw new RouteRoleUndeclaredException(routeLabel(context));
  }

  // No resolvable role at all: answer exactly like a missing resource.
  if (!held) throw new ResourceNotVisibleException();

  if (required.includes(held)) {
    // SUPPORT may only ever pass through a route that ALSO declares a
    // break-glass. Belt and braces with the CI rule, because a runtime check
    // survives a deleted test and a CI rule does not.
    if (held === Role.SUPPORT && !resolveBreakGlass(reflector, context)) {
      throw new ResourceNotVisibleException();
    }
    return true;
  }

  // Denied. Which status depends on whether the caller is inside this tenant —
  // see the long comment in `authz.errors.ts`.
  const requiredIsFamilyScoped = required.every((r) => isFamilyScopedRole(r));
  if (isFamilyScopedRole(held) && requiredIsFamilyScoped && principal?.familyId) {
    throw new RoleNotPermittedException(held, required);
  }
  throw new ResourceNotVisibleException();
}
