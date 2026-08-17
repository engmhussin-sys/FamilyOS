import { randomUUID } from 'crypto';

import { Pool } from 'pg';

/**
 * G16 — THE CONTROLLED-PILOT ALLOW-LIST, PROVEN AGAINST A REAL POSTGRESQL.
 *
 * WHY THIS FILE EXISTS SEPARATELY FROM `test/analytics/pilot-gate.spec.ts`.
 * That suite proves the SERVICE refuses an uninvited household and produces a
 * readable decision. This one proves the DATABASE refuses the shapes that would
 * make that decision unsound — a second invitation for one address in one
 * cohort, a half-redeemed row, a mixed-case email that the gate's lower-cased
 * lookup could never match. Those are different claims, and only the second
 * survives someone deleting a guard clause in the service.
 *
 * Every attack is attempted DIRECTLY IN SQL, with no application code in the
 * path, so a passing test here means the shape is impossible even from a psql
 * session. The pattern (raw `pg`, skipped rather than silently passed when
 * INTEGRATION_DATABASE_URL is unset) is the one `rewards-concurrency`,
 * `payment-idempotency` and `growth-referral-fraud` already established.
 */
const CONNECTION_STRING = process.env.INTEGRATION_DATABASE_URL;
const describeIfDb = CONNECTION_STRING ? describe : describe.skip;

describeIfDb('G16 — pilot cohort allow-list (real PostgreSQL)', () => {
  let pool: Pool;

  const COHORT = `pilot-test-${randomUUID().slice(0, 8)}`;
  const OTHER_COHORT = `${COHORT}-b`;
  const familyA = randomUUID();
  const familyB = randomUUID();

  beforeAll(async () => {
    pool = new Pool({ connectionString: CONNECTION_STRING });
    await pool.query(
      `INSERT INTO "families" ("id","name","timezone","created_at","updated_at")
       VALUES ($1,'Pilot family A','Asia/Riyadh',now(),now()),
              ($2,'Pilot family B','Africa/Cairo',now(),now())`,
      [familyA, familyB],
    );
  });

  afterAll(async () => {
    await pool.query('DELETE FROM "pilot_invites" WHERE "cohort_id" = ANY($1)', [
      [COHORT, OTHER_COHORT],
    ]);
    await pool.query('DELETE FROM "families" WHERE "id" = ANY($1)', [[familyA, familyB]]);
    await pool.end();
  });

  async function invite(email: string, country = 'SA', cohort = COHORT): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO "pilot_invites" ("email","cohort_id","country_code")
       VALUES ($1,$2,$3) RETURNING "id"`,
      [email, cohort, country],
    );
    return rows[0].id;
  }

  // ======================================================================
  // THE ALLOW-LIST INVARIANT
  // ======================================================================

  it('THE LOAD-BEARING CONSTRAINT: one address cannot be invited twice into one cohort', async () => {
    const email = `dup-${randomUUID().slice(0, 8)}@example.com`;
    await invite(email);

    // Without this constraint the second row would be a second redeemable
    // invitation, so "one invitation, one household" would hold only until
    // somebody inserted a duplicate.
    await expect(invite(email)).rejects.toThrow(/pilot_invites_email_cohort_id_key|duplicate key/i);
  });

  it('the SAME address may be invited into a DIFFERENT cohort — waves are independent', async () => {
    const email = `wave-${randomUUID().slice(0, 8)}@example.com`;
    await invite(email, 'SA', COHORT);

    await expect(invite(email, 'SA', OTHER_COHORT)).resolves.toEqual(expect.any(String));
  });

  // ======================================================================
  // REDEMPTION IS ATOMIC IN SHAPE
  // ======================================================================

  it('a half-redeemed row is not representable: a timestamp with no family is refused', async () => {
    const id = await invite(`half-a-${randomUUID().slice(0, 8)}@example.com`);

    await expect(
      pool.query(`UPDATE "pilot_invites" SET "redeemed_at" = now() WHERE "id" = $1`, [id]),
    ).rejects.toThrow(/pilot_invites_redemption_complete/i);
  });

  it('a half-redeemed row is not representable: a family with no timestamp is refused', async () => {
    const id = await invite(`half-b-${randomUUID().slice(0, 8)}@example.com`);

    await expect(
      pool.query(`UPDATE "pilot_invites" SET "redeemed_by_family_id" = $1 WHERE "id" = $2`, [
        familyA,
        id,
      ]),
    ).rejects.toThrow(/pilot_invites_redemption_complete/i);
  });

  it('COHORT AND COUNTRY ARE RECORDED when an invited family joins', async () => {
    const email = `joins-${randomUUID().slice(0, 8)}@example.com`;
    const id = await invite(email, 'EG');

    const { rowCount } = await pool.query(
      `UPDATE "pilot_invites"
          SET "redeemed_at" = now(), "redeemed_by_family_id" = $1
        WHERE "id" = $2 AND "redeemed_at" IS NULL`,
      [familyA, id],
    );
    expect(rowCount).toBe(1);

    const { rows } = await pool.query<{
      cohort_id: string;
      country_code: string;
      redeemed_by_family_id: string;
      redeemed_at: Date;
    }>(
      `SELECT "cohort_id","country_code","redeemed_by_family_id","redeemed_at"
         FROM "pilot_invites" WHERE "id" = $1`,
      [id],
    );

    // The row IS the record: which wave, which market, which household, when.
    expect(rows[0].cohort_id).toBe(COHORT);
    expect(rows[0].country_code).toBe('EG');
    expect(rows[0].redeemed_by_family_id).toBe(familyA);
    expect(rows[0].redeemed_at).toBeInstanceOf(Date);
  });

  it('THE RACE: two households cannot redeem one invitation', async () => {
    const id = await invite(`race-${randomUUID().slice(0, 8)}@example.com`);

    // Both statements are the exact conditional update the service issues.
    const first = await pool.query(
      `UPDATE "pilot_invites" SET "redeemed_at" = now(), "redeemed_by_family_id" = $1
        WHERE "id" = $2 AND "redeemed_at" IS NULL`,
      [familyA, id],
    );
    const second = await pool.query(
      `UPDATE "pilot_invites" SET "redeemed_at" = now(), "redeemed_by_family_id" = $1
        WHERE "id" = $2 AND "redeemed_at" IS NULL`,
      [familyB, id],
    );

    expect(first.rowCount).toBe(1);
    // The `redeemed_at IS NULL` predicate is what makes the loser observable
    // rather than silent — and it is why the service can keep the losing
    // household's account instead of deleting a family over a race.
    expect(second.rowCount).toBe(0);

    const { rows } = await pool.query<{ redeemed_by_family_id: string }>(
      `SELECT "redeemed_by_family_id" FROM "pilot_invites" WHERE "id" = $1`,
      [id],
    );
    expect(rows[0].redeemed_by_family_id).toBe(familyA);
  });

  // ======================================================================
  // NORMALISATION IS ENFORCED, NOT HOPED FOR
  // ======================================================================

  it('a mixed-case email is refused, because the gate looks up lower-cased', async () => {
    // One hand-inserted mixed-case row would be an invitation an operator can
    // see and a family can never redeem.
    await expect(invite(`MixedCase-${randomUUID().slice(0, 8)}@Example.com`)).rejects.toThrow(
      /pilot_invites_email_lowercase/i,
    );
  });

  it('a lower-case country code is refused, because the pilot list is compared upper-cased', async () => {
    await expect(invite(`lc-${randomUUID().slice(0, 8)}@example.com`, 'sa')).rejects.toThrow(
      /pilot_invites_country_code_uppercase/i,
    );
  });

  it('a country code that is not two characters is refused', async () => {
    await expect(invite(`len-${randomUUID().slice(0, 8)}@example.com`, 'S')).rejects.toThrow(
      /pilot_invites_country_code_uppercase|value too long/i,
    );
  });

  // ======================================================================
  // THE TABLE IS NOT FAMILY-SCOPED, AND THAT IS DELIBERATE
  // ======================================================================

  it('an invitation exists before any family does — the reason the table is global', async () => {
    const email = `pre-${randomUUID().slice(0, 8)}@example.com`;
    const id = await invite(email);

    const { rows } = await pool.query<{ redeemed_by_family_id: string | null }>(
      `SELECT "redeemed_by_family_id" FROM "pilot_invites" WHERE "id" = $1`,
      [id],
    );
    // The gate reads this row during registration, before the transaction that
    // creates the Family. A family_id column could only be NULL at that moment.
    expect(rows[0].redeemed_by_family_id).toBeNull();
  });

  it('deleting the family does not delete the invitation record', async () => {
    // There is no FK: an audit of who was invited must survive a household
    // deleting its account, and the invite table is not tenant data.
    const email = `nofk-${randomUUID().slice(0, 8)}@example.com`;
    const doomed = randomUUID();
    await pool.query(
      `INSERT INTO "families" ("id","name","timezone","created_at","updated_at")
       VALUES ($1,'Doomed','Asia/Riyadh',now(),now())`,
      [doomed],
    );
    const id = await invite(email);
    await pool.query(
      `UPDATE "pilot_invites" SET "redeemed_at" = now(), "redeemed_by_family_id" = $1 WHERE "id" = $2`,
      [doomed, id],
    );

    await pool.query('DELETE FROM "families" WHERE "id" = $1', [doomed]);

    const { rows } = await pool.query(`SELECT "id" FROM "pilot_invites" WHERE "id" = $1`, [id]);
    expect(rows).toHaveLength(1);
  });
});
