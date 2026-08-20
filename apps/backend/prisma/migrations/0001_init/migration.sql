-- 0001_init — complete baseline for the full 60-model schema.
--
-- REPLACES prisma/migrations/20260731_life_intelligence_platform_sprint13,
-- which was hand-authored, covered 13 of 60 tables, and aborted at its
-- first foreign key with `relation "children" does not exist`
-- (A2-Data-Audit §5.2, exit code 3). CI's `prisma migrate deploy` step
-- could therefore never be green, and no new environment could ever be
-- built from the migration history.
--
-- HOW THIS FILE WAS PRODUCED (not hand-written):
--   the Prisma schema engine itself, run through WASM because
--   binaries.prisma.sh is 403-blocked in this environment:
--     SchemaEngine.diff({ from: {tag:'empty'},
--                         to:   {tag:'schemaDatamodel', files:[schema.prisma]},
--                         script: true })
--   (@prisma/schema-engine-wasm + @prisma/adapter-pg). See
--   /root/abny/audit/F1-Backend-Fix-Report.md for the exact commands.
--
-- VERIFIED BY EXECUTION against a clean PostgreSQL 16.13 database:
--   psql -v ON_ERROR_STOP=1 -f migration.sql  -> exit 0
--   60 BASE TABLEs, 76 FOREIGN KEYs, 34 UNIQUE indexes created.
--
-- EXISTING DATABASES (built historically with `prisma db push`) must be
-- baselined rather than re-applied:
--     npx prisma migrate resolve --applied 0001_init
--
-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('PENDING_VERIFICATION', 'ACTIVE', 'SUSPENDED', 'DELETED');

-- CreateEnum
CREATE TYPE "FamilyRole" AS ENUM ('OWNER', 'PARENT');

-- CreateEnum
CREATE TYPE "SubscriptionPlan" AS ENUM ('FREE', 'PREMIUM', 'FAMILY', 'ENTERPRISE');

-- CreateEnum
CREATE TYPE "SubscriptionStatus" AS ENUM ('TRIALING', 'ACTIVE', 'PAST_DUE', 'CANCELED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "InvoiceStatus" AS ENUM ('DRAFT', 'OPEN', 'PAID', 'VOID', 'UNCOLLECTIBLE');

-- CreateEnum
CREATE TYPE "PaymentProvider" AS ENUM ('STRIPE', 'PAYMOB', 'FAWRY', 'MANUAL', 'APPLE_IAP', 'GOOGLE_PLAY');

-- CreateEnum
CREATE TYPE "DevicePlatform" AS ENUM ('ANDROID', 'IOS');

-- CreateEnum
CREATE TYPE "DeviceOwnerType" AS ENUM ('PARENT', 'CHILD');

-- CreateEnum
CREATE TYPE "DeviceStatus" AS ENUM ('PENDING_PAIRING', 'ACTIVE', 'REVOKED', 'LOST');

-- CreateEnum
CREATE TYPE "ConsentType" AS ENUM ('DATA_COLLECTION', 'LOCATION_TRACKING', 'APP_USAGE_MONITORING', 'AI_BEHAVIOR_ANALYSIS', 'KEYBOARD_BEHAVIOR_ANALYSIS', 'HEALTH_DATA');

-- CreateEnum
CREATE TYPE "AppRuleType" AS ENUM ('BLOCK', 'ALLOW', 'TIME_LIMIT');

-- CreateEnum
CREATE TYPE "ZoneType" AS ENUM ('HOME', 'SCHOOL', 'CUSTOM');

-- CreateEnum
CREATE TYPE "LocationEventType" AS ENUM ('ENTER_ZONE', 'EXIT_ZONE', 'PERIODIC_PING', 'SOS');

-- CreateEnum
CREATE TYPE "AlertCategory" AS ENUM ('DIGITAL_SAFETY', 'BEHAVIOR', 'HEALTH', 'EDUCATION', 'LOCATION');

-- CreateEnum
CREATE TYPE "AlertSeverity" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL');

-- CreateEnum
CREATE TYPE "AlertStatus" AS ENUM ('NEW', 'REVIEWED', 'DISMISSED', 'ESCALATED');

-- CreateEnum
CREATE TYPE "ActorType" AS ENUM ('USER', 'DEVICE', 'SYSTEM');

-- CreateEnum
CREATE TYPE "TrustLevel" AS ENUM ('L0_UNKNOWN', 'L1_REGISTERED', 'L2_VERIFIED', 'L3_ATTESTED', 'L4_ENTERPRISE', 'L5_HIGH_TRUST');

-- CreateEnum
CREATE TYPE "RiskLevel" AS ENUM ('UNKNOWN', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL');

-- CreateEnum
CREATE TYPE "PairingState" AS ENUM ('INVITATION_CREATED', 'INVITATION_SENT', 'INVITATION_OPENED', 'AUTHENTICATING', 'DEVICE_REGISTERED', 'DEVICE_VERIFIED', 'CAPABILITIES_UPLOADED', 'PARENT_CONFIRMED', 'POLICY_ASSIGNED', 'ACTIVATED', 'HEALTHY', 'DEGRADED', 'SUSPENDED', 'REVOKED', 'REMOVED', 'REJECTED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "PairingEventType" AS ENUM ('PAIRING_INVITED', 'PAIRING_ACCEPTED', 'PAIRING_REJECTED', 'PAIRING_EXPIRED', 'AUTHENTICATION_STARTED', 'AUTHENTICATION_SUCCEEDED', 'AUTHENTICATION_FAILED', 'DEVICE_REGISTERED', 'DEVICE_VERIFIED', 'DEVICE_VERIFICATION_FAILED', 'CAPABILITIES_UPLOADED', 'PARENT_CONFIRMED', 'POLICY_ASSIGNED', 'DEVICE_ACTIVATED', 'ACTIVATION_BLOCKED_HIGH_RISK', 'HEARTBEAT_RECEIVED', 'HEARTBEAT_MISSED', 'DEVICE_SUSPENDED', 'DEVICE_REACTIVATED', 'DEVICE_REVOKED', 'DEVICE_REMOVED', 'DEVICE_TRUST_CHANGED');

-- CreateEnum
CREATE TYPE "OrganizationType" AS ENUM ('FAMILY', 'SCHOOL', 'COMPANY', 'BANK');

-- CreateEnum
CREATE TYPE "OrganizationRole" AS ENUM ('OWNER', 'ADMIN', 'MANAGER', 'MEMBER', 'GUEST');

-- CreateEnum
CREATE TYPE "InvitationStatus" AS ENUM ('PENDING', 'ACCEPTED', 'EXPIRED', 'REVOKED');

-- CreateEnum
CREATE TYPE "PartnerCampaignType" AS ENUM ('REFERRAL', 'COUPON', 'TRIAL_EXTENSION', 'DISCOUNT', 'QR_CODE');

-- CreateEnum
CREATE TYPE "SmartTaskStatus" AS ENUM ('SUGGESTED', 'ACCEPTED', 'COMPLETED', 'DISMISSED');

-- CreateEnum
CREATE TYPE "RewardType" AS ENUM ('XP', 'COINS', 'BADGE');

-- CreateEnum
CREATE TYPE "RedemptionStatus" AS ENUM ('REQUESTED', 'APPROVED', 'DENIED', 'FULFILLED');

-- CreateEnum
CREATE TYPE "MessageAuthorType" AS ENUM ('PARENT', 'AI');

-- CreateEnum
CREATE TYPE "MessageApprovalStatus" AS ENUM ('NOT_REQUIRED', 'PENDING', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "ActivitySocialContext" AS ENUM ('SOLO', 'GROUP', 'TEAM');

-- CreateEnum
CREATE TYPE "TimelineCategory" AS ENUM ('HEALTH', 'LEARNING', 'FAITH', 'REWARDS', 'SAFETY', 'HABITS', 'FAMILY');

-- CreateEnum
CREATE TYPE "ActivitySocialContextV2" AS ENUM ('SOLO', 'GROUP', 'TEAM');

-- CreateEnum
CREATE TYPE "FaithPracticeType" AS ENUM ('QURAN_MEMORIZATION', 'QURAN_REVIEW', 'AZKAR', 'SALAH', 'ISLAMIC_VALUE', 'OCCASION');

-- CreateEnum
CREATE TYPE "LearningGoalStatus" AS ENUM ('ACTIVE', 'COMPLETED', 'ABANDONED');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "full_name" TEXT NOT NULL,
    "phone" TEXT,
    "locale" TEXT NOT NULL DEFAULT 'en',
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "status" "UserStatus" NOT NULL DEFAULT 'PENDING_VERIFICATION',
    "mfa_enabled" BOOLEAN NOT NULL DEFAULT false,
    "email_verified_at" TIMESTAMP(3),
    "last_login_at" TIMESTAMP(3),
    "terms_accepted_at" TIMESTAMP(3),
    "terms_version" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "families" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "subscription_plan" "SubscriptionPlan" NOT NULL DEFAULT 'FREE',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "families_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "family_members" (
    "id" UUID NOT NULL,
    "family_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "role" "FamilyRole" NOT NULL DEFAULT 'PARENT',
    "joined_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "family_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "children" (
    "id" UUID NOT NULL,
    "family_id" UUID NOT NULL,
    "first_name" TEXT NOT NULL,
    "last_name" TEXT,
    "date_of_birth" DATE NOT NULL,
    "gender" TEXT,
    "avatar_url" TEXT,
    "pin_code_hash" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "children_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "parental_consents" (
    "id" UUID NOT NULL,
    "child_id" UUID NOT NULL,
    "consent_type" "ConsentType" NOT NULL,
    "granted" BOOLEAN NOT NULL DEFAULT true,
    "granted_by_user_id" UUID NOT NULL,
    "granted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "parental_consents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "devices" (
    "id" UUID NOT NULL,
    "family_id" UUID NOT NULL,
    "owner_type" "DeviceOwnerType" NOT NULL,
    "user_id" UUID,
    "child_id" UUID,
    "platform" "DevicePlatform" NOT NULL,
    "device_model" TEXT,
    "os_version" TEXT,
    "app_version" TEXT,
    "push_token" TEXT,
    "pairing_code_hash" TEXT,
    "status" "DeviceStatus" NOT NULL DEFAULT 'PENDING_PAIRING',
    "last_seen_at" TIMESTAMP(3),
    "paired_at" TIMESTAMP(3),
    "public_key" TEXT,
    "attestation_chain" TEXT,
    "trust_level" "TrustLevel" NOT NULL DEFAULT 'L0_UNKNOWN',
    "pairing_protocol_version" TEXT,
    "device_fingerprint" TEXT,
    "capability_profile" JSONB,
    "capability_profile_hash" TEXT,
    "last_telemetry" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "devices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "device_pairing_events" (
    "id" UUID NOT NULL,
    "device_id" UUID,
    "child_id" UUID NOT NULL,
    "event_type" "PairingEventType" NOT NULL,
    "from_state" "PairingState",
    "to_state" "PairingState" NOT NULL,
    "actor_type" "ActorType" NOT NULL,
    "actor_id" TEXT,
    "metadata" JSONB,
    "occurred_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "device_pairing_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "device_risk_assessments" (
    "id" UUID NOT NULL,
    "device_id" UUID NOT NULL,
    "overall_risk" INTEGER NOT NULL,
    "overall_level" "RiskLevel" NOT NULL,
    "category_scores" JSONB NOT NULL,
    "reasons" JSONB NOT NULL,
    "assessed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "device_risk_assessments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refresh_tokens" (
    "id" UUID NOT NULL,
    "user_id" UUID,
    "device_id" UUID,
    "token_hash" TEXT NOT NULL,
    "user_agent" TEXT,
    "ip_address" TEXT,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "revoked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "family_token_id" UUID NOT NULL,
    "replaced_by_id" UUID,

    CONSTRAINT "refresh_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "screen_time_policies" (
    "id" UUID NOT NULL,
    "child_id" UUID NOT NULL,
    "daily_limit_minutes" INTEGER,
    "bedtime_start" TEXT,
    "bedtime_end" TEXT,
    "weekday_schedule" JSONB,
    "focus_mode_enabled" BOOLEAN NOT NULL DEFAULT false,
    "created_by_user_id" UUID NOT NULL,
    "effective_from" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "screen_time_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app_catalog_entries" (
    "id" UUID NOT NULL,
    "device_id" UUID NOT NULL,
    "package_name" TEXT NOT NULL,
    "app_name" TEXT NOT NULL,
    "category" TEXT,
    "icon_url" TEXT,
    "first_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_used_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "app_catalog_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "support_requests" (
    "id" UUID NOT NULL,
    "family_id" UUID,
    "user_id" UUID,
    "email" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "is_priority" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "support_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "daily_behavioral_snapshots" (
    "id" UUID NOT NULL,
    "child_id" UUID NOT NULL,
    "device_id" UUID NOT NULL,
    "usage_date" DATE NOT NULL,
    "total_screen_minutes" INTEGER NOT NULL,
    "pickup_count" INTEGER NOT NULL,
    "night_usage_minutes" INTEGER NOT NULL,
    "blocked_attempt_count" INTEGER NOT NULL,
    "session_count" INTEGER,
    "average_session_minutes" INTEGER,
    "longest_session_minutes" INTEGER,
    "education_minutes" INTEGER,
    "gaming_minutes" INTEGER,
    "social_minutes" INTEGER,
    "entertainment_minutes" INTEGER,
    "patterns" JSONB,
    "positive_patterns" JSONB,
    "baseline_deviation_percent" DOUBLE PRECISION,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "daily_behavioral_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app_usage_logs" (
    "id" UUID NOT NULL,
    "child_id" UUID NOT NULL,
    "device_id" UUID NOT NULL,
    "package_name" TEXT NOT NULL,
    "category" TEXT,
    "usage_date" DATE NOT NULL,
    "usage_minutes" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "app_usage_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app_block_rules" (
    "id" UUID NOT NULL,
    "child_id" UUID NOT NULL,
    "package_name" TEXT,
    "category" TEXT,
    "rule_type" "AppRuleType" NOT NULL,
    "limit_minutes" INTEGER,
    "schedule" JSONB,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "app_block_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "location_safe_zones" (
    "id" UUID NOT NULL,
    "child_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "zone_type" "ZoneType" NOT NULL,
    "latitude" DOUBLE PRECISION NOT NULL,
    "longitude" DOUBLE PRECISION NOT NULL,
    "radius_meters" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "location_safe_zones_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "location_events" (
    "id" UUID NOT NULL,
    "child_id" UUID NOT NULL,
    "device_id" UUID NOT NULL,
    "safe_zone_id" UUID,
    "event_type" "LocationEventType" NOT NULL,
    "latitude_enc" TEXT NOT NULL,
    "longitude_enc" TEXT NOT NULL,
    "accuracy_meters" DOUBLE PRECISION,
    "recorded_at" TIMESTAMP(3) NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "location_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_usage_logs" (
    "id" UUID NOT NULL,
    "model" TEXT NOT NULL,
    "input_tokens" INTEGER NOT NULL,
    "output_tokens" INTEGER NOT NULL,
    "estimated_cost_micro_cents" INTEGER NOT NULL,
    "source_feature" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_usage_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_risk_scores" (
    "id" UUID NOT NULL,
    "child_id" UUID NOT NULL,
    "score_date" DATE NOT NULL,
    "overall_score" INTEGER NOT NULL,
    "category_breakdown" JSONB NOT NULL,
    "generated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_risk_scores_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_alerts" (
    "id" UUID NOT NULL,
    "child_id" UUID NOT NULL,
    "category" "AlertCategory" NOT NULL,
    "severity" "AlertSeverity" NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "source_module" TEXT NOT NULL,
    "status" "AlertStatus" NOT NULL DEFAULT 'NEW',
    "reviewed_by_user_id" UUID,
    "reviewed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ai_alerts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" UUID NOT NULL,
    "actor_type" "ActorType" NOT NULL,
    "actor_user_id" UUID,
    "action" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" UUID NOT NULL,
    "metadata" JSONB,
    "ip_address" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_memory_entries" (
    "id" UUID NOT NULL,
    "child_id" UUID NOT NULL,
    "category" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ai_memory_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "plan_definitions" (
    "id" UUID NOT NULL,
    "tier" "SubscriptionPlan" NOT NULL,
    "name" TEXT NOT NULL,
    "price_cents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "billing_interval_months" INTEGER NOT NULL DEFAULT 1,
    "features" JSONB NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "plan_definitions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subscriptions" (
    "id" UUID NOT NULL,
    "family_id" UUID NOT NULL,
    "plan_tier" "SubscriptionPlan" NOT NULL,
    "status" "SubscriptionStatus" NOT NULL DEFAULT 'TRIALING',
    "provider" "PaymentProvider" NOT NULL DEFAULT 'MANUAL',
    "provider_subscription_id" TEXT,
    "trial_ends_at" TIMESTAMP(3),
    "current_period_start" TIMESTAMP(3),
    "current_period_end" TIMESTAMP(3),
    "canceled_at" TIMESTAMP(3),
    "pending_discount_percent" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoices" (
    "id" UUID NOT NULL,
    "subscription_id" UUID NOT NULL,
    "amount_cents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "status" "InvoiceStatus" NOT NULL DEFAULT 'DRAFT',
    "provider_invoice_id" TEXT,
    "issued_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "paid_at" TIMESTAMP(3),

    CONSTRAINT "invoices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "feature_flags" (
    "id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "is_enabled_globally" BOOLEAN NOT NULL DEFAULT false,
    "enabled_family_ids" UUID[],
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "feature_flags_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "analytics_events" (
    "id" UUID NOT NULL,
    "family_id" UUID,
    "user_id" UUID,
    "session_id" TEXT NOT NULL,
    "event_name" TEXT NOT NULL,
    "payload" JSONB,
    "occurred_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "analytics_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "organizations" (
    "id" UUID NOT NULL,
    "type" "OrganizationType" NOT NULL,
    "name" TEXT NOT NULL,
    "parent_organization_id" UUID,
    "settings" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "organizations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "organization_members" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "role" "OrganizationRole" NOT NULL DEFAULT 'MEMBER',
    "joined_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "organization_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "organization_policies" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "organization_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "organization_invitations" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "role" "OrganizationRole" NOT NULL DEFAULT 'MEMBER',
    "invited_by_user_id" UUID NOT NULL,
    "status" "InvitationStatus" NOT NULL DEFAULT 'PENDING',
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "organization_invitations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "partner_campaigns" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "type" "PartnerCampaignType" NOT NULL,
    "config" JSONB NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3),

    CONSTRAINT "partner_campaigns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "child_id" UUID,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "data" JSONB,
    "priority" TEXT NOT NULL DEFAULT 'NORMAL',
    "read_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "habits" (
    "id" UUID NOT NULL,
    "child_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "description" TEXT,
    "scheduled_start_time" TEXT,
    "scheduled_end_time" TEXT,
    "recurrence" TEXT NOT NULL DEFAULT 'DAILY',
    "recurrence_days_of_week" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    "priority" TEXT NOT NULL DEFAULT 'NORMAL',
    "is_custom" BOOLEAN NOT NULL DEFAULT true,
    "is_shared" BOOLEAN NOT NULL DEFAULT false,
    "created_by_user_id" UUID,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "habits_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "habit_completions" (
    "id" UUID NOT NULL,
    "habit_id" UUID NOT NULL,
    "child_id" UUID NOT NULL,
    "date" DATE NOT NULL,
    "completed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" TEXT NOT NULL DEFAULT 'COMPLETED',

    CONSTRAINT "habit_completions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rewards_accounts" (
    "id" UUID NOT NULL,
    "child_id" UUID NOT NULL,
    "xp" INTEGER NOT NULL DEFAULT 0,
    "coins" INTEGER NOT NULL DEFAULT 0,
    "stars" INTEGER NOT NULL DEFAULT 0,
    "level" INTEGER NOT NULL DEFAULT 1,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "rewards_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rewards_ledger_entries" (
    "id" UUID NOT NULL,
    "child_id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "reward_type" "RewardType" NOT NULL,
    "amount" INTEGER NOT NULL,
    "delta" INTEGER NOT NULL,
    "source" TEXT NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rewards_ledger_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "badge_definitions" (
    "id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "criteria" JSONB NOT NULL,
    "is_group_achievement" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "badge_definitions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "child_badge_awards" (
    "id" UUID NOT NULL,
    "child_id" UUID NOT NULL,
    "badge_id" UUID NOT NULL,
    "awarded_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "child_badge_awards_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reward_catalog_items" (
    "id" UUID NOT NULL,
    "family_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "cost_coins" INTEGER NOT NULL,
    "created_by_user_id" UUID NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reward_catalog_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reward_redemptions" (
    "id" UUID NOT NULL,
    "child_id" UUID NOT NULL,
    "reward_catalog_item_id" UUID NOT NULL,
    "status" "RedemptionStatus" NOT NULL DEFAULT 'REQUESTED',
    "requested_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decided_at" TIMESTAMP(3),
    "decided_by_user_id" UUID,

    CONSTRAINT "reward_redemptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reward_rules" (
    "id" UUID NOT NULL,
    "family_id" UUID,
    "trigger_engine" TEXT NOT NULL,
    "trigger_condition" JSONB NOT NULL,
    "reward_type" "RewardType" NOT NULL,
    "reward_amount_or_badge_id" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reward_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "child_messages" (
    "id" UUID NOT NULL,
    "child_id" UUID NOT NULL,
    "from_user_id" UUID,
    "author_type" "MessageAuthorType" NOT NULL,
    "approval_status" "MessageApprovalStatus" NOT NULL DEFAULT 'NOT_REQUIRED',
    "category" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "delivered_at" TIMESTAMP(3),
    "acknowledged_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "child_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "family_broadcast_messages" (
    "id" UUID NOT NULL,
    "family_id" UUID NOT NULL,
    "authored_by_user_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "family_broadcast_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "life_timeline_events" (
    "id" UUID NOT NULL,
    "child_id" UUID NOT NULL,
    "source_engine" TEXT NOT NULL,
    "category" "TimelineCategory" NOT NULL,
    "event_type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "occurred_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "metadata" JSONB,

    CONSTRAINT "life_timeline_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "child_digital_twin_projections" (
    "child_id" UUID NOT NULL,
    "health_slice" JSONB,
    "learning_slice" JSONB,
    "faith_slice" JSONB,
    "behavior_slice" JSONB,
    "habits_slice" JSONB,
    "social_slice" JSONB,
    "safety_slice" JSONB,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "child_digital_twin_projections_pkey" PRIMARY KEY ("child_id")
);

-- CreateTable
CREATE TABLE "nutrition_logs" (
    "id" UUID NOT NULL,
    "child_id" UUID NOT NULL,
    "date" DATE NOT NULL,
    "meal_type" TEXT NOT NULL,
    "items" JSONB NOT NULL,
    "calories" INTEGER,
    "protein_g" DOUBLE PRECISION,
    "calcium_mg" DOUBLE PRECISION,
    "iron_mg" DOUBLE PRECISION,
    "sugar_g" DOUBLE PRECISION,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "nutrition_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hydration_logs" (
    "id" UUID NOT NULL,
    "child_id" UUID NOT NULL,
    "amount_ml" INTEGER NOT NULL,
    "logged_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "hydration_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sleep_logs" (
    "id" UUID NOT NULL,
    "child_id" UUID NOT NULL,
    "date" DATE NOT NULL,
    "sleep_start" TIMESTAMP(3) NOT NULL,
    "sleep_end" TIMESTAMP(3) NOT NULL,
    "quality" INTEGER,

    CONSTRAINT "sleep_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "activity_logs" (
    "id" UUID NOT NULL,
    "child_id" UUID NOT NULL,
    "date" DATE NOT NULL,
    "activity_type" TEXT NOT NULL,
    "duration_minutes" INTEGER NOT NULL,
    "social_context" "ActivitySocialContextV2" NOT NULL DEFAULT 'SOLO',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "activity_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "physical_measurement_logs" (
    "id" UUID NOT NULL,
    "child_id" UUID NOT NULL,
    "date" DATE NOT NULL,
    "height_cm" DOUBLE PRECISION,
    "weight_kg" DOUBLE PRECISION,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "physical_measurement_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "health_score_daily" (
    "id" UUID NOT NULL,
    "child_id" UUID NOT NULL,
    "date" DATE NOT NULL,
    "score" DOUBLE PRECISION NOT NULL,
    "breakdown" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "health_score_daily_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "faith_practices" (
    "id" UUID NOT NULL,
    "child_id" UUID NOT NULL,
    "type" "FaithPracticeType" NOT NULL,
    "title" TEXT NOT NULL,
    "config" JSONB,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "faith_practices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "faith_practice_logs" (
    "id" UUID NOT NULL,
    "practice_id" UUID NOT NULL,
    "child_id" UUID NOT NULL,
    "date" DATE NOT NULL,
    "progress" JSONB,
    "completed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "faith_practice_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "learning_goals" (
    "id" UUID NOT NULL,
    "child_id" UUID NOT NULL,
    "subject" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "target_date" DATE,
    "status" "LearningGoalStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "learning_goals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "learning_sessions" (
    "id" UUID NOT NULL,
    "child_id" UUID NOT NULL,
    "goal_id" UUID,
    "subject" TEXT NOT NULL,
    "duration_minutes" INTEGER NOT NULL,
    "progress_note" TEXT,
    "date" DATE NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "learning_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "learning_assessments" (
    "id" UUID NOT NULL,
    "child_id" UUID NOT NULL,
    "subject" TEXT NOT NULL,
    "score_percent" DOUBLE PRECISION NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'self-reported',
    "taken_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "learning_assessments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "smart_tasks" (
    "id" UUID NOT NULL,
    "child_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "generated_reason" TEXT NOT NULL,
    "source_signals" JSONB NOT NULL,
    "suggested_date" DATE NOT NULL,
    "status" "SmartTaskStatus" NOT NULL DEFAULT 'SUGGESTED',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decided_at" TIMESTAMP(3),

    CONSTRAINT "smart_tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "family_challenges" (
    "id" UUID NOT NULL,
    "family_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "start_date" DATE NOT NULL,
    "end_date" DATE NOT NULL,
    "criteria" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "family_challenges_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "family_challenge_participations" (
    "id" UUID NOT NULL,
    "challenge_id" UUID NOT NULL,
    "child_id" UUID NOT NULL,
    "completed_at" TIMESTAMP(3),

    CONSTRAINT "family_challenge_participations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "users_status_idx" ON "users"("status");

-- CreateIndex
CREATE INDEX "family_members_user_id_idx" ON "family_members"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "family_members_family_id_user_id_key" ON "family_members"("family_id", "user_id");

-- CreateIndex
CREATE INDEX "children_family_id_idx" ON "children"("family_id");

-- CreateIndex
CREATE INDEX "parental_consents_child_id_idx" ON "parental_consents"("child_id");

-- CreateIndex
CREATE UNIQUE INDEX "parental_consents_child_id_consent_type_key" ON "parental_consents"("child_id", "consent_type");

-- CreateIndex
CREATE INDEX "devices_family_id_idx" ON "devices"("family_id");

-- CreateIndex
CREATE INDEX "devices_user_id_idx" ON "devices"("user_id");

-- CreateIndex
CREATE INDEX "devices_child_id_idx" ON "devices"("child_id");

-- CreateIndex
CREATE INDEX "device_pairing_events_device_id_occurred_at_idx" ON "device_pairing_events"("device_id", "occurred_at");

-- CreateIndex
CREATE INDEX "device_pairing_events_child_id_occurred_at_idx" ON "device_pairing_events"("child_id", "occurred_at");

-- CreateIndex
CREATE INDEX "device_risk_assessments_device_id_assessed_at_idx" ON "device_risk_assessments"("device_id", "assessed_at");

-- CreateIndex
CREATE UNIQUE INDEX "refresh_tokens_token_hash_key" ON "refresh_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "refresh_tokens_user_id_idx" ON "refresh_tokens"("user_id");

-- CreateIndex
CREATE INDEX "refresh_tokens_device_id_idx" ON "refresh_tokens"("device_id");

-- CreateIndex
CREATE INDEX "refresh_tokens_family_token_id_idx" ON "refresh_tokens"("family_token_id");

-- CreateIndex
CREATE INDEX "screen_time_policies_child_id_idx" ON "screen_time_policies"("child_id");

-- CreateIndex
CREATE INDEX "app_catalog_entries_device_id_idx" ON "app_catalog_entries"("device_id");

-- CreateIndex
CREATE UNIQUE INDEX "app_catalog_entries_device_id_package_name_key" ON "app_catalog_entries"("device_id", "package_name");

-- CreateIndex
CREATE INDEX "support_requests_family_id_idx" ON "support_requests"("family_id");

-- CreateIndex
CREATE INDEX "support_requests_created_at_idx" ON "support_requests"("created_at");

-- CreateIndex
CREATE INDEX "support_requests_is_priority_created_at_idx" ON "support_requests"("is_priority", "created_at");

-- CreateIndex
CREATE INDEX "daily_behavioral_snapshots_child_id_usage_date_idx" ON "daily_behavioral_snapshots"("child_id", "usage_date");

-- CreateIndex
CREATE UNIQUE INDEX "daily_behavioral_snapshots_child_id_usage_date_key" ON "daily_behavioral_snapshots"("child_id", "usage_date");

-- CreateIndex
CREATE INDEX "app_usage_logs_child_id_usage_date_idx" ON "app_usage_logs"("child_id", "usage_date");

-- CreateIndex
CREATE UNIQUE INDEX "app_usage_logs_child_id_device_id_package_name_usage_date_key" ON "app_usage_logs"("child_id", "device_id", "package_name", "usage_date");

-- CreateIndex
CREATE INDEX "app_block_rules_child_id_idx" ON "app_block_rules"("child_id");

-- CreateIndex
CREATE INDEX "location_safe_zones_child_id_idx" ON "location_safe_zones"("child_id");

-- CreateIndex
CREATE INDEX "location_events_child_id_recorded_at_idx" ON "location_events"("child_id", "recorded_at");

-- CreateIndex
CREATE INDEX "location_events_expires_at_idx" ON "location_events"("expires_at");

-- CreateIndex
CREATE INDEX "ai_usage_logs_created_at_idx" ON "ai_usage_logs"("created_at");

-- CreateIndex
CREATE INDEX "ai_usage_logs_source_feature_created_at_idx" ON "ai_usage_logs"("source_feature", "created_at");

-- CreateIndex
CREATE INDEX "ai_risk_scores_child_id_idx" ON "ai_risk_scores"("child_id");

-- CreateIndex
CREATE UNIQUE INDEX "ai_risk_scores_child_id_score_date_key" ON "ai_risk_scores"("child_id", "score_date");

-- CreateIndex
CREATE INDEX "ai_alerts_child_id_status_idx" ON "ai_alerts"("child_id", "status");

-- CreateIndex
CREATE INDEX "ai_alerts_severity_idx" ON "ai_alerts"("severity");

-- CreateIndex
CREATE INDEX "audit_logs_entity_type_entity_id_idx" ON "audit_logs"("entity_type", "entity_id");

-- CreateIndex
CREATE INDEX "audit_logs_actor_user_id_idx" ON "audit_logs"("actor_user_id");

-- CreateIndex
CREATE INDEX "ai_memory_entries_child_id_category_idx" ON "ai_memory_entries"("child_id", "category");

-- CreateIndex
CREATE UNIQUE INDEX "ai_memory_entries_child_id_category_key_key" ON "ai_memory_entries"("child_id", "category", "key");

-- CreateIndex
CREATE UNIQUE INDEX "plan_definitions_tier_key" ON "plan_definitions"("tier");

-- CreateIndex
CREATE UNIQUE INDEX "subscriptions_family_id_key" ON "subscriptions"("family_id");

-- CreateIndex
CREATE INDEX "invoices_subscription_id_idx" ON "invoices"("subscription_id");

-- CreateIndex
CREATE UNIQUE INDEX "feature_flags_key_key" ON "feature_flags"("key");

-- CreateIndex
CREATE INDEX "analytics_events_event_name_occurred_at_idx" ON "analytics_events"("event_name", "occurred_at");

-- CreateIndex
CREATE INDEX "analytics_events_family_id_idx" ON "analytics_events"("family_id");

-- CreateIndex
CREATE INDEX "organizations_type_idx" ON "organizations"("type");

-- CreateIndex
CREATE INDEX "organizations_parent_organization_id_idx" ON "organizations"("parent_organization_id");

-- CreateIndex
CREATE INDEX "organization_members_user_id_idx" ON "organization_members"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "organization_members_organization_id_user_id_key" ON "organization_members"("organization_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "organization_policies_organization_id_key_key" ON "organization_policies"("organization_id", "key");

-- CreateIndex
CREATE INDEX "organization_invitations_organization_id_status_idx" ON "organization_invitations"("organization_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "partner_campaigns_code_key" ON "partner_campaigns"("code");

-- CreateIndex
CREATE INDEX "partner_campaigns_code_idx" ON "partner_campaigns"("code");

-- CreateIndex
CREATE INDEX "notifications_user_id_read_at_idx" ON "notifications"("user_id", "read_at");

-- CreateIndex
CREATE INDEX "notifications_child_id_created_at_idx" ON "notifications"("child_id", "created_at");

-- CreateIndex
CREATE INDEX "habits_child_id_is_active_idx" ON "habits"("child_id", "is_active");

-- CreateIndex
CREATE INDEX "habit_completions_child_id_date_idx" ON "habit_completions"("child_id", "date");

-- CreateIndex
CREATE UNIQUE INDEX "habit_completions_habit_id_date_key" ON "habit_completions"("habit_id", "date");

-- CreateIndex
CREATE UNIQUE INDEX "rewards_accounts_child_id_key" ON "rewards_accounts"("child_id");

-- CreateIndex
CREATE INDEX "rewards_ledger_entries_child_id_created_at_idx" ON "rewards_ledger_entries"("child_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "rewards_ledger_entries_child_id_idempotency_key_key" ON "rewards_ledger_entries"("child_id", "idempotency_key");

-- CreateIndex
CREATE UNIQUE INDEX "badge_definitions_key_key" ON "badge_definitions"("key");

-- CreateIndex
CREATE UNIQUE INDEX "child_badge_awards_child_id_badge_id_key" ON "child_badge_awards"("child_id", "badge_id");

-- CreateIndex
CREATE INDEX "reward_catalog_items_family_id_is_active_idx" ON "reward_catalog_items"("family_id", "is_active");

-- CreateIndex
CREATE INDEX "reward_redemptions_child_id_status_idx" ON "reward_redemptions"("child_id", "status");

-- CreateIndex
CREATE INDEX "reward_rules_family_id_is_active_idx" ON "reward_rules"("family_id", "is_active");

-- CreateIndex
CREATE INDEX "child_messages_child_id_delivered_at_idx" ON "child_messages"("child_id", "delivered_at");

-- CreateIndex
CREATE INDEX "child_messages_approval_status_idx" ON "child_messages"("approval_status");

-- CreateIndex
CREATE INDEX "life_timeline_events_child_id_occurred_at_idx" ON "life_timeline_events"("child_id", "occurred_at");

-- CreateIndex
CREATE INDEX "life_timeline_events_child_id_category_idx" ON "life_timeline_events"("child_id", "category");

-- CreateIndex
CREATE INDEX "nutrition_logs_child_id_date_idx" ON "nutrition_logs"("child_id", "date");

-- CreateIndex
CREATE INDEX "hydration_logs_child_id_logged_at_idx" ON "hydration_logs"("child_id", "logged_at");

-- CreateIndex
CREATE INDEX "sleep_logs_child_id_date_idx" ON "sleep_logs"("child_id", "date");

-- CreateIndex
CREATE INDEX "activity_logs_child_id_date_idx" ON "activity_logs"("child_id", "date");

-- CreateIndex
CREATE INDEX "activity_logs_child_id_social_context_idx" ON "activity_logs"("child_id", "social_context");

-- CreateIndex
CREATE INDEX "physical_measurement_logs_child_id_date_idx" ON "physical_measurement_logs"("child_id", "date");

-- CreateIndex
CREATE UNIQUE INDEX "health_score_daily_child_id_date_key" ON "health_score_daily"("child_id", "date");

-- CreateIndex
CREATE INDEX "faith_practices_child_id_is_active_idx" ON "faith_practices"("child_id", "is_active");

-- CreateIndex
CREATE INDEX "faith_practice_logs_child_id_date_idx" ON "faith_practice_logs"("child_id", "date");

-- CreateIndex
CREATE UNIQUE INDEX "faith_practice_logs_practice_id_date_key" ON "faith_practice_logs"("practice_id", "date");

-- CreateIndex
CREATE INDEX "learning_goals_child_id_status_idx" ON "learning_goals"("child_id", "status");

-- CreateIndex
CREATE INDEX "learning_sessions_child_id_date_idx" ON "learning_sessions"("child_id", "date");

-- CreateIndex
CREATE INDEX "learning_assessments_child_id_taken_at_idx" ON "learning_assessments"("child_id", "taken_at");

-- CreateIndex
CREATE INDEX "smart_tasks_child_id_status_idx" ON "smart_tasks"("child_id", "status");

-- CreateIndex
CREATE INDEX "smart_tasks_child_id_suggested_date_idx" ON "smart_tasks"("child_id", "suggested_date");

-- CreateIndex
CREATE INDEX "family_challenges_family_id_idx" ON "family_challenges"("family_id");

-- CreateIndex
CREATE INDEX "family_challenge_participations_child_id_idx" ON "family_challenge_participations"("child_id");

-- CreateIndex
CREATE UNIQUE INDEX "family_challenge_participations_challenge_id_child_id_key" ON "family_challenge_participations"("challenge_id", "child_id");

-- AddForeignKey
ALTER TABLE "family_members" ADD CONSTRAINT "family_members_family_id_fkey" FOREIGN KEY ("family_id") REFERENCES "families"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "family_members" ADD CONSTRAINT "family_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "children" ADD CONSTRAINT "children_family_id_fkey" FOREIGN KEY ("family_id") REFERENCES "families"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "parental_consents" ADD CONSTRAINT "parental_consents_child_id_fkey" FOREIGN KEY ("child_id") REFERENCES "children"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "parental_consents" ADD CONSTRAINT "parental_consents_granted_by_user_id_fkey" FOREIGN KEY ("granted_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "devices" ADD CONSTRAINT "devices_family_id_fkey" FOREIGN KEY ("family_id") REFERENCES "families"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "devices" ADD CONSTRAINT "devices_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "devices" ADD CONSTRAINT "devices_child_id_fkey" FOREIGN KEY ("child_id") REFERENCES "children"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "device_pairing_events" ADD CONSTRAINT "device_pairing_events_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "devices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "device_risk_assessments" ADD CONSTRAINT "device_risk_assessments_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "devices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "devices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "screen_time_policies" ADD CONSTRAINT "screen_time_policies_child_id_fkey" FOREIGN KEY ("child_id") REFERENCES "children"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app_catalog_entries" ADD CONSTRAINT "app_catalog_entries_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "devices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support_requests" ADD CONSTRAINT "support_requests_family_id_fkey" FOREIGN KEY ("family_id") REFERENCES "families"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support_requests" ADD CONSTRAINT "support_requests_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "daily_behavioral_snapshots" ADD CONSTRAINT "daily_behavioral_snapshots_child_id_fkey" FOREIGN KEY ("child_id") REFERENCES "children"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "daily_behavioral_snapshots" ADD CONSTRAINT "daily_behavioral_snapshots_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "devices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app_usage_logs" ADD CONSTRAINT "app_usage_logs_child_id_fkey" FOREIGN KEY ("child_id") REFERENCES "children"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app_usage_logs" ADD CONSTRAINT "app_usage_logs_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "devices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app_block_rules" ADD CONSTRAINT "app_block_rules_child_id_fkey" FOREIGN KEY ("child_id") REFERENCES "children"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "location_safe_zones" ADD CONSTRAINT "location_safe_zones_child_id_fkey" FOREIGN KEY ("child_id") REFERENCES "children"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "location_events" ADD CONSTRAINT "location_events_child_id_fkey" FOREIGN KEY ("child_id") REFERENCES "children"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "location_events" ADD CONSTRAINT "location_events_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "devices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "location_events" ADD CONSTRAINT "location_events_safe_zone_id_fkey" FOREIGN KEY ("safe_zone_id") REFERENCES "location_safe_zones"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_risk_scores" ADD CONSTRAINT "ai_risk_scores_child_id_fkey" FOREIGN KEY ("child_id") REFERENCES "children"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_alerts" ADD CONSTRAINT "ai_alerts_child_id_fkey" FOREIGN KEY ("child_id") REFERENCES "children"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_alerts" ADD CONSTRAINT "ai_alerts_reviewed_by_user_id_fkey" FOREIGN KEY ("reviewed_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_memory_entries" ADD CONSTRAINT "ai_memory_entries_child_id_fkey" FOREIGN KEY ("child_id") REFERENCES "children"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_family_id_fkey" FOREIGN KEY ("family_id") REFERENCES "families"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_subscription_id_fkey" FOREIGN KEY ("subscription_id") REFERENCES "subscriptions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_parent_organization_id_fkey" FOREIGN KEY ("parent_organization_id") REFERENCES "organizations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organization_members" ADD CONSTRAINT "organization_members_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organization_members" ADD CONSTRAINT "organization_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organization_policies" ADD CONSTRAINT "organization_policies_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organization_invitations" ADD CONSTRAINT "organization_invitations_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "partner_campaigns" ADD CONSTRAINT "partner_campaigns_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_child_id_fkey" FOREIGN KEY ("child_id") REFERENCES "children"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "habits" ADD CONSTRAINT "habits_child_id_fkey" FOREIGN KEY ("child_id") REFERENCES "children"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "habits" ADD CONSTRAINT "habits_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "habit_completions" ADD CONSTRAINT "habit_completions_habit_id_fkey" FOREIGN KEY ("habit_id") REFERENCES "habits"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "habit_completions" ADD CONSTRAINT "habit_completions_child_id_fkey" FOREIGN KEY ("child_id") REFERENCES "children"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rewards_accounts" ADD CONSTRAINT "rewards_accounts_child_id_fkey" FOREIGN KEY ("child_id") REFERENCES "children"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rewards_ledger_entries" ADD CONSTRAINT "rewards_ledger_entries_child_id_fkey" FOREIGN KEY ("child_id") REFERENCES "children"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "child_badge_awards" ADD CONSTRAINT "child_badge_awards_child_id_fkey" FOREIGN KEY ("child_id") REFERENCES "children"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "child_badge_awards" ADD CONSTRAINT "child_badge_awards_badge_id_fkey" FOREIGN KEY ("badge_id") REFERENCES "badge_definitions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reward_catalog_items" ADD CONSTRAINT "reward_catalog_items_family_id_fkey" FOREIGN KEY ("family_id") REFERENCES "families"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reward_catalog_items" ADD CONSTRAINT "reward_catalog_items_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reward_redemptions" ADD CONSTRAINT "reward_redemptions_child_id_fkey" FOREIGN KEY ("child_id") REFERENCES "children"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reward_redemptions" ADD CONSTRAINT "reward_redemptions_reward_catalog_item_id_fkey" FOREIGN KEY ("reward_catalog_item_id") REFERENCES "reward_catalog_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reward_rules" ADD CONSTRAINT "reward_rules_family_id_fkey" FOREIGN KEY ("family_id") REFERENCES "families"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "child_messages" ADD CONSTRAINT "child_messages_child_id_fkey" FOREIGN KEY ("child_id") REFERENCES "children"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "child_messages" ADD CONSTRAINT "child_messages_from_user_id_fkey" FOREIGN KEY ("from_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "family_broadcast_messages" ADD CONSTRAINT "family_broadcast_messages_family_id_fkey" FOREIGN KEY ("family_id") REFERENCES "families"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "family_broadcast_messages" ADD CONSTRAINT "family_broadcast_messages_authored_by_user_id_fkey" FOREIGN KEY ("authored_by_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "life_timeline_events" ADD CONSTRAINT "life_timeline_events_child_id_fkey" FOREIGN KEY ("child_id") REFERENCES "children"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "child_digital_twin_projections" ADD CONSTRAINT "child_digital_twin_projections_child_id_fkey" FOREIGN KEY ("child_id") REFERENCES "children"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "nutrition_logs" ADD CONSTRAINT "nutrition_logs_child_id_fkey" FOREIGN KEY ("child_id") REFERENCES "children"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hydration_logs" ADD CONSTRAINT "hydration_logs_child_id_fkey" FOREIGN KEY ("child_id") REFERENCES "children"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sleep_logs" ADD CONSTRAINT "sleep_logs_child_id_fkey" FOREIGN KEY ("child_id") REFERENCES "children"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "activity_logs" ADD CONSTRAINT "activity_logs_child_id_fkey" FOREIGN KEY ("child_id") REFERENCES "children"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "physical_measurement_logs" ADD CONSTRAINT "physical_measurement_logs_child_id_fkey" FOREIGN KEY ("child_id") REFERENCES "children"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "health_score_daily" ADD CONSTRAINT "health_score_daily_child_id_fkey" FOREIGN KEY ("child_id") REFERENCES "children"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "faith_practices" ADD CONSTRAINT "faith_practices_child_id_fkey" FOREIGN KEY ("child_id") REFERENCES "children"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "faith_practice_logs" ADD CONSTRAINT "faith_practice_logs_practice_id_fkey" FOREIGN KEY ("practice_id") REFERENCES "faith_practices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "faith_practice_logs" ADD CONSTRAINT "faith_practice_logs_child_id_fkey" FOREIGN KEY ("child_id") REFERENCES "children"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "learning_goals" ADD CONSTRAINT "learning_goals_child_id_fkey" FOREIGN KEY ("child_id") REFERENCES "children"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "learning_sessions" ADD CONSTRAINT "learning_sessions_child_id_fkey" FOREIGN KEY ("child_id") REFERENCES "children"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "learning_sessions" ADD CONSTRAINT "learning_sessions_goal_id_fkey" FOREIGN KEY ("goal_id") REFERENCES "learning_goals"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "learning_assessments" ADD CONSTRAINT "learning_assessments_child_id_fkey" FOREIGN KEY ("child_id") REFERENCES "children"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "smart_tasks" ADD CONSTRAINT "smart_tasks_child_id_fkey" FOREIGN KEY ("child_id") REFERENCES "children"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "family_challenges" ADD CONSTRAINT "family_challenges_family_id_fkey" FOREIGN KEY ("family_id") REFERENCES "families"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "family_challenge_participations" ADD CONSTRAINT "family_challenge_participations_challenge_id_fkey" FOREIGN KEY ("challenge_id") REFERENCES "family_challenges"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "family_challenge_participations" ADD CONSTRAINT "family_challenge_participations_child_id_fkey" FOREIGN KEY ("child_id") REFERENCES "children"("id") ON DELETE CASCADE ON UPDATE CASCADE;
