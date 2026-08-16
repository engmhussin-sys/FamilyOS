-- =============================================================================
-- 0013_payment_enum_extensions — PHASE D, part 1 of 2.
--
-- WHY THIS IS ITS OWN MIGRATION, AND NOT THE TOP OF 0014.
--
-- PostgreSQL permits `ALTER TYPE ... ADD VALUE` inside a transaction block
-- since v12, but it does NOT permit the newly added value to be *used* in the
-- same transaction — the attempt fails with «unsafe use of new value ... of
-- enum type». `prisma migrate deploy` runs each migration file in one
-- transaction, and 0014 both adds `'MOYASAR'` to `PaymentProvider` and INSERTs
-- a `countries` row whose `default_provider` IS `'MOYASAR'`.
--
-- Keeping the five ADD VALUE statements in their own file is what makes 0014
-- applicable by `prisma migrate deploy` and not merely by psql. This is not
-- tidiness; putting them together produces a migration that passes by hand and
-- fails in CI.
--
-- ADD VALUE, NEVER RENAME. `SubscriptionStatus.TRIALING` and `.CANCELED` keep
-- their existing US spellings. The brief's `TRIAL` / `CANCELLED` vocabulary is
-- owned by `src/modules/billing/domain/subscription-status.ts`, which holds the
-- one bidirectional mapping and is proven total in both directions by test.
-- Renaming an enum value that every existing row depends on would break a live
-- deployment mid-rollout and buy nothing.
--
-- SAFE TO RE-RUN: every statement is `ADD VALUE IF NOT EXISTS`.
-- =============================================================================

-- CONTEXT.md §6 names four consumer tiers: Free / Basic / Premium / Family.
-- `BASIC` was the missing one.
ALTER TYPE "SubscriptionPlan" ADD VALUE IF NOT EXISTS 'BASIC';

-- The three lifecycle states the brief names that this database could not
-- represent. PENDING is the state Fawry makes unavoidable (a payment reference
-- the customer may settle days later); GRACE_PERIOD is Q17's 7-day
-- non-punitive window; REFUNDED is terminal and, unlike CANCELED, revokes
-- entitlement immediately because money went back.
ALTER TYPE "SubscriptionStatus" ADD VALUE IF NOT EXISTS 'PENDING';
ALTER TYPE "SubscriptionStatus" ADD VALUE IF NOT EXISTS 'GRACE_PERIOD';
ALTER TYPE "SubscriptionStatus" ADD VALUE IF NOT EXISTS 'REFUNDED';

-- The Saudi card/mada-capable gateway. CONTEXT.md §2 names Moyasar or Tap and
-- 00-Company-Response.md Q16 leaves the final pick to two commercial offers;
-- the adapter is written against the interface either way. See
-- HUMAN DECISION REQUIRED #4 in PHASE-D-Payments-Report.md.
ALTER TYPE "PaymentProvider" ADD VALUE IF NOT EXISTS 'MOYASAR';
