-- 0002_rewards_integrity_constraints — DA-002 defense in depth.
--
-- CHECK constraints cannot be expressed in the Prisma schema language, so
-- they live in a hand-written migration (Prisma's own documented pattern
-- for unsupported database features). They are NOT the primary control:
-- the primary control is the conditional UPDATE in
-- src/modules/life-intelligence/infrastructure/repositories/rewards.sql.ts
-- (`WHERE coins >= $cost`), which is what the concurrency tests exercise.
-- These constraints exist so that ANY future writer — a migration script,
-- a manual psql session, a new repository method that forgets the WHERE —
-- is stopped by the database instead of quietly producing the −500 balance
-- A2 §7.5 measured.
--
-- KNOWN TRADE-OFF, stated rather than hidden: `prisma migrate dev` derives
-- its diff from schema.prisma, which cannot describe these constraints, so
-- a future `migrate dev` will propose dropping them. Re-apply this file (or
-- keep it as the last migration) if that happens.

-- A rewards balance is a count of things earned. None of them can be
-- negative, ever.
ALTER TABLE "rewards_accounts"
  ADD CONSTRAINT "rewards_accounts_coins_non_negative" CHECK ("coins" >= 0),
  ADD CONSTRAINT "rewards_accounts_xp_non_negative" CHECK ("xp" >= 0),
  ADD CONSTRAINT "rewards_accounts_stars_non_negative" CHECK ("stars" >= 0),
  ADD CONSTRAINT "rewards_accounts_level_positive" CHECK ("level" >= 1);

-- The ledger's signed `delta` must agree with the unsigned `amount` plus
-- the direction in `type`. This is what makes `SUM(delta)` trustworthy as
-- the reconstructed balance (DP-5): a row can no longer claim EARN while
-- carrying a negative delta.
ALTER TABLE "rewards_ledger_entries"
  ADD CONSTRAINT "rewards_ledger_entries_delta_matches_type" CHECK (
    ("type" = 'EARN'   AND "delta" > 0) OR
    ("type" = 'REDEEM' AND "delta" < 0)
  ),
  ADD CONSTRAINT "rewards_ledger_entries_amount_positive" CHECK ("amount" > 0);
