/**
 * DA-002 concurrency proof — a REAL integration test.
 *
 * A2-Data-Audit executed two scenarios against PostgreSQL 16 and measured:
 *   - 8 concurrent identical grant requests  -> 8 ledger rows, 400 XP
 *     (expected: 1 row, 50 XP)
 *   - 6 concurrent approvals of ONE 100-coin redemption against a 100-coin
 *     balance -> final balance −500, 6 REDEEM rows (expected: 0, 1)
 *
 * This suite re-runs both scenarios under real parallelism and asserts the
 * fixed behaviour. It does NOT reimplement the production logic: it imports
 * and executes the exact SQL statements the repository issues, from
 * src/.../repositories/rewards.sql.ts. If a `WHERE` clause or an
 * `ON CONFLICT` is ever dropped from production, these tests go red.
 *
 * Why node-postgres and not PrismaClient: the Prisma query engine binary
 * cannot be downloaded in this environment (binaries.prisma.sh answers 403),
 * so the client is generated with `--no-engine` and cannot open a real
 * connection. `pg` speaks to the same PostgreSQL server the repository would.
 *
 * Runs only when INTEGRATION_DATABASE_URL points at a database built from
 * prisma/migrations. Skipped (not silently passed) otherwise.
 */
import { Pool } from 'pg';

import {
  SQL_APPLY_ACCOUNT_DELTAS,
  SQL_BALANCE_FROM_LEDGER,
  SQL_CLAIM_REDEMPTION,
  SQL_DEDUCT_COINS_IF_SUFFICIENT,
  SQL_INSERT_EARN_LEDGER_ENTRY,
  SQL_INSERT_REDEEM_LEDGER_ENTRY,
  SQL_RECONCILE_ACCOUNT_FROM_LEDGER,
} from '../../src/modules/life-intelligence/infrastructure/repositories/rewards.sql';

const CONNECTION_STRING = process.env.INTEGRATION_DATABASE_URL;
const describeIfDb = CONNECTION_STRING ? describe : describe.skip;

describeIfDb('DA-002 — rewards idempotency and redemption concurrency (real PostgreSQL)', () => {
  let pool: Pool;
  let familyId: string;
  let childId: string;
  let userId: string;

  /** The production `applyEarn` transaction, statement for statement. */
  async function applyEarn(params: {
    childId: string;
    rewardType: 'XP' | 'COINS' | 'BADGE';
    amount: number;
    source: string;
    idempotencyKey: string;
    newLevel?: number | null;
  }): Promise<boolean> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const delta = params.rewardType === 'BADGE' ? 1 : params.amount;
      const inserted = await client.query(SQL_INSERT_EARN_LEDGER_ENTRY, [
        params.childId,
        params.rewardType,
        params.amount,
        delta,
        params.source,
        params.idempotencyKey,
        familyId,
        // B4: `$8` is `business_date` — the family's calendar day the grant
        // belongs to, which `maxPerDay` / `maxPerWeek` are counted against.
        // NULL here on purpose: this suite is about the UNIQUE CONSTRAINT under
        // concurrency, and the constraint is `(child_id, idempotency_key)` with
        // no date component. Passing NULL proves the insert still behaves
        // identically for a caller that has no cap to enforce.
        null,
      ]);
      if (inserted.rowCount === 0) {
        await client.query('COMMIT');
        return false;
      }
      await client.query(SQL_APPLY_ACCOUNT_DELTAS, [
        params.childId,
        params.rewardType === 'XP' ? delta : 0,
        params.rewardType === 'COINS' ? delta : 0,
        params.rewardType === 'BADGE' ? delta : 0,
        params.newLevel ?? null,
        familyId,
      ]);
      await client.query('COMMIT');
      return true;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /** The production `approveRedemption` transaction, statement for statement. */
  async function approveRedemption(params: {
    redemptionId: string;
    childId: string;
    costCoins: number;
    decidedByUserId: string;
  }): Promise<'APPROVED' | 'ALREADY_DECIDED' | 'INSUFFICIENT_COINS'> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const claimed = await client.query(SQL_CLAIM_REDEMPTION, [
        params.redemptionId,
        params.decidedByUserId,
        familyId,
      ]);
      if (claimed.rowCount === 0) {
        await client.query('ROLLBACK');
        return 'ALREADY_DECIDED';
      }
      const deducted = await client.query(SQL_DEDUCT_COINS_IF_SUFFICIENT, [
        params.childId,
        params.costCoins,
        familyId,
      ]);
      if (deducted.rowCount === 0) {
        await client.query('ROLLBACK');
        return 'INSUFFICIENT_COINS';
      }
      await client.query(SQL_INSERT_REDEEM_LEDGER_ENTRY, [
        params.childId,
        params.costCoins,
        params.redemptionId,
        familyId,
      ]);
      await client.query('COMMIT');
      return 'APPROVED';
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async function account(): Promise<{ xp: number; coins: number; stars: number }> {
    const { rows } = await pool.query(
      'SELECT xp, coins, stars FROM rewards_accounts WHERE child_id = $1',
      [childId],
    );
    return rows[0];
  }

  async function ledgerBalance(): Promise<Record<string, number>> {
    const { rows } = await pool.query(SQL_BALANCE_FROM_LEDGER, [childId, familyId]);
    return Object.fromEntries(rows.map((r) => [r.reward_type, Number(r.balance)]));
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: CONNECTION_STRING, max: 20 });
  });

  afterAll(async () => {
    await pool?.end();
  });

  beforeEach(async () => {
    // Fresh family/child/account per test — no shared state between the
    // concurrency scenarios.
    const fam = await pool.query(
      `INSERT INTO families (id, name, created_at, updated_at)
       VALUES (gen_random_uuid(), 'DA-002 Family', now(), now()) RETURNING id`,
    );
    familyId = fam.rows[0].id;

    const user = await pool.query(
      `INSERT INTO users (id, email, password_hash, full_name, status, created_at, updated_at)
       VALUES (gen_random_uuid(), 'da002-' || gen_random_uuid() || '@example.test', 'x', 'Parent', 'ACTIVE', now(), now())
       RETURNING id`,
    );
    userId = user.rows[0].id;

    const child = await pool.query(
      `INSERT INTO children (id, family_id, first_name, date_of_birth, created_at, updated_at)
       VALUES (gen_random_uuid(), $1, 'Kid', DATE '2016-01-01', now(), now()) RETURNING id`,
      [familyId],
    );
    childId = child.rows[0].id;

    await pool.query(
      `INSERT INTO rewards_accounts (id, family_id, child_id, xp, coins, stars, level, updated_at)
       VALUES (gen_random_uuid(), $2, $1, 0, 0, 0, 1, now())`,
      [childId, familyId],
    );
  });

  afterEach(async () => {
    await pool.query('DELETE FROM families WHERE id = $1', [familyId]);
    await pool.query('DELETE FROM users WHERE id = $1', [userId]);
  });

  describe('grant idempotency under real concurrency', () => {
    it('8 concurrent identical grants produce EXACTLY ONE reward (A2 measured 8)', async () => {
      const key = 'habit-completion:habit-1:2026-08-14:XP:habit_streak';

      const results = await Promise.all(
        Array.from({ length: 8 }, () =>
          applyEarn({
            childId,
            rewardType: 'XP',
            amount: 50,
            source: 'habit_streak',
            idempotencyKey: key,
          }),
        ),
      );

      expect(results.filter(Boolean)).toHaveLength(1);

      const { rows } = await pool.query(
        'SELECT count(*)::int AS n FROM rewards_ledger_entries WHERE child_id = $1',
        [childId],
      );
      expect(rows[0].n).toBe(1);
      expect((await account()).xp).toBe(50);
      expect((await ledgerBalance()).XP).toBe(50);
    });

    it('8 concurrent grants with DISTINCT keys all land (the constraint is not over-blocking)', async () => {
      const results = await Promise.all(
        Array.from({ length: 8 }, (_, i) =>
          applyEarn({
            childId,
            rewardType: 'XP',
            amount: 50,
            source: 'habit_streak',
            idempotencyKey: `distinct-key-${i}`,
          }),
        ),
      );

      expect(results.filter(Boolean)).toHaveLength(8);
      expect((await account()).xp).toBe(400);
      expect((await ledgerBalance()).XP).toBe(400);
    });

    it('the unique index really is (child_id, idempotency_key), so two children may share a key', async () => {
      const sibling = await pool.query(
        `INSERT INTO children (id, family_id, first_name, date_of_birth, created_at, updated_at)
         VALUES (gen_random_uuid(), $1, 'Sibling', DATE '2018-01-01', now(), now()) RETURNING id`,
        [familyId],
      );
      const siblingId = sibling.rows[0].id;
      await pool.query(
        `INSERT INTO rewards_accounts (id, family_id, child_id, xp, coins, stars, level, updated_at)
         VALUES (gen_random_uuid(), $2, $1, 0, 0, 0, 1, now())`,
        [siblingId, familyId],
      );

      const key = 'shared-family-event-key';
      const a = await applyEarn({ childId, rewardType: 'XP', amount: 10, source: 's', idempotencyKey: key });
      const b = await applyEarn({ childId: siblingId, rewardType: 'XP', amount: 10, source: 's', idempotencyKey: key });

      expect(a).toBe(true);
      expect(b).toBe(true);
    });
  });

  describe('redemption concurrency', () => {
    async function seedRedemption(costCoins: number, startingCoins: number): Promise<string> {
      await pool.query('UPDATE rewards_accounts SET coins = $2 WHERE child_id = $1', [
        childId,
        startingCoins,
      ]);
      const item = await pool.query(
        `INSERT INTO reward_catalog_items (id, family_id, title, cost_coins, created_by_user_id, is_active, created_at)
         VALUES (gen_random_uuid(), $1, 'Ice cream', $2, $3, true, now()) RETURNING id`,
        [familyId, costCoins, userId],
      );
      const redemption = await pool.query(
        `INSERT INTO reward_redemptions (id, family_id, child_id, reward_catalog_item_id, status, requested_at)
         VALUES (gen_random_uuid(), $3, $1, $2, 'REQUESTED', now()) RETURNING id`,
        [childId, item.rows[0].id, familyId],
      );
      return redemption.rows[0].id;
    }

    it('6 concurrent approvals of ONE redemption: one wins, balance never goes negative (A2 measured −500)', async () => {
      const redemptionId = await seedRedemption(100, 100);

      const outcomes = await Promise.all(
        Array.from({ length: 6 }, () =>
          approveRedemption({ redemptionId, childId, costCoins: 100, decidedByUserId: userId }),
        ),
      );

      expect(outcomes.filter((o) => o === 'APPROVED')).toHaveLength(1);
      expect(outcomes.filter((o) => o === 'ALREADY_DECIDED')).toHaveLength(5);

      const { coins } = await account();
      expect(coins).toBe(0);
      expect(coins).toBeGreaterThanOrEqual(0);

      const redeemRows = await pool.query(
        `SELECT count(*)::int AS n FROM rewards_ledger_entries
          WHERE child_id = $1 AND type = 'REDEEM'`,
        [childId],
      );
      expect(redeemRows.rows[0].n).toBe(1);

      const status = await pool.query('SELECT status FROM reward_redemptions WHERE id = $1', [
        redemptionId,
      ]);
      expect(status.rows[0].status).toBe('APPROVED');
    });

    it('12 concurrent approvals across 12 DISTINCT redemptions stop at the available balance', async () => {
      // 250 coins, 12 redemptions costing 100 each -> at most 2 can succeed
      // and the balance must land on 50, never below zero.
      await pool.query('UPDATE rewards_accounts SET coins = 250 WHERE child_id = $1', [childId]);
      const item = await pool.query(
        `INSERT INTO reward_catalog_items (id, family_id, title, cost_coins, created_by_user_id, is_active, created_at)
         VALUES (gen_random_uuid(), $1, 'Toy', 100, $2, true, now()) RETURNING id`,
        [familyId, userId],
      );
      const redemptionIds: string[] = [];
      for (let i = 0; i < 12; i++) {
        const r = await pool.query(
          `INSERT INTO reward_redemptions (id, family_id, child_id, reward_catalog_item_id, status, requested_at)
           VALUES (gen_random_uuid(), $3, $1, $2, 'REQUESTED', now()) RETURNING id`,
          [childId, item.rows[0].id, familyId],
        );
        redemptionIds.push(r.rows[0].id);
      }

      const outcomes = await Promise.all(
        redemptionIds.map((redemptionId) =>
          approveRedemption({ redemptionId, childId, costCoins: 100, decidedByUserId: userId }),
        ),
      );

      expect(outcomes.filter((o) => o === 'APPROVED')).toHaveLength(2);
      expect(outcomes.filter((o) => o === 'INSUFFICIENT_COINS')).toHaveLength(10);

      const { coins } = await account();
      expect(coins).toBe(50);
      expect(coins).toBeGreaterThanOrEqual(0);
    });

    it('an unaffordable redemption leaves BOTH the balance and the status untouched', async () => {
      const redemptionId = await seedRedemption(100, 50);

      const outcome = await approveRedemption({
        redemptionId,
        childId,
        costCoins: 100,
        decidedByUserId: userId,
      });

      expect(outcome).toBe('INSUFFICIENT_COINS');
      expect((await account()).coins).toBe(50);
      const status = await pool.query('SELECT status FROM reward_redemptions WHERE id = $1', [
        redemptionId,
      ]);
      expect(status.rows[0].status).toBe('REQUESTED');
    });
  });

  describe('the ledger is a ledger again (DP-5)', () => {
    it('SUM(delta) reconstructs the balance after mixed EARN and REDEEM traffic', async () => {
      await applyEarn({ childId, rewardType: 'COINS', amount: 300, source: 'grant', idempotencyKey: 'k1' });
      await applyEarn({ childId, rewardType: 'COINS', amount: 300, source: 'grant', idempotencyKey: 'k2' });

      const item = await pool.query(
        `INSERT INTO reward_catalog_items (id, family_id, title, cost_coins, created_by_user_id, is_active, created_at)
         VALUES (gen_random_uuid(), $1, 'Book', 100, $2, true, now()) RETURNING id`,
        [familyId, userId],
      );
      const redemption = await pool.query(
        `INSERT INTO reward_redemptions (id, family_id, child_id, reward_catalog_item_id, status, requested_at)
         VALUES (gen_random_uuid(), $3, $1, $2, 'REQUESTED', now()) RETURNING id`,
        [childId, item.rows[0].id, familyId],
      );
      await approveRedemption({
        redemptionId: redemption.rows[0].id,
        childId,
        costCoins: 100,
        decidedByUserId: userId,
      });

      const { coins } = await account();
      expect(coins).toBe(500);
      // The A2 failure mode: SUM(amount) counts EARN and REDEEM in the
      // same direction and cannot equal the balance.
      const sumAmount = await pool.query(
        `SELECT COALESCE(SUM(amount),0)::int AS s FROM rewards_ledger_entries
          WHERE child_id = $1 AND reward_type = 'COINS'`,
        [childId],
      );
      expect(sumAmount.rows[0].s).toBe(700);
      // SUM(delta) does.
      expect((await ledgerBalance()).COINS).toBe(500);
    });

    it('reconciles a drifted account column back to the ledger', async () => {
      await applyEarn({ childId, rewardType: 'COINS', amount: 120, source: 'grant', idempotencyKey: 'r1' });
      // Simulate drift the way it happens in production: something wrote
      // the cached column without a ledger row.
      await pool.query('UPDATE rewards_accounts SET coins = 999 WHERE child_id = $1', [childId]);
      expect((await account()).coins).toBe(999);

      await pool.query(SQL_RECONCILE_ACCOUNT_FROM_LEDGER, [childId, familyId]);

      expect((await account()).coins).toBe(120);
      expect((await ledgerBalance()).COINS).toBe(120);
    });
  });

  describe('database-level backstop (migration 0002)', () => {
    it('refuses a direct UPDATE that would make a balance negative', async () => {
      await expect(
        pool.query('UPDATE rewards_accounts SET coins = -1 WHERE child_id = $1', [childId]),
      ).rejects.toThrow(/rewards_accounts_coins_non_negative/);
    });

    it('refuses a ledger row whose delta contradicts its type', async () => {
      await expect(
        pool.query(
          `INSERT INTO rewards_ledger_entries
             (id, family_id, child_id, type, reward_type, amount, delta, source, idempotency_key, created_at)
           VALUES (gen_random_uuid(), $2, $1, 'EARN', 'COINS', 10, -10, 'bogus', 'bogus-key', now())`,
          [childId, familyId],
        ),
      ).rejects.toThrow(/rewards_ledger_entries_delta_matches_type/);
    });
  });
});
