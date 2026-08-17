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
  // PHASE D (PC-D-005): a notification held for the end of a family's quiet
  // hours. Same class as `Notification` for the same reason — the row is one
  // household's business, is meaningless outside it, and is read back by that
  // household's own release path from inside `runWithTenant`.
  'NotificationDelivery',
  // PHASE F (F6-002): the two tables of the smart notification decision layer,
  // migration 0018. `NotificationDecision` is the same class as `Notification`
  // and `NotificationDelivery` for the same reason — a decision about one
  // household's notification is that household's business and is meaningless
  // outside it; the platform analytics surface reads it CROSS-TENANT through
  // `runAsSystemAsync` and a `@SystemRoute`, exactly as the delivery backlog
  // gauge does, and never by weakening the tenant filter.
  // `NotificationPolicySetting` is the household's OWN caps and quiet hours —
  // it is deliberately NOT the `GrowthSetting` case: growth settings are
  // platform configuration with one global value, and these have one value PER
  // FAMILY, which is the whole reason the table exists.
  'NotificationDecision',
  'NotificationPolicySetting',
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
  // -- F4 (Smart Learning & Reward Engine): created STRICT in migration 0006,
  //    `family_id uuid NOT NULL` from the first row, so — exactly as in 0005 —
  //    there is no backfill, no orphan case and no nullable window. A reward
  //    program without a family is not something this system can produce: the
  //    tenant is stamped from the parent's verified session on create, and
  //    every downstream row (achievement, verification attempt, screen-time
  //    grant, fulfilment) inherits it from the program that caused it.
  'RewardProgram',
  'AchievementRequest',
  'VerificationAttempt',
  'ScreenTimeRewardGrant',
  'RewardFulfilment',

  // -- B5 (PA-B-017, PA-B-019) --
  // Both are reachable only through an AchievementRequest, which is strict, so
  // rule 1 applies verbatim: the tenant is derivable from the relation graph
  // and the row is meaningless outside one household. `achievement_evidence`
  // in particular is the most sensitive table B5 adds — a recording of a
  // child's voice — and STRICT is the only defensible class for it.
  'QuizAssignment',
  'AchievementEvidence',

  // -- PHASE D (commercial subscription & payments) --
  // Created STRICT in migration 0013 with `family_id uuid NOT NULL` from the
  // first row, so — as in 0005 and 0006 — there is no backfill, no orphan case
  // and no nullable window.
  //
  // The tenant of a payment is NOT taken from the request. For a store
  // purchase it is resolved from `provider_account_links`, whose UNIQUE
  // `(provider, provider_account_ref)` maps the store's opaque account token to
  // exactly one household; for a gateway callback it is resolved from the
  // merchant order we ourselves created before redirecting the customer. In
  // both cases the family is derived from state WE wrote, never from the
  // payload the provider (or an attacker imitating one) sent.
  'Trial',
  'ProviderAccountLink',
  'PaymentTransaction',
  'Refund',
  'Entitlement',

  // -- PHASE D (GROWTH). Created STRICT in migration 0015 with
  //    `family_id uuid NOT NULL` from the first row — as in 0005, 0006 and
  //    0014, so no backfill, no orphan case and no nullable window.
  //
  //    Rule 1 applies verbatim to all six: each row describes ONE household
  //    and is meaningless outside it. `AcquisitionAttribution` is where a
  //    household came from; `FamilyActivation` is whether it ever reached
  //    value; the four referral tables are one household's invitations, its
  //    conversions and the payouts it earned.
  //
  //    THE REFERRAL TABLES ARE THE INTERESTING CASE, because a referral spans
  //    TWO households. The tenant of a `ReferralEvent` is the REFERRER —
  //    `family_id` — and the referred household appears only as
  //    `referred_family_id`, a plain column with no tenancy meaning. That is
  //    deliberate and it is the whole reason the referral surface is
  //    tenant-safe: parent A can read the events they caused, and reading one
  //    of them tells them a code was redeemed, never who the other household
  //    is beyond an opaque id they cannot resolve to anything through any
  //    route in this API.
  'AcquisitionAttribution',
  'FamilyActivation',
  'ReferralCode',
  'ReferralLink',
  'ReferralEvent',
  'ReferralReward',
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
  // B5 (PA-B-017). The question bank is the SECOND legitimate member of this
  // class and it is here for exactly the reason the class exists: migration
  // 0008 seeds platform sample questions with `family_id IS NULL` so every
  // family can draw from them, while a family that authors its own questions
  // gets rows only it can read. Making it GLOBAL would have leaked one
  // family's authored questions to every other family; making it STRICT would
  // have made the seeded bank invisible to everyone.
  'QuizQuestion',
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
  // PHASE C P4 (scheduler). A run of `data-retention-sweep` covers every
  // household at once and belongs to none of them, so `family_id IS NULL` is
  // the honest value and the row must NOT be readable by a tenant — a family
  // learning that a platform sweep deleted 412,000 rows tells it about other
  // families. A run of `family-daily-rollover` DOES belong to one household:
  // the runner re-enters `runWithTenant({ familyId })` before executing it, so
  // the extension stamps the tenant on the insert exactly as it would for an
  // HTTP request, and that family (and only that family) can read its own
  // rollover history. Both meanings in one table is precisely what this class
  // is for.
  'JobRun',
  // PHASE D. A provider's webhook is RECEIVED, and its signature VERIFIED,
  // before any family is known — that is precisely what "never trust the
  // payload" means: we write the dedupe row first (so a redelivery is already
  // a no-op if we crash mid-handler), then resolve the tenant from state we
  // ourselves wrote. `family_id IS NULL` is therefore the honest value for the
  // window between receipt and resolution, and for every event that never
  // resolves — a webhook for a purchase that belongs to no household of ours,
  // which is exactly the row an operator most needs to be able to read. Such a
  // row must NOT be visible to a tenant: it is another merchant's traffic, or
  // an attack, and either way it is not this family's business.
  'PaymentWebhookEvent',
  // PHASE D (GROWTH). An operator alert. Every rule this module raises today
  // is population-level (conversion, churn, payment failures, a country's
  // performance shifting) and belongs to no household — `family_id IS NULL` is
  // the honest value. The column exists because an AI-SAFETY alert IS about
  // one household, and such a row must NOT be readable by a tenant: an alert
  // is a platform operations artefact, and "another family had a safety
  // incident" is not this family's business. Exactly the AuditLog / JobRun
  // case, which is why it is in this class and not in SHARED_NULL.
  'GrowthAlert',
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
  [
    'Country',
    'PHASE D: the launch-market catalogue — ISO code, currency, and the VAT rate set by that country\'s tax authority. Facts of law, owned by the deployment, identical for every household. Exactly the PlanDefinition case.',
  ],
  [
    'Currency',
    'PHASE D: ISO-4217 reference data (symbol, minor-unit exponent). It is not tenant data under any reading, and scoping it to a family would mean a family could not render its own price.',
  ],
  [
    'SubscriptionPrice',
    'PHASE D: THE price list — what each tier costs per country, currency and billing period. The catalogue is platform-owned and identical for every family; what a household actually BOUGHT lives on `subscriptions` and `payment_transactions`, both of which ARE tenant-scoped. Making this STRICT would mean one price-list row per household (sixty thousand rows describing one price) and would make a price change a data migration.',
  ],
  ['BadgeDefinition', 'Global badge catalogue. Ownership lives in ChildBadgeAward, which IS tenant-scoped.'],
  ['FeatureFlag', 'Platform configuration. Per-family targeting is a value inside `enabled_family_ids`, not a row-level tenant.'],
  [
    'ScheduledJob',
    'PHASE C P4: the job REGISTRY — one row per named piece of code, holding its cadence, its enabled flag and its lease. Exactly the FeatureFlag case: platform configuration owned by the deployment, not by a household. Giving it a family_id would mean either one registry row per family (sixty thousand rows describing one job) or a NULL that means nothing. The per-family half of a scheduled job lives in JobRun.family_id, which IS tenant-annotated.',
  ],
  [
    'Organization',
    'SECOND, PARALLEL TENANT AXIS (B2B). schema.prisma states the constraint explicitly: zero FK from these tables into Family and zero FK from Family into them. They are keyed on `organization_id`, not `family_id`, and are unreachable from any family-scoped route today. Scoping them to a family would be wrong, not merely unnecessary — see F2 report for the deliberate decision and the follow-up it implies.',
  ],
  ['OrganizationMember', 'Part of the parallel B2B tenant axis keyed on organization_id; zero FK to Family by explicit schema constraint. See Organization above for the full reasoning.'],
  ['OrganizationPolicy', 'Part of the parallel B2B tenant axis keyed on organization_id; zero FK to Family by explicit schema constraint. See Organization above for the full reasoning.'],
  ['OrganizationInvitation', 'Part of the parallel B2B tenant axis keyed on organization_id; zero FK to Family by explicit schema constraint. See Organization above for the full reasoning.'],
  ['PartnerCampaign', 'Part of the parallel B2B tenant axis keyed on organization_id; zero FK to Family by explicit schema constraint. See Organization above for the full reasoning.'],
  [
    'RewardProgramCategory',
    'F4: global category catalogue, seeded by migration 0006 from src/shared/rewards/program-taxonomy.ts. Exactly the BadgeDefinition case — the CATALOGUE is platform-owned and identical for every family, while ownership lives in RewardProgram, which IS strict. A table (not a PostgreSQL enum) so a nineteenth category is an INSERT rather than an ALTER TYPE.',
  ],
  [
    'QuranSurah',
    'F4: the 114 surahs and their Hafs ayah counts, seeded by migration 0006 from src/shared/rewards/quran.ts. Fixed reference data about the mushaf; it is not tenant data under any reading, and scoping it to a family would mean a family could not validate a target spec.',
  ],
  [
    'GrowthCampaign',
    'PHASE D (GROWTH): an admin-created acquisition campaign — budget, country, channel, window and targets. Platform configuration owned by the deployment and identical for every household; exactly the SubscriptionPrice case. What a HOUSEHOLD\'s relationship to a campaign is lives in AcquisitionAttribution, which IS strict.',
  ],
  [
    'CampaignDailySpend',
    'PHASE D (GROWTH): what a campaign cost on a day, plus the impressions/clicks/visits the ad platform reported. Ad spend is a platform fact; no household paid any of it, and scoping it to one would be meaningless.',
  ],
  [
    'GrowthDailyMetric',
    'PHASE D (GROWTH): the cross-tenant daily aggregate. A row is a COUNT OVER HOUSEHOLDS and therefore belongs to none of them; making it readable by a tenant would tell one family how many other families exist, converted and churned. Written only by the aggregation job under SystemContext.',
  ],
  [
    'GrowthQuarterlyTarget',
    'PHASE D (GROWTH): what a human committed to for a country and quarter. A company target is not tenant data under any reading, and a household that could read it would learn the company\'s revenue plan.',
  ],
  [
    'GrowthForecastScenario',
    'PHASE D (GROWTH): the admin-editable assumptions behind every projection (acquisition, conversion, churn, ARPU, CAC, retention). Platform-level business planning inputs, the same class as the price list they are derived against.',
  ],
  [
    'GrowthSetting',
    'PHASE D (GROWTH): every business number the growth module obeys — referral reward values, the qualification window, the activation threshold, alert thresholds, reporting timezones. Platform configuration owned by the deployment, exactly the FeatureFlag case. Per-country variation is a value inside the key, not a row-level tenant.',
  ],
  [
    'PilotInvite',
    'G16: the controlled-pilot allow-list — one row per invited household, created by an operator BEFORE that household exists. Global for a reason of TIMING, not convenience: the pilot gate runs inside registration, ahead of the transaction that creates the Family row, because its entire purpose is to refuse before an account exists. A family_id column could therefore only ever be NULL at the single moment it is read, and a tenant column that is NULL exactly when it is needed is worse than none — it invites a filter that silently matches nothing. The backward link is redeemed_by_family_id, written once the family exists, and it is indexed. Identical to the FeatureFlag / GrowthSetting case in every other respect: platform configuration owned by the deployment, and no family-scoped route reads these rows.',
  ],
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
