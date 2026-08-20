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
} from '../../src/modules/billing/application/ports/payment.repository.port';
import type {
  IBillingRepository,
  ICreateSubscriptionInput,
} from '../../src/modules/billing/application/ports/billing.repository.port';
import type { BillingPeriodValue } from '../../src/modules/billing/application/ports/payment-provider.port';
import type {
  EntitlementKey,
  IInvoiceRecord,
  InvoiceStatusValue,
  IPlanDefinition,
  ISubscriptionRecord,
  PaymentProviderValue,
  SubscriptionPlanTier,
  SubscriptionStatusValue,
} from '../../src/modules/billing/domain/billing.types';
import type { CanonicalSubscriptionStatus } from '../../src/modules/billing/domain/subscription-status';
import { toPersistedStatus } from '../../src/modules/billing/domain/subscription-status';

/**
 * PHASE D — REPOSITORY DOUBLES THAT REIMPLEMENT THE UNIQUE CONSTRAINTS.
 *
 * ===================== WHY THESE ARE NOT SIMPLE STUBS =====================
 *
 * A stub that returns whatever the test wants would make the duplicate,
 * concurrency and idempotency assertions self-fulfilling: they would pass
 * against a service that had no idempotency at all.
 *
 * So every insert here enforces its REAL unique key and returns
 * `wasCreated: false` on a collision, exactly as the PostgreSQL indexes in
 * migration 0014 do:
 *
 *   payment_webhook_events (provider, provider_event_id)
 *   payment_transactions   (provider, provider_transaction_id)
 *   payment_transactions   (family_id, idempotency_key)
 *   refunds                (family_id, idempotency_key)
 *   trials                 (family_id)
 *   provider_account_links (provider, provider_account_ref)
 *   entitlements           (family_id, feature_key)   [upsert, monotonic]
 *
 * `applySubscriptionStateIfNewer` reimplements the conditional UPDATE's WHERE
 * clause, including the strict `>` on the provider timestamp.
 *
 * AND THE CONSTRAINTS THEMSELVES ARE PROVEN SEPARATELY, against a real
 * PostgreSQL built from the migrations, in
 * `test/database/payment-idempotency.integration.spec.ts`. Neither half stands
 * alone: this file proves the SERVICES behave correctly given constraints that
 * hold, and that file proves the constraints hold.
 *
 * ============================== THE CATALOGUE ==============================
 *
 * The prices below are TEST FIXTURES, not the product's prices. Migration 0014
 * deliberately seeds no prices at all (see HUMAN DECISION REQUIRED #1); these
 * exist so the tests have something to compare against, and they use the
 * numbers CONTEXT.md §6 proposes so that a reader recognises them.
 */

export const MARKETS: Record<'EG' | 'SA', ICountryConfig> = {
  EG: {
    code: 'EG',
    nameEn: 'Egypt',
    nameAr: 'مصر',
    currencyCode: 'EGP',
    vatBasisPoints: 1_400,
    vatMode: 'INCLUSIVE',
    defaultProvider: 'PAYMOB',
    isActive: true,
    minorUnits: 2,
  },
  SA: {
    code: 'SA',
    nameEn: 'Saudi Arabia',
    nameAr: 'السعودية',
    currencyCode: 'SAR',
    vatBasisPoints: 1_500,
    vatMode: 'INCLUSIVE',
    defaultProvider: 'MOYASAR',
    isActive: true,
    minorUnits: 2,
  },
};

function price(
  id: string,
  planTier: SubscriptionPlanTier,
  countryCode: 'EG' | 'SA',
  billingPeriod: BillingPeriodValue,
  amountMinor: number,
  storeProductId: string | null,
): ISubscriptionPriceRecord {
  return {
    id,
    planTier,
    countryCode,
    currencyCode: MARKETS[countryCode].currencyCode,
    billingPeriod,
    amountMinor,
    vatMode: 'INCLUSIVE',
    storeProductId,
    isActive: true,
  };
}

/** CONTEXT.md §6's PROPOSED numbers, used here as fixtures. */
export const TEST_PRICES: ISubscriptionPriceRecord[] = [
  price('p-eg-basic-m', 'BASIC', 'EG', 'MONTHLY', 9_900, 'com.abny.basic.monthly.eg'),
  price('p-eg-premium-m', 'PREMIUM', 'EG', 'MONTHLY', 17_900, 'com.abny.premium.monthly.eg'),
  price('p-eg-family-m', 'FAMILY', 'EG', 'MONTHLY', 24_900, 'com.abny.family.monthly.eg'),
  // 20% annual discount: 179 * 12 * 0.8 = 1718.40 EGP.
  price('p-eg-premium-a', 'PREMIUM', 'EG', 'ANNUAL', 171_840, 'com.abny.premium.annual.eg'),
  price('p-sa-basic-m', 'BASIC', 'SA', 'MONTHLY', 1_900, 'com.abny.basic.monthly.sa'),
  price('p-sa-premium-m', 'PREMIUM', 'SA', 'MONTHLY', 3_400, 'com.abny.premium.monthly.sa'),
  price('p-sa-family-m', 'FAMILY', 'SA', 'MONTHLY', 4_900, 'com.abny.family.monthly.sa'),
];

const PLAN_FEATURES: Record<SubscriptionPlanTier, EntitlementKey[]> = {
  FREE: [],
  BASIC: ['multiple_children'],
  PREMIUM: ['ai_diagnostics', 'family_insights', 'multiple_children', 'behavioral_trend_analysis'],
  FAMILY: [
    'ai_diagnostics',
    'family_insights',
    'multiple_children',
    'unlimited_devices_per_child',
    'behavioral_trend_analysis',
    'priority_support',
  ],
  ENTERPRISE: [
    'ai_diagnostics',
    'family_insights',
    'multiple_children',
    'unlimited_devices_per_child',
    'behavioral_trend_analysis',
    'priority_support',
  ],
};

let sequence = 0;
const nextId = (prefix: string) => `${prefix}-${(sequence += 1)}`;

interface ISubscriptionState {
  id: string;
  familyId: string;
  status: CanonicalSubscriptionStatus;
  currentPeriodStart: Date | null;
  currentPeriodEnd: Date | null;
  gracePeriodEndsAt: Date | null;
  autoRenewing: boolean;
  canceledAt: Date | null;
  providerProductId: string | null;
  providerOriginalTransactionId: string | null;
  lastProviderEventAt: Date | null;
}

export class InMemoryPaymentRepository implements IPaymentRepository {
  readonly webhookEvents: IWebhookEventRecord[] = [];
  readonly transactions: IPaymentTransactionRecord[] = [];
  readonly refunds: IRefundRecord[] = [];
  readonly entitlements: IEntitlementRecord[] = [];
  readonly trials: ITrialRecord[] = [];
  readonly accountLinks: Array<{ familyId: string; provider: PaymentProviderValue; ref: string }> = [];
  readonly subscriptions = new Map<string, ISubscriptionState>();

  /** Test helper — pre-link a store account to a family. */
  linkFamily(provider: PaymentProviderValue, ref: string, familyId: string): void {
    this.accountLinks.push({ familyId, provider, ref });
  }

  /** Test helper — inspect what the state machine actually did. */
  subscriptionState(subscriptionId: string): ISubscriptionState | undefined {
    return this.subscriptions.get(subscriptionId);
  }

  registerSubscription(id: string, familyId: string): void {
    this.subscriptions.set(id, {
      id,
      familyId,
      status: 'PENDING',
      currentPeriodStart: null,
      currentPeriodEnd: null,
      gracePeriodEndsAt: null,
      autoRenewing: false,
      canceledAt: null,
      providerProductId: null,
      providerOriginalTransactionId: null,
      lastProviderEventAt: null,
    });
  }

  // -- catalogue ------------------------------------------------------------

  async findCountry(code: string): Promise<ICountryConfig | null> {
    return MARKETS[code as 'EG' | 'SA'] ?? null;
  }

  async listActiveCountries(): Promise<ICountryConfig[]> {
    return Object.values(MARKETS);
  }

  async findPrice(params: {
    planTier: SubscriptionPlanTier;
    countryCode: string;
    billingPeriod: BillingPeriodValue;
  }): Promise<ISubscriptionPriceRecord | null> {
    return (
      TEST_PRICES.find(
        (p) =>
          p.planTier === params.planTier &&
          p.countryCode === params.countryCode &&
          p.billingPeriod === params.billingPeriod,
      ) ?? null
    );
  }

  async findPriceByStoreProductId(storeProductId: string): Promise<ISubscriptionPriceRecord | null> {
    return TEST_PRICES.find((p) => p.storeProductId === storeProductId) ?? null;
  }

  async listPricesForCountry(countryCode: string): Promise<ISubscriptionPriceRecord[]> {
    return TEST_PRICES.filter((p) => p.countryCode === countryCode);
  }

  // -- trial: UNIQUE (family_id) -------------------------------------------

  async findTrial(familyId: string): Promise<ITrialRecord | null> {
    return this.trials.find((t) => t.familyId === familyId) ?? null;
  }

  async createTrialIfNone(input: {
    familyId: string;
    planTier: SubscriptionPlanTier;
    endsAt: Date;
    source: string;
  }): Promise<IIdempotentInsert<ITrialRecord>> {
    const existing = this.trials.find((t) => t.familyId === input.familyId);
    if (existing) return { record: existing, wasCreated: false };
    const record: ITrialRecord = {
      id: nextId('trial'),
      familyId: input.familyId,
      planTier: input.planTier,
      startedAt: new Date(),
      endsAt: input.endsAt,
      source: input.source,
      convertedAt: null,
      cancelledAt: null,
    };
    this.trials.push(record);
    return { record, wasCreated: true };
  }

  async markTrialConverted(familyId: string, at: Date): Promise<void> {
    const index = this.trials.findIndex((t) => t.familyId === familyId);
    if (index >= 0) this.trials[index] = { ...this.trials[index], convertedAt: at };
  }

  // -- account links: UNIQUE (provider, provider_account_ref) --------------

  async findFamilyByProviderAccountRef(
    provider: PaymentProviderValue,
    providerAccountRef: string,
  ): Promise<string | null> {
    return this.accountLinks.find((l) => l.provider === provider && l.ref === providerAccountRef)?.familyId ?? null;
  }

  async linkProviderAccount(input: {
    familyId: string;
    provider: PaymentProviderValue;
    providerAccountRef: string;
  }): Promise<IIdempotentInsert<{ familyId: string }>> {
    const existing = this.accountLinks.find(
      (l) => l.provider === input.provider && l.ref === input.providerAccountRef,
    );
    if (existing) return { record: { familyId: existing.familyId }, wasCreated: false };
    this.accountLinks.push({ familyId: input.familyId, provider: input.provider, ref: input.providerAccountRef });
    return { record: { familyId: input.familyId }, wasCreated: true };
  }

  // -- payment transactions: TWO unique indexes ----------------------------

  async recordPaymentTransaction(
    input: Omit<IPaymentTransactionRecord, 'id'> & { verifiedPayloadDigest: string | null },
  ): Promise<IIdempotentInsert<IPaymentTransactionRecord>> {
    const byProvider = this.transactions.find(
      (t) => t.provider === input.provider && t.providerTransactionId === input.providerTransactionId,
    );
    const byKey = this.transactions.find(
      (t) => t.familyId === input.familyId && t.idempotencyKey === input.idempotencyKey,
    );
    const existing = byProvider ?? byKey;
    if (existing) return { record: existing, wasCreated: false };

    const record: IPaymentTransactionRecord = { id: nextId('txn'), ...input };
    this.transactions.push(record);
    return { record, wasCreated: true };
  }

  async findPaymentTransaction(
    provider: PaymentProviderValue,
    providerTransactionId: string,
  ): Promise<IPaymentTransactionRecord | null> {
    return (
      this.transactions.find((t) => t.provider === provider && t.providerTransactionId === providerTransactionId) ??
      null
    );
  }

  async listPaymentTransactions(familyId: string): Promise<IPaymentTransactionRecord[]> {
    return this.transactions.filter((t) => t.familyId === familyId);
  }

  /**
   * Mirrors the database trigger: ONLY the status and `verifiedAt` may change,
   * and only along the allowed lattice. Anything else throws here exactly as
   * `payment_transactions_immutable` raises in PostgreSQL.
   */
  async advancePaymentStatus(
    id: string,
    status: IPaymentTransactionRecord['status'],
    verifiedAt?: Date,
  ): Promise<void> {
    const index = this.transactions.findIndex((t) => t.id === id);
    if (index < 0) return;
    const current = this.transactions[index];
    const allowed: Record<string, string[]> = {
      PENDING: ['SUCCEEDED', 'FAILED'],
      SUCCEEDED: ['REFUNDED', 'CHARGEBACK'],
      REFUNDED: ['CHARGEBACK'],
      FAILED: [],
      CHARGEBACK: [],
    };
    if (status !== current.status && !allowed[current.status].includes(status)) {
      throw new Error(`payment_transactions row ${id}: status transition ${current.status} -> ${status} is not allowed.`);
    }
    this.transactions[index] = { ...current, status, verifiedAt: verifiedAt ?? current.verifiedAt };
  }

  // -- refunds: UNIQUE (family_id, idempotency_key) ------------------------

  async recordRefund(input: Omit<IRefundRecord, 'id'>): Promise<IIdempotentInsert<IRefundRecord>> {
    const existing = this.refunds.find(
      (r) => r.familyId === input.familyId && r.idempotencyKey === input.idempotencyKey,
    );
    if (existing) return { record: existing, wasCreated: false };
    const record: IRefundRecord = { id: nextId('refund'), ...input };
    this.refunds.push(record);
    return { record, wasCreated: true };
  }

  async listRefunds(familyId: string): Promise<IRefundRecord[]> {
    return this.refunds.filter((r) => r.familyId === familyId);
  }

  // -- entitlements: UPSERT on (family_id, feature_key), MONOTONIC ----------

  async grantEntitlement(input: {
    familyId: string;
    featureKey: EntitlementKey;
    planTier: SubscriptionPlanTier;
    source: PaymentProviderValue;
    subscriptionId: string | null;
    validFrom: Date;
    validUntil: Date | null;
  }): Promise<IEntitlementRecord> {
    const index = this.entitlements.findIndex(
      (e) => e.familyId === input.familyId && e.featureKey === input.featureKey,
    );
    if (index >= 0) {
      const current = this.entitlements[index];
      // GREATEST() on valid_until — a stale renewal must never SHORTEN access;
      // NULL (open-ended) beats every date.
      const validUntil =
        current.validUntil === null || input.validUntil === null
          ? null
          : new Date(Math.max(current.validUntil.getTime(), input.validUntil.getTime()));
      const validFrom = new Date(Math.min(current.validFrom.getTime(), input.validFrom.getTime()));
      const updated: IEntitlementRecord = {
        ...current,
        planTier: input.planTier,
        source: input.source,
        subscriptionId: input.subscriptionId,
        status: 'ACTIVE',
        revokedAt: null,
        revokedReason: null,
        validFrom,
        validUntil,
      };
      this.entitlements[index] = updated;
      return updated;
    }
    const record: IEntitlementRecord = {
      id: nextId('ent'),
      familyId: input.familyId,
      featureKey: input.featureKey,
      planTier: input.planTier,
      source: input.source,
      subscriptionId: input.subscriptionId,
      status: 'ACTIVE',
      validFrom: input.validFrom,
      validUntil: input.validUntil,
      revokedAt: null,
      revokedReason: null,
    };
    this.entitlements.push(record);
    return record;
  }

  async extendEntitlements(familyId: string, validUntil: Date): Promise<number> {
    // The same WHERE the real `updateMany` uses: ACTIVE rows with a bounded
    // window that ends EARLIER than the new one. A refund stays refunded, an
    // open-ended manual grant stays open-ended, and a longer paid window is
    // never shortened.
    let count = 0;
    for (let i = 0; i < this.entitlements.length; i += 1) {
      const row = this.entitlements[i];
      if (row.familyId !== familyId) continue;
      if (row.status !== 'ACTIVE') continue;
      if (row.validUntil === null || row.validUntil.getTime() >= validUntil.getTime()) continue;
      this.entitlements[i] = { ...row, validUntil };
      count += 1;
    }
    return count;
  }

  async revokeEntitlements(familyId: string, reason: string, at: Date): Promise<number> {
    let count = 0;
    for (let i = 0; i < this.entitlements.length; i += 1) {
      if (this.entitlements[i].familyId === familyId && this.entitlements[i].status === 'ACTIVE') {
        this.entitlements[i] = {
          ...this.entitlements[i],
          status: 'REVOKED',
          revokedAt: at,
          revokedReason: reason.slice(0, 200),
        };
        count += 1;
      }
    }
    return count;
  }

  async listEntitlements(familyId: string): Promise<IEntitlementRecord[]> {
    return this.entitlements.filter((e) => e.familyId === familyId);
  }

  async findEntitlement(familyId: string, featureKey: EntitlementKey): Promise<IEntitlementRecord | null> {
    return this.entitlements.find((e) => e.familyId === familyId && e.featureKey === featureKey) ?? null;
  }

  // -- webhook dedupe: UNIQUE (provider, provider_event_id) ----------------

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
    const existing = this.webhookEvents.find(
      (e) => e.provider === input.provider && e.providerEventId === input.providerEventId,
    );
    if (existing) return { record: existing, wasCreated: false };
    const record: IWebhookEventRecord = { id: nextId('whe'), ...input, receivedAt: new Date(), processedAt: null };
    this.webhookEvents.push(record);
    return { record, wasCreated: true };
  }

  async finaliseWebhookEvent(
    id: string,
    outcome: WebhookOutcomeValue,
    familyId: string | null,
  ): Promise<void> {
    const index = this.webhookEvents.findIndex((e) => e.id === id);
    if (index >= 0) {
      this.webhookEvents[index] = { ...this.webhookEvents[index], outcome, familyId, processedAt: new Date() };
    }
  }

  // -- subscription state ---------------------------------------------------

  async findSubscriptionByOriginalTransactionId(
    providerOriginalTransactionId: string,
  ): Promise<{ id: string; familyId: string; lastProviderEventAt: Date | null } | null> {
    for (const state of this.subscriptions.values()) {
      if (state.providerOriginalTransactionId === providerOriginalTransactionId) {
        return { id: state.id, familyId: state.familyId, lastProviderEventAt: state.lastProviderEventAt };
      }
    }
    return null;
  }

  /**
   * The conditional UPDATE, reimplemented — including the STRICT `>` on the
   * provider timestamp, which is the whole out-of-order guard.
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
    const state = this.subscriptions.get(input.subscriptionId);
    if (!state) return false;
    if (state.lastProviderEventAt && state.lastProviderEventAt >= input.eventAt) return false;

    // The persisted spelling is what a real UPDATE would write; round-tripping
    // it here keeps the mapping under test on this path too.
    const persisted: SubscriptionStatusValue = toPersistedStatus(input.status);
    void persisted;

    this.subscriptions.set(input.subscriptionId, {
      ...state,
      status: input.status,
      currentPeriodStart: input.currentPeriodStart ?? state.currentPeriodStart,
      currentPeriodEnd: input.currentPeriodEnd ?? state.currentPeriodEnd,
      gracePeriodEndsAt: input.gracePeriodEndsAt ?? null,
      autoRenewing: input.autoRenewing ?? state.autoRenewing,
      canceledAt: input.canceledAt ?? state.canceledAt,
      providerProductId: input.providerProductId ?? state.providerProductId,
      lastProviderEventAt: input.eventAt,
    });
    return true;
  }

  async attachProviderLineage(input: {
    subscriptionId: string;
    providerOriginalTransactionId: string;
    providerProductId: string | null;
  }): Promise<void> {
    const state = this.subscriptions.get(input.subscriptionId);
    if (!state) return;
    this.subscriptions.set(input.subscriptionId, {
      ...state,
      providerOriginalTransactionId: input.providerOriginalTransactionId,
      providerProductId: input.providerProductId ?? state.providerProductId,
    });
  }
}

/** The Sprint 8 repository, doubled. */
export class InMemoryBillingRepository implements IBillingRepository {
  private readonly subscriptionsByFamily = new Map<string, ISubscriptionRecord>();
  private readonly invoices: IInvoiceRecord[] = [];
  private paymentRepository: InMemoryPaymentRepository | null = null;

  /** Wires the two doubles together the way the real repositories share a DB. */
  bind(payments: InMemoryPaymentRepository): void {
    this.paymentRepository = payments;
  }

  createSubscriptionFor(familyId: string, planTier: SubscriptionPlanTier = 'PREMIUM'): string {
    const id = nextId('sub');
    this.subscriptionsByFamily.set(familyId, {
      id,
      familyId,
      planTier,
      status: 'ACTIVE',
      provider: 'APPLE_IAP',
      providerSubscriptionId: null,
      trialEndsAt: null,
      currentPeriodStart: null,
      currentPeriodEnd: null,
      canceledAt: null,
      pendingDiscountPercent: null,
    });
    this.paymentRepository?.registerSubscription(id, familyId);
    return id;
  }

  async findAllActivePlans(): Promise<IPlanDefinition[]> {
    return (Object.keys(PLAN_FEATURES) as SubscriptionPlanTier[]).map((tier) => this.plan(tier));
  }

  async findPlanByTier(tier: SubscriptionPlanTier): Promise<IPlanDefinition | null> {
    return this.plan(tier);
  }

  private plan(tier: SubscriptionPlanTier): IPlanDefinition {
    return {
      id: `plan-${tier}`,
      tier,
      name: tier,
      // The legacy Sprint 8 column. Phase D reads prices from
      // `subscription_prices`; this stays only for pre-Phase-D callers.
      priceCents: 0,
      currency: 'USD',
      billingIntervalMonths: 1,
      features: PLAN_FEATURES[tier],
      isActive: true,
    };
  }

  async findSubscriptionByFamily(familyId: string): Promise<ISubscriptionRecord | null> {
    return this.subscriptionsByFamily.get(familyId) ?? null;
  }

  async findSubscriptionByProviderSubscriptionId(id: string): Promise<ISubscriptionRecord | null> {
    for (const sub of this.subscriptionsByFamily.values()) {
      if (sub.providerSubscriptionId === id) return sub;
    }
    return null;
  }

  async createSubscription(input: ICreateSubscriptionInput): Promise<ISubscriptionRecord> {
    const id = this.createSubscriptionFor(input.familyId, input.planTier);
    const record = this.subscriptionsByFamily.get(input.familyId)!;
    const updated = { ...record, id, status: input.status, provider: input.provider };
    this.subscriptionsByFamily.set(input.familyId, updated);
    return updated;
  }

  async updateSubscriptionStatus(
    subscriptionId: string,
    status: SubscriptionStatusValue,
    extra?: { canceledAt?: Date; currentPeriodStart?: Date; currentPeriodEnd?: Date; trialEndsAt?: Date },
  ): Promise<void> {
    for (const [familyId, sub] of this.subscriptionsByFamily) {
      if (sub.id === subscriptionId) {
        this.subscriptionsByFamily.set(familyId, { ...sub, status, ...extra });
      }
    }
  }

  async createInvoice(input: {
    subscriptionId: string;
    amountCents: number;
    currency: string;
    status: InvoiceStatusValue;
    providerInvoiceId?: string;
  }): Promise<IInvoiceRecord> {
    const record: IInvoiceRecord = {
      id: nextId('inv'),
      subscriptionId: input.subscriptionId,
      amountCents: input.amountCents,
      currency: input.currency,
      status: input.status,
      providerInvoiceId: input.providerInvoiceId ?? null,
      issuedAt: new Date(),
      paidAt: null,
    };
    this.invoices.push(record);
    return record;
  }

  async markInvoicePaid(invoiceId: string, paidAt: Date): Promise<void> {
    const index = this.invoices.findIndex((i) => i.id === invoiceId);
    if (index >= 0) this.invoices[index] = { ...this.invoices[index], status: 'PAID', paidAt };
  }

  async listInvoicesForSubscription(subscriptionId: string): Promise<IInvoiceRecord[]> {
    return this.invoices.filter((i) => i.subscriptionId === subscriptionId);
  }

  async setPendingDiscount(): Promise<void> {
    /* not exercised by Phase D */
  }

  async clearPendingDiscount(): Promise<void> {
    /* not exercised by Phase D */
  }
}
