-- ============================================================================
-- FAMILY COUNTRY — the column every commercial question already assumed.
--
-- WHAT WAS BROKEN. `Family` carried `timezone` and nothing else about where the
-- household is. Meanwhile `subscription_prices`, `payment_transactions`,
-- `growth_daily_metrics`, `growth_quarterly_targets`, `marketing_campaigns` and
-- `pilot_invitations` are ALL keyed by `country_code`, and `countries` holds the
-- currency, the VAT rate and the default payment provider per market. So the
-- product could price, tax and report by country while being unable to say which
-- country a given family was in. The parent app collected a country on the
-- family-setup screen and threw it away, because `UpdateSettingsDto` had nowhere
-- to put it and `forbidNonWhitelisted: true` turned sending it into a 400.
--
-- A REAL FOREIGN KEY, NOT A CHECK CONSTRAINT AND NOT AN ENUM.
-- «لا تسمح للـ client بفرض قيم غير مدعومة» is enforced here, at the database,
-- for the same reason this codebase enforces idempotency with unique indexes
-- rather than with `if` statements: a constraint cannot be forgotten by a new
-- code path. `countries` is already the launch-market catalogue (EG and SA seeded
-- in 0014) and adding a market is an INSERT — an enum would have required a
-- migration and a redeploy to sell in a third country, which is exactly the
-- coupling `countries` was created to avoid.
--
-- ON DELETE RESTRICT, deliberately. A country row that families point at must
-- not be deletable; de-listing a market is `is_active = false`, which is what
-- that column is for. Cascading would delete households, and SET NULL would
-- silently un-country live paying families.
--
-- WHY NULLABLE, WHICH IS THE ONE HONEST ANSWER HERE. Existing families predate
-- this column and there is NO true value to backfill them with. Defaulting them
-- to 'EG' or 'SA' would invent market data that the growth dashboard then reports
-- as fact — and this dashboard's whole discipline is that an unmeasurable metric
-- renders NOT MEASURED rather than 0. Nullable is also consistent with every
-- other `country_code` in the analytics schema, which is nullable for the same
-- reason. New families get it at creation; old rows stay honestly unknown.
-- ============================================================================

ALTER TABLE "families"
  ADD COLUMN "country_code" VARCHAR(2);

ALTER TABLE "families"
  ADD CONSTRAINT "families_country_code_fkey"
  FOREIGN KEY ("country_code") REFERENCES "countries"("code")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- The access path for every per-country aggregation: "families in SA", "families
-- in EG created this quarter". Partial, because a NULL country is never the thing
-- being counted — the analytics queries all filter on a concrete code, and a
-- partial index keeps the pre-existing rows out of it entirely.
CREATE INDEX "families_country_code_idx"
  ON "families" ("country_code")
  WHERE "country_code" IS NOT NULL;
