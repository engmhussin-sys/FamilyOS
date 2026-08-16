-- =============================================================================
-- 0015_growth_attribution_referral — PHASE D (GROWTH).
--
-- WHAT WAS THERE. A1-Backend-Audit §20 classified the `analytics` module
-- EXTEND: «الهيكل صحيح (port + adapters + privacy filter). ناقص: funnels،
-- retention، الـ 15 Journey». One table (`analytics_events`), one metrics
-- service that counted families and devices, and no way at all to answer
-- «where did this household come from», «did it ever reach value», «what did
-- that channel cost» or «is this month better than last month».
--
-- WHAT THIS MIGRATION ADDS. Twelve tables and seven enum types covering
-- acquisition attribution, the activation fact, campaigns and their reported
-- spend, the four referral tables, the daily aggregate, quarterly targets,
-- forecast scenarios, operator alerts, and the settings table that holds every
-- business number so none of them is a constant in code.
--
-- THE FIVE THINGS WORTH READING BEFORE CHANGING ANYTHING HERE:
--
--   1. THE REFERRAL FRAUD DEFENCES ARE CONSTRAINTS, NOT SERVICE CODE.
--      Section 6 installs a CHECK that makes self-referral unrepresentable, a
--      PARTIAL UNIQUE INDEX that makes a household referable exactly once ever
--      by exactly one referrer, and a UNIQUE on `referral_rewards
--      (referral_event_id)` that makes «two workers qualified the same
--      conversion» produce one payout. The services below produce nicer error
--      messages than PostgreSQL would; PostgreSQL is what makes them true.
--      Same discipline as 0002 (reward ledger) and 0014 (payments).
--
--   2. IDEMPOTENCY OF THE AGGREGATION JOB IS A UNIQUE INDEX.
--      `growth_daily_metrics (business_date, country_code)`. Re-running
--      yesterday's aggregation UPSERTs one row rather than doubling every
--      number in it. `country_code` uses the sentinel '**' for the
--      platform-wide row rather than NULL, because PostgreSQL treats NULLs as
--      distinct and a NULLable column would have permitted duplicate platform
--      rows — the exact hole DA-002 found in the reward ledger's nullable
--      idempotency key.
--
--   3. NO CHILD DATA. Not one column below holds a child id, a child name, a
--      birth date, message content or app-usage detail. `family_activations`
--      is the table closest to a child's behaviour and it stores a family id,
--      an instant, a duration and a rule version. CONTEXT §3 principle 8.
--
--   4. TENANCY. Four STRICT tables (`acquisition_attributions`,
--      `family_activations`, the four referral tables), one
--      PLATFORM_ANNOTATED (`growth_alerts`), the rest GLOBAL. Every STRICT
--      table is created with `family_id uuid NOT NULL` from the first row, so
--      there is no backfill and no orphan window — as in 0005, 0006 and 0014.
--
--   5. NO SEEDED BUSINESS VALUES. `growth_settings` is deliberately left
--      EMPTY. The defaults live in `domain/growth-settings.ts` and are applied
--      when no row exists, so an unconfigured deployment behaves predictably;
--      seeding them here would make an operator's later edit look like a
--      change to a decision somebody made, which is exactly what it is not.
--
-- SAFE TO RE-RUN. Every statement is IF NOT EXISTS / DO $$ guarded, the
-- property migrations 0007-0014 established.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1. ENUM TYPES.
-- -----------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'AcquisitionChannelType') THEN
    CREATE TYPE "AcquisitionChannelType" AS ENUM (
      'ORGANIC','TIKTOK','INSTAGRAM','FACEBOOK','YOUTUBE','GOOGLE','INFLUENCER',
      'SCHOOL','PARENT_COMMUNITY','REFERRAL','PARTNERSHIP','APP_STORE','GOOGLE_PLAY','OTHER'
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'AcquisitionPlatformType') THEN
    CREATE TYPE "AcquisitionPlatformType" AS ENUM ('ANDROID','IOS','WEB','UNKNOWN');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ReferralEventKind') THEN
    CREATE TYPE "ReferralEventKind" AS ENUM ('SENT','CLICKED','REGISTERED','QUALIFIED','REJECTED');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ReferralRewardKind') THEN
    CREATE TYPE "ReferralRewardKind" AS ENUM ('SUBSCRIPTION_CREDIT_DAYS','CHILD_REWARD_COINS');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ReferralRewardState') THEN
    CREATE TYPE "ReferralRewardState" AS ENUM ('PENDING','GRANTED','FAILED');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ForecastScenarioKind') THEN
    CREATE TYPE "ForecastScenarioKind" AS ENUM ('CONSERVATIVE','BASE','AGGRESSIVE');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'GrowthAlertSeverity') THEN
    CREATE TYPE "GrowthAlertSeverity" AS ENUM ('INFO','WARNING','CRITICAL');
  END IF;
END $$;


-- -----------------------------------------------------------------------------
-- 2. ACQUISITION ATTRIBUTION — STRICT, written once, never updated.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "acquisition_attributions" (
  "id"            uuid PRIMARY KEY,
  "family_id"     uuid NOT NULL REFERENCES "families"("id") ON DELETE CASCADE,
  "channel"       "AcquisitionChannelType" NOT NULL,
  "source"        varchar(120),
  "campaign"      varchar(120),
  "campaign_id"   uuid,
  "medium"        varchar(60),
  "content"       varchar(120),
  "country_code"  varchar(2),
  "platform"      "AcquisitionPlatformType" NOT NULL DEFAULT 'UNKNOWN',
  "referral_code" varchar(32),
  "referrer"      varchar(400),
  "landing_page"  varchar(400),
  "session_id"    varchar(100),
  "created_at"    timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- ONE ROW PER HOUSEHOLD. This is what makes attribution immutable in practice:
-- a second INSERT for the same family loses at the database, so a client that
-- retries registration cannot re-attribute an existing household.
CREATE UNIQUE INDEX IF NOT EXISTS "acquisition_attributions_family_id_key"
  ON "acquisition_attributions" ("family_id");
CREATE INDEX IF NOT EXISTS "acquisition_attributions_channel_created_at_idx"
  ON "acquisition_attributions" ("channel", "created_at");
CREATE INDEX IF NOT EXISTS "acquisition_attributions_country_created_at_idx"
  ON "acquisition_attributions" ("country_code", "created_at");
CREATE INDEX IF NOT EXISTS "acquisition_attributions_campaign_id_idx"
  ON "acquisition_attributions" ("campaign_id");
CREATE INDEX IF NOT EXISTS "acquisition_attributions_referral_code_idx"
  ON "acquisition_attributions" ("referral_code");


-- -----------------------------------------------------------------------------
-- 3. FAMILY ACTIVATION — STRICT, one row per household ever.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "family_activations" (
  "id"                     uuid PRIMARY KEY,
  "family_id"              uuid NOT NULL REFERENCES "families"("id") ON DELETE CASCADE,
  "rule_version"           varchar(40) NOT NULL,
  "completion_kind"        varchar(30) NOT NULL,
  "occurred_at"            timestamp(3) NOT NULL,
  "time_to_value_minutes"  integer NOT NULL,
  "country_code"           varchar(2),
  "created_at"             timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- A negative time-to-value is a clock problem, not a fast family. Refused
  -- rather than clamped, so it cannot silently enter a median.
  CONSTRAINT "family_activations_ttv_non_negative" CHECK ("time_to_value_minutes" >= 0)
);

-- GATE 4 of the activation definition. Two concurrent qualifying completions
-- produce exactly one activation, and the guarantee is this index.
CREATE UNIQUE INDEX IF NOT EXISTS "family_activations_family_id_key"
  ON "family_activations" ("family_id");
CREATE INDEX IF NOT EXISTS "family_activations_occurred_at_idx"
  ON "family_activations" ("occurred_at");
CREATE INDEX IF NOT EXISTS "family_activations_country_occurred_at_idx"
  ON "family_activations" ("country_code", "occurred_at");


-- -----------------------------------------------------------------------------
-- 4. CAMPAIGNS AND THEIR REPORTED SPEND — GLOBAL.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "growth_campaigns" (
  "id"                 uuid PRIMARY KEY,
  "name"               varchar(120) NOT NULL,
  "channel"            "AcquisitionChannelType" NOT NULL,
  "country_code"       varchar(2) NOT NULL,
  "budget_minor"       integer NOT NULL,
  "currency_code"      varchar(3) NOT NULL,
  "starts_at"          timestamp(3) NOT NULL,
  "ends_at"            timestamp(3) NOT NULL,
  "target_users"       integer NOT NULL,
  "target_paid_users"  integer NOT NULL,
  "utm_campaign"       varchar(120),
  "is_active"          boolean NOT NULL DEFAULT true,
  "created_by_user_id" uuid,
  "notes"              varchar(500),
  "created_at"         timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"         timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- No hardcoded budget anywhere in the module means the DATABASE has to
  -- refuse a nonsensical one; these three CHECKs are that refusal.
  CONSTRAINT "growth_campaigns_budget_non_negative" CHECK ("budget_minor" >= 0),
  CONSTRAINT "growth_campaigns_targets_non_negative"
    CHECK ("target_users" >= 0 AND "target_paid_users" >= 0),
  CONSTRAINT "growth_campaigns_window_ordered" CHECK ("ends_at" > "starts_at"),
  CONSTRAINT "growth_campaigns_currency_iso" CHECK ("currency_code" ~ '^[A-Z]{3}$')
);

CREATE UNIQUE INDEX IF NOT EXISTS "growth_campaigns_name_country_key"
  ON "growth_campaigns" ("name", "country_code");
CREATE INDEX IF NOT EXISTS "growth_campaigns_country_active_idx"
  ON "growth_campaigns" ("country_code", "is_active");
CREATE INDEX IF NOT EXISTS "growth_campaigns_channel_idx"
  ON "growth_campaigns" ("channel");

CREATE TABLE IF NOT EXISTS "campaign_daily_spend" (
  "id"            uuid PRIMARY KEY,
  "campaign_id"   uuid NOT NULL REFERENCES "growth_campaigns"("id") ON DELETE CASCADE,
  "business_date" date NOT NULL,
  "spend_minor"   integer NOT NULL,
  "impressions"   integer NOT NULL DEFAULT 0,
  "clicks"        integer NOT NULL DEFAULT 0,
  "visits"        integer NOT NULL DEFAULT 0,
  "leads"         integer NOT NULL DEFAULT 0,
  "created_at"    timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"    timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "campaign_daily_spend_non_negative"
    CHECK ("spend_minor" >= 0 AND "impressions" >= 0 AND "clicks" >= 0
           AND "visits" >= 0 AND "leads" >= 0)
);

-- Re-importing yesterday's ad-platform export UPDATEs one row instead of
-- doubling the spend, and therefore instead of halving the reported CAC.
CREATE UNIQUE INDEX IF NOT EXISTS "campaign_daily_spend_campaign_date_key"
  ON "campaign_daily_spend" ("campaign_id", "business_date");
CREATE INDEX IF NOT EXISTS "campaign_daily_spend_business_date_idx"
  ON "campaign_daily_spend" ("business_date");


-- -----------------------------------------------------------------------------
-- 5. REFERRAL CODES AND LINKS — STRICT.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "referral_codes" (
  "id"                 uuid PRIMARY KEY,
  "family_id"          uuid NOT NULL REFERENCES "families"("id") ON DELETE CASCADE,
  "code"               varchar(32) NOT NULL,
  "created_by_user_id" uuid,
  "is_active"          boolean NOT NULL DEFAULT true,
  "created_at"         timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"         timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- ONE CODE PER HOUSEHOLD, FOR LIFE. A household that could mint codes could
-- mint one per invitation and defeat every velocity limit counted per code.
CREATE UNIQUE INDEX IF NOT EXISTS "referral_codes_family_id_key"
  ON "referral_codes" ("family_id");
CREATE UNIQUE INDEX IF NOT EXISTS "referral_codes_code_key"
  ON "referral_codes" ("code");

CREATE TABLE IF NOT EXISTS "referral_links" (
  "id"               uuid PRIMARY KEY,
  "family_id"        uuid NOT NULL REFERENCES "families"("id") ON DELETE CASCADE,
  "referral_code_id" uuid NOT NULL REFERENCES "referral_codes"("id") ON DELETE CASCADE,
  "channel"          "AcquisitionChannelType" NOT NULL,
  "url"              varchar(400) NOT NULL,
  "click_count"      integer NOT NULL DEFAULT 0,
  "created_at"       timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"       timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "referral_links_click_count_non_negative" CHECK ("click_count" >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS "referral_links_code_channel_key"
  ON "referral_links" ("referral_code_id", "channel");
CREATE INDEX IF NOT EXISTS "referral_links_family_id_idx"
  ON "referral_links" ("family_id");


-- -----------------------------------------------------------------------------
-- 6. REFERRAL EVENTS AND REWARDS — STRICT, AND THE FOUR FRAUD DEFENCES.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "referral_events" (
  "id"                 uuid PRIMARY KEY,
  "family_id"          uuid NOT NULL REFERENCES "families"("id") ON DELETE CASCADE,
  "referral_code_id"   uuid NOT NULL REFERENCES "referral_codes"("id") ON DELETE CASCADE,
  "kind"               "ReferralEventKind" NOT NULL,
  "referred_family_id" uuid,
  "channel"            "AcquisitionChannelType",
  "rejection_reason"   varchar(60),
  "idempotency_key"    varchar(200) NOT NULL,
  "occurred_at"        timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  -- VECTOR 1 — SELF-REFERRAL. Not "the service checks this": the row cannot
  -- exist. A NULL referred family (SENT/CLICKED) passes, which is correct —
  -- there is nothing to compare yet.
  CONSTRAINT "referral_events_no_self_referral"
    CHECK ("referred_family_id" IS NULL OR "referred_family_id" <> "family_id"),

  -- A REGISTERED/QUALIFIED row without a referred household is meaningless and
  -- would corrupt every count that groups by it.
  CONSTRAINT "referral_events_referred_present_when_needed"
    CHECK ("kind" NOT IN ('REGISTERED','QUALIFIED') OR "referred_family_id" IS NOT NULL)
);

-- VECTOR 2 — DUPLICATE REFERRAL. A PARTIAL unique index over REGISTERED rows
-- only: one household can be referred exactly once, ever, by exactly one
-- referrer. Deliberately NOT `(family_id, referred_family_id)`, which would
-- still have let two different referrers claim the same household.
CREATE UNIQUE INDEX IF NOT EXISTS "referral_events_referred_family_uq"
  ON "referral_events" ("referred_family_id")
  WHERE "kind" = 'REGISTERED' AND "referred_family_id" IS NOT NULL;

-- The same discipline `payment_transactions (family_id, idempotency_key)` uses:
-- a redelivered qualification writes one row, not two.
CREATE UNIQUE INDEX IF NOT EXISTS "referral_events_family_idempotency_key"
  ON "referral_events" ("family_id", "idempotency_key");
CREATE INDEX IF NOT EXISTS "referral_events_family_kind_occurred_idx"
  ON "referral_events" ("family_id", "kind", "occurred_at");
CREATE INDEX IF NOT EXISTS "referral_events_referred_family_idx"
  ON "referral_events" ("referred_family_id");

CREATE TABLE IF NOT EXISTS "referral_rewards" (
  "id"                uuid PRIMARY KEY,
  "family_id"         uuid NOT NULL REFERENCES "families"("id") ON DELETE CASCADE,
  "referral_event_id" uuid NOT NULL REFERENCES "referral_events"("id") ON DELETE CASCADE,
  "kind"              "ReferralRewardKind" NOT NULL,
  "value"             integer NOT NULL,
  "status"            "ReferralRewardState" NOT NULL DEFAULT 'PENDING',
  "fulfilment_ref"    varchar(120),
  "failure_reason"    varchar(300),
  "granted_at"        timestamp(3),
  "created_at"        timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"        timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "referral_rewards_value_positive" CHECK ("value" > 0)
);

-- VECTOR 3 — MULTIPLE REWARDS FOR ONE CONVERSION. This one index is the whole
-- answer to «two workers qualified the same conversion at the same instant».
CREATE UNIQUE INDEX IF NOT EXISTS "referral_rewards_referral_event_id_key"
  ON "referral_rewards" ("referral_event_id");
CREATE INDEX IF NOT EXISTS "referral_rewards_family_status_idx"
  ON "referral_rewards" ("family_id", "status");


-- -----------------------------------------------------------------------------
-- 7. THE DAILY AGGREGATE — GLOBAL, and idempotent by unique index.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "growth_daily_metrics" (
  "id"                          uuid PRIMARY KEY,
  "business_date"               date NOT NULL,
  "country_code"                varchar(2) NOT NULL,
  "currency_code"               varchar(3),
  "reporting_timezone"          varchar(64) NOT NULL,
  "dau"                         integer NOT NULL DEFAULT 0,
  "wau"                         integer NOT NULL DEFAULT 0,
  "mau"                         integer NOT NULL DEFAULT 0,
  "new_registrations"           integer NOT NULL DEFAULT 0,
  "activations"                 integer NOT NULL DEFAULT 0,
  "children_added"              integer NOT NULL DEFAULT 0,
  "devices_paired"              integer NOT NULL DEFAULT 0,
  "trials_started"              integer NOT NULL DEFAULT 0,
  "trials_resolved"             integer NOT NULL DEFAULT 0,
  "trials_converted"            integer NOT NULL DEFAULT 0,
  "new_paid_families"           integer NOT NULL DEFAULT 0,
  "paying_families"             integer NOT NULL DEFAULT 0,
  "active_paid_subscriptions"   integer NOT NULL DEFAULT 0,
  "churned_paid_subscriptions"  integer NOT NULL DEFAULT 0,
  "payment_success_count"       integer NOT NULL DEFAULT 0,
  "payment_failure_count"       integer NOT NULL DEFAULT 0,
  "referrals_qualified"         integer NOT NULL DEFAULT 0,
  "net_revenue_minor"           integer NOT NULL DEFAULT 0,
  "mrr_minor"                   integer NOT NULL DEFAULT 0,
  "median_time_to_value_minutes" integer,
  "computed_at"                 timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"                  timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- THE IDEMPOTENCY OF THE AGGREGATION JOB, in one line. '**' is the platform
-- row: a sentinel rather than NULL, because PostgreSQL treats NULLs as
-- distinct and a NULLable column would permit duplicate platform rows.
CREATE UNIQUE INDEX IF NOT EXISTS "growth_daily_metrics_date_country_key"
  ON "growth_daily_metrics" ("business_date", "country_code");
CREATE INDEX IF NOT EXISTS "growth_daily_metrics_country_date_idx"
  ON "growth_daily_metrics" ("country_code", "business_date");


-- -----------------------------------------------------------------------------
-- 8. TARGETS AND FORECAST SCENARIOS — GLOBAL, admin-owned inputs.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "growth_quarterly_targets" (
  "id"             uuid PRIMARY KEY,
  "country_code"   varchar(2) NOT NULL,
  "year"           integer NOT NULL,
  "quarter"        integer NOT NULL,
  "metric"         varchar(30) NOT NULL,
  "target_value"   decimal(18,6) NOT NULL,
  "currency_code"  varchar(3),
  "set_by_user_id" uuid,
  "note"           varchar(300),
  "created_at"     timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"     timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "growth_quarterly_targets_quarter_range" CHECK ("quarter" BETWEEN 1 AND 4),
  CONSTRAINT "growth_quarterly_targets_year_range" CHECK ("year" BETWEEN 2024 AND 2100)
);

CREATE UNIQUE INDEX IF NOT EXISTS "growth_quarterly_targets_country_year_quarter_metric_key"
  ON "growth_quarterly_targets" ("country_code", "year", "quarter", "metric");
CREATE INDEX IF NOT EXISTS "growth_quarterly_targets_country_year_idx"
  ON "growth_quarterly_targets" ("country_code", "year");

CREATE TABLE IF NOT EXISTS "growth_forecast_scenarios" (
  "id"                   uuid PRIMARY KEY,
  "scenario"             "ForecastScenarioKind" NOT NULL,
  "country_code"         varchar(2) NOT NULL,
  "currency_code"        varchar(3) NOT NULL,
  "monthly_acquisition"  integer NOT NULL,
  "conversion_rate"      decimal(6,5) NOT NULL,
  "paid_conversion_rate" decimal(6,5) NOT NULL,
  "churn_rate"           decimal(6,5) NOT NULL,
  "arpu_minor"           integer NOT NULL,
  "cac_minor"            integer NOT NULL,
  "retention_d30"        decimal(6,5) NOT NULL,
  "is_active"            boolean NOT NULL DEFAULT true,
  "updated_by_user_id"   uuid,
  "created_at"           timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"           timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- Every assumption is a rate in [0,1] or a non-negative amount. An
  -- assumption outside those bounds produces a forecast that is not merely
  -- optimistic but arithmetically impossible, and the database refuses it.
  CONSTRAINT "growth_forecast_scenarios_rates_bounded"
    CHECK ("conversion_rate" BETWEEN 0 AND 1
           AND "paid_conversion_rate" BETWEEN 0 AND 1
           AND "churn_rate" BETWEEN 0 AND 1
           AND "retention_d30" BETWEEN 0 AND 1),
  CONSTRAINT "growth_forecast_scenarios_amounts_non_negative"
    CHECK ("monthly_acquisition" >= 0 AND "arpu_minor" >= 0 AND "cac_minor" >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS "growth_forecast_scenarios_country_scenario_key"
  ON "growth_forecast_scenarios" ("country_code", "scenario");


-- -----------------------------------------------------------------------------
-- 9. OPERATOR ALERTS — PLATFORM_ANNOTATED.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "growth_alerts" (
  "id"                     uuid PRIMARY KEY,
  "family_id"              uuid REFERENCES "families"("id") ON DELETE SET NULL,
  "alert_type"             varchar(60) NOT NULL,
  "scope_key"              varchar(40) NOT NULL,
  "business_date"          date NOT NULL,
  "severity"               "GrowthAlertSeverity" NOT NULL DEFAULT 'WARNING',
  "message"                varchar(500) NOT NULL,
  "observed_value"         decimal(18,6),
  "threshold_value"        decimal(18,6),
  "acknowledged_at"        timestamp(3),
  "acknowledged_by_user_id" uuid,
  "created_at"             timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- An hourly scan of a condition that persists for three days raises ONE alert
-- per day, not seventy-two. The dedupe is the index, not a cooldown in memory
-- that a restart would forget.
CREATE UNIQUE INDEX IF NOT EXISTS "growth_alerts_type_scope_date_key"
  ON "growth_alerts" ("alert_type", "scope_key", "business_date");
CREATE INDEX IF NOT EXISTS "growth_alerts_severity_created_idx"
  ON "growth_alerts" ("severity", "created_at");
CREATE INDEX IF NOT EXISTS "growth_alerts_acknowledged_idx"
  ON "growth_alerts" ("acknowledged_at");


-- -----------------------------------------------------------------------------
-- 10. GROWTH SETTINGS — GLOBAL. Deliberately EMPTY (see header note 5).
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "growth_settings" (
  "key"                varchar(80) PRIMARY KEY,
  "value"              varchar(200) NOT NULL,
  "updated_by_user_id" uuid,
  "updated_at"         timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);


-- -----------------------------------------------------------------------------
-- 11. THE TWO SCHEDULED JOBS. Registered as ROWS, because
--     `test/scheduler/job-registry.spec.ts` asserts that the code registry and
--     these rows are the SAME SET — a job in code with no row is never claimed,
--     and a row with no code fails every tick.
--
--     `local_hour` is NULL for both: these are PLATFORM jobs, and a platform
--     job has no family calendar to be due on. The reporting timezone they use
--     for their day boundary is a `growth_settings` row, read at run time.
-- -----------------------------------------------------------------------------
INSERT INTO "scheduled_jobs" ("name","scope","cadence_seconds","local_hour","enabled","next_run_at")
VALUES
  ('growth-daily-aggregation','PLATFORM', 3600, NULL, true, now()),
  ('growth-alert-scan',       'PLATFORM', 3600, NULL, true, now())
ON CONFLICT ("name") DO NOTHING;
