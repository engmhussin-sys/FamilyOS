/**
 * DA-002. The reward-integrity guarantees this project depends on are
 * *database* guarantees, not application guarantees:
 *
 *   - exactly one grant per idempotency key  -> `ON CONFLICT DO NOTHING`
 *     on `rewards_ledger_entries (child_id, idempotency_key)`
 *   - a balance that can never go negative   -> a conditional UPDATE with
 *     `WHERE coins >= $cost`, which is atomic under any concurrency
 *   - one approval per redemption            -> a conditional UPDATE with
 *     `WHERE status = 'REQUESTED'`, which is the same trick applied to a
 *     state machine instead of a number
 *
 * A2 proved all three were missing by execution: 8 concurrent identical
 * grants produced 8 rewards, and 6 concurrent approvals of ONE redemption
 * costing 100 coins drove a 100-coin balance to −500.
 *
 * The statements live here, as exported constants, for one reason: the
 * integration tests in `test/database/rewards-concurrency.integration.spec.ts`
 * execute *these exact strings* against a real PostgreSQL 16 server under
 * real parallelism. If the production statement loses its `WHERE` clause,
 * the concurrency test that proves the property fails — the test cannot
 * drift away from the code it is meant to protect.
 *
 * `$N` placeholders are PostgreSQL positional parameters, passed through
 * both Prisma's `$executeRawUnsafe` and node-postgres unchanged.
 */

/**
 * Ledger-first insert. If the key was already used for this child the
 * insert is a no-op (`rowCount === 0`) and the caller MUST NOT touch the
 * balance — that ordering is what makes the whole grant idempotent.
 *
 * $1 childId · $2 rewardType · $3 amount (unsigned) · $4 delta (signed)
 * $5 source · $6 idempotencyKey · $7 familyId
 *
 * F2: `family_id` is written here explicitly. Raw SQL is NOT intercepted by the
 * tenant extension, so a statement that omitted it would be the one write path
 * in the codebase with no tenant at all — and after migration 0003 the column
 * is NOT NULL, so it would simply fail. The value comes from the ambient tenant
 * context, never from a caller argument that a client could influence.
 */
export const SQL_INSERT_EARN_LEDGER_ENTRY = `
INSERT INTO "rewards_ledger_entries"
  ("id", "family_id", "child_id", "type", "reward_type", "amount", "delta", "source", "idempotency_key", "created_at")
VALUES
  (gen_random_uuid(), $7::uuid, $1::uuid, 'EARN', $2::"RewardType", $3::int, $4::int, $5::text, $6::text, now())
ON CONFLICT ("child_id", "idempotency_key") DO NOTHING`;

/**
 * Applied only after the ledger insert actually created a row.
 *
 * $1 childId · $2 xpDelta · $3 coinsDelta · $4 starsDelta · $5 newLevel
 * (nullable — `NULL` leaves the level untouched) · $6 familyId
 */
export const SQL_APPLY_ACCOUNT_DELTAS = `
UPDATE "rewards_accounts"
   SET "xp"    = "xp"    + $2::int,
       "coins" = "coins" + $3::int,
       "stars" = "stars" + $4::int,
       "level" = COALESCE($5::int, "level"),
       "updated_at" = now()
 WHERE "child_id" = $1::uuid AND "family_id" = $6::uuid`;

/**
 * Claims the redemption. `WHERE status = 'REQUESTED'` makes this the
 * single serialization point for concurrent approvals: PostgreSQL lets
 * exactly one transaction win the row, every other one sees
 * `rowCount === 0` and aborts. This replaces the check-then-act in
 * `RewardsEngineService.approveRedemption`, which two concurrent callers
 * could both pass.
 *
 * $1 redemptionId · $2 decidedByUserId · $3 familyId
 */
export const SQL_CLAIM_REDEMPTION = `
UPDATE "reward_redemptions"
   SET "status" = 'APPROVED', "decided_at" = now(), "decided_by_user_id" = $2::uuid
 WHERE "id" = $1::uuid AND "status" = 'REQUESTED' AND "family_id" = $3::uuid`;

/**
 * The negative-balance guard. `WHERE coins >= $2` is evaluated under the
 * row lock the UPDATE itself takes, so it cannot be raced. `rowCount === 0`
 * means insufficient funds and the caller rolls the transaction back.
 *
 * $1 childId · $2 costCoins · $3 familyId
 */
export const SQL_DEDUCT_COINS_IF_SUFFICIENT = `
UPDATE "rewards_accounts"
   SET "coins" = "coins" - $2::int, "updated_at" = now()
 WHERE "child_id" = $1::uuid AND "coins" >= $2::int AND "family_id" = $3::uuid`;

/**
 * The REDEEM side of the ledger. Its idempotency key is derived from the
 * redemption id, so the database itself caps a redemption at one REDEEM
 * row no matter how the call is retried.
 *
 * $1 childId · $2 costCoins · $3 redemptionId · $4 familyId
 */
export const SQL_INSERT_REDEEM_LEDGER_ENTRY = `
INSERT INTO "rewards_ledger_entries"
  ("id", "family_id", "child_id", "type", "reward_type", "amount", "delta", "source", "idempotency_key", "created_at")
VALUES
  (gen_random_uuid(), $4::uuid, $1::uuid, 'REDEEM', 'COINS', $2::int, -$2::int, 'redemption:' || $3::text, 'redemption:' || $3::text, now())
ON CONFLICT ("child_id", "idempotency_key") DO NOTHING`;

/**
 * DP-5: the balance recomputed from the ledger alone. `SUM(delta)` is
 * meaningful precisely because `delta` is signed; `SUM(amount)` never was.
 *
 * $1 childId · $2 familyId
 */
export const SQL_BALANCE_FROM_LEDGER = `
SELECT "reward_type" AS reward_type, COALESCE(SUM("delta"), 0)::int AS balance
  FROM "rewards_ledger_entries"
 WHERE "child_id" = $1::uuid AND "family_id" = $2::uuid
 GROUP BY "reward_type"`;

/** Reconciles the cached account columns to the ledger. $1 childId · $2 familyId */
export const SQL_RECONCILE_ACCOUNT_FROM_LEDGER = `
UPDATE "rewards_accounts" a
   SET "xp"    = COALESCE(l.xp, 0),
       "coins" = COALESCE(l.coins, 0),
       "stars" = COALESCE(l.stars, 0),
       "updated_at" = now()
  FROM (
    SELECT
      SUM("delta") FILTER (WHERE "reward_type" = 'XP')    AS xp,
      SUM("delta") FILTER (WHERE "reward_type" = 'COINS') AS coins,
      SUM("delta") FILTER (WHERE "reward_type" = 'BADGE') AS stars
    FROM "rewards_ledger_entries"
    WHERE "child_id" = $1::uuid AND "family_id" = $2::uuid
  ) l
 WHERE a."child_id" = $1::uuid AND a."family_id" = $2::uuid`;
