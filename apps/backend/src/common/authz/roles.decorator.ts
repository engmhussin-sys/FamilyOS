import { SetMetadata } from '@nestjs/common';

import { Role, type PrincipalRole } from './principal-role';

/**
 * Same `abny:` metadata namespace as `@SystemRoute` — one convention, one
 * grep. `grep -rn "@Roles\|@OwnerOnly\|@ParentSurface\|@ChildSurface" src/` IS
 * the permission matrix, the same way `grep -rn "@SystemRoute" src/` is the
 * tenant-bypass audit trail.
 */
export const ROLES_METADATA = 'abny:roles';

/**
 * Declares WHICH principal roles may execute this route.
 *
 * Read by `assertRoleAllowed()` from inside `JwtAuthGuard` /
 * `DeviceJwtAuthGuard` — i.e. the EXISTING guard chain, extended. There is no
 * second guard to remember to stack, and no route can opt out by forgetting
 * one: a route behind an auth guard that declares no roles at all is DENIED at
 * runtime and fails `controller-guard-coverage.spec.ts` in CI.
 *
 * Method-level metadata overrides class-level (Nest's `getAllAndOverride`), so
 * a controller may state its default once and a single route may narrow it.
 */
export const Roles = (...roles: PrincipalRole[]) =>
  SetMetadata<string, PrincipalRole[]>(ROLES_METADATA, roles);

/**
 * The ordinary parenting surface: both adults in the family, co-equal.
 *
 * This is the default for a reason. Two parents in one household must BOTH be
 * able to run the product day to day; a co-parent who cannot approve a reward
 * is not a co-parent. The OWNER/PARENT distinction is reserved for the three
 * things a separated or compromised parent must not be able to do alone.
 */
export const ParentSurface = () => Roles(Role.OWNER, Role.PARENT);

/** Billing, membership and destruction. The family owner / primary guardian. */
export const OwnerOnly = () => Roles(Role.OWNER);

/** The child app, authenticated by a paired-device token. */
export const ChildSurface = () => Roles(Role.CHILD);

/** Platform-internal surfaces behind `InternalAdminGuard`. */
export const PlatformAdminSurface = () => Roles(Role.SUPER_ADMIN);
