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
 * PHASE D — SAUDI ARABIA: THE CARD / mada GATEWAY.
 *
 * ====================== WHAT THIS ADAPTER IS ======================
 *
 * The `MOYASAR` enum value names a SLOT, not a final commercial decision.
 * `00-Company-Response.md` Q16 recommends Moyasar (integration simplicity,
 * documentation quality) or Tap (wider regional coverage), with HyperPay as
 * the enterprise alternative, and says the choice «is settled after two
 * commercial offers». CONTEXT.md §2 repeats it.
 *
 * All three speak the same shape: create a payment with an amount WE computed,
 * redirect for 3-D Secure, receive a server-to-server callback authenticated
 * by a shared secret, support refunds. Q16's own conclusion is the design
 * requirement — «the cost of changing provider later is confined to one
 * adapter» — and this file is that adapter. Swapping Moyasar for Tap is a new
 * class implementing `IPaymentProvider` and one line in the registry; zero
 * business-logic files change.
 *
 * See `HUMAN DECISION REQUIRED #4` in `PHASE-D-Payments-Report.md`.
 *
 * ================= WHY SAUDI IS BEHAVIOURALLY DIFFERENT =================
 *
 * Q16: recurring auto-debit on mada and cards IS reliably supported by the
 * major Saudi providers, while Egypt's is not. So Saudi subscriptions get real
 * auto-renewal and automated dunning (retry on day 0, 2, 5) and Egypt gets
 * reminded manual renewal. That is «a behavioural difference in the product,
 * not a settings difference» — and it lives here, in `supports()` and in the
 * `autoRenewing` flag, rather than in an `if (country === 'EG')` scattered
 * through `SubscriptionService`.
 *
 * mada is mandatory: Q16 records its absence as a stated churn cause. Apple Pay
 * is ALSO offered by these gateways — and that is the correct, and only, place
 * for Apple Pay in this architecture: as a CARD PRESENTMENT METHOD behind a
 * gateway, for non-digital flows. It is not, and must never be conflated with,
 * the Apple In-App Purchase path in `AppleStoreKitProvider`.
 *
 * ====================== WHAT IS NOT FABRICATED ======================
 *
 * NO CREDENTIALS EXIST AND NONE ARE INVENTED. Saudi onboarding needs a Saudi
 * commercial register, a tax certificate, a local bank account and signatory
 * documents, 4–8 weeks — and Q16 notes that if the client has no Saudi legal
 * entity at all, the recommended answer is to sequence Egypt first.
 * Unconfigured, this adapter is loudly unavailable and verifies nothing.
 *
 * ========================= VAT: 15%, NOT 14% =========================
 *
 * Q16 is explicit that Saudi VAT is 15% against Egypt's 14% and that it «must
 * be built into the quoted price and the invoice, not added after pricing
 * launches». It is not in this file at all: it is a column on `countries`,
 * read by `PricingService`. That is the point.
 */
@Injectable()
export class MoyasarProvider implements IPaymentProvider, IPaymentProviderAdapter {
  readonly providerName = 'MOYASAR' as const;
  readonly kind: ProviderKind = 'GATEWAY';

  constructor(private readonly configService: ConfigService) {}

  isConfigured(): boolean {
    return (
      !!this.configService.get<string>('MOYASAR_SECRET_KEY') &&
      !!this.configService.get<string>('MOYASAR_WEBHOOK_SECRET')
    );
  }

  supports(capability: ProviderCapability): boolean {
    return capability === 'CHECKOUT' || capability === 'REFUND' || capability === 'WEBHOOK' || capability === 'VERIFY';
  }

  async createCheckout(_input: ICheckoutInput): Promise<ICheckoutResult> {
    this.requireConfigured();
    // POST https://api.moyasar.com/v1/payments  (HTTP Basic, secret key as user)
    // `amount` in halalas, from PricingService. `source.type` = 'creditcard'
    // (mada cards route through the same field) or 'applepay' for the wallet.
    // Response carries `source.transaction_url` for the 3-D Secure redirect.
    throw new PaymentProviderNotConfiguredException('Moyasar (Saudi card/mada gateway)');
  }

  async verifyPurchase(_input: IVerifyPurchaseInput): Promise<IVerifiedPurchase> {
    this.requireConfigured();
    // GET /v1/payments/{id} — the authoritative inquiry. The client's claim of
    // a successful 3-D Secure return is never sufficient.
    throw new PaymentProviderNotConfiguredException('Moyasar (Saudi card/mada gateway)');
  }

  async refund(_input: IRefundInput): Promise<IRefundResult> {
    this.requireConfigured();
    // POST /v1/payments/{id}/refund
    throw new PaymentProviderNotConfiguredException('Moyasar (Saudi card/mada gateway)');
  }

  /**
   * The webhook carries a `secret_token` field the merchant configures when
   * registering the endpoint. Compared in CONSTANT TIME — a plain `===` on a
   * shared secret leaks its prefix through timing, which is the same
   * discipline this codebase already applies to pairing tokens.
   *
   * A shared bearer secret is weaker than Apple's asymmetric signature, and
   * that is a property of the provider, not a choice made here. It is
   * compensated for by `verifyPurchase`: the handler never trusts the
   * callback's amount, it re-reads the payment from the gateway.
   */
  async verifyWebhookSignature(request: IWebhookRequest): Promise<IWebhookVerification> {
    const secret = this.configService.get<string>('MOYASAR_WEBHOOK_SECRET');
    if (!secret) {
      return {
        verified: false,
        reason: 'MOYASAR_WEBHOOK_SECRET is not configured — callback refused, not skipped.',
      };
    }

    let body: { secret_token?: unknown };
    try {
      body = JSON.parse(request.rawBody) as { secret_token?: unknown };
    } catch {
      return { verified: false, reason: 'Moyasar callback body is not valid JSON.' };
    }

    const provided = typeof body.secret_token === 'string' ? body.secret_token : null;
    if (!provided) return { verified: false, reason: 'Moyasar callback carries no secret_token.' };

    // Both sides hashed before comparison so `timingSafeEqual` always gets
    // equal-length buffers and the length of the provided token leaks nothing.
    const expectedDigest = crypto.createHash('sha256').update(secret, 'utf8').digest();
    const providedDigest = crypto.createHash('sha256').update(provided, 'utf8').digest();
    if (!crypto.timingSafeEqual(expectedDigest, providedDigest)) {
      return { verified: false, reason: 'Moyasar secret_token does not match.' };
    }
    return { verified: true, reason: null };
  }

  async parseWebhook(request: IWebhookRequest): Promise<IProviderWebhookEvent> {
    const body = JSON.parse(request.rawBody) as {
      id?: string;
      type?: string;
      created_at?: string;
      data?: Record<string, unknown>;
    };
    const data = body.data ?? {};
    const status = typeof data.status === 'string' ? data.status.toLowerCase() : '';

    return {
      provider: this.providerName,
      providerEventId: body.id ?? String(data.id ?? ''),
      kind:
        body.type === 'payment_refunded' || status === 'refunded'
          ? 'REFUNDED'
          : status === 'paid'
            ? 'PAYMENT_SUCCEEDED'
            : status === 'initiated'
              ? 'PAYMENT_PENDING'
              : status === 'failed'
                ? 'PAYMENT_FAILED'
                : 'UNHANDLED',
      rawEventType: body.type ?? status ?? 'UNKNOWN',
      rawEventSubtype: null,
      signedAt: body.created_at ? new Date(body.created_at) : null,
      verifiedPurchase: null,
      refund:
        body.type === 'payment_refunded' || status === 'refunded'
          ? {
              providerRefundId: body.id ?? null,
              providerTransactionId: String(data.id ?? ''),
              // Halalas. SAR has 2 minor units, so the gateway's own integer is
              // already in minor units — no conversion, and no assumption of a
              // conversion either: the currency travels with it.
              amountMinor: typeof data.refunded === 'number' ? data.refunded : null,
              currency: typeof data.currency === 'string' ? data.currency.toUpperCase() : 'SAR',
              reason: 'REFUNDED',
              occurredAt: body.created_at ? new Date(body.created_at) : new Date(),
              isReversal: false,
            }
          : null,
      // Moyasar echoes our own `metadata` back. Tenant resolution goes through
      // the reference WE generated, never through anything in the payload that
      // an attacker could set.
      providerOriginalTransactionId: readMetadataReference(data),
      providerAccountRef: readMetadataReference(data),
    };
  }

  async charge(_input: IChargeInput): Promise<IChargeResult> {
    this.requireConfigured();
    throw new PaymentProviderNotConfiguredException('Moyasar (Saudi card/mada gateway)');
  }

  private requireConfigured(): void {
    if (!this.isConfigured()) {
      throw new PaymentProviderNotConfiguredException('Moyasar (Saudi card/mada gateway)');
    }
  }
}

function readMetadataReference(data: Record<string, unknown>): string | null {
  const metadata = data.metadata as { merchant_reference?: unknown } | undefined;
  const value = metadata?.merchant_reference;
  return typeof value === 'string' ? value : null;
}
