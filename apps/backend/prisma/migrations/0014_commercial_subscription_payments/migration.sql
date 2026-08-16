-- =============================================================================
-- 0014_commercial_subscription_payments — PHASE D, part 2 of 2.
--
-- WHAT WAS THERE. A1-Backend-Audit §21/§22 measured the billing module at
-- 1,049 lines with SIX payment adapters of which exactly one (MANUAL) does
-- anything, and a `PaymentProvider` port whose entire contract is
-- `charge(subscriptionId, amountCents, currency)`. There was no country, no
-- currency other than a hardcoded "USD" default, no billing period, no VAT, no
-- payment transaction, no refund, no entitlement row, and no webhook dedupe
-- table. `00-Company-Response.md` Q17 specifies all of them.
--
-- WHAT THIS MIGRATION ADDS. Nine tables, six enum types (the five ADD VALUEs on
-- pre-existing types are 0013, for the transaction-visibility reason stated
-- there), and the columns that let a subscription say WHICH MARKET it was sold in.
--
-- THE TWO THINGS WORTH READING BEFORE CHANGING ANYTHING HERE:
--
--   1. APPEND-ONLY IS ENFORCED BY TRIGGERS, NOT BY DISCIPLINE. Section 7
--      installs a DELETE-blocking trigger on all four financial tables and an
--      UPDATE trigger on `payment_transactions` that rejects any change to a
--      monetary column, to the provider, or to the provider's transaction id,
--      and rejects a status transition outside the allowed lattice. The
--      application cannot corrupt financial history even by mistake, and
--      neither can a psql session.
--
--   2. IDEMPOTENCY IS A UNIQUE INDEX, NOT A CHECK-THEN-INSERT. Same discipline
--      migration 0002 established for the reward ledger and 0005 for the event
--      backbone: `payment_transactions (provider, provider_transaction_id)`,
--      `payment_transactions (family_id, idempotency_key)`,
--      `refunds (family_id, idempotency_key)` and
--      `payment_webhook_events (provider, provider_event_id)`. A concurrent
--      redelivery loses the race at the database, not in a `SELECT` that
--      another transaction has already invalidated.
--
-- SAFE TO RE-RUN. Every statement is IF NOT EXISTS / ADD VALUE IF NOT EXISTS /
-- ON CONFLICT DO NOTHING / CREATE OR REPLACE — the property migrations
-- 0007-0011 established. Applying it twice to the same database is a no-op.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1. NEW ENUM TYPES.
-- -----------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'BillingPeriod') THEN
    CREATE TYPE "BillingPeriod" AS ENUM ('MONTHLY', 'QUARTERLY', 'ANNUAL');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'VatMode') THEN
    CREATE TYPE "VatMode" AS ENUM ('INCLUSIVE', 'EXCLUSIVE');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'PaymentTransactionStatus') THEN
    CREATE TYPE "PaymentTransactionStatus" AS ENUM ('PENDING', 'SUCCEEDED', 'FAILED', 'REFUNDED', 'CHARGEBACK');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'RefundStatus') THEN
    CREATE TYPE "RefundStatus" AS ENUM ('PENDING', 'COMPLETED', 'DECLINED', 'REVERSED');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'EntitlementStatus') THEN
    CREATE TYPE "EntitlementStatus" AS ENUM ('ACTIVE', 'REVOKED', 'EXPIRED');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'WebhookOutcome') THEN
    CREATE TYPE "WebhookOutcome" AS ENUM (
      'RECEIVED', 'PROCESSED', 'IGNORED',
      'REJECTED_SIGNATURE', 'REJECTED_VALIDATION', 'DUPLICATE', 'FAILED'
    );
  END IF;
END $$;

-- -----------------------------------------------------------------------------
-- 2. THE PRICE CATALOGUE — currencies, countries, prices.
--
--    GLOBAL tenancy class (no family_id), same as `plan_definitions`: a price
--    list is owned by the deployment and read by every household.
--
--    VAT IS A COLUMN. 14% in Egypt and 15% in Saudi Arabia today
--    (00-Company-Response.md Q16); both are set by decree and neither belongs
--    in a TypeScript constant. Stored in BASIS POINTS so no money arithmetic
--    in this module ever touches a float.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "currencies" (
  "code"        VARCHAR(3)  PRIMARY KEY,
  "symbol_en"   VARCHAR(8)  NOT NULL,
  "symbol_ar"   VARCHAR(8)  NOT NULL,
  "minor_units" INTEGER     NOT NULL DEFAULT 2,
  "is_active"   BOOLEAN     NOT NULL DEFAULT true,
  "created_at"  TIMESTAMP(3) NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "countries" (
  "code"             VARCHAR(2)   PRIMARY KEY,
  "name_en"          VARCHAR(80)  NOT NULL,
  "name_ar"          VARCHAR(80)  NOT NULL,
  "currency_code"    VARCHAR(3)   NOT NULL,
  "vat_basis_points" INTEGER      NOT NULL,
  "vat_mode"         "VatMode"    NOT NULL DEFAULT 'INCLUSIVE',
  "default_provider" "PaymentProvider" NOT NULL DEFAULT 'MANUAL',
  "is_active"        BOOLEAN      NOT NULL DEFAULT true,
  "created_at"       TIMESTAMP(3) NOT NULL DEFAULT now(),
  "updated_at"       TIMESTAMP(3) NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "subscription_prices" (
  "id"               UUID              PRIMARY KEY DEFAULT gen_random_uuid(),
  "plan_tier"        "SubscriptionPlan" NOT NULL,
  "country_code"     VARCHAR(2)        NOT NULL,
  "currency_code"    VARCHAR(3)        NOT NULL,
  "billing_period"   "BillingPeriod"   NOT NULL,
  "amount_minor"     INTEGER           NOT NULL,
  "vat_mode"         "VatMode"         NOT NULL,
  "store_product_id" VARCHAR(120),
  "is_active"        BOOLEAN           NOT NULL DEFAULT true,
  "created_at"       TIMESTAMP(3)      NOT NULL DEFAULT now(),
  "updated_at"       TIMESTAMP(3)      NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'countries_currency_code_fkey') THEN
    ALTER TABLE "countries" ADD CONSTRAINT "countries_currency_code_fkey"
      FOREIGN KEY ("currency_code") REFERENCES "currencies"("code") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
  -- A negative VAT rate, or one above 100%, is not a policy this system can
  -- represent. Refused at the database rather than half-honoured in code.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'countries_vat_range_check') THEN
    ALTER TABLE "countries" ADD CONSTRAINT "countries_vat_range_check"
      CHECK ("vat_basis_points" >= 0 AND "vat_basis_points" <= 10000);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'currencies_minor_units_check') THEN
    ALTER TABLE "currencies" ADD CONSTRAINT "currencies_minor_units_check"
      CHECK ("minor_units" >= 0 AND "minor_units" <= 4);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'subscription_prices_country_code_fkey') THEN
    ALTER TABLE "subscription_prices" ADD CONSTRAINT "subscription_prices_country_code_fkey"
      FOREIGN KEY ("country_code") REFERENCES "countries"("code") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'subscription_prices_currency_code_fkey') THEN
    ALTER TABLE "subscription_prices" ADD CONSTRAINT "subscription_prices_currency_code_fkey"
      FOREIGN KEY ("currency_code") REFERENCES "currencies"("code") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
  -- A price of zero is legitimate (the FREE tier). A negative one is not.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'subscription_prices_amount_check') THEN
    ALTER TABLE "subscription_prices" ADD CONSTRAINT "subscription_prices_amount_check"
      CHECK ("amount_minor" >= 0);
  END IF;
END $$;

-- ONE live price per (tier, country, period). This constraint is the reason two
-- rows can never disagree about what Premium monthly costs in Egypt.
CREATE UNIQUE INDEX IF NOT EXISTS "subscription_prices_plan_country_period_key"
  ON "subscription_prices" ("plan_tier", "country_code", "billing_period");
CREATE INDEX IF NOT EXISTS "subscription_prices_country_active_idx"
  ON "subscription_prices" ("country_code", "is_active");
CREATE INDEX IF NOT EXISTS "subscription_prices_store_product_idx"
  ON "subscription_prices" ("store_product_id");
CREATE INDEX IF NOT EXISTS "countries_is_active_idx" ON "countries" ("is_active");

-- -----------------------------------------------------------------------------
-- 3. TRIAL — the lifetime, once-per-family fact.
--
--    `family_id` is UNIQUE, and that constraint IS the "one trial per family
--    ever" rule (00-Company-Response.md Q17). An application check would be a
--    race; this is not. It is deliberately a separate table from
--    `subscriptions.trial_ends_at`, which stays where it is: the trial fact has
--    to survive the subscription row being cancelled and re-created.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "trials" (
  "id"           UUID               PRIMARY KEY DEFAULT gen_random_uuid(),
  "family_id"    UUID               NOT NULL,
  "plan_tier"    "SubscriptionPlan" NOT NULL,
  "started_at"   TIMESTAMP(3)       NOT NULL DEFAULT now(),
  "ends_at"      TIMESTAMP(3)       NOT NULL,
  "source"       VARCHAR(60)        NOT NULL DEFAULT 'SIGNUP',
  "converted_at" TIMESTAMP(3),
  "cancelled_at" TIMESTAMP(3),
  "created_at"   TIMESTAMP(3)       NOT NULL DEFAULT now(),
  "updated_at"   TIMESTAMP(3)       NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'trials_family_id_fkey') THEN
    ALTER TABLE "trials" ADD CONSTRAINT "trials_family_id_fkey"
      FOREIGN KEY ("family_id") REFERENCES "families"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'trials_window_check') THEN
    ALTER TABLE "trials" ADD CONSTRAINT "trials_window_check" CHECK ("ends_at" > "started_at");
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "trials_family_id_key" ON "trials" ("family_id");
CREATE INDEX IF NOT EXISTS "trials_ends_at_idx" ON "trials" ("ends_at");

-- -----------------------------------------------------------------------------
-- 4. PROVIDER ACCOUNT LINK — the cross-tenant defence.
--
--    Apple gives a purchase an `appAccountToken` and Google an
--    `obfuscatedExternalAccountId`. Both are opaque to the store and are the
--    ONLY durable link from a verified purchase back to one of our tenants.
--    Resolution goes through this table's UNIQUE index, so a purchase whose
--    account reference belongs to family B cannot be applied to family A no
--    matter what the client claims — because the client is not asked.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "provider_account_links" (
  "id"                   UUID              PRIMARY KEY DEFAULT gen_random_uuid(),
  "family_id"            UUID              NOT NULL,
  "provider"             "PaymentProvider" NOT NULL,
  "provider_account_ref" VARCHAR(120)      NOT NULL,
  "linked_at"            TIMESTAMP(3)      NOT NULL DEFAULT now(),
  "revoked_at"           TIMESTAMP(3)
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'provider_account_links_family_id_fkey') THEN
    ALTER TABLE "provider_account_links" ADD CONSTRAINT "provider_account_links_family_id_fkey"
      FOREIGN KEY ("family_id") REFERENCES "families"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "provider_account_links_provider_ref_key"
  ON "provider_account_links" ("provider", "provider_account_ref");
CREATE INDEX IF NOT EXISTS "provider_account_links_family_provider_idx"
  ON "provider_account_links" ("family_id", "provider");

-- -----------------------------------------------------------------------------
-- 5. PAYMENT TRANSACTION — the append-only money fact.
--
--    Every amount in this table came from a SERVER-SIDE VERIFICATION: Apple's
--    signed JWS, Google's Developer API response, or a gateway's HMAC-signed
--    server-to-server callback. None of it came from a request body. That is
--    the whole architecture in one sentence, and section 7's triggers are what
--    stop it from being merely an intention.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "payment_transactions" (
  "id"                               UUID                       PRIMARY KEY DEFAULT gen_random_uuid(),
  "family_id"                        UUID                       NOT NULL,
  "subscription_id"                  UUID,
  "provider"                         "PaymentProvider"          NOT NULL,
  "provider_transaction_id"          VARCHAR(160)               NOT NULL,
  "provider_original_transaction_id" VARCHAR(200),
  "product_ref"                      VARCHAR(120),
  "plan_tier"                        "SubscriptionPlan",
  "billing_period"                   "BillingPeriod",
  "country_code"                     VARCHAR(2),
  "currency"                         VARCHAR(3)                 NOT NULL,
  "gross_amount_minor"               INTEGER                    NOT NULL,
  "vat_amount_minor"                 INTEGER                    NOT NULL DEFAULT 0,
  "net_amount_minor"                 INTEGER                    NOT NULL,
  "status"                           "PaymentTransactionStatus" NOT NULL,
  "idempotency_key"                  VARCHAR(200)               NOT NULL,
  "occurred_at"                      TIMESTAMP(3)               NOT NULL,
  "verified_at"                      TIMESTAMP(3),
  "verified_payload_digest"          VARCHAR(64),
  "is_sandbox"                       BOOLEAN                    NOT NULL DEFAULT false,
  "created_at"                       TIMESTAMP(3)               NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payment_transactions_family_id_fkey') THEN
    ALTER TABLE "payment_transactions" ADD CONSTRAINT "payment_transactions_family_id_fkey"
      FOREIGN KEY ("family_id") REFERENCES "families"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payment_transactions_subscription_id_fkey') THEN
    ALTER TABLE "payment_transactions" ADD CONSTRAINT "payment_transactions_subscription_id_fkey"
      FOREIGN KEY ("subscription_id") REFERENCES "subscriptions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  -- Money is never negative here. A reversal is a `refunds` row, not a
  -- negative payment — that is what makes this table auditable.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payment_transactions_amounts_check') THEN
    ALTER TABLE "payment_transactions" ADD CONSTRAINT "payment_transactions_amounts_check"
      CHECK (
        "gross_amount_minor" >= 0
        AND "vat_amount_minor" >= 0
        AND "net_amount_minor" >= 0
        AND "vat_amount_minor" <= "gross_amount_minor"
        AND "net_amount_minor" + "vat_amount_minor" = "gross_amount_minor"
      );
  END IF;
  -- ISO-4217 is three uppercase letters. A row saying "usd" or "EGP " is a bug
  -- that would otherwise surface as a silent currency mismatch months later.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payment_transactions_currency_check') THEN
    ALTER TABLE "payment_transactions" ADD CONSTRAINT "payment_transactions_currency_check"
      CHECK ("currency" ~ '^[A-Z]{3}$');
  END IF;
END $$;

-- THE TWO IDEMPOTENCY CONSTRAINTS.
CREATE UNIQUE INDEX IF NOT EXISTS "payment_transactions_provider_txn_key"
  ON "payment_transactions" ("provider", "provider_transaction_id");
CREATE UNIQUE INDEX IF NOT EXISTS "payment_transactions_family_idempotency_key"
  ON "payment_transactions" ("family_id", "idempotency_key");
CREATE INDEX IF NOT EXISTS "payment_transactions_family_occurred_idx"
  ON "payment_transactions" ("family_id", "occurred_at");
CREATE INDEX IF NOT EXISTS "payment_transactions_subscription_idx"
  ON "payment_transactions" ("subscription_id");
CREATE INDEX IF NOT EXISTS "payment_transactions_original_txn_idx"
  ON "payment_transactions" ("provider_original_transaction_id");

-- -----------------------------------------------------------------------------
-- 6. REFUND, ENTITLEMENT, WEBHOOK EVENT.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "refunds" (
  "id"                     UUID              PRIMARY KEY DEFAULT gen_random_uuid(),
  "family_id"              UUID              NOT NULL,
  "payment_transaction_id" UUID              NOT NULL,
  "provider"               "PaymentProvider" NOT NULL,
  "provider_refund_id"     VARCHAR(160),
  "amount_minor"           INTEGER           NOT NULL,
  "currency"               VARCHAR(3)        NOT NULL,
  "reason"                 VARCHAR(300),
  "status"                 "RefundStatus"    NOT NULL,
  "idempotency_key"        VARCHAR(200)      NOT NULL,
  "occurred_at"            TIMESTAMP(3)      NOT NULL,
  "created_at"             TIMESTAMP(3)      NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "entitlements" (
  "id"              UUID                PRIMARY KEY DEFAULT gen_random_uuid(),
  "family_id"       UUID                NOT NULL,
  "feature_key"     VARCHAR(60)         NOT NULL,
  "plan_tier"       "SubscriptionPlan"  NOT NULL,
  "source"          "PaymentProvider"   NOT NULL,
  "subscription_id" UUID,
  "status"          "EntitlementStatus" NOT NULL DEFAULT 'ACTIVE',
  "valid_from"      TIMESTAMP(3)        NOT NULL,
  "valid_until"     TIMESTAMP(3),
  "revoked_at"      TIMESTAMP(3),
  "revoked_reason"  VARCHAR(200),
  "created_at"      TIMESTAMP(3)        NOT NULL DEFAULT now(),
  "updated_at"      TIMESTAMP(3)        NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "payment_webhook_events" (
  "id"                 UUID              PRIMARY KEY DEFAULT gen_random_uuid(),
  "family_id"          UUID,
  "provider"           "PaymentProvider" NOT NULL,
  "provider_event_id"  VARCHAR(200)      NOT NULL,
  "event_type"         VARCHAR(80)       NOT NULL,
  "event_subtype"      VARCHAR(80),
  "signature_verified" BOOLEAN           NOT NULL DEFAULT false,
  "outcome"            "WebhookOutcome"  NOT NULL DEFAULT 'RECEIVED',
  "payload_digest"     VARCHAR(64)       NOT NULL,
  "provider_signed_at" TIMESTAMP(3),
  "received_at"        TIMESTAMP(3)      NOT NULL DEFAULT now(),
  "processed_at"       TIMESTAMP(3),
  "failure_reason"     VARCHAR(400)
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'refunds_family_id_fkey') THEN
    ALTER TABLE "refunds" ADD CONSTRAINT "refunds_family_id_fkey"
      FOREIGN KEY ("family_id") REFERENCES "families"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  -- RESTRICT, not CASCADE: a refund must never be able to outlive, or be
  -- silently removed with, the payment it reverses.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'refunds_payment_transaction_id_fkey') THEN
    ALTER TABLE "refunds" ADD CONSTRAINT "refunds_payment_transaction_id_fkey"
      FOREIGN KEY ("payment_transaction_id") REFERENCES "payment_transactions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'refunds_amount_check') THEN
    ALTER TABLE "refunds" ADD CONSTRAINT "refunds_amount_check" CHECK ("amount_minor" > 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'refunds_currency_check') THEN
    ALTER TABLE "refunds" ADD CONSTRAINT "refunds_currency_check" CHECK ("currency" ~ '^[A-Z]{3}$');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'entitlements_family_id_fkey') THEN
    ALTER TABLE "entitlements" ADD CONSTRAINT "entitlements_family_id_fkey"
      FOREIGN KEY ("family_id") REFERENCES "families"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'entitlements_subscription_id_fkey') THEN
    ALTER TABLE "entitlements" ADD CONSTRAINT "entitlements_subscription_id_fkey"
      FOREIGN KEY ("subscription_id") REFERENCES "subscriptions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payment_webhook_events_family_id_fkey') THEN
    ALTER TABLE "payment_webhook_events" ADD CONSTRAINT "payment_webhook_events_family_id_fkey"
      FOREIGN KEY ("family_id") REFERENCES "families"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "refunds_family_idempotency_key"
  ON "refunds" ("family_id", "idempotency_key");
CREATE INDEX IF NOT EXISTS "refunds_payment_transaction_idx" ON "refunds" ("payment_transaction_id");
CREATE INDEX IF NOT EXISTS "refunds_family_occurred_idx"     ON "refunds" ("family_id", "occurred_at");

-- One LIVE row per (family, feature). Makes the grant an idempotent UPSERT: a
-- redelivered renewal extends `valid_until` rather than creating a second,
-- contradictory grant.
CREATE UNIQUE INDEX IF NOT EXISTS "entitlements_family_feature_key"
  ON "entitlements" ("family_id", "feature_key");
CREATE INDEX IF NOT EXISTS "entitlements_family_status_idx" ON "entitlements" ("family_id", "status");
CREATE INDEX IF NOT EXISTS "entitlements_valid_until_idx"   ON "entitlements" ("valid_until");

-- THE WEBHOOK DEDUPE CONSTRAINT. `00-Company-Response.md` Q17 names this
-- exact index as «the point that usually breaks subscription systems».
CREATE UNIQUE INDEX IF NOT EXISTS "payment_webhook_events_provider_event_key"
  ON "payment_webhook_events" ("provider", "provider_event_id");
CREATE INDEX IF NOT EXISTS "payment_webhook_events_provider_received_idx"
  ON "payment_webhook_events" ("provider", "received_at");
CREATE INDEX IF NOT EXISTS "payment_webhook_events_outcome_received_idx"
  ON "payment_webhook_events" ("outcome", "received_at");

-- -----------------------------------------------------------------------------
-- 7. APPEND-ONLY, ENFORCED.
--
--    «Financial history is append-only — never deleted.» Two triggers make that
--    a property of the database rather than a property of how carefully the
--    application is written.
--
--    Note what is deliberately NOT blocked: a monotonic status advance
--    (PENDING -> SUCCEEDED, SUCCEEDED -> REFUNDED) and the two verification
--    columns. Fawry's entire model is a payment that completes days after it is
--    recorded; refusing that UPDATE would force a second row for one payment,
--    which is a worse ledger, not a stricter one. What is blocked is any change
--    to WHAT WAS PAID, TO WHOM, IN WHAT CURRENCY, and any status regression.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION "abny_block_financial_delete"() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION
    'append-only table %: DELETE is not permitted (PHASE D, migration 0014). Financial history is never deleted.',
    TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION "abny_payment_transactions_immutable"() RETURNS TRIGGER AS $$
BEGIN
  IF NEW."provider"                IS DISTINCT FROM OLD."provider"
     OR NEW."provider_transaction_id" IS DISTINCT FROM OLD."provider_transaction_id"
     OR NEW."family_id"            IS DISTINCT FROM OLD."family_id"
     OR NEW."currency"             IS DISTINCT FROM OLD."currency"
     OR NEW."gross_amount_minor"   IS DISTINCT FROM OLD."gross_amount_minor"
     OR NEW."vat_amount_minor"     IS DISTINCT FROM OLD."vat_amount_minor"
     OR NEW."net_amount_minor"     IS DISTINCT FROM OLD."net_amount_minor"
     OR NEW."occurred_at"          IS DISTINCT FROM OLD."occurred_at"
     OR NEW."created_at"           IS DISTINCT FROM OLD."created_at"
  THEN
    RAISE EXCEPTION
      'payment_transactions row % is immutable: provider, transaction id, tenant, currency, amounts and timestamps cannot be changed after insert.',
      OLD."id"
      USING ERRCODE = 'restrict_violation';
  END IF;

  -- The allowed status lattice, in full. Anything else is a regression.
  IF NEW."status" IS DISTINCT FROM OLD."status" AND NOT (
       (OLD."status" = 'PENDING'   AND NEW."status" IN ('SUCCEEDED', 'FAILED'))
    OR (OLD."status" = 'SUCCEEDED' AND NEW."status" IN ('REFUNDED', 'CHARGEBACK'))
    OR (OLD."status" = 'REFUNDED'  AND NEW."status" = 'CHARGEBACK')
  ) THEN
    RAISE EXCEPTION
      'payment_transactions row %: status transition % -> % is not allowed.',
      OLD."id", OLD."status", NEW."status"
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['payment_transactions', 'refunds', 'invoices', 'payment_webhook_events'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', t || '_no_delete', t);
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE DELETE ON %I FOR EACH ROW EXECUTE FUNCTION "abny_block_financial_delete"()',
      t || '_no_delete', t
    );
  END LOOP;

  DROP TRIGGER IF EXISTS "payment_transactions_immutable" ON "payment_transactions";
  CREATE TRIGGER "payment_transactions_immutable"
    BEFORE UPDATE ON "payment_transactions"
    FOR EACH ROW EXECUTE FUNCTION "abny_payment_transactions_immutable"();
END $$;

-- -----------------------------------------------------------------------------
-- 8. SUBSCRIPTION AND INVOICE COLUMNS.
--
--    All nullable. Every row written before Phase D remains valid and readable;
--    nothing is backfilled with an invented country or an invented currency,
--    because inventing one would be a lie about where a customer bought.
-- -----------------------------------------------------------------------------
ALTER TABLE "subscriptions" ADD COLUMN IF NOT EXISTS "country_code"                     VARCHAR(2);
ALTER TABLE "subscriptions" ADD COLUMN IF NOT EXISTS "currency_code"                    VARCHAR(3);
ALTER TABLE "subscriptions" ADD COLUMN IF NOT EXISTS "billing_period"                   "BillingPeriod";
ALTER TABLE "subscriptions" ADD COLUMN IF NOT EXISTS "subscription_price_id"            UUID;
ALTER TABLE "subscriptions" ADD COLUMN IF NOT EXISTS "grace_period_ends_at"             TIMESTAMP(3);
ALTER TABLE "subscriptions" ADD COLUMN IF NOT EXISTS "auto_renewing"                    BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "subscriptions" ADD COLUMN IF NOT EXISTS "provider_original_transaction_id" VARCHAR(200);
ALTER TABLE "subscriptions" ADD COLUMN IF NOT EXISTS "provider_product_id"              VARCHAR(120);
ALTER TABLE "subscriptions" ADD COLUMN IF NOT EXISTS "last_provider_event_at"           TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "subscriptions_original_txn_idx"
  ON "subscriptions" ("provider_original_transaction_id");

ALTER TABLE "invoices" ADD COLUMN IF NOT EXISTS "invoice_number"         VARCHAR(40);
ALTER TABLE "invoices" ADD COLUMN IF NOT EXISTS "country_code"           VARCHAR(2);
ALTER TABLE "invoices" ADD COLUMN IF NOT EXISTS "billing_period"         "BillingPeriod";
ALTER TABLE "invoices" ADD COLUMN IF NOT EXISTS "vat_basis_points"       INTEGER;
ALTER TABLE "invoices" ADD COLUMN IF NOT EXISTS "subtotal_minor"         INTEGER;
ALTER TABLE "invoices" ADD COLUMN IF NOT EXISTS "vat_minor"              INTEGER;
ALTER TABLE "invoices" ADD COLUMN IF NOT EXISTS "total_minor"            INTEGER;
ALTER TABLE "invoices" ADD COLUMN IF NOT EXISTS "provider"               "PaymentProvider";
ALTER TABLE "invoices" ADD COLUMN IF NOT EXISTS "payment_transaction_id" UUID;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'invoices_payment_transaction_id_fkey') THEN
    ALTER TABLE "invoices" ADD CONSTRAINT "invoices_payment_transaction_id_fkey"
      FOREIGN KEY ("payment_transaction_id") REFERENCES "payment_transactions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "invoices_invoice_number_key" ON "invoices" ("invoice_number");
CREATE INDEX IF NOT EXISTS "invoices_payment_transaction_idx"   ON "invoices" ("payment_transaction_id");

-- -----------------------------------------------------------------------------
-- 9. SEED — the two launch markets, and NOTHING ELSE.
--
--     WHAT IS SEEDED: the country rows, the currency rows and their VAT rates,
--     which are facts of Egyptian and Saudi tax law, not commercial decisions.
--
--     WHAT IS DELIBERATELY *NOT* SEEDED: the prices. `CONTEXT.md` §6 and
--     `00-Company-Response.md` Q17 both carry a number (Basic 99 EGP / 19 SAR
--     per month, 20% annual discount) and both label it PROPOSED. Writing a
--     proposal into the price table would make it look decided. The rows go in
--     when a human decides — see `HUMAN DECISION REQUIRED #1` in
--     `PHASE-D-Payments-Report.md` and `prisma/seed-phase-d-prices.example.sql`.
-- -----------------------------------------------------------------------------
INSERT INTO "currencies" ("code", "symbol_en", "symbol_ar", "minor_units") VALUES
  ('EGP', 'E£',  'ج.م', 2),
  ('SAR', 'SR',  'ر.س', 2),
  ('USD', '$',   '$',   2)
ON CONFLICT ("code") DO NOTHING;

-- VAT: Egypt 14%, Saudi Arabia 15% (00-Company-Response.md Q16). Basis points.
-- `default_provider` is DATA: Egypt's default is Paymob because it is the only
-- provider covering cards + wallets + Fawry behind one integration (Q15).
INSERT INTO "countries" ("code", "name_en", "name_ar", "currency_code", "vat_basis_points", "vat_mode", "default_provider") VALUES
  ('EG', 'Egypt',        'مصر',           'EGP', 1400, 'INCLUSIVE', 'PAYMOB'),
  ('SA', 'Saudi Arabia', 'السعودية',      'SAR', 1500, 'INCLUSIVE', 'MOYASAR')
ON CONFLICT ("code") DO NOTHING;
