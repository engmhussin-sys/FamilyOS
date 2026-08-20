/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * B4 — MIGRATION 0007's CONSTRAINTS ARE REAL, AND THEY STAY REAL.
 *
 * PA-B-034 named the risk precisely: migration 0002 put six CHECK constraints
 * on `rewards_ledger_entries` that `schema.prisma` does not describe, so the
 * first future `prisma migrate dev` will offer to DROP them, silently, and the
 * safety net under every grant disappears without anyone noticing. Migration
 * 0007 adds three more CHECKs and one expression index that Prisma likewise
 * cannot express.
 *
 * This suite is the answer that finding asked for: it queries `pg_constraint`
 * and `pg_indexes` on the REAL database and fails if any of them is missing. A
 * constraint nobody checks for is a constraint that will eventually not be
 * there.
 *
 * It also EXECUTES each one, because "the row exists in the catalogue" and "the
 * database actually refuses the bad write" are different claims.
 */
import { Pool } from 'pg';

const CONNECTION_STRING = process.env.INTEGRATION_DATABASE_URL;
const describeIfDb = CONNECTION_STRING ? describe : describe.skip;

describeIfDb('B4 — reward_rules integrity constraints (real PostgreSQL)', () => {
  let pool: Pool;
  let familyId: string;
  let userId: string;

  beforeAll(async () => {
    pool = new Pool({ connectionString: CONNECTION_STRING });

    const stamp = Date.now();
    const family = await pool.query(
      `INSERT INTO "families" ("id", "name", "timezone", "created_at", "updated_at")
       VALUES (gen_random_uuid(), $1, 'UTC', now(), now()) RETURNING "id"`,
      [`B4 constraints ${stamp}`],
    );
    familyId = family.rows[0].id;

    const user = await pool.query(
      `INSERT INTO "users" ("id", "email", "password_hash", "full_name", "created_at", "updated_at")
       VALUES (gen_random_uuid(), $1, 'x', 'B4 Constraints', now(), now()) RETURNING "id"`,
      [`b4.constraints.${stamp}@example.com`],
    );
    userId = user.rows[0].id;
  });

  afterAll(async () => {
    if (pool) {
      await pool.query('DELETE FROM "reward_rules" WHERE "family_id" = $1', [familyId]);
      await pool.query('DELETE FROM "families" WHERE "id" = $1', [familyId]);
      await pool.query('DELETE FROM "users" WHERE "id" = $1', [userId]);
      await pool.end();
    }
  });

  const insert = (overrides: Record<string, unknown> = {}) => {
    const row = {
      event_type: 'HABIT_COMPLETED',
      trigger_engine: 'habit-builder',
      trigger_condition: '{}',
      reward_type: 'XP',
      amount: '10',
      max_per_day: null,
      max_per_week: null,
      min_verified_by: null,
      category: null,
      ...overrides,
    } as any;
    return pool.query(
      `INSERT INTO "reward_rules"
         ("id", "family_id", "trigger_engine", "event_type", "trigger_condition", "reward_type",
          "reward_amount_or_badge_id", "is_active", "max_per_day", "max_per_week", "min_verified_by",
          "category", "created_by_user_id", "created_at", "updated_at")
       VALUES (gen_random_uuid(), $1, $2, $3, $4::jsonb, $5::"RewardType", $6, true, $7, $8, $9, $10, $11, now(), now())
       RETURNING "id"`,
      [
        familyId,
        row.trigger_engine,
        row.event_type,
        row.trigger_condition,
        row.reward_type,
        row.amount,
        row.max_per_day,
        row.max_per_week,
        row.min_verified_by,
        row.category,
        userId,
      ],
    );
  };

  describe('the constraints EXIST in the catalogue', () => {
    it('all three CHECK constraints from 0007 are present', async () => {
      const res = await pool.query(
        `SELECT conname FROM pg_constraint WHERE conname = ANY($1::text[])`,
        [[
          'reward_rules_max_per_day_positive',
          'reward_rules_max_per_week_positive',
          'reward_rules_min_verified_by_known',
        ]],
      );
      expect(res.rows.map((r: any) => r.conname).sort()).toEqual([
        'reward_rules_max_per_day_positive',
        'reward_rules_max_per_week_positive',
        'reward_rules_min_verified_by_known',
      ]);
    });

    it('the category foreign key points at the reference TABLE, not an enum', async () => {
      const res = await pool.query(
        `SELECT confrelid::regclass::text AS target, confdeltype
           FROM pg_constraint WHERE conname = 'reward_rules_category_fkey'`,
      );
      expect(res.rows).toHaveLength(1);
      expect(res.rows[0].target).toBe('reward_program_categories');
      // 'r' = RESTRICT: a catalogue row a family is actively using cannot be
      // deleted out from under it.
      expect(res.rows[0].confdeltype).toBe('r');
    });

    it('the scope unique index exists, is partial, and hashes the trigger condition', async () => {
      const res = await pool.query(
        `SELECT indexdef FROM pg_indexes WHERE indexname = 'reward_rules_active_scope_uniq'`,
      );
      expect(res.rows).toHaveLength(1);
      const def: string = res.rows[0].indexdef;
      expect(def).toContain('UNIQUE');
      // COALESCE on family_id: without it every NULL is distinct and the
      // PLATFORM tier would be unconstrained — the vacuous-index trap A2 §7.3
      // measured on `idempotency_key`.
      expect(def).toContain('COALESCE');
      expect(def).toContain('md5');
      expect(def).toContain('WHERE');
    });

    it('rewards_ledger_entries carries the business_date column and its cap index', async () => {
      const col = await pool.query(
        `SELECT data_type, is_nullable FROM information_schema.columns
          WHERE table_name = 'rewards_ledger_entries' AND column_name = 'business_date'`,
      );
      expect(col.rows).toHaveLength(1);
      expect(col.rows[0].data_type).toBe('date');
      // NULLABLE on purpose: rows written before B4 have no business date and
      // must not be invented one.
      expect(col.rows[0].is_nullable).toBe('YES');

      const idx = await pool.query(
        `SELECT indexdef FROM pg_indexes WHERE indexname = 'rewards_ledger_entries_cap_idx'`,
      );
      expect(idx.rows).toHaveLength(1);
    });
  });

  describe('the constraints are ENFORCED, not merely declared', () => {
    afterEach(async () => {
      await pool.query('DELETE FROM "reward_rules" WHERE "family_id" = $1', [familyId]);
    });

    it('rejects maxPerDay = 0 and maxPerWeek = 0', async () => {
      await expect(insert({ max_per_day: 0 })).rejects.toThrow(/reward_rules_max_per_day_positive/);
      await expect(insert({ max_per_week: 0 })).rejects.toThrow(/reward_rules_max_per_week_positive/);
    });

    it('rejects an unknown verification floor', async () => {
      await expect(insert({ min_verified_by: 'VIBES' })).rejects.toThrow(/reward_rules_min_verified_by_known/);
      await expect(insert({ min_verified_by: 'PARENT' })).resolves.toBeDefined();
    });

    it('rejects an uncatalogued category', async () => {
      await expect(insert({ category: 'NOT_A_CATEGORY' })).rejects.toThrow(/reward_rules_category_fkey/);
    });

    it('rejects a SECOND active rule with the same engine, event type, reward type and condition', async () => {
      await expect(insert()).resolves.toBeDefined();
      await expect(insert()).rejects.toThrow(/reward_rules_active_scope_uniq/);
    });

    it('ALLOWS two rules that differ only by their trigger condition — the two health defaults do', async () => {
      await expect(insert({ event_type: 'DAILY_GOAL_COMPLETED', trigger_condition: '{"metric":"hydration"}' })).resolves.toBeDefined();
      await expect(insert({ event_type: 'DAILY_GOAL_COMPLETED', trigger_condition: '{"metric":"activity"}' })).resolves.toBeDefined();
    });

    it('the jsonb hash is key-order independent — the same condition written two ways still collides', async () => {
      await expect(insert({ trigger_condition: '{"a":1,"b":2}' })).resolves.toBeDefined();
      // PostgreSQL stores jsonb with keys sorted and whitespace normalised, so
      // both spellings produce the same `::text` and the same md5.
      await expect(insert({ trigger_condition: '{ "b": 2, "a": 1 }' })).rejects.toThrow(/reward_rules_active_scope_uniq/);
    });

    it('the PLATFORM tier is constrained too — COALESCE(family_id) is what makes that true', async () => {
      // The 15 seeded platform rows are live in this database; inserting a
      // duplicate of one of them must be refused even though family_id IS NULL.
      const seeded = await pool.query(
        `SELECT "trigger_engine", "event_type", "reward_type", "trigger_condition"
           FROM "reward_rules" WHERE "family_id" IS NULL AND "program_id" IS NULL LIMIT 1`,
      );
      const r = seeded.rows[0];
      await expect(
        pool.query(
          `INSERT INTO "reward_rules"
             ("id", "family_id", "trigger_engine", "event_type", "trigger_condition", "reward_type",
              "reward_amount_or_badge_id", "is_active", "created_at", "updated_at")
           VALUES (gen_random_uuid(), NULL, $1, $2, $3::jsonb, $4::"RewardType", '1', true, now(), now())`,
          [r.trigger_engine, r.event_type, JSON.stringify(r.trigger_condition), r.reward_type],
        ),
      ).rejects.toThrow(/reward_rules_active_scope_uniq/);
    });

    it('an INACTIVE rule is outside the index — history is kept, not fought with', async () => {
      const first = await insert();
      await pool.query('UPDATE "reward_rules" SET "is_active" = false WHERE "id" = $1', [first.rows[0].id]);
      // The same scope is now free: a parent may replace a rule they switched
      // off without having to delete the row every past grant points at.
      await expect(insert()).resolves.toBeDefined();
    });
  });
});
