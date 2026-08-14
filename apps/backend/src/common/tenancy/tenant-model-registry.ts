/**
 * The single source of truth for "which model belongs to which tenancy class".
 *
 * R8 / DA-004 / SA-010. Every one of the 60 models in schema.prisma appears in
 * exactly one of the five sets below. That exhaustiveness is not a convention —
 * `test/tenancy/tenant-model-registry.spec.ts` reads Prisma's own model list at
 * runtime and fails if a model is missing from all of them or present in two.
 *
 * The rule that produced the classification (applied in this order):
 *
 *   1. Can a row's tenant be derived from the relation graph, and is the row
 *      meaningless outside one household?  -> STRICT_TENANT_MODELS
 *      (`family_id uuid NOT NULL`). This covers both directly-family-owned
 *      rows and everything reachable through `children.family_id`.
 *   2. Is the row tenant-owned when it exists, but legitimately tenant-less in
 *      a defined case (a system-provided default, an anonymised row, a
 *      platform-level event)?  -> one of the two nullable classes.
 *      - SHARED_NULL_TENANT_MODELS: `family_id IS NULL` means "provided by the
 *        platform to every family" and MUST stay readable to all tenants.
 *      - PLATFORM_ANNOTATED_MODELS: `family_id IS NULL` means "not attributable
 *        to a family" and MUST NOT be readable by any tenant, only by
 *        SystemContext.
 *   3. Is the row the tenant itself?  -> SELF_TENANT_MODELS (scoped by `id`).
 *   4. Otherwise it is genuinely not part of family tenancy -> GLOBAL_MODELS,
 *      and the reason is written next to it. Nothing lands here by default;
 *      everything here is an explicit, argued decision.
 */

/** Model names as Prisma exposes them (`Prisma.ModelName`). */
export type TenantModelName = string;

/**
 * Class (a) + (b): 44 models carrying `family_id uuid NOT NULL`.
 * The extension injects `where: { familyId }` on every read/update/delete and
 * sets `familyId` on every create. No tenant context => the operation throws.
 */
export const STRICT_TENANT_MODELS: ReadonlySet<TenantModelName> = new Set([
  // -- directly family-owned (carried family_id before F2) --
  'FamilyMember',
  'Child',
  'Device',
  'Subscription',
  'RewardCatalogItem',
  'FamilyBroadcastMessage',
  'FamilyChallenge',
  // -- gained family_id in migration 0003, backfilled via children.family_id --
  'ParentalConsent',
  'DevicePairingEvent',
  'ScreenTimePolicy',
  'DailyBehavioralSnapshot',
  'AppUsageLog',
  'AppBlockRule',
  'LocationSafeZone',
  'LocationEvent',
  'AiRiskScore',
  'AiAlert',
  'AiMemoryEntry',
  'Notification',
  'Habit',
  'HabitCompletion',
  'RewardsAccount',
  'RewardsLedgerEntry',
  'ChildBadgeAward',
  'RewardRedemption',
  'ChildMessage',
  'LifeTimelineEvent',
  'ChildDigitalTwinProjection',
  'NutritionLog',
  'HydrationLog',
  'SleepLog',
  'ActivityLog',
  'PhysicalMeasurementLog',
  'HealthScoreDaily',
  'FaithPractice',
  'FaithPracticeLog',
  'LearningGoal',
  'LearningSession',
  'LearningAssessment',
  'SmartTask',
  'FamilyChallengeParticipation',
  // -- gained family_id in migration 0003, backfilled via devices.family_id --
  'DeviceRiskAssessment',
  'AppCatalogEntry',
  // -- gained family_id in migration 0003, backfilled via subscriptions --
  'Invoice',
  // -- F3 (R3): the event backbone. Created STRICT in migration 0005, never
  //    nullable, so there is no backfill and no orphan case. A domain event
  //    without a family is not something this system can produce: the tenant is
  //    stamped from the verified device token at ingestion, and every derived
  //    event inherits it from the event that caused it.
  'DomainEvent',
  'OutboxMessage',
  'ConsumedMessage',
]);

/**
 * `family_id IS NULL` means "platform-provided, visible to every family".
 * Reads become `WHERE family_id = $ctx OR family_id IS NULL`; writes are still
 * forced to the caller's tenant, so a tenant can never create or edit a shared
 * row. Today this is exactly one model — `RewardRule` already ships system
 * rules with a NULL tenant and `prisma-rewards.repository.ts:79` already reads
 * it with that OR by hand.
 */
export const SHARED_NULL_TENANT_MODELS: ReadonlySet<TenantModelName> = new Set([
  'RewardRule',
]);

/**
 * `family_id IS NULL` means "not attributable to a family", and such rows are
 * deliberately INVISIBLE to tenants — only SystemContext sees them. Reads are
 * filtered strictly (`family_id = $ctx`), writes are stamped with the tenant
 * when there is one and left NULL under SystemContext.
 */
export const PLATFORM_ANNOTATED_MODELS: ReadonlySet<TenantModelName> = new Set([
  // Platform events (a failed login before any family is known) legitimately
  // have no tenant; family-attributable events now do. BA-009 / DA-008.
  'AuditLog',
  // DA-013: no relation exists from which a tenant could be derived for rows
  // written before F2, so historical rows are honestly NULL.
  'AiUsageLog',
  // family_id is nulled deliberately by the 180-day anonymisation job.
  'AnalyticsEvent',
  // A support request can arrive from someone who is not logged in.
  'SupportRequest',
]);

/**
 * The tenant root itself. Scoped on `id`, not on `familyId` — without this a
 * `family.findMany()` would enumerate every household in the system.
 */
export const SELF_TENANT_MODELS: ReadonlyMap<TenantModelName, string> = new Map([
  ['Family', 'id'],
]);

/**
 * Genuinely outside family tenancy. Every entry carries its justification;
 * "it was easier" is not one of them.
 */
export const GLOBAL_MODELS: ReadonlyMap<TenantModelName, string> = new Map([
  [
    'User',
    'Identity, not tenant data. Login resolves a user by email BEFORE any family context can exist, and a user may (by schema) belong to more than one family. Exposure is controlled at the route layer — no endpoint lists users.',
  ],
  [
    'RefreshToken',
    'Auth artefact looked up by a secret SHA-256 hash before a tenant is known. The hash is the capability; a tenant filter would add nothing.',
  ],
  ['PlanDefinition', 'Global price/feature catalogue. Read-only for tenants.'],
  ['BadgeDefinition', 'Global badge catalogue. Ownership lives in ChildBadgeAward, which IS tenant-scoped.'],
  ['FeatureFlag', 'Platform configuration. Per-family targeting is a value inside `enabled_family_ids`, not a row-level tenant.'],
  [
    'Organization',
    'SECOND, PARALLEL TENANT AXIS (B2B). schema.prisma states the constraint explicitly: zero FK from these tables into Family and zero FK from Family into them. They are keyed on `organization_id`, not `family_id`, and are unreachable from any family-scoped route today. Scoping them to a family would be wrong, not merely unnecessary — see F2 report for the deliberate decision and the follow-up it implies.',
  ],
  ['OrganizationMember', 'Part of the parallel B2B tenant axis keyed on organization_id; zero FK to Family by explicit schema constraint. See Organization above for the full reasoning.'],
  ['OrganizationPolicy', 'Part of the parallel B2B tenant axis keyed on organization_id; zero FK to Family by explicit schema constraint. See Organization above for the full reasoning.'],
  ['OrganizationInvitation', 'Part of the parallel B2B tenant axis keyed on organization_id; zero FK to Family by explicit schema constraint. See Organization above for the full reasoning.'],
  ['PartnerCampaign', 'Part of the parallel B2B tenant axis keyed on organization_id; zero FK to Family by explicit schema constraint. See Organization above for the full reasoning.'],
]);

/** True for any model the extension must not let through without a tenant. */
export function isTenantScoped(model: string): boolean {
  return (
    STRICT_TENANT_MODELS.has(model) ||
    SHARED_NULL_TENANT_MODELS.has(model) ||
    PLATFORM_ANNOTATED_MODELS.has(model) ||
    SELF_TENANT_MODELS.has(model)
  );
}

/** The column the extension filters on for a given model. */
export function tenantColumnFor(model: string): string | undefined {
  if (SELF_TENANT_MODELS.has(model)) return SELF_TENANT_MODELS.get(model);
  if (isTenantScoped(model)) return 'familyId';
  return undefined;
}

/** Every classified model, used by the exhaustiveness test and the CI guard. */
export const ALL_CLASSIFIED_MODELS: ReadonlySet<TenantModelName> = new Set([
  ...STRICT_TENANT_MODELS,
  ...SHARED_NULL_TENANT_MODELS,
  ...PLATFORM_ANNOTATED_MODELS,
  ...SELF_TENANT_MODELS.keys(),
  ...GLOBAL_MODELS.keys(),
]);
