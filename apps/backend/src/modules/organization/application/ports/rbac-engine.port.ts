import type { OrganizationRoleValue } from '../../domain/organization.types';

/**
 * Sprint 9 addendum \u2014 the SHARED permission engine every organization
 * type resolves through, per the project manager's explicit closing
 * instruction: "family, school, company, and bank should all use the
 * same RBAC + Policy engine, differing only by organization type."
 *
 * `resource` is a dot-scoped string (e.g. "child.screen_time_policy",
 * "device.pairing", "billing.subscription") \u2014 deliberately not an enum
 * here, since the full resource vocabulary depends on which
 * organization types actually ship with which features, a product
 * decision this architecture pass doesn't make on their behalf.
 *
 * NOT implemented in this sprint. A future `RbacEngineService`
 * implementing this port would replace today's scattered, ad-hoc
 * ownership checks (`assertChildBelongsToFamily`,
 * `assertDeviceBelongsToFamily`, etc.) with one central decision
 * point \u2014 but that is a real refactor of working, tested code, out of
 * scope for "don't redesign any previous Sprint."
 */
export interface IPermissionCheck {
  userId: string;
  organizationId: string;
  resource: string;
  action: 'READ' | 'WRITE' | 'DELETE' | 'ADMIN';
}

export const RBAC_ENGINE = Symbol('RBAC_ENGINE');

export interface IRbacEngine {
  hasPermission(check: IPermissionCheck): Promise<boolean>;
  getRole(userId: string, organizationId: string): Promise<OrganizationRoleValue | null>;
}
