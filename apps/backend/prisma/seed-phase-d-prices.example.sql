-- =============================================================================
-- PHASE D — THE PRICE LIST. AN EXAMPLE, NOT A MIGRATION.
--
-- ============================ WHY THIS IS NOT SEEDED ============================
--
-- Migration 0014 seeds the COUNTRIES and their VAT rates, because 14% in Egypt
-- and 15% in Saudi Arabia are facts of tax law. It seeds NO PRICES, because a
-- price is a commercial decision and this repository is not the party that
-- makes it.
--
-- `CONTEXT.md` §6 and `00-Company-Response.md` Q17 both carry a number — Basic
-- 99 EGP / 19 SAR per month, Premium 179 / 34, Family 249 / 49, 20% off
-- annually — and both label it PROPOSED. Writing a proposal into the price
-- table would make it look decided, and the first person to read
-- `subscription_prices` after that would reasonably assume someone had signed
-- it off.
--
-- So the numbers live HERE, in a file with `.example` in its name, that no
-- migration runner will ever pick up. When a human decides, they copy this
-- file, change the numbers, and run it.
--
-- ==================== HUMAN DECISION REQUIRED #1 — READ THIS ====================
--
-- FIVE things must be settled before these rows are real, and none of them is
-- an engineering question:
--
--   1. THE ACTUAL PRICES. The numbers below are the brief's proposals.
--   2. STORE BILLING vs DIRECT CHECKOUT. Google Play Billing takes 15-30% and
--      supports NEITHER Fawry NOR mobile wallets — which between them are the
--      default payment channel for a large part of the Egyptian market. Web
--      checkout keeps the margin and supports both, but the app may not steer
--      users to it in a way that violates Play policy. The `store_product_id`
--      column is NULL for a direct-checkout-only price and set for a
--      store-sold one, so the schema supports either or both — but the
--      commercial answer changes the prices themselves, because 30% of 99 EGP
--      is not a rounding error. Q15 puts this decision before Sprint 12 and
--      estimates the annual difference in the hundreds of thousands of dollars.
--   3. THE ANNUAL DISCOUNT. 20% is proposed. In Egypt the annual plan is
--      structurally preferable — Q15 is explicit that reliable auto-renewal
--      does not exist there, so an annual plan reduces renewals from twelve to
--      one — which may justify a deeper discount than Saudi Arabia's.
--   4. VAT-INCLUSIVE vs VAT-EXCLUSIVE DISPLAY. Every row below is INCLUSIVE,
--      which is the consumer norm in both markets. If finance wants exclusive
--      display, change `vat_mode` — the arithmetic already supports both and
--      is tested for both.
--   5. THE STORE PRODUCT IDENTIFIERS. The `store_product_id` values below are
--      PLACEHOLDERS. They must match the product identifiers actually created
--      in App Store Connect and the base plan ids created in Play Console; a
--      purchase whose product is not in this table grants NOTHING, on purpose.
--
-- ============================== HOW TO APPLY ==============================
--
--   psql "$DATABASE_URL" -f prisma/seed-phase-d-prices.example.sql
--
-- Safe to re-run: ON CONFLICT DO UPDATE. Changing a price here does NOT
-- re-price live subscriptions — each one records the `subscription_price_id` it
-- was sold at, deliberately, so a price change applies to new sales only.
-- =============================================================================

INSERT INTO "subscription_prices"
  ("plan_tier", "country_code", "currency_code", "billing_period", "amount_minor", "vat_mode", "store_product_id")
VALUES
  -- ---- EGYPT (EGP, VAT 14% inclusive) ----
  ('BASIC',   'EG', 'EGP', 'MONTHLY',   9900, 'INCLUSIVE', 'com.abny.basic.monthly.eg'),
  ('PREMIUM', 'EG', 'EGP', 'MONTHLY',  17900, 'INCLUSIVE', 'com.abny.premium.monthly.eg'),
  ('FAMILY',  'EG', 'EGP', 'MONTHLY',  24900, 'INCLUSIVE', 'com.abny.family.monthly.eg'),
  -- Annual at the proposed 20% discount: monthly x 12 x 0.8.
  ('BASIC',   'EG', 'EGP', 'ANNUAL',    95040, 'INCLUSIVE', 'com.abny.basic.annual.eg'),
  ('PREMIUM', 'EG', 'EGP', 'ANNUAL',   171840, 'INCLUSIVE', 'com.abny.premium.annual.eg'),
  ('FAMILY',  'EG', 'EGP', 'ANNUAL',   239040, 'INCLUSIVE', 'com.abny.family.annual.eg'),

  -- ---- SAUDI ARABIA (SAR, VAT 15% inclusive) ----
  ('BASIC',   'SA', 'SAR', 'MONTHLY',   1900, 'INCLUSIVE', 'com.abny.basic.monthly.sa'),
  ('PREMIUM', 'SA', 'SAR', 'MONTHLY',   3400, 'INCLUSIVE', 'com.abny.premium.monthly.sa'),
  ('FAMILY',  'SA', 'SAR', 'MONTHLY',   4900, 'INCLUSIVE', 'com.abny.family.monthly.sa'),
  ('BASIC',   'SA', 'SAR', 'ANNUAL',   18240, 'INCLUSIVE', 'com.abny.basic.annual.sa'),
  ('PREMIUM', 'SA', 'SAR', 'ANNUAL',   32640, 'INCLUSIVE', 'com.abny.premium.annual.sa'),
  ('FAMILY',  'SA', 'SAR', 'ANNUAL',   47040, 'INCLUSIVE', 'com.abny.family.annual.sa'),

  -- ---- FREE, in both markets ----
  -- A row with amount 0 exists so that `resolvePrice('FREE', ...)` answers
  -- rather than throwing. There is no store product: nobody buys Free.
  ('FREE',    'EG', 'EGP', 'MONTHLY',       0, 'INCLUSIVE', NULL),
  ('FREE',    'SA', 'SAR', 'MONTHLY',       0, 'INCLUSIVE', NULL)

ON CONFLICT ("plan_tier", "country_code", "billing_period") DO UPDATE SET
  "amount_minor"     = EXCLUDED."amount_minor",
  "currency_code"    = EXCLUDED."currency_code",
  "vat_mode"         = EXCLUDED."vat_mode",
  "store_product_id" = EXCLUDED."store_product_id",
  "is_active"        = true,
  "updated_at"       = now();
