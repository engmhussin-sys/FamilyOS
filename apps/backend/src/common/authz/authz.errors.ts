import { ForbiddenException, NotFoundException } from '@nestjs/common';

import type { PrincipalRole } from './principal-role';

/**
 * WHICH STATUS, AND WHY — the rule, written down once so it is not decided
 * per-route by whoever is typing.
 *
 * F1/F2 established "404, never 403" and the reason was specific: a 403 on a
 * resource belonging to ANOTHER family CONFIRMS THAT THE RESOURCE EXISTS. That
 * reasoning is preserved here without modification for every case where a
 * denial would leak existence.
 *
 * It does NOT extend to the intra-family case, and pretending it did would be
 * cargo-culting the shape of the rule instead of its reason:
 *
 *   - CROSS-TENANT and NON-MEMBER denials -> 404 (`ResourceNotVisible`).
 *     A `SUPPORT` or `SUPER_ADMIN` principal poking a family route, or a
 *     principal with no resolvable role, learns nothing about whether the
 *     family or the row exists. Same answer as a nonexistent id.
 *
 *   - INTRA-FAMILY ROLE denials -> 403 (`RoleNotPermitted`).
 *     A `PARENT` hitting `POST /families/ownership/transfer` is a PROVEN
 *     member of that tenant. There is no existence to conceal: the route is in
 *     the published API contract, the family is their own, and they can already
 *     enumerate its members. A 404 here would leak nothing but would tell the
 *     Parent App "this endpoint does not exist", which is false, unactionable,
 *     and would force the app to guess. So it answers 403 with a stable machine
 *     code the app can branch on, and an Arabic sentence that is a statement of
 *     fact plus a way forward (CONTEXT §3 principle 7): "this action is for the
 *     family owner — ask them to do it, or to transfer ownership to you."
 *
 * Flipping the intra-family case to 404 is a one-line change in this file if
 * the product decides otherwise; the decision is recorded, not buried.
 */

export const ROLE_NOT_PERMITTED = 'ROLE_NOT_PERMITTED';
export const ROUTE_ROLE_UNDECLARED = 'ROUTE_ROLE_UNDECLARED';
export const BREAK_GLASS_REQUIRED = 'BREAK_GLASS_REQUIRED';

/** Intra-family: the caller belongs here, but not with this role. */
export class RoleNotPermittedException extends ForbiddenException {
  constructor(held: PrincipalRole, required: readonly PrincipalRole[]) {
    super({
      code: ROLE_NOT_PERMITTED,
      messageEn: `This action requires one of: ${required.join(', ')}.`,
      messageAr: 'هذا الإجراء مخصّص لمالك الأسرة. اطلب منه تنفيذه أو نقل الملكية إليك.',
      requiredRoles: [...required],
      heldRole: held,
    });
  }
}

/**
 * Everything else: a principal with no business in this tenant at all. Answers
 * exactly like a nonexistent resource, on purpose.
 */
export class ResourceNotVisibleException extends NotFoundException {
  constructor() {
    super({
      code: 'NOT_FOUND',
      messageEn: 'The requested resource was not found.',
      messageAr: 'لم نجد ما تبحث عنه.',
    });
  }
}

/**
 * A route behind an auth guard that declares no `@Roles(...)` at all. Deny —
 * the same fail-closed posture the tenant extension takes when no tenant is
 * bound. In practice this is unreachable, because CI fails first.
 */
export class RouteRoleUndeclaredException extends ForbiddenException {
  constructor(route: string) {
    super({
      code: ROUTE_ROLE_UNDECLARED,
      messageEn: `Route ${route} declares no roles and is denied by default.`,
      messageAr: 'هذا الإجراء غير متاح حاليًا. حاول لاحقًا أو تواصل مع الدعم.',
    });
  }
}
