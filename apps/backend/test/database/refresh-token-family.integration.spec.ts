/**
 * SA-002 integration proof — refresh-token family revocation against a real
 * PostgreSQL database built from prisma/migrations.
 *
 * The unit tests in test/auth/token.service.spec.ts prove TokenService's
 * decision logic with a mocked repository. This file proves the other half:
 * that the schema actually carries `family_token_id` / `replaced_by_id`,
 * that the lineage index exists, and that the single UPDATE the repository
 * issues really does kill an entire rotation chain — including the token
 * the attacker just minted for themselves.
 *
 * Runs only when INTEGRATION_DATABASE_URL is set; skipped otherwise.
 */
import { randomUUID } from 'crypto';

import { Pool } from 'pg';

const CONNECTION_STRING = process.env.INTEGRATION_DATABASE_URL;
const describeIfDb = CONNECTION_STRING ? describe : describe.skip;

describeIfDb('SA-002 — refresh token family revocation (real PostgreSQL)', () => {
  let pool: Pool;
  let userId: string;

  async function insertToken(params: {
    id: string;
    familyTokenId: string;
    revokedAt?: Date | null;
    replacedById?: string | null;
  }): Promise<void> {
    await pool.query(
      `INSERT INTO refresh_tokens
         (id, user_id, device_id, token_hash, expires_at, revoked_at, created_at, family_token_id, replaced_by_id)
       VALUES ($1::uuid, $2::uuid, NULL, $3, now() + interval '30 days', $4, now(), $5::uuid, $6::uuid)`,
      [
        params.id,
        userId,
        `hash-${params.id}`,
        params.revokedAt ?? null,
        params.familyTokenId,
        params.replacedById ?? null,
      ],
    );
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: CONNECTION_STRING, max: 5 });
  });

  afterAll(async () => {
    await pool?.end();
  });

  beforeEach(async () => {
    const user = await pool.query(
      `INSERT INTO users (id, email, password_hash, full_name, status, created_at, updated_at)
       VALUES (gen_random_uuid(), 'sa002-' || gen_random_uuid() || '@example.test', 'x', 'Parent', 'ACTIVE', now(), now())
       RETURNING id`,
    );
    userId = user.rows[0].id;
  });

  afterEach(async () => {
    await pool.query('DELETE FROM users WHERE id = $1', [userId]);
  });

  it('carries the lineage columns and the lineage index', async () => {
    const cols = await pool.query(
      `SELECT column_name, is_nullable FROM information_schema.columns
        WHERE table_name = 'refresh_tokens' AND column_name IN ('family_token_id','replaced_by_id')
        ORDER BY column_name`,
    );
    expect(cols.rows).toEqual([
      { column_name: 'family_token_id', is_nullable: 'NO' },
      { column_name: 'replaced_by_id', is_nullable: 'YES' },
    ]);

    const idx = await pool.query(
      `SELECT indexname FROM pg_indexes
        WHERE tablename = 'refresh_tokens' AND indexdef LIKE '%family_token_id%'`,
    );
    expect(idx.rowCount).toBeGreaterThanOrEqual(1);
  });

  it('revokes the entire rotation chain in one statement — including the live descendant', async () => {
    // A realistic compromised session: three rotations happened, so two
    // tokens are already revoked and the newest one (t3) is live. The
    // attacker holds t3; the legitimate user replays t2.
    const family = randomUUID();
    const [t1, t2, t3] = [randomUUID(), randomUUID(), randomUUID()];
    await insertToken({ id: t1, familyTokenId: family, revokedAt: new Date(), replacedById: t2 });
    await insertToken({ id: t2, familyTokenId: family, revokedAt: new Date(), replacedById: t3 });
    await insertToken({ id: t3, familyTokenId: family, revokedAt: null });

    // An unrelated session for the same user must survive untouched.
    const otherFamily = randomUUID();
    const other = randomUUID();
    await insertToken({ id: other, familyTokenId: otherFamily, revokedAt: null });

    // Exactly what PrismaRefreshTokenRepository.revokeFamily issues.
    const revoked = await pool.query(
      `UPDATE refresh_tokens SET revoked_at = now()
        WHERE family_token_id = $1::uuid AND revoked_at IS NULL`,
      [family],
    );
    expect(revoked.rowCount).toBe(1); // only t3 was still alive

    const live = await pool.query(
      `SELECT id FROM refresh_tokens WHERE user_id = $1 AND revoked_at IS NULL`,
      [userId],
    );
    expect(live.rows.map((r) => r.id)).toEqual([other]);
  });

  it('rejects a second token row reusing the same token hash', async () => {
    const family = randomUUID();
    const id = randomUUID();
    await insertToken({ id, familyTokenId: family });

    await expect(
      pool.query(
        `INSERT INTO refresh_tokens
           (id, user_id, device_id, token_hash, expires_at, created_at, family_token_id)
         VALUES (gen_random_uuid(), $1::uuid, NULL, $2, now() + interval '30 days', now(), $3::uuid)`,
        [userId, `hash-${id}`, family],
      ),
    ).rejects.toThrow(/refresh_tokens_token_hash_key/);
  });
});
