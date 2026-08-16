import * as crypto from 'crypto';

import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type {
  ICheckoutInput,
  ICheckoutResult,
  IChargeInput,
  IChargeResult,
  IPaymentProvider,
  IPaymentProviderAdapter,
  IProviderWebhookEvent,
  IRefundInput,
  IRefundResult,
  IVerifiedPurchase,
  IVerifyPurchaseInput,
  IWebhookRequest,
  IWebhookVerification,
  ProviderCapability,
  ProviderKind,
} from '../../application/ports/payment-provider.port';
import { PaymentProviderNotConfiguredException } from '../../domain/billing.errors';

/**
 * PHASE D — PAYMOB (EGYPT).
 *
 * =========================== WHY PAYMOB ===========================
 *
 * `00-Company-Response.md` Q15: it is the only Egyptian provider covering all
 * three channels the market needs behind ONE integration — cards
 * (Visa/Mastercard/Meeza), mobile wallets (Vodafone Cash / Orange Money /
 * InstaPay — «the default payment channel for a large segment»), and Fawry
 * cash collection. CONTEXT.md §2 locks the decision.
 *
 * ====================== WHAT IS NOT FABRICATED ======================
 *
 * NO CREDENTIALS EXIST FOR THIS PROJECT AND NONE ARE INVENTED. Paymob merchant
 * onboarding needs a commercial register, a tax card, a bank account in the
 * entity's name and signatory documents, and Q15 puts it at 4–8 realistic
 * weeks (up to 10). Until that completes, this adapter:
 *
 *   - returns `isConfigured() === false`;
 *   - throws `PaymentProviderNotConfiguredException` (a 503, not a generic
 *     failure) from every method that would need to talk to Paymob;
 *   - returns `{verified: false}` — never `true` — from
 *     `verifyWebhookSignature`, so an unconfigured deployment cannot be tricked
 *     into processing an unsigned callback.
 *
 * That is exactly the posture the Sprint 8 adapters had, and A1-Backend-Audit
 * called it honest. It is kept.
 *
 * ==================== THE HMAC, AND ONE CAVEAT ====================
 *
 * Paymob signs its `transaction processed` callback with HMAC-SHA512 over a
 * concatenation — no separators — of a FIXED, ORDERED subset of the
 * transaction object's fields, keyed by the merchant's HMAC secret.
 *
 * THE ORDERED FIELD LIST BELOW IS MARKED `VERIFY BEFORE GO-LIVE`. Paymob's
 * canonical HMAC page (docs.paymob.com/docs/hmac-calculation) is served by a
 * JavaScript-only documentation host that could not be fetched from this
 * environment on 2026-08-16 — the request 302s to an app shell with no
 * content. The list is therefore reproduced from the widely-published Paymob
 * integration order and is a CONFIGURATION CONSTANT in one place, not a
 * scattered literal: an operator with access to the live documentation
 * confirms or corrects `PAYMOB_HMAC_FIELDS` in one edit, and a signature
 * mismatch fails CLOSED (the callback is rejected and logged) rather than
 * silently passing. This is called out in `PHASE-D-Payments-Report.md`
 * §«افتراضات ومخاطر مفتوحة» rather than presented as verified.
 *
 * ================ 3-D SECURE AND THE SOURCE OF TRUTH ================
 *
 * Q15: 3-D Secure is effectively mandatory on Egyptian cards, so the payment
 * flow LEAVES THE APP and may or may not come back. `createCheckout` therefore
 * returns a redirect URL and the subscription stays `PENDING`. The customer
 * returning to the app is not evidence of anything; the WEBHOOK is the source
 * of truth. That is why `verifyPurchase` here queries Paymob's own transaction
 * inquiry rather than believing a client-reported success.
 */
@Injectable()
export class PaymobProvider implements IPaymentProvider, IPaymentProviderAdapter {
  readonly providerName = 'PAYMOB' as const;
  readonly kind: ProviderKind = 'GATEWAY';

  constructor(private readonly configService: ConfigService) {}

  isConfigured(): boolean {
    return (
      !!this.configService.get<string>('PAYMOB_API_KEY') &&
      !!this.configService.get<string>('PAYMOB_HMAC_SECRET') &&
      !!this.configService.get<string>('PAYMOB_INTEGRATION_ID')
    );
  }

  supports(capability: ProviderCapability): boolean {
    return capability === 'CHECKOUT' || capability === 'REFUND' || capability === 'WEBHOOK' || capability === 'VERIFY';
  }

  // -------------------------------------------------------------------------

  async createCheckout(_input: ICheckoutInput): Promise<ICheckoutResult> {
    this.requireConfigured();
    // Unreachable until credentials exist. The real sequence, for whoever
    // implements it against a live account, is Q15's:
    //   POST /api/auth/tokens                -> auth token
    //   POST /api/ecommerce/orders           -> order id (amount from OUR catalogue)
    //   POST /api/acceptance/payment_keys    -> payment key (integration id, billing data)
    //   redirect to /api/acceptance/iframes/{iframeId}?payment_token={key}
    // `amount_cents` MUST be the value `PricingService` computed. It is never
    // read back from the client, and the callback's amount is compared to it.
    throw new PaymentProviderNotConfiguredException('Paymob');
  }

  async verifyPurchase(_input: IVerifyPurchaseInput): Promise<IVerifiedPurchase> {
    this.requireConfigured();
    // GET /api/acceptance/transactions/{id}, or the merchant-order inquiry.
    // Server-to-server, authenticated, never the client's word.
    throw new PaymentProviderNotConfiguredException('Paymob');
  }

  async refund(_input: IRefundInput): Promise<IRefundResult> {
    this.requireConfigured();
    // POST /api/acceptance/void_refund/refund with transaction_id + amount_cents.
    throw new PaymentProviderNotConfiguredException('Paymob');
  }

  /**
   * HMAC-SHA512 over the ordered field concatenation, compared in constant
   * time. FAILS CLOSED with no secret — the same discipline
   * `StripeWebhookService.verifySignature` already established in Sprint 8.
   */
  async verifyWebhookSignature(request: IWebhookRequest): Promise<IWebhookVerification> {
    const secret = this.configService.get<string>('PAYMOB_HMAC_SECRET');
    if (!secret) {
      return { verified: false, reason: 'PAYMOB_HMAC_SECRET is not configured — callback refused, not skipped.' };
    }

    const provided = request.headers['x-paymob-hmac'] ?? extractQueryHmac(request);
    if (!provided) return { verified: false, reason: 'Paymob callback carries no HMAC.' };

    let body: { obj?: Record<string, unknown> };
    try {
      body = JSON.parse(request.rawBody) as { obj?: Record<string, unknown> };
    } catch {
      return { verified: false, reason: 'Paymob callback body is not valid JSON.' };
    }
    if (!body.obj) return { verified: false, reason: 'Paymob callback has no `obj` transaction object.' };

    const expected = crypto
      .createHmac('sha512', secret)
      .update(buildPaymobHmacString(body.obj))
      .digest('hex');

    // timingSafeEqual throws on a length mismatch, so the lengths are compared
    // first — and a length mismatch is itself a rejection, not an exception.
    const expectedBuffer = Buffer.from(expected, 'utf8');
    const providedBuffer = Buffer.from(provided.toLowerCase(), 'utf8');
    if (expectedBuffer.length !== providedBuffer.length) {
      return { verified: false, reason: 'Paymob HMAC length mismatch.' };
    }
    if (!crypto.timingSafeEqual(expectedBuffer, providedBuffer)) {
      return { verified: false, reason: 'Paymob HMAC does not match.' };
    }
    return { verified: true, reason: null };
  }

  async parseWebhook(request: IWebhookRequest): Promise<IProviderWebhookEvent> {
    const body = JSON.parse(request.rawBody) as {
      type?: string;
      obj?: Record<string, unknown>;
    };
    const obj = body.obj ?? {};
    const id = String(obj.id ?? '');
    const success = obj.success === true;
    const pending = obj.pending === true;
    const isRefund = obj.is_refund === true;
    const isVoided = obj.is_voided === true;

    return {
      provider: this.providerName,
      // Paymob's transaction id is its own stable identifier for the event.
      providerEventId: id,
      kind: isRefund || isVoided ? 'REFUNDED' : pending ? 'PAYMENT_PENDING' : success ? 'PAYMENT_SUCCEEDED' : 'PAYMENT_FAILED',
      rawEventType: body.type ?? 'TRANSACTION',
      rawEventSubtype: null,
      signedAt: typeof obj.created_at === 'string' ? new Date(obj.created_at) : null,
      // NO VERIFIED PURCHASE FROM THE CALLBACK. The callback is HMAC-signed,
      // which proves it came from Paymob — it does not prove the amount is the
      // one we asked for. The handler compares against our own order.
      verifiedPurchase: null,
      refund:
        isRefund || isVoided
          ? {
              providerRefundId: id,
              providerTransactionId: String(
                (obj.parent_transaction as { id?: unknown } | undefined)?.id ?? obj.id ?? '',
              ),
              amountMinor: typeof obj.amount_cents === 'number' ? obj.amount_cents : null,
              currency: typeof obj.currency === 'string' ? obj.currency.toUpperCase() : null,
              reason: isVoided ? 'VOIDED' : 'REFUNDED',
              occurredAt: typeof obj.created_at === 'string' ? new Date(obj.created_at) : new Date(),
              isReversal: false,
            }
          : null,
      // Paymob's `merchant_order_id` is OUR reference — the one we generated
      // when creating the order. Tenant resolution goes through it.
      providerOriginalTransactionId: readMerchantOrderId(obj),
      providerAccountRef: readMerchantOrderId(obj),
    };
  }

  /** Sprint 8 contract, unchanged behaviour: loud failure until configured. */
  async charge(_input: IChargeInput): Promise<IChargeResult> {
    this.requireConfigured();
    throw new PaymentProviderNotConfiguredException('Paymob');
  }

  private requireConfigured(): void {
    if (!this.isConfigured()) throw new PaymentProviderNotConfiguredException('Paymob');
  }
}

/**
 * THE ORDERED HMAC FIELD LIST. `VERIFY BEFORE GO-LIVE` — see the class
 * docstring for why this carries a caveat rather than a citation.
 *
 * Exported so that the one place it is asserted (the adapter test) and the one
 * place it is used (above) cannot drift, and so that correcting it is a
 * single-line change in a single file.
 */
export const PAYMOB_HMAC_FIELDS: readonly string[] = [
  'amount_cents',
  'created_at',
  'currency',
  'error_occured',
  'has_parent_transaction',
  'id',
  'integration_id',
  'is_3d_secure',
  'is_auth',
  'is_capture',
  'is_refunded',
  'is_standalone_payment',
  'is_voided',
  'order.id',
  'owner',
  'pending',
  'source_data.pan',
  'source_data.sub_type',
  'source_data.type',
  'success',
];

/**
 * Concatenates the ordered fields with NO separator, lowercasing booleans —
 * Paymob's callback JSON carries real JSON booleans while the HMAC is computed
 * over their Python `str()`-style lowercase text. `JSON.stringify(true)`
 * already yields `"true"`, but writing it explicitly documents the requirement
 * instead of relying on a coincidence.
 */
export function buildPaymobHmacString(obj: Record<string, unknown>): string {
  return PAYMOB_HMAC_FIELDS.map((path) => {
    const value = readPath(obj, path);
    if (value === null || value === undefined) return '';
    if (typeof value === 'boolean') return value ? 'true' : 'false';
    return String(value);
  }).join('');
}

function readPath(obj: Record<string, unknown>, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, key) => {
    if (acc === null || acc === undefined || typeof acc !== 'object') return undefined;
    return (acc as Record<string, unknown>)[key];
  }, obj);
}

function readMerchantOrderId(obj: Record<string, unknown>): string | null {
  const order = obj.order as { merchant_order_id?: unknown } | undefined;
  const value = order?.merchant_order_id;
  return typeof value === 'string' || typeof value === 'number' ? String(value) : null;
}

/** Paymob's redirect callback carries the HMAC as a query parameter. */
function extractQueryHmac(request: IWebhookRequest): string | undefined {
  return request.headers.hmac;
}
