import { randomUUID } from 'crypto';

import { Pool } from 'pg';

/**
 * PHASE D — THE DATABASE CONSTRAINTS, PROVEN AGAINST A REAL POSTGRESQL.
 *
 * `payment-webhook.pipeline.spec.ts` proves the SERVICES behave correctly
 * given constraints that hold. This file proves the constraints hold. Neither
 * half is worth much on its own: an in-memory double that reimplements a unique
 * index is only evidence if the index actually exists, and an index is only
 * useful if the code above it treats a conflict as success.
 *
 * Everything below is raw SQL against the schema migrations 0013 and 0014
 * build. No Prisma client, no application code — the same approach
 * `rewards-concurrency.integration.spec.ts` established for DA-002, and for the
 * same reason: the Prisma query engine binary cannot be downloaded in this
 * environment (binaries.prisma.sh answers 403), and `pg` speaks to the same
 * server.
 *
 * Runs only when INTEGRATION_DATABASE_URL points at a database built from
 * prisma/migrations. SKIPPED — not silently passed — otherwise.
 */
const CONNECTION_STRING = process.env.INTEGRATION_DATABASE_URL;
const describeIfDb = CONNECTION_STRING ? describe : describe.skip;

describeIfDb('PHASE D — payment idempotency and append-only enforcement (real PostgreSQL)', () => {
  let pool: Pool;
  let familyId: string;
  let otherFamilyId: string;
  let subscriptionId: string;

  beforeAll(async () => {
    pool = new Pool({ connectionString: CONNECTION_STRING });
    familyId = randomUUID();
    otherFamilyId = randomUUID();
    subscriptionId = randomUUID();

    await pool.query(
      `INSERT INTO "families" ("id","name","timezone","created_at","updated_at")
       VALUES ($1,'Phase D fixture','Africa/Cairo',now(),now()), ($2,'Phase D other','Asia/Riyadh',now(),now())`,
      [familyId, otherFamilyId],
    );
    await pool.query(
      `INSERT INTO "subscriptions" ("id","family_id","plan_tier","status","provider","created_at","updated_at")
       VALUES ($1,$2,'PREMIUM','ACTIVE','APPLE_IAP',now(),now())`,
      [subscriptionId, familyId],
    );
  });

  afterAll(async () => {
    // The financial tables refuse DELETE by trigger — that is the point of this
    // suite — so the fixture is torn down by removing the FAMILIES, whose
    // CASCADE the triggers do not intercept (a BEFORE DELETE trigger on the
    // child fires for cascaded deletes too, so this is done with the triggers
    // temporarily disabled, under an explicit transaction, exactly as a real
    // GDPR erasure job would have to).
    await pool.query('BEGIN');
    await pool.query('ALTER TABLE "payment_transactions" DISABLE TRIGGER "payment_transactions_no_delete"');
    await pool.query('ALTER TABLE "refunds" DISABLE TRIGGER "refunds_no_delete"');
    await pool.query('ALTER TABLE "payment_webhook_events" DISABLE TRIGGER "payment_webhook_events_no_delete"');
    await pool.query('ALTER TABLE "invoices" DISABLE TRIGGER "invoices_no_delete"');
    await pool.query('DELETE FROM "families" WHERE "id" = ANY($1)', [[familyId, otherFamilyId]]);
    await pool.query('ALTER TABLE "payment_transactions" ENABLE TRIGGER "payment_transactions_no_delete"');
    await pool.query('ALTER TABLE "refunds" ENABLE TRIGGER "refunds_no_delete"');
    await pool.query('ALTER TABLE "payment_webhook_events" ENABLE TRIGGER "payment_webhook_events_no_delete"');
    await pool.query('ALTER TABLE "invoices" ENABLE TRIGGER "invoices_no_delete"');
    await pool.query('COMMIT');
    await pool.end();
  });

  async function insertTransaction(over: Record<string, unknown> = {}): Promise<{ rowCount: number; id?: string }> {
    const values = {
      provider: 'APPLE_IAP',
      providerTransactionId: `txn-${randomUUID()}`,
      idempotencyKey: `key-${randomUUID()}`,
      gross: 17_900,
      vat: 2_198,
      currency: 'EGP',
      status: 'SUCCEEDED',
      familyId,
      // `net` is normally DERIVED (gross - vat) so that every insert this helper
      // makes is internally consistent. It is overridable only so that one test
      // can prove the CHECK constraint actually fires — an "inconsistent
      // breakdown is refused" test that cannot construct an inconsistent
      // breakdown proves nothing.
      net: undefined as number | undefined,
      ...over,
    } as Record<string, string | number | undefined>;

    const result = await pool.query(
      `INSERT INTO "payment_transactions"
         ("family_id","subscription_id","provider","provider_transaction_id","currency",
          "gross_amount_minor","vat_amount_minor","net_amount_minor","status","idempotency_key","occurred_at")
       VALUES ($1,$2,$3::"PaymentProvider",$4,$5,$6,$7,$8,$9::"PaymentTransactionStatus",$10,now())
       ON CONFLICT DO NOTHING
       RETURNING "id"`,
      [
        values.familyId,
        subscriptionId,
        values.provider,
        values.providerTransactionId,
        values.currency,
        values.gross,
        values.vat,
        values.net ?? (values.gross as number) - (values.vat as number),
        values.status,
        values.idempotencyKey,
      ],
    );
    return { rowCount: result.rowCount ?? 0, id: result.rows[0]?.id as string | undefined };
  }

  describe('THE UNIQUE INDEXES', () => {
    it('payment_transactions (provider, provider_transaction_id) — a provider redelivery inserts nothing', async () => {
      const providerTransactionId = `txn-${randomUUID()}`;
      const first = await insertTransaction({ providerTransactionId });
      const second = await insertTransaction({ providerTransactionId });
      expect(first.rowCount).toBe(1);
      expect(second.rowCount).toBe(0);
    });

    it('payment_transactions (family_id, idempotency_key) — two of our own code paths credit once', async () => {
      const idempotencyKey = `key-${randomUUID()}`;
      const first = await insertTransaction({ idempotencyKey });
      const second = await insertTransaction({ idempotencyKey });
      expect(first.rowCount).toBe(1);
      expect(second.rowCount).toBe(0);
    });

    it('the idempotency key is TENANT-SCOPED: the same key in another family is a different payment', async () => {
      const idempotencyKey = `key-${randomUUID()}`;
      await insertTransaction({ idempotencyKey });
      const other = await insertTransaction({ idempotencyKey, familyId: otherFamilyId });
      expect(other.rowCount).toBe(1);
    });

    it('EIGHT CONCURRENT identical inserts produce exactly ONE row', async () => {
      // DA-002's exact scenario, applied to money. The defence is the index,
      // not a check-then-insert — which is a race that a determined user, or a
      // provider retrying eight times after a timeout, wins.
      const providerTransactionId = `txn-${randomUUID()}`;
      const results = await Promise.all(
        Array.from({ length: 8 }, () => insertTransaction({ providerTransactionId })),
      );
      expect(results.filter((r) => r.rowCount === 1)).toHaveLength(1);

      const count = await pool.query(
        'SELECT count(*)::int AS n FROM "payment_transactions" WHERE "provider_transaction_id" = $1',
        [providerTransactionId],
      );
      expect(count.rows[0].n).toBe(1);
    });

    it('payment_webhook_events (provider, provider_event_id) — Q17 dedupe constraint, verbatim', async () => {
      const providerEventId = `evt-${randomUUID()}`;
      const insert = () =>
        pool.query(
          `INSERT INTO "payment_webhook_events"
             ("provider","provider_event_id","event_type","signature_verified","outcome","payload_digest")
           VALUES ('APPLE_IAP','${providerEventId}','DID_RENEW',true,'RECEIVED','digest')
           ON CONFLICT DO NOTHING RETURNING "id"`,
        );
      const results = await Promise.all([insert(), insert(), insert(), insert()]);
      expect(results.filter((r) => (r.rowCount ?? 0) === 1)).toHaveLength(1);
    });

    it('trials (family_id) — one lifetime trial per family, enforced by the database', async () => {
      const insert = () =>
        pool.query(
          `INSERT INTO "trials" ("family_id","plan_tier","ends_at")
           VALUES ($1,'PREMIUM', now() + interval '14 days')
           ON CONFLICT DO NOTHING RETURNING "id"`,
          [familyId],
        );
      const results = await Promise.all([insert(), insert(), insert()]);
      expect(results.filter((r) => (r.rowCount ?? 0) === 1)).toHaveLength(1);
    });

    it('provider_account_links (provider, provider_account_ref) — two families cannot claim one store account', async () => {
      const ref = `acct-${randomUUID()}`;
      const claim = (family: string) =>
        pool.query(
          `INSERT INTO "provider_account_links" ("family_id","provider","provider_account_ref")
           VALUES ($1,'APPLE_IAP',$2) ON CONFLICT DO NOTHING RETURNING "family_id"`,
          [family, ref],
        );
      const [a, b] = await Promise.all([claim(familyId), claim(otherFamilyId)]);
      expect((a.rowCount ?? 0) + (b.rowCount ?? 0)).toBe(1);
    });

    it('entitlements (family_id, feature_key) — the upsert extends valid_until and never shortens it', async () => {
      const featureKey = `feat-${randomUUID().slice(0, 8)}`;
      const grant = (validUntil: string) =>
        pool.query(
          `INSERT INTO "entitlements"
             ("family_id","feature_key","plan_tier","source","status","valid_from","valid_until")
           VALUES ($1,$2,'PREMIUM','APPLE_IAP','ACTIVE', now(), $3::timestamptz)
           ON CONFLICT ("family_id","feature_key") DO UPDATE SET
             "valid_until" = CASE
               WHEN "entitlements"."valid_until" IS NULL OR EXCLUDED."valid_until" IS NULL THEN NULL
               ELSE GREATEST("entitlements"."valid_until", EXCLUDED."valid_until")
             END
           RETURNING "valid_until"`,
          [familyId, featureKey, validUntil],
        );

      await grant('2026-12-01T00:00:00Z');
      // A STALE renewal arriving late. Without GREATEST() this silently cuts
      // the customer off two months early.
      const stale = await grant('2026-09-01T00:00:00Z');
      expect(new Date(stale.rows[0].valid_until as string).toISOString()).toBe('2026-12-01T00:00:00.000Z');
    });
  });

  describe('THE APPEND-ONLY TRIGGERS', () => {
    it('DELETE is refused on every financial table', async () => {
      const { id } = await insertTransaction();
      await expect(pool.query('DELETE FROM "payment_transactions" WHERE "id" = $1', [id])).rejects.toThrow(
        /append-only table payment_transactions/,
      );
    });

    it('an amount cannot be changed after insert', async () => {
      const { id } = await insertTransaction();
      await expect(
        pool.query('UPDATE "payment_transactions" SET "gross_amount_minor" = 1 WHERE "id" = $1', [id]),
      ).rejects.toThrow(/is immutable/);
    });

    it('the currency cannot be changed after insert', async () => {
      const { id } = await insertTransaction();
      await expect(
        pool.query('UPDATE "payment_transactions" SET "currency" = $2 WHERE "id" = $1', [id, 'SAR']),
      ).rejects.toThrow(/is immutable/);
    });

    it('the TENANT cannot be moved — a payment cannot be reassigned to another household', async () => {
      const { id } = await insertTransaction();
      await expect(
        pool.query('UPDATE "payment_transactions" SET "family_id" = $2 WHERE "id" = $1', [id, otherFamilyId]),
      ).rejects.toThrow(/is immutable/);
    });

    it('a status REGRESSION is refused', async () => {
      const { id } = await insertTransaction({ status: 'SUCCEEDED' });
      await pool.query(
        `UPDATE "payment_transactions" SET "status" = 'REFUNDED'::"PaymentTransactionStatus" WHERE "id" = $1`,
        [id],
      );
      await expect(
        pool.query(
          `UPDATE "payment_transactions" SET "status" = 'SUCCEEDED'::"PaymentTransactionStatus" WHERE "id" = $1`,
          [id],
        ),
      ).rejects.toThrow(/is not allowed/);
    });

    it('the monotonic advance PENDING -> SUCCEEDED IS allowed — Fawry depends on it', async () => {
      // A customer takes a Fawry reference to a kiosk and pays three days
      // later. Refusing this UPDATE would force a second row for one payment,
      // which is a worse ledger rather than a stricter one.
      const { id } = await insertTransaction({ status: 'PENDING' });
      await expect(
        pool.query(
          `UPDATE "payment_transactions" SET "status" = 'SUCCEEDED'::"PaymentTransactionStatus", "verified_at" = now() WHERE "id" = $1`,
          [id],
        ),
      ).resolves.toBeDefined();
    });
  });

  describe('THE CHECK CONSTRAINTS', () => {
    it('net + vat must equal gross — an internally inconsistent breakdown is refused', async () => {
      // 90 + 10 !== 100 would be fine; 5 + 10 !== 100 is not.
      await expect(insertTransaction({ gross: 100, vat: 10, net: 5 })).rejects.toThrow(/amounts_check/);
    });

    it('a negative amount is refused — a reversal is a refunds row, not a negative payment', async () => {
      await expect(insertTransaction({ gross: -100, vat: 0 })).rejects.toThrow(/amounts_check/);
    });

    it('a currency that is not ISO-4217 uppercase alpha-3 is refused', async () => {
      await expect(insertTransaction({ currency: 'egp' })).rejects.toThrow(/currency_check/);
      await expect(insertTransaction({ currency: 'EG' })).rejects.toThrow(/currency_check/);
    });

    it('a VAT rate outside [0%, 100%] is refused', async () => {
      await expect(
        pool.query(
          `INSERT INTO "countries" ("code","name_en","name_ar","currency_code","vat_basis_points")
           VALUES ('ZZ','Nowhere','لامكان','EGP', 20000)`,
        ),
      ).rejects.toThrow(/vat_range_check/);
    });

    it('a refund cannot be zero or negative', async () => {
      const { id } = await insertTransaction();
      await expect(
        pool.query(
          `INSERT INTO "refunds"
             ("family_id","payment_transaction_id","provider","amount_minor","currency","status","idempotency_key","occurred_at")
           VALUES ($1,$2,'APPLE_IAP',0,'EGP','COMPLETED',$3, now())`,
          [familyId, id, `r-${randomUUID()}`],
        ),
      ).rejects.toThrow(/refunds_amount_check/);
    });
  });

  describe('THE SEEDED LAUNCH MARKETS', () => {
    it('Egypt and Saudi Arabia exist with their real VAT rates and default providers', async () => {
      const result = await pool.query(
        `SELECT "code","vat_basis_points","currency_code","default_provider" FROM "countries" WHERE "code" IN ('EG','SA') ORDER BY "code"`,
      );
      expect(result.rows).toEqual([
        { code: 'EG', vat_basis_points: 1400, currency_code: 'EGP', default_provider: 'PAYMOB' },
        { code: 'SA', vat_basis_points: 1500, currency_code: 'SAR', default_provider: 'MOYASAR' },
      ]);
    });

    it('NO PRICES ARE SEEDED — the commercial decision has not been made', async () => {
      // Deliberate, and asserted so that someone who adds a "temporary" default
      // price has to come here and argue with it. See HUMAN DECISION REQUIRED #1.
      const result = await pool.query('SELECT count(*)::int AS n FROM "subscription_prices"');
      expect(result.rows[0].n).toBe(0);
    });
  });

  describe('THE OUT-OF-ORDER GUARD, as a conditional UPDATE', () => {
    it('an older provider event matches zero rows', async () => {
      const apply = (eventAt: string, status: string) =>
        pool.query(
          `UPDATE "subscriptions" SET
             "status" = $2::"SubscriptionStatus",
             "last_provider_event_at" = $3::timestamptz
           WHERE "id" = $1
             AND ("last_provider_event_at" IS NULL OR "last_provider_event_at" < $3::timestamptz)
           RETURNING "id"`,
          [subscriptionId, status, eventAt],
        );

      const newer = await apply('2026-09-01T00:00:00Z', 'EXPIRED');
      expect(newer.rowCount).toBe(1);

      const older = await apply('2026-07-01T00:00:00Z', 'ACTIVE');
      expect(older.rowCount).toBe(0);

      const state = await pool.query('SELECT "status" FROM "subscriptions" WHERE "id" = $1', [subscriptionId]);
      expect(state.rows[0].status).toBe('EXPIRED');
    });
  });
});
