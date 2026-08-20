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
 * PHASE D — FAWRY (EGYPT, CASH COLLECTION).
 *
 * ====================== WHY FAWRY IS DIFFERENT ======================
 *
 * `00-Company-Response.md` Q15 calls this channel «حاسمة — it opens the
 * unbanked market», and it is the reason `SubscriptionStatus.PENDING` exists
 * at all:
 *
 *   FAWRY IS NOT INSTANT. The customer is given a reference number and takes
 *   it to a kiosk, a pharmacy or a grocery — possibly tomorrow, possibly in
 *   three days, possibly never. The subscription stays PENDING for the whole
 *   of that window and becomes ACTIVE only when Fawry's server-to-server
 *   notification says the money arrived.
 *
 * Every other design in this module follows from that one fact: no entitlement
 * on `createCheckout`, no entitlement on the customer returning to the app,
 * and a reference that expires.
 *
 * FAWRY ALSO CANNOT AUTO-DEBIT. Q15 is explicit that recurring charges are
 * impossible on this channel, which is why the Egyptian design is «reminded
 * manual renewal» plus a 7-day grace period, and why `supports('REFUND')` is
 * true but auto-renewal is not a capability at all.
 *
 * ====================== WHAT IS NOT FABRICATED ======================
 *
 * NO CREDENTIALS EXIST AND NONE ARE INVENTED. Fawry issues a `merchantCode`
 * and a `securityKey` after the same 4–8 week onboarding. Unconfigured, this
 * adapter reports `isConfigured() === false`, throws
 * `PaymentProviderNotConfiguredException` (503) from anything that would call
 * Fawry, and returns `{verified: false}` from signature verification.
 *
 * =========================== THE SIGNATURE ===========================
 *
 * Fawry signs its callback with SHA-256 over an ordered concatenation ending
 * in the merchant's security key. As with Paymob, THE EXACT FIELD ORDER IS A
 * SINGLE EXPORTED CONSTANT marked `VERIFY BEFORE GO-LIVE`: Fawry's developer
 * portal was not reachable from this environment on 2026-08-16, and a field
 * order reproduced from memory is precisely the kind of detail that must be
 * confirmed against the live specification rather than asserted. A mismatch
 * fails CLOSED.
 */
@Injectable()
export class FawryProvider implements IPaymentProvider, IPaymentProviderAdapter {
  readonly providerName = 'FAWRY' as const;
  readonly kind: ProviderKind = 'GATEWAY';

  constructor(private readonly configService: ConfigService) {}

  isConfigured(): boolean {
    return (
      !!this.configService.get<string>('FAWRY_MERCHANT_CODE') &&
      !!this.configService.get<string>('FAWRY_SECURITY_KEY')
    );
  }

  supports(capability: ProviderCapability): boolean {
    return capability === 'CHECKOUT' || capability === 'REFUND' || capability === 'WEBHOOK' || capability === 'VERIFY';
  }

  /**
   * Returns an OFFLINE REFERENCE, not a redirect. The subscription must stay
   * PENDING until the notification arrives; anything else gives the product
   * away to anyone who can click "subscribe".
   */
  async createCheckout(_input: ICheckoutInput): Promise<ICheckoutResult> {
    this.requireConfigured();
    // POST /ECommerceWeb/Fawry/payments/charge with paymentMethod: 'PAYATFAWRY'.
    // `amount` MUST come from PricingService. The response carries
    // `referenceNumber` (the kiosk code) and `expirationTime`.
    throw new PaymentProviderNotConfiguredException('Fawry');
  }

  async verifyPurchase(_input: IVerifyPurchaseInput): Promise<IVerifiedPurchase> {
    this.requireConfigured();
    // GET /ECommerceWeb/Fawry/payments/status/v2 — the authoritative inquiry.
    throw new PaymentProviderNotConfiguredException('Fawry');
  }

  async refund(_input: IRefundInput): Promise<IRefundResult> {
    this.requireConfigured();
    throw new PaymentProviderNotConfiguredException('Fawry');
  }

  async verifyWebhookSignature(request: IWebhookRequest): Promise<IWebhookVerification> {
    const securityKey = this.configService.get<string>('FAWRY_SECURITY_KEY');
    if (!securityKey) {
      return { verified: false, reason: 'FAWRY_SECURITY_KEY is not configured — callback refused, not skipped.' };
    }

    let body: Record<string, unknown>;
    try {
      body = JSON.parse(request.rawBody) as Record<string, unknown>;
    } catch {
      return { verified: false, reason: 'Fawry callback body is not valid JSON.' };
    }

    const provided = typeof body.messageSignature === 'string' ? body.messageSignature : null;
    if (!provided) return { verified: false, reason: 'Fawry callback carries no messageSignature.' };

    const expected = crypto
      .createHash('sha256')
      .update(buildFawrySignatureString(body, securityKey))
      .digest('hex');

    const expectedBuffer = Buffer.from(expected, 'utf8');
    const providedBuffer = Buffer.from(provided.toLowerCase(), 'utf8');
    if (expectedBuffer.length !== providedBuffer.length) {
      return { verified: false, reason: 'Fawry signature length mismatch.' };
    }
    if (!crypto.timingSafeEqual(expectedBuffer, providedBuffer)) {
      return { verified: false, reason: 'Fawry signature does not match.' };
    }
    return { verified: true, reason: null };
  }

  async parseWebhook(request: IWebhookRequest): Promise<IProviderWebhookEvent> {
    const body = JSON.parse(request.rawBody) as Record<string, unknown>;
    const status = typeof body.orderStatus === 'string' ? body.orderStatus.toUpperCase() : '';
    const referenceNumber = String(body.fawryRefNumber ?? '');
    const merchantRef = typeof body.merchantRefNumber === 'string' ? body.merchantRefNumber : null;

    return {
      provider: this.providerName,
      // Fawry's own reference number for the collection. Stable across
      // redeliveries of the same event.
      providerEventId: `${referenceNumber}:${status}`,
      kind:
        status === 'PAID'
          ? 'PAYMENT_SUCCEEDED'
          : status === 'REFUNDED'
            ? 'REFUNDED'
            : status === 'NEW' || status === 'UNPAID'
              ? 'PAYMENT_PENDING'
              : status === 'EXPIRED' || status === 'CANCELED' || status === 'FAILED'
                ? 'PAYMENT_FAILED'
                : 'UNHANDLED',
      rawEventType: status || 'UNKNOWN',
      rawEventSubtype: null,
      signedAt: typeof body.paymentTime === 'number' ? new Date(body.paymentTime) : null,
      verifiedPurchase: null,
      refund:
        status === 'REFUNDED'
          ? {
              providerRefundId: referenceNumber,
              providerTransactionId: referenceNumber,
              // Fawry reports major units as a decimal. Converted by the
              // handler against the ORIGINAL transaction's currency, never
              // guessed here.
              amountMinor: typeof body.paymentAmount === 'number' ? Math.round(body.paymentAmount * 100) : null,
              currency: 'EGP',
              reason: 'REFUNDED',
              occurredAt: typeof body.paymentTime === 'number' ? new Date(body.paymentTime) : new Date(),
              isReversal: false,
            }
          : null,
      // OUR reference, generated at checkout. Tenant resolution goes through it.
      providerOriginalTransactionId: merchantRef,
      providerAccountRef: merchantRef,
    };
  }

  async charge(_input: IChargeInput): Promise<IChargeResult> {
    this.requireConfigured();
    throw new PaymentProviderNotConfiguredException('Fawry');
  }

  private requireConfigured(): void {
    if (!this.isConfigured()) throw new PaymentProviderNotConfiguredException('Fawry');
  }
}

/**
 * THE ORDERED SIGNATURE FIELD LIST. `VERIFY BEFORE GO-LIVE` — see the class
 * docstring. One exported constant so that correcting it is one edit.
 */
export const FAWRY_SIGNATURE_FIELDS: readonly string[] = [
  'fawryRefNumber',
  'merchantRefNumber',
  'paymentAmount',
  'orderAmount',
  'orderStatus',
  'paymentMethod',
];

export function buildFawrySignatureString(body: Record<string, unknown>, securityKey: string): string {
  const parts = FAWRY_SIGNATURE_FIELDS.map((field) => {
    const value = body[field];
    if (value === null || value === undefined) return '';
    // Fawry formats monetary values to exactly two decimals in the signature
    // string. `String(120)` would be "120" where Fawry expects "120.00", and
    // that single difference is the usual cause of a "signature mismatch" that
    // people work around by disabling verification.
    if (typeof value === 'number' && (field === 'paymentAmount' || field === 'orderAmount')) {
      return value.toFixed(2);
    }
    return String(value);
  });
  return `${parts.join('')}${securityKey}`;
}
