import { SetMetadata } from '@nestjs/common';

import type { Permission } from '../../../../common/authz/permissions';

/**
 * The permission a route needs, declared on the route.
 *
 * ONE PERMISSION PER ROUTE, not a list. A route that needs two permissions is a
 * route doing two things, and the honest fix is two routes — an `OR` would mean
 * a role could reach a handler by a path the matrix never intended, and an
 * `AND` would hide from the matrix that both are required.
 *
 * Its ABSENCE is a refusal, not a default. `OperatorAuthGuard` rejects an
 * undeclared route outright, for the same reason `JwtAuthGuard` rejects a route
 * with no `@Roles`: the alternative is that the next operator endpoint someone
 * writes is open to every role, and nothing anywhere says so.
 */
export const REQUIRED_PERMISSION_METADATA = 'abny:operator-permission';

export const RequirePermission = (permission: Permission) =>
  SetMetadata(REQUIRED_PERMISSION_METADATA, permission);

/** Reads `request.operator`, populated by `OperatorAuthGuard` and by nothing
 * else — so its presence is proof that both gates and the permission check
 * passed. */
export const OPERATOR_REQUEST_KEY = 'operator';
