/**
 * Sprint 9 addendum. Generalizes the versioned-policy-per-owner pattern
 * `ScreenTimeService` already uses at the Child level, one layer up, to
 * the Organization level \u2014 e.g. a School's default policy applying to
 * every Family sub-organization enrolled under it. NOT a replacement
 * for ScreenTimePolicy (which stays exactly as-is, per "don't redesign
 * any previous Sprint") \u2014 a future org-level policy would compose WITH
 * the existing child-level one (school default, family override), the
 * same layering relationship any real policy-inheritance system needs,
 * left for whoever implements this port to design in detail.
 *
 * NOT implemented in this sprint.
 */
export const POLICY_ENGINE = Symbol('POLICY_ENGINE');

export interface IPolicyEngine {
  getPolicy<T = unknown>(organizationId: string, key: string): Promise<T | null>;
  setPolicy(organizationId: string, key: string, value: unknown): Promise<void>;
  /** Walks up the `parentOrganizationId` chain (e.g. Family \u2192 School)
   * until a value for `key` is found, or returns null if none of the
   * ancestor organizations have one set \u2014 the inheritance behavior a
   * School-default-overridden-by-Family-preference model needs. */
  getEffectivePolicy<T = unknown>(organizationId: string, key: string): Promise<T | null>;
}
