import { randomUUID } from 'crypto';

import { Pool } from 'pg';

/**
 * PHASE D (GROWTH) — THE FOUR REFERRAL FRAUD VECTORS, PROVEN AGAINST A REAL
 * POSTGRESQL.
 *
 * WHY THIS FILE EXISTS SEPARATELY FROM THE SERVICE TESTS. The service produces
 * a readable 409 for a self-referral; the CHECK constraint is what makes a
 * self-referral impossible. Those are different claims, and only one of them
 * survives someone deleting a guard clause. This suite tests the second one, by
 * attempting each attack DIRECTLY IN SQL — no application code in the path at
 * all, so a passing test here means the attack fails even from a psql session.
 *
 * The pattern (raw `pg`, no Prisma client, skipped rather than silently passed
 * when INTEGRATION_DATABASE_URL is unset) is the one
 * `rewards-concurrency.integration.spec.ts` established for DA-002 and
 * `payment-idempotency.integration.spec.ts` continued for Phase D payments.
 */
const CONNECTION_STRING = process.env.INTEGRATION_DATABASE_URL;
const describeIfDb = CONNECTION_STRING ? describe : describe.skip;

describeIfDb('PHASE D (GROWTH) — referral fraud resistance (real PostgreSQL)', () => {
  let pool: Pool;

  const referrerA = randomUUID();
  const referrerB = randomUUID();
  const referred = randomUUID();
  const otherReferred = randomUUID();
  let codeA: string;
  let codeB: string;

  beforeAll(async () => {
    pool = new Pool({ connectionString: CONNECTION_STRING });

    await pool.query(
      `INSERT INTO "families" ("id","name","timezone","created_at","updated_at")
       VALUES ($1,'Referrer A','Africa/Cairo',now(),now()),
              ($2,'Referrer B','Asia/Riyadh',now(),now()),
              ($3,'Referred','Africa/Cairo',now(),now()),
              ($4,'Other referred','Africa/Cairo',now(),now())`,
      [referrerA, referrerB, referred, otherReferred],
    );

    codeA = randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase();
    codeB = randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase();
    await pool.query(
      `INSERT INTO "referral_codes" ("id","family_id","code","created_at","updated_at")
       VALUES (gen_random_uuid(),$1,$2,now(),now()), (gen_random_uuid(),$3,$4,now(),now())`,
      [referrerA, codeA, referrerB, codeB],
    );
  });

  afterAll(async () => {
    await pool.query('DELETE FROM "families" WHERE "id" = ANY($1)', [
      [referrerA, referrerB, referred, otherReferred],
    ]);
    await pool.end();
  });

  async function codeIdOf(familyId: string): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      'SELECT "id" FROM "referral_codes" WHERE "family_id" = $1',
      [familyId],
    );
    return rows[0].id;
  }

  async function insertEvent(
    referrerFamilyId: string,
    kind: string,
    referredFamilyId: string | null,
    key: string,
  ): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO "referral_events"
         ("id","family_id","referral_code_id","kind","referred_family_id","idempotency_key","occurred_at")
       VALUES (gen_random_uuid(),$1,$2,$3::"ReferralEventKind",$4,$5,now())
       RETURNING "id"`,
      [referrerFamilyId, await codeIdOf(referrerFamilyId), kind, referredFamilyId, key],
    );
    return rows[0].id;
  }

  describe('VECTOR 1 — SELF-REFERRAL', () => {
    it('the DATABASE refuses a family referring itself, not merely the service', async () => {
      await expect(
        insertEvent(referrerA, 'REGISTERED', referrerA, `self-${randomUUID()}`),
      ).rejects.toThrow(/referral_events_no_self_referral/);
    });

    it('a REJECTED row recording the attempt IS allowed — with a NULL referred family', async () => {
      // The refusal is kept as evidence: "this household tried to refer itself
      // eleven times" is a fraud signal a system that discards refusals cannot
      // see. The CHECK permits it because `referred_family_id` is NULL.
      const id = await insertEvent(referrerA, 'REJECTED', null, `rej-${randomUUID()}`);
      expect(id).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('SENT and CLICKED carry no referred family, so the CHECK cannot fire on them', async () => {
      const id = await insertEvent(referrerA, 'SENT', null, `sent-${randomUUID()}`);
      expect(id).toBeTruthy();
    });
  });

  describe('VECTOR 2 — DUPLICATE REFERRAL', () => {
    it('the first referrer wins; a SECOND referrer claiming the same household is refused', async () => {
      await insertEvent(referrerA, 'REGISTERED', referred, `registered:${referred}`);

      // Referrer B tries to claim the SAME household with its own key — which
      // a per-referrer unique index would have allowed. The PARTIAL unique on
      // `referred_family_id` alone is what refuses it.
      await expect(
        insertEvent(referrerB, 'REGISTERED', referred, `registered:${referred}`),
      ).rejects.toThrow(/referral_events_referred_family_uq/);
    });

    it('the SAME referrer cannot claim the same household twice either', async () => {
      await expect(
        insertEvent(referrerA, 'REGISTERED', referred, `registered-again:${referred}`),
      ).rejects.toThrow(/referral_events_referred_family_uq/);
    });

    it('a QUALIFIED row for that household is still allowed — the unique is scoped to REGISTERED', async () => {
      const id = await insertEvent(referrerA, 'QUALIFIED', referred, `qualified:${referred}`);
      expect(id).toBeTruthy();
    });

    it('a REGISTERED row REQUIRES a referred family — a headless one would corrupt every count', async () => {
      await expect(
        insertEvent(referrerA, 'REGISTERED', null, `headless-${randomUUID()}`),
      ).rejects.toThrow(/referral_events_referred_present_when_needed/);
    });

    it('a DIFFERENT household can still be referred by the same referrer', async () => {
      const id = await insertEvent(referrerA, 'REGISTERED', otherReferred, `registered:${otherReferred}`);
      expect(id).toBeTruthy();
    });
  });

  describe('VECTOR 3 — MULTIPLE REWARDS FOR ONE CONVERSION', () => {
    it('CONCURRENT qualification produces EXACTLY ONE reward row', async () => {
      const eventId = await insertEvent(referrerB, 'QUALIFIED', otherReferred, `qualified:${otherReferred}`);

      // Eight real connections racing on the same conversion. This is the
      // shape A2 §7.3 used to prove the reward ledger's nullable key was
      // unprotected, applied to the referral payout.
      const attempts = Array.from({ length: 8 }, () =>
        pool
          .query(
            `INSERT INTO "referral_rewards"
               ("id","family_id","referral_event_id","kind","value","status","created_at","updated_at")
             VALUES (gen_random_uuid(),$1,$2,'SUBSCRIPTION_CREDIT_DAYS',30,'PENDING',now(),now())`,
            [referrerB, eventId],
          )
          .then(() => 'ok' as const)
          .catch(() => 'refused' as const),
      );

      const results = await Promise.all(attempts);
      expect(results.filter((r) => r === 'ok')).toHaveLength(1);
      expect(results.filter((r) => r === 'refused')).toHaveLength(7);

      const { rows } = await pool.query<{ count: string }>(
        'SELECT COUNT(*)::text AS count FROM "referral_rewards" WHERE "referral_event_id" = $1',
        [eventId],
      );
      expect(rows[0].count).toBe('1');
    });

    it('a zero or negative reward value is refused — a payout of nothing is a bug, not a policy', async () => {
      const eventId = await insertEvent(referrerA, 'REJECTED', null, `zero-${randomUUID()}`);
      await expect(
        pool.query(
          `INSERT INTO "referral_rewards"
             ("id","family_id","referral_event_id","kind","value","status","created_at","updated_at")
           VALUES (gen_random_uuid(),$1,$2,'CHILD_REWARD_COINS',0,'PENDING',now(),now())`,
          [referrerA, eventId],
        ),
      ).rejects.toThrow(/referral_rewards_value_positive/);
    });
  });

  describe('VECTOR 4 — RAPID ABUSE: the audit trail the velocity limits count against', () => {
    it('every SENT row is a durable row, so "why did this family earn nine rewards" is answerable a year later', async () => {
      const before = await pool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM "referral_events" WHERE "family_id" = $1 AND "kind" = 'SENT'`,
        [referrerA],
      );
      for (let i = 0; i < 3; i++) {
        await insertEvent(referrerA, 'SENT', null, `velocity-${i}-${randomUUID()}`);
      }
      const after = await pool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM "referral_events" WHERE "family_id" = $1 AND "kind" = 'SENT'`,
        [referrerA],
      );
      expect(Number(after.rows[0].count) - Number(before.rows[0].count)).toBe(3);
      // A Redis counter would have answered the same question today and none of
      // it after the next restart.
    });

    it('one household holds exactly ONE referral code, for life', async () => {
      await expect(
        pool.query(
          `INSERT INTO "referral_codes" ("id","family_id","code","created_at","updated_at")
           VALUES (gen_random_uuid(),$1,$2,now(),now())`,
          [referrerA, `${codeB}X`],
        ),
      ).rejects.toThrow(/referral_codes_family_id_key/);
    });

    it('two households cannot share a code', async () => {
      await expect(
        pool.query(
          `INSERT INTO "referral_codes" ("id","family_id","code","created_at","updated_at")
           VALUES (gen_random_uuid(),$1,$2,now(),now())`,
          [otherReferred, codeA],
        ),
      ).rejects.toThrow(/referral_codes_code_key/);
    });

    it('a household gets one link per channel, so links cannot be minted to dilute a limit', async () => {
      const codeId = await codeIdOf(referrerA);
      await pool.query(
        `INSERT INTO "referral_links" ("id","family_id","referral_code_id","channel","url","created_at","updated_at")
         VALUES (gen_random_uuid(),$1,$2,'INSTAGRAM','https://abny.app/r/x',now(),now())`,
        [referrerA, codeId],
      );
      await expect(
        pool.query(
          `INSERT INTO "referral_links" ("id","family_id","referral_code_id","channel","url","created_at","updated_at")
           VALUES (gen_random_uuid(),$1,$2,'INSTAGRAM','https://abny.app/r/y',now(),now())`,
          [referrerA, codeId],
        ),
      ).rejects.toThrow(/referral_links_code_channel_key/);
    });
  });
});

describeIfDb('PHASE D (GROWTH) — activation and aggregation are idempotent (real PostgreSQL)', () => {
  let pool: Pool;
  const familyId = randomUUID();

  beforeAll(async () => {
    pool = new Pool({ connectionString: CONNECTION_STRING });
    await pool.query(
      `INSERT INTO "families" ("id","name","timezone","created_at","updated_at")
       VALUES ($1,'Activation fixture','Africa/Cairo',now(),now())`,
      [familyId],
    );
  });

  afterAll(async () => {
    await pool.query('DELETE FROM "growth_daily_metrics" WHERE "country_code" = $1', ['ZZ']);
    await pool.query('DELETE FROM "growth_alerts" WHERE "scope_key" = $1', ['test-scope']);
    await pool.query('DELETE FROM "families" WHERE "id" = $1', [familyId]);
    await pool.end();
  });

  it('GATE 4 — a family activates EXACTLY ONCE, decided by the database under concurrency', async () => {
    const attempts = Array.from({ length: 8 }, () =>
      pool
        .query(
          `INSERT INTO "family_activations"
             ("id","family_id","rule_version","completion_kind","occurred_at","time_to_value_minutes","created_at")
           VALUES (gen_random_uuid(),$1,'MEANINGFUL_GOAL_V1','HABIT',now(),150,now())`,
          [familyId],
        )
        .then(() => 'ok' as const)
        .catch(() => 'refused' as const),
    );
    const results = await Promise.all(attempts);
    expect(results.filter((r) => r === 'ok')).toHaveLength(1);

    const { rows } = await pool.query<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM "family_activations" WHERE "family_id" = $1',
      [familyId],
    );
    expect(rows[0].count).toBe('1');
  });

  it('a NEGATIVE time-to-value is refused rather than clamped into the median', async () => {
    await pool.query('DELETE FROM "family_activations" WHERE "family_id" = $1', [familyId]);
    await expect(
      pool.query(
        `INSERT INTO "family_activations"
           ("id","family_id","rule_version","completion_kind","occurred_at","time_to_value_minutes","created_at")
         VALUES (gen_random_uuid(),$1,'MEANINGFUL_GOAL_V1','HABIT',now(),-5,now())`,
        [familyId],
      ),
    ).rejects.toThrow(/family_activations_ttv_non_negative/);
  });

  it('AGGREGATION IDEMPOTENCY — re-running a day UPSERTs one row instead of doubling every number', async () => {
    const day = '2026-08-15';
    const upsert = (dau: number) =>
      pool.query(
        `INSERT INTO "growth_daily_metrics"
           ("id","business_date","country_code","reporting_timezone","dau","new_registrations","computed_at","updated_at")
         VALUES (gen_random_uuid(),$1::date,'ZZ','Africa/Cairo',$2,$2,now(),now())
         ON CONFLICT ("business_date","country_code")
         DO UPDATE SET "dau" = EXCLUDED."dau", "new_registrations" = EXCLUDED."new_registrations", "updated_at" = now()`,
        [day, dau],
      );

    await upsert(120);
    await upsert(120);
    await upsert(120);

    const { rows } = await pool.query<{ count: string; dau: number }>(
      `SELECT COUNT(*)::text AS count, MAX("dau") AS dau
         FROM "growth_daily_metrics" WHERE "business_date" = $1::date AND "country_code" = 'ZZ'`,
      [day],
    );
    expect(rows[0].count).toBe('1');
    expect(rows[0].dau).toBe(120);

    // ... and a CORRECTED re-run overwrites rather than accumulating.
    await upsert(135);
    const corrected = await pool.query<{ count: string; dau: number }>(
      `SELECT COUNT(*)::text AS count, MAX("dau") AS dau
         FROM "growth_daily_metrics" WHERE "business_date" = $1::date AND "country_code" = 'ZZ'`,
      [day],
    );
    expect(corrected.rows[0].count).toBe('1');
    expect(corrected.rows[0].dau).toBe(135);
  });

  it("the platform row uses the '**' sentinel rather than NULL, so the unique index actually applies to it", async () => {
    // PostgreSQL treats NULLs as distinct, so a nullable country column would
    // have permitted duplicate platform rows — the exact hole DA-002 found in
    // the reward ledger's nullable idempotency key.
    const { rows } = await pool.query<{ is_nullable: string }>(
      `SELECT "is_nullable" FROM information_schema.columns
        WHERE table_name = 'growth_daily_metrics' AND column_name = 'country_code'`,
    );
    expect(rows[0].is_nullable).toBe('NO');
  });

  it('ALERT DEDUPE — an hourly scan of a persisting condition raises ONE alert per day', async () => {
    const raise = () =>
      pool
        .query(
          `INSERT INTO "growth_alerts"
             ("id","alert_type","scope_key","business_date","severity","message","created_at")
           VALUES (gen_random_uuid(),'CHURN_RISE','test-scope','2026-08-15'::date,'CRITICAL','x',now())`,
        )
        .then(() => 'ok' as const)
        .catch(() => 'deduped' as const);

    const results = await Promise.all(Array.from({ length: 24 }, raise));
    expect(results.filter((r) => r === 'ok')).toHaveLength(1);
    expect(results.filter((r) => r === 'deduped')).toHaveLength(23);
  });

  it('CAMPAIGN SPEND IMPORT IS IDEMPOTENT — re-importing a day corrects it instead of doubling CAC downward', async () => {
    const campaignId = randomUUID();
    await pool.query(
      `INSERT INTO "growth_campaigns"
         ("id","name","channel","country_code","budget_minor","currency_code","starts_at","ends_at",
          "target_users","target_paid_users","created_at","updated_at")
       VALUES ($1,$2,'TIKTOK','EG',5000000,'EGP',now(),now() + interval '30 days',10000,1000,now(),now())`,
      [campaignId, `spend-fixture-${campaignId.slice(0, 8)}`],
    );

    const importDay = (spend: number) =>
      pool.query(
        `INSERT INTO "campaign_daily_spend"
           ("id","campaign_id","business_date","spend_minor","impressions","created_at","updated_at")
         VALUES (gen_random_uuid(),$1,'2026-08-15'::date,$2,100000,now(),now())
         ON CONFLICT ("campaign_id","business_date")
         DO UPDATE SET "spend_minor" = EXCLUDED."spend_minor", "updated_at" = now()`,
        [campaignId, spend],
      );

    await importDay(120_000);
    await importDay(120_000);

    const { rows } = await pool.query<{ total: string; rows: string }>(
      `SELECT COALESCE(SUM("spend_minor"),0)::text AS total, COUNT(*)::text AS rows
         FROM "campaign_daily_spend" WHERE "campaign_id" = $1`,
      [campaignId],
    );
    // Doubling the spend would have HALVED the reported CAC — in the
    // flattering direction, which is the direction nobody questions.
    expect(rows[0].total).toBe('120000');
    expect(rows[0].rows).toBe('1');

    await pool.query('DELETE FROM "growth_campaigns" WHERE "id" = $1', [campaignId]);
  });

  it('a campaign cannot exist without an admin-stated budget and targets', async () => {
    await expect(
      pool.query(
        `INSERT INTO "growth_campaigns"
           ("id","name","channel","country_code","currency_code","starts_at","ends_at","created_at","updated_at")
         VALUES (gen_random_uuid(),'no-budget','TIKTOK','EG','EGP',now(),now() + interval '1 day',now(),now())`,
      ),
    ).rejects.toThrow(/budget_minor|null value/i);
  });

  it('a campaign whose window ends before it starts is refused', async () => {
    await expect(
      pool.query(
        `INSERT INTO "growth_campaigns"
           ("id","name","channel","country_code","budget_minor","currency_code","starts_at","ends_at",
            "target_users","target_paid_users","created_at","updated_at")
         VALUES (gen_random_uuid(),'backwards','TIKTOK','EG',1000,'EGP',now(),now() - interval '1 day',10,1,now(),now())`,
      ),
    ).rejects.toThrow(/growth_campaigns_window_ordered/);
  });

  it('a forecast scenario with an impossible assumption is refused by the database', async () => {
    await expect(
      pool.query(
        `INSERT INTO "growth_forecast_scenarios"
           ("id","scenario","country_code","currency_code","monthly_acquisition","conversion_rate",
            "paid_conversion_rate","churn_rate","arpu_minor","cac_minor","retention_d30","created_at","updated_at")
         VALUES (gen_random_uuid(),'BASE','ZZ','EGP',1000,1.5,0.3,0.06,17900,35000,0.4,now(),now())`,
      ),
    ).rejects.toThrow(/growth_forecast_scenarios_rates_bounded/);
  });
});
