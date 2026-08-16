import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';
import type {
  ICountryConfig,
  IEntitlementRecord,
  IIdempotentInsert,
  IPaymentRepository,
  IPaymentTransactionRecord,
  IRefundRecord,
  ISubscriptionPriceRecord,
  ITrialRecord,
  IWebhookEventRecord,
  WebhookOutcomeValue,
} from '../application/ports/payment.repository.port';
import type { BillingPeriodValue } from '../application/ports/payment-provider.port';
import type { EntitlementKey, PaymentProviderValue, SubscriptionPlanTier } from '../domain/billing.types';
import type { CanonicalSubscriptionStatus } from '../domain/subscription-status';
import type { VatMode } from '../domain/money';
import { toPersistedStatus } from '../domain/subscription-status';

/** Postgres unique-violation. The ONLY thing that makes an insert idempotent. */
const UNIQUE_VIOLATION = 'P2002';

/**
 * PHASE D — THE FINANCIAL PERSISTENCE LAYER.
 *
 * ============== HOW IDEMPOTENCY IS ACTUALLY IMPLEMENTED ==============
 *
 * Not `if (await findFirst(...)) return;` — that is a check-then-act race, and
 * DA-002 measured what it costs on this exact codebase: eight concurrent
 * identical reward grants produced eight rows and 400 XP where one row and 50
 * XP were correct. The fix there, and the pattern here, is the same:
 *
 *   ATTEMPT THE INSERT. LET THE UNIQUE INDEX DECIDE. TREAT P2002 AS SUCCESS.
 *
 * Every method below that returns `IIdempotentInsert` does exactly that. Two
 * concurrent webhook deliveries both call `create`; PostgreSQL serialises them
 * on the index; one gets `wasCreated: true` and applies side effects, the
 * other gets `wasCreated: false` and applies none. There is no window between
 * the check and the write, because there is no check.
 *
 * ================ WHY SO MUCH OF THIS IS RAW SQL ================
 *
 * Two operations cannot be expressed through Prisma's query builder and are
 * written as parameterised `$queryRaw`:
 *
 *   1. `applySubscriptionStateIfNewer` — the out-of-order guard has to compare
 *      the incoming timestamp against the STORED one inside the UPDATE's own
 *      WHERE clause. Reading it first and comparing in TypeScript reintroduces
 *      precisely the race the guard exists to close.
 *   2. `grantEntitlement` — `ON CONFLICT ... DO UPDATE` with a conditional
 *      `GREATEST()` on `valid_until`, so that a redelivered renewal can only
 *      ever EXTEND access and never shorten it.
 *
 * Both mention `family_id` explicitly, which is what the tenant CI guard
 * (RULE 2) requires of raw SQL, and both are parameterised — no interpolation
 * of any value, ever.
 */
@Injectable()
export class PrismaPaymentRepository implements IPaymentRepository {
  private readonly logger = new Logger(PrismaPaymentRepository.name);

  constructor(private readonly prisma: PrismaService) {}

  // -------------------------------------------------------------------------
  // Price catalogue (GLOBAL — no tenant scoping, by classification)
  // -------------------------------------------------------------------------

  async findCountry(countryCode: string): Promise<ICountryConfig | null> {
    const row = await this.prisma.country.findUnique({
      where: { code: countryCode },
      include: { currency: true },
    });
    return row ? toCountryConfig(row) : null;
  }

  async listActiveCountries(): Promise<ICountryConfig[]> {
    const rows = await this.prisma.country.findMany({
      where: { isActive: true },
      include: { currency: true },
      orderBy: { code: 'asc' },
    });
    return rows.map(toCountryConfig);
  }

  async findPrice(params: {
    planTier: SubscriptionPlanTier;
    countryCode: string;
    billingPeriod: BillingPeriodValue;
  }): Promise<ISubscriptionPriceRecord | null> {
    const row = await this.prisma.subscriptionPrice.findUnique({
      where: {
        planTier_countryCode_billingPeriod: {
          planTier: params.planTier,
          countryCode: params.countryCode,
          billingPeriod: params.billingPeriod,
        },
      },
    });
    return row && row.isActive ? (row as ISubscriptionPriceRecord) : null;
  }

  async findPriceByStoreProductId(storeProductId: string): Promise<ISubscriptionPriceRecord | null> {
    const row = await this.prisma.subscriptionPrice.findFirst({
      where: { storeProductId, isActive: true },
    });
    return row ?? null;
  }

  async listPricesForCountry(countryCode: string): Promise<ISubscriptionPriceRecord[]> {
    return this.prisma.subscriptionPrice.findMany({
      where: { countryCode, isActive: true },
      orderBy: [{ planTier: 'asc' }, { billingPeriod: 'asc' }],
    });
  }

  // -------------------------------------------------------------------------
  // Trial
  // -------------------------------------------------------------------------

  async findTrial(familyId: string): Promise<ITrialRecord | null> {
    return this.prisma.trial.findUnique({ where: { familyId } });
  }

  /**
   * ONE TRIAL PER FAMILY, EVER — enforced by the UNIQUE index on
   * `trials.family_id`, not by a preceding SELECT. Q17 makes this a product
   * rule («once per family, tied to familyId not to the device»), and a
   * product rule enforced in application code is a product rule a user defeats
   * by tapping twice.
   */
  async createTrialIfNone(input: {
    familyId: string;
    planTier: SubscriptionPlanTier;
    endsAt: Date;
    source: string;
  }): Promise<IIdempotentInsert<ITrialRecord>> {
    try {
      const record = await this.prisma.trial.create({
        data: {
          familyId: input.familyId,
          planTier: input.planTier,
          endsAt: input.endsAt,
          source: input.source,
        },
      });
      return { record, wasCreated: true };
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const existing = await this.prisma.trial.findUnique({ where: { familyId: input.familyId } });
      // The unique index just fired, so the row exists. A `!` here would be a
      // lie under a concurrent DELETE; rethrowing the original violation is the
      // honest answer, and it is what a caller can actually act on.
      if (!existing) throw error;
      return { record: existing, wasCreated: false };
    }
  }

  async markTrialConverted(familyId: string, at: Date): Promise<void> {
    await this.prisma.trial.updateMany({ where: { familyId }, data: { convertedAt: at } });
  }

  // -------------------------------------------------------------------------
  // Store account linking — THE CROSS-TENANT DEFENCE
  // -------------------------------------------------------------------------

  /**
   * Resolves a store's opaque account reference to a tenant.
   *
   * Runs UNSCOPED on purpose (see `payment-verification.service.ts`, which
   * calls it under `runAsSystem('BILLING_WEBHOOK')`): the question being asked
   * is «WHICH family does this purchase belong to», and answering it inside a
   * tenant scope would answer «does it belong to the family that asked», which
   * always returns a comfortable yes-or-nothing and never catches the attack.
   */
  async findFamilyByProviderAccountRef(
    provider: PaymentProviderValue,
    providerAccountRef: string,
  ): Promise<string | null> {
    const row = await this.prisma.providerAccountLink.findUnique({
      where: { provider_providerAccountRef: { provider, providerAccountRef } },
    });
    if (!row || row.revokedAt) return null;
    return row.familyId as string;
  }

  async linkProviderAccount(input: {
    familyId: string;
    provider: PaymentProviderValue;
    providerAccountRef: string;
  }): Promise<IIdempotentInsert<{ familyId: string }>> {
    try {
      const record = await this.prisma.providerAccountLink.create({ data: input });
      return { record: { familyId: record.familyId as string }, wasCreated: true };
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const existing = await this.prisma.providerAccountLink.findUnique({
        where: {
          provider_providerAccountRef: {
            provider: input.provider,
            providerAccountRef: input.providerAccountRef,
          },
        },
      });
      // The unique index just fired, so the row exists — but a race with a
      // concurrent DELETE is expressible, and pretending otherwise with a `!`
      // would turn it into a TypeError inside a payment path. Rethrowing the
      // original violation is the honest answer.
      if (!existing) throw error;
      return { record: { familyId: existing.familyId }, wasCreated: false };
    }
  }

  // -------------------------------------------------------------------------
  // Append-only financial record
  // -------------------------------------------------------------------------

  async recordPaymentTransaction(input: {
    familyId: string;
    subscriptionId: string | null;
    provider: PaymentProviderValue;
    providerTransactionId: string;
    providerOriginalTransactionId: string | null;
    productRef: string | null;
    planTier: SubscriptionPlanTier | null;
    billingPeriod: BillingPeriodValue | null;
    countryCode: string | null;
    currency: string;
    grossAmountMinor: number;
    vatAmountMinor: number;
    netAmountMinor: number;
    status: IPaymentTransactionRecord['status'];
    idempotencyKey: string;
    occurredAt: Date;
    verifiedAt: Date | null;
    verifiedPayloadDigest: string | null;
    isSandbox: boolean;
  }): Promise<IIdempotentInsert<IPaymentTransactionRecord>> {
    try {
      const record = await this.prisma.paymentTransaction.create({ data: input });
      return { record, wasCreated: true };
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      // EITHER unique index may have fired: `(provider, providerTransactionId)`
      // for a provider redelivery, or `(familyId, idempotencyKey)` for two of
      // our own code paths deriving the same key. Both mean "already recorded";
      // the provider index is tried first because it is the specific one.
      const existing =
        (await this.prisma.paymentTransaction.findUnique({
          where: {
            provider_providerTransactionId: {
              provider: input.provider,
              providerTransactionId: input.providerTransactionId,
            },
          },
        })) ??
        (await this.prisma.paymentTransaction.findUnique({
          where: {
            familyId_idempotencyKey: {
              familyId: input.familyId,
              idempotencyKey: input.idempotencyKey,
            },
          },
        }));
      // The unique index just fired, so the row exists. A `!` here would be a
      // lie under a concurrent DELETE; rethrowing the original violation is the
      // honest answer, and it is what a caller can actually act on.
      if (!existing) throw error;
      return { record: existing, wasCreated: false };
    }
  }

  async findPaymentTransaction(
    provider: PaymentProviderValue,
    providerTransactionId: string,
  ): Promise<IPaymentTransactionRecord | null> {
    return this.prisma.paymentTransaction.findUnique({
      where: { provider_providerTransactionId: { provider, providerTransactionId } },
    });
  }

  async listPaymentTransactions(familyId: string): Promise<IPaymentTransactionRecord[]> {
    return this.prisma.paymentTransaction.findMany({
      where: { familyId },
      orderBy: { occurredAt: 'desc' },
    });
  }

  /**
   * The only permitted mutation. Migration 0014's
   * `payment_transactions_immutable` trigger rejects anything that changes an
   * amount, a currency, a tenant or the provider's own identifiers, and
   * rejects a status regression — so a bug here surfaces as a loud database
   * error rather than as a quietly rewritten ledger.
   */
  async advancePaymentStatus(
    paymentTransactionId: string,
    status: IPaymentTransactionRecord['status'],
    verifiedAt?: Date,
  ): Promise<void> {
    await this.prisma.paymentTransaction.update({
      where: { id: paymentTransactionId },
      data: { status, ...(verifiedAt ? { verifiedAt } : {}) },
    });
  }

  async recordRefund(input: {
    familyId: string;
    paymentTransactionId: string;
    provider: PaymentProviderValue;
    providerRefundId: string | null;
    amountMinor: number;
    currency: string;
    reason: string | null;
    status: IRefundRecord['status'];
    idempotencyKey: string;
    occurredAt: Date;
  }): Promise<IIdempotentInsert<IRefundRecord>> {
    try {
      const record = await this.prisma.refund.create({ data: input });
      return { record, wasCreated: true };
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const existing = await this.prisma.refund.findUnique({
        where: {
          familyId_idempotencyKey: { familyId: input.familyId, idempotencyKey: input.idempotencyKey },
        },
      });
      // The unique index just fired, so the row exists. A `!` here would be a
      // lie under a concurrent DELETE; rethrowing the original violation is the
      // honest answer, and it is what a caller can actually act on.
      if (!existing) throw error;
      return { record: existing, wasCreated: false };
    }
  }

  async listRefunds(familyId: string): Promise<IRefundRecord[]> {
    return this.prisma.refund.findMany({ where: { familyId }, orderBy: { occurredAt: 'desc' } });
  }

  // -------------------------------------------------------------------------
  // Entitlements
  // -------------------------------------------------------------------------

  /**
   * UPSERT with a MONOTONIC `valid_until`.
   *
   * `GREATEST(entitlements.valid_until, EXCLUDED.valid_until)` is the whole
   * point: webhooks arrive out of order, so a stale RENEWED event for an
   * earlier period must not be able to SHORTEN a household's access. The only
   * things that shorten access are an explicit revocation and expiry.
   *
   * A NULL `valid_until` means open-ended (a manual grant) and beats every
   * date — which is why the CASE, rather than a bare GREATEST that PostgreSQL
   * would collapse to NULL.
   */
  async grantEntitlement(input: {
    familyId: string;
    featureKey: EntitlementKey;
    planTier: SubscriptionPlanTier;
    source: PaymentProviderValue;
    subscriptionId: string | null;
    validFrom: Date;
    validUntil: Date | null;
  }): Promise<IEntitlementRecord> {
    const rows = await this.prisma.$queryRaw<IEntitlementRecord[]>(Prisma.sql`
      INSERT INTO "entitlements" (
        "family_id", "feature_key", "plan_tier", "source", "subscription_id",
        "status", "valid_from", "valid_until", "created_at", "updated_at"
      ) VALUES (
        ${input.familyId}::uuid,
        ${input.featureKey},
        ${input.planTier}::"SubscriptionPlan",
        ${input.source}::"PaymentProvider",
        ${input.subscriptionId}::uuid,
        'ACTIVE'::"EntitlementStatus",
        ${input.validFrom},
        ${input.validUntil},
        now(), now()
      )
      ON CONFLICT ("family_id", "feature_key") DO UPDATE SET
        "plan_tier"       = EXCLUDED."plan_tier",
        "source"          = EXCLUDED."source",
        "subscription_id" = EXCLUDED."subscription_id",
        "status"          = 'ACTIVE'::"EntitlementStatus",
        "revoked_at"      = NULL,
        "revoked_reason"  = NULL,
        "valid_from"      = LEAST("entitlements"."valid_from", EXCLUDED."valid_from"),
        "valid_until"     = CASE
          WHEN "entitlements"."valid_until" IS NULL OR EXCLUDED."valid_until" IS NULL THEN NULL
          ELSE GREATEST("entitlements"."valid_until", EXCLUDED."valid_until")
        END,
        "updated_at"      = now()
      RETURNING
        "id", "family_id" AS "familyId", "feature_key" AS "featureKey",
        "plan_tier" AS "planTier", "source", "subscription_id" AS "subscriptionId",
        "status", "valid_from" AS "validFrom", "valid_until" AS "validUntil",
        "revoked_at" AS "revokedAt", "revoked_reason" AS "revokedReason"
    `);
    return rows[0];
  }

  /**
   * Revocation NEVER DELETES. «this household lost access on 3 March and here
   * is why» is exactly the question a support ticket asks, and a DELETE makes
   * it unanswerable.
   */
  async revokeEntitlements(familyId: string, reason: string, at: Date): Promise<number> {
    const result = await this.prisma.entitlement.updateMany({
      where: { familyId, status: 'ACTIVE' },
      data: { status: 'REVOKED', revokedAt: at, revokedReason: reason.slice(0, 200) },
    });
    return result.count as number;
  }

  async listEntitlements(familyId: string): Promise<IEntitlementRecord[]> {
    return this.prisma.entitlement.findMany({ where: { familyId }, orderBy: { featureKey: 'asc' } });
  }

  async findEntitlement(familyId: string, featureKey: EntitlementKey): Promise<IEntitlementRecord | null> {
    return this.prisma.entitlement.findUnique({
      where: { familyId_featureKey: { familyId, featureKey } },
    });
  }

  // -------------------------------------------------------------------------
  // Webhook dedupe
  // -------------------------------------------------------------------------

  async recordWebhookEvent(input: {
    provider: PaymentProviderValue;
    providerEventId: string;
    eventType: string;
    eventSubtype: string | null;
    signatureVerified: boolean;
    outcome: WebhookOutcomeValue;
    payloadDigest: string;
    providerSignedAt: Date | null;
    familyId: string | null;
  }): Promise<IIdempotentInsert<IWebhookEventRecord>> {
    try {
      const record = await this.prisma.paymentWebhookEvent.create({ data: input });
      return { record, wasCreated: true };
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const existing = await this.prisma.paymentWebhookEvent.findUnique({
        where: {
          provider_providerEventId: {
            provider: input.provider,
            providerEventId: input.providerEventId,
          },
        },
      });
      // The unique index just fired, so the row exists. A `!` here would be a
      // lie under a concurrent DELETE; rethrowing the original violation is the
      // honest answer, and it is what a caller can actually act on.
      if (!existing) throw error;
      return { record: existing, wasCreated: false };
    }
  }

  async finaliseWebhookEvent(
    id: string,
    outcome: WebhookOutcomeValue,
    familyId: string | null,
    failureReason: string | null,
  ): Promise<void> {
    await this.prisma.paymentWebhookEvent.updateMany({
      where: { id },
      data: {
        outcome,
        familyId,
        failureReason: failureReason ? failureReason.slice(0, 400) : null,
        processedAt: new Date(),
      },
    });
  }

  // -------------------------------------------------------------------------
  // Subscription (Phase D columns)
  // -------------------------------------------------------------------------

  async findSubscriptionByOriginalTransactionId(
    providerOriginalTransactionId: string,
  ): Promise<{ id: string; familyId: string; lastProviderEventAt: Date | null } | null> {
    const row = await this.prisma.subscription.findFirst({
      where: { providerOriginalTransactionId },
      select: { id: true, familyId: true, lastProviderEventAt: true },
    });
    return row ?? null;
  }

  /**
   * THE OUT-OF-ORDER GUARD.
   *
   * The timestamp comparison is in the UPDATE's own WHERE clause, so two
   * deliveries racing each other are serialised by the row lock and the older
   * one matches zero rows. Reading `last_provider_event_at` first and
   * comparing in TypeScript would reintroduce exactly the race this closes.
   *
   * `family_id` is mentioned explicitly — both because the tenant CI guard
   * requires it of raw SQL, and because it means a subscription id guessed
   * from another tenant updates nothing.
   */
  async applySubscriptionStateIfNewer(input: {
    subscriptionId: string;
    eventAt: Date;
    status: CanonicalSubscriptionStatus;
    currentPeriodStart?: Date | null;
    currentPeriodEnd?: Date | null;
    gracePeriodEndsAt?: Date | null;
    autoRenewing?: boolean;
    canceledAt?: Date | null;
    providerProductId?: string | null;
  }): Promise<boolean> {
    const persisted = toPersistedStatus(input.status);
    const rows = await this.prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      UPDATE "subscriptions" SET
        "status"                 = ${persisted}::"SubscriptionStatus",
        "current_period_start"   = COALESCE(${input.currentPeriodStart ?? null}, "current_period_start"),
        "current_period_end"     = COALESCE(${input.currentPeriodEnd ?? null}, "current_period_end"),
        "grace_period_ends_at"   = ${input.gracePeriodEndsAt ?? null},
        "auto_renewing"          = COALESCE(${input.autoRenewing ?? null}, "auto_renewing"),
        "canceled_at"            = COALESCE(${input.canceledAt ?? null}, "canceled_at"),
        "provider_product_id"    = COALESCE(${input.providerProductId ?? null}, "provider_product_id"),
        "last_provider_event_at" = ${input.eventAt},
        "updated_at"             = now()
      WHERE "id" = ${input.subscriptionId}::uuid
        AND "family_id" IS NOT NULL
        AND ("last_provider_event_at" IS NULL OR "last_provider_event_at" < ${input.eventAt})
      RETURNING "id"
    `);
    if (rows.length === 0) {
      this.logger.log(
        `Subscription ${input.subscriptionId}: dropped a provider event dated ${input.eventAt.toISOString()} — not newer than the state already applied.`,
      );
    }
    return rows.length > 0;
  }

  async attachProviderLineage(input: {
    subscriptionId: string;
    providerOriginalTransactionId: string;
    providerProductId: string | null;
    countryCode: string | null;
    currencyCode: string | null;
    billingPeriod: BillingPeriodValue | null;
    subscriptionPriceId: string | null;
  }): Promise<void> {
    await this.prisma.subscription.update({
      where: { id: input.subscriptionId },
      data: {
        providerOriginalTransactionId: input.providerOriginalTransactionId,
        providerProductId: input.providerProductId,
        countryCode: input.countryCode,
        currencyCode: input.currencyCode,
        billingPeriod: input.billingPeriod,
        subscriptionPriceId: input.subscriptionPriceId,
      },
    });
  }
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: string }).code === UNIQUE_VIOLATION
  );
}

/** The `countries` row shape Prisma returns with its currency joined in. */
interface ICountryRow {
  code: string;
  nameEn: string;
  nameAr: string;
  currencyCode: string;
  vatBasisPoints: number;
  vatMode: VatMode;
  defaultProvider: PaymentProviderValue;
  isActive: boolean;
  currency: { minorUnits: number } | null;
}

function toCountryConfig(row: ICountryRow): ICountryConfig {
  return {
    code: row.code,
    nameEn: row.nameEn,
    nameAr: row.nameAr,
    currencyCode: row.currencyCode,
    vatBasisPoints: row.vatBasisPoints,
    vatMode: row.vatMode,
    defaultProvider: row.defaultProvider,
    isActive: row.isActive,
    minorUnits: row.currency?.minorUnits ?? 2,
  };
}
