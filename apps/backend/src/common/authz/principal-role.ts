/**
 * PHASE C / P3 — the role vocabulary of this system, in one file.
 *
 * A4 §SA-005 recorded the defect this file exists to close: there was no role
 * system at all on the authorization path. `IJwtPayload` carried
 * `sub / actorType / tokenKind / familyId / jti` and nothing else, so every
 * `PARENT` in a family had, byte for byte, the permissions of the `OWNER` on
 * all 143 routes behind `JwtAuthGuard` — including account/family deletion.
 * The single exception in the whole repository was
 * `account-deletion.service.ts:54`, which read `family_members.role` BY HAND
 * inside a service. The need was known; the mechanism was missing.
 *
 * ---------------------------------------------------------------------------
 * NAMING: we EXTEND, we do not rename.
 * ---------------------------------------------------------------------------
 * The client proposed `SUPER_ADMIN | ADMIN | PARENT | CHILD | SUPPORT`.
 * `schema.prisma` has shipped `enum FamilyRole { OWNER, PARENT }` since 0001,
 * the value is persisted in `family_members.role`, it is returned to the
 * Parent App inside the `login` response (`IAuthenticatedUser.familyRole`), and
 * `account-deletion.service.ts` branches on the literal string `'OWNER'`.
 * Renaming `OWNER` to `ADMIN` would cost a data migration and a breaking API
 * change and would buy exactly zero security. So the mapping is:
 *
 *   client name    ABNY name       where it comes from
 *   -----------    -------------   -------------------------------------------
 *   SUPER_ADMIN    SUPER_ADMIN     `InternalAdminGuard` (INTERNAL_ADMIN_API_KEY)
 *   ADMIN          OWNER   (kept)  `family_members.role = 'OWNER'`
 *   PARENT         PARENT          `family_members.role = 'PARENT'`
 *   CHILD          CHILD           derived from `actorType = 'DEVICE'`
 *   SUPPORT        SUPPORT         platform principal; NOT a family membership
 *
 * ---------------------------------------------------------------------------
 * WHY OWNERSHIP IS A ROLE AND NOT A SECOND COLUMN
 * ---------------------------------------------------------------------------
 * The alternative considered was `Family.primaryGuardianUserId` — a dedicated
 * "family owner" pointer separate from the `PARENT` role. Rejected: it creates
 * a SECOND source of truth for the same fact, free to drift from
 * `family_members.role`, and every check would then have to consult both and
 * decide which wins. `FamilyRole.OWNER` already IS the distinct concept the
 * product needs; it was simply never enforced. Migration 0009 adds the
 * constraint that makes it trustworthy — exactly one live OWNER per family.
 *
 * The product scenarios this model has to survive, stated plainly:
 *   - TWO PARENTS, ONE FAMILY. Both must have FULL day-to-day parenting rights
 *     (create habits, approve rewards, edit policies). So `PARENT` is NOT a
 *     read-only or junior role — it is co-equal on the parenting surface, and
 *     the `OWNER`/`PARENT` split touches only billing, membership and deletion.
 *   - A SEPARATED PARENT must not be able to remove the other parent, transfer
 *     ownership, or delete the family. Those three are OWNER-only, and are
 *     additionally re-verified against the database inside the transaction
 *     (see `family-membership.service.ts`) so a 15-minute-stale token claim
 *     cannot execute them.
 *   - A SUPPORT AGENT must never read a child's activity without an audited
 *     break-glass. `SUPPORT` is therefore declared here, granted by NO token
 *     issuance path in this codebase (asserted by test), and denied on every
 *     route by fail-closed default. The only way a route could ever admit it is
 *     `@Roles(Role.SUPPORT)` + `@BreakGlass(...)`, and the generated sweep
 *     fails the build if the second is missing.
 */

export const Role = {
  /** Platform staff with the internal admin API key. Never family-scoped. */
  SUPER_ADMIN: 'SUPER_ADMIN',
  /** Customer-support staff. Granted by nothing today; break-glass only. */
  SUPPORT: 'SUPPORT',
  /** The family owner / primary guardian. `family_members.role = 'OWNER'`. */
  OWNER: 'OWNER',
  /** A co-parent. Full parenting rights, no billing/membership/deletion. */
  PARENT: 'PARENT',
  /** A paired child device acting for its child. `actorType = 'DEVICE'`. */
  CHILD: 'CHILD',
} as const;

export type PrincipalRole = (typeof Role)[keyof typeof Role];

export const PRINCIPAL_ROLES: readonly PrincipalRole[] = Object.freeze([
  Role.SUPER_ADMIN,
  Role.SUPPORT,
  Role.OWNER,
  Role.PARENT,
  Role.CHILD,
]);

/**
 * The subset that is actually persisted in `family_members.role` — i.e. the
 * Prisma `FamilyRole` enum. `CHILD`, `SUPPORT` and `SUPER_ADMIN` are principal
 * roles derived at authentication time and have no row in `family_members`.
 */
export type PersistedFamilyRole = typeof Role.OWNER | typeof Role.PARENT;

export const PERSISTED_FAMILY_ROLES: readonly PersistedFamilyRole[] = Object.freeze([
  Role.OWNER,
  Role.PARENT,
]);

export function isPersistedFamilyRole(value: unknown): value is PersistedFamilyRole {
  return value === Role.OWNER || value === Role.PARENT;
}

export function isPrincipalRole(value: unknown): value is PrincipalRole {
  return typeof value === 'string' && (PRINCIPAL_ROLES as readonly string[]).includes(value);
}

/** Roles that belong to a household — the ones a `familyId` scopes. */
export const FAMILY_SCOPED_ROLES: readonly PrincipalRole[] = Object.freeze([
  Role.OWNER,
  Role.PARENT,
  Role.CHILD,
]);

export function isFamilyScopedRole(role: PrincipalRole): boolean {
  return (FAMILY_SCOPED_ROLES as readonly string[]).includes(role);
}

/**
 * The role a principal actually holds, derived from the VERIFIED token only.
 *
 * Deliberate fallback, and the reason is compatibility, not laziness: access
 * tokens issued before this sprint carry no `familyRole` claim and stay valid
 * for up to 15 minutes after deploy. Treating them as `PARENT` — the LEAST
 * privileged adult role — means such a token keeps the ordinary parenting
 * surface working while being unable to delete the family, transfer ownership
 * or remove a co-parent. Failing closed entirely would 403 every parent in the
 * fleet for 15 minutes; failing open to `OWNER` would be the bug this sprint
 * exists to remove. Degrading to `PARENT` fails safe in the direction that
 * matters.
 */
export function principalRoleFromToken(payload: {
  actorType?: string;
  familyRole?: string;
}): PrincipalRole | undefined {
  if (payload.actorType === 'DEVICE') return Role.CHILD;
  if (payload.actorType !== 'USER') return undefined;
  if (isPersistedFamilyRole(payload.familyRole)) return payload.familyRole;
  return Role.PARENT;
}
