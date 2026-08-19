import { Prisma } from '@prisma/client';

/**
 * THE ONE PLACE THAT DECIDES WHAT LEAVES THIS MODULE.
 *
 * `FeatureFlag.enabledFamilyIds` is a `String[] @db.Uuid` — the per-family
 * rollout allow-list. `familyId` is the tenant key of this entire API, so that
 * column is a list of OTHER TENANTS' PRIMARY KEYS sitting in a table any
 * authenticated parent could read. `GET /api/v1/feature-flags` used to
 * `findMany()` with no `select` and return the rows verbatim, which handed
 * every parent, in every family, the UUID of every family each flag had been
 * switched on for — plus the names and descriptions of unreleased features.
 *
 * This is the same defect that shipped in `GET /children` (a child's PIN hash
 * returned inside the raw Prisma row) and it is fixed the same way: a WHITELIST
 * in the repository, with the view type DERIVED from the whitelist rather than
 * restated, so the query and the type cannot drift and a column added to
 * `FeatureFlag` tomorrow is NOT exposed until somebody widens one of these
 * lists on purpose.
 */

/**
 * THE EVALUATION PROJECTION — SERVER-SIDE ONLY, NEVER SERIALISED.
 *
 * The only projection that reads `enabledFamilyIds`, because deciding "is this
 * flag on for family X?" genuinely needs the allow-list. It is reachable from
 * `findByKey`, which feeds `FeatureFlagService.isEnabled` (a boolean) and
 * `enableForFamily` (a write). No controller returns this type, and the
 * compiler says so: every handler in this module declares
 * `IFeatureFlagClientView`, which has no `enabledFamilyIds` to assign into.
 */
export const FEATURE_FLAG_EVALUATION_SELECT = {
  key: true,
  isEnabledGlobally: true,
  enabledFamilyIds: true,
} as const satisfies Prisma.FeatureFlagSelect;

export type IFeatureFlagEvaluation = Prisma.FeatureFlagGetPayload<{
  select: typeof FEATURE_FLAG_EVALUATION_SELECT;
}>;

/**
 * THE ROSTER PROJECTION. One row per flag, WITHOUT the allow-list — the tenant
 * UUIDs are not selected, so they are never read out of PostgreSQL and there is
 * nothing in this process's memory to leak on any list path.
 *
 * `isEnabledGlobally` is a property of the DEPLOYMENT, not of any family: it is
 * already served unauthenticated by `GET /system/diagnostics`. It is kept here
 * because that route reads it, and because it is half of the server-side
 * `isEnabledForMe` computation. It is not on the parent's wire shape.
 */
export const FEATURE_FLAG_ROSTER_SELECT = {
  key: true,
  isEnabledGlobally: true,
} as const satisfies Prisma.FeatureFlagSelect;

export type IFeatureFlagSummary = Prisma.FeatureFlagGetPayload<{
  select: typeof FEATURE_FLAG_ROSTER_SELECT;
}>;

/**
 * THE MEMBERSHIP PROJECTION. "Which flags is MY family on the allow-list for?"
 * asked as a `where` clause — `enabledFamilyIds: { has: familyId }` — so the
 * database answers with the caller's own keys and never ships anyone else's
 * UUIDs across the wire from Postgres. Only the caller's own `familyId`, taken
 * from the verified access token, is ever put into that filter.
 */
export const FEATURE_FLAG_KEY_SELECT = {
  key: true,
} as const satisfies Prisma.FeatureFlagSelect;

export type IFeatureFlagKey = Prisma.FeatureFlagGetPayload<{
  select: typeof FEATURE_FLAG_KEY_SELECT;
}>;

/**
 * THE WIRE SHAPE — everything a parent receives from `GET /feature-flags`, and
 * the only type its handler may return.
 *
 * TWO FIELDS, AND HERE IS THE ARGUMENT FOR EACH:
 *
 *  `key`             the client cannot act on an answer it cannot match to a
 *                    switch. These identifiers are compiled into the client
 *                    already, and `GET /system/diagnostics` publishes the same
 *                    list with no authentication at all, so withholding them
 *                    here would cost the route its purpose and hide nothing.
 *
 *  `isEnabledForMe`  the DECISION, taken on the server from the caller's token
 *                    `familyId`. The client is told what it may do; it is never
 *                    given the inputs and asked to work it out. A client that
 *                    receives a rollout list and evaluates itself is a client
 *                    deciding its own entitlement — it can simply claim to be
 *                    on the list, and the value of every other family's UUID
 *                    lies precisely in being able to make that claim.
 *
 * AND HERE IS WHY EVERY OTHER COLUMN IS GONE:
 *
 *  `enabledFamilyIds`  the defect. Other tenants' primary keys.
 *  `description`       roadmap prose about features that have not shipped;
 *                      product intent, not a parent's entitlement.
 *  `isEnabledGlobally` combined with `isEnabledForMe` it discloses whether this
 *                      family is on a private allow-list — a rollout decision
 *                      about this account that the account has no use for.
 *  `id`, `createdAt`,
 *  `updatedAt`         row bookkeeping; a flag is addressed by `key`.
 *
 * Deliberately NOT a `Prisma.FeatureFlagGetPayload`: `isEnabledForMe` is
 * COMPUTED and exists on no table. That makes this shape closed by
 * construction — a column added to `FeatureFlag` cannot appear here even by
 * accident, which is the strongest form of the "not exposed by default" rule
 * this file exists to enforce.
 */
export interface IFeatureFlagClientView {
  readonly key: string;
  readonly isEnabledForMe: boolean;
}
