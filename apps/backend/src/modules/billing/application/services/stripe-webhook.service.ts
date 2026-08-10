import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';

import { BILLING_REPOSITORY, type IBillingRepository } from '../ports/billing.repository.port';

/**
 * Follow-up to the master completeness audit — CLOSES A REAL GAP
 * explicitly flagged as "NOT VERIFIED" and confirmed, on
 * investigation, to be genuinely MISSING: zero payment webhook
 * architecture existed anywhere in this codebase. Without this, a
 * subscription cancelled or a charge that fails DAYS after the
 * initial successful charge (both real, common events any real
 * payment provider reports asynchronously) would never reach this
 * system at all — the family's own subscription status would
 * silently drift out of sync with what they're actually being
 * charged.
 *
 * DELIBERATE SCOPE, stated plainly: Stripe only for this first pass
 * (the most common provider, with the clearest documented signature
 * scheme) — Paymob/Fawry/Apple IAP/Google Play each have their own
 * different verification mechanisms, real separate follow-up work,
 * not guessed at here. Only two event types handled
 * (invoice.payment_failed, customer.subscription.deleted) — the two
 * with the clearest, safest mapping to this system's own state
 * machine; successful-renewal handling would need real design
 * decisions about idempotency/period extension this pass doesn't
 * make.
 *
 * Same "real code, waiting for a real secret" posture as
 * StripeAdapter — without STRIPE_WEBHOOK_SECRET configured, this
 * FAILS CLOSED (rejects every request) rather than skipping
 * verification, exactly the discipline every other guard in this
 * codebase already follows.
 */
@Injectable()
export class StripeWebhookService {
  private readonly logger = new Logger(StripeWebhookService.name);

  constructor(
    private readonly configService: ConfigService,
    @Inject(BILLING_REPOSITORY) private readonly repository: IBillingRepository,
  ) {}

  /** Verifies Stripe's own signature scheme: HMAC-SHA256 of
   * "{timestamp}.{rawBody}" using the webhook signing secret, compared
   * using a timing-safe comparison (never a plain === on secret-derived
   * bytes — the same discipline this codebase already uses for
   * pairing token comparisons). */
  verifySignature(rawBody: string, signatureHeader: string | undefined): boolean {
    const secret = this.configService.get<string>('STRIPE_WEBHOOK_SECRET');
    if (!secret) {
      this.logger.warn('Stripe webhook received but STRIPE_WEBHOOK_SECRET is not configured — rejecting.');
      return false;
    }
    if (!signatureHeader) return false;

    const parts = Object.fromEntries(
      signatureHeader.split(',').map((pair) => {
        const [key, value] = pair.split('=');
        return [key, value];
      }),
    );
    const timestamp = parts.t;
    const providedSignature = parts.v1;
    if (!timestamp || !providedSignature) return false;

    const signedPayload = `${timestamp}.${rawBody}`;
    const expectedSignature = crypto.createHmac('sha256', secret).update(signedPayload).digest('hex');

    const expectedBuffer = Buffer.from(expectedSignature, 'hex');
    const providedBuffer = Buffer.from(providedSignature, 'hex');
    if (expectedBuffer.length !== providedBuffer.length) return false;

    return crypto.timingSafeEqual(expectedBuffer, providedBuffer);
  }

  /** Handles the two event types this pass supports. Unknown event
   * types are logged and safely ignored (200 OK) — Stripe retries on
   * non-2xx responses, so acknowledging an event this system doesn't
   * yet act on prevents pointless retries, matching Stripe's own
   * documented recommendation. */
  async handleEvent(event: { type: string; data: { object: Record<string, unknown> } }): Promise<void> {
    switch (event.type) {
      case 'invoice.payment_failed': {
        const providerSubscriptionId = event.data.object.subscription as string | undefined;
        if (!providerSubscriptionId) return;
        const subscription = await this.repository.findSubscriptionByProviderSubscriptionId(providerSubscriptionId);
        if (!subscription) {
          this.logger.warn(`Received payment_failed for unknown providerSubscriptionId: ${providerSubscriptionId}`);
          return;
        }
        await this.repository.updateSubscriptionStatus(subscription.id, 'PAST_DUE');
        break;
      }
      case 'customer.subscription.deleted': {
        const providerSubscriptionId = event.data.object.id as string | undefined;
        if (!providerSubscriptionId) return;
        const subscription = await this.repository.findSubscriptionByProviderSubscriptionId(providerSubscriptionId);
        if (!subscription) {
          this.logger.warn(`Received subscription.deleted for unknown providerSubscriptionId: ${providerSubscriptionId}`);
          return;
        }
        await this.repository.updateSubscriptionStatus(subscription.id, 'CANCELED', { canceledAt: new Date() });
        break;
      }
      default:
        this.logger.log(`Received unhandled Stripe event type: ${event.type} — acknowledged, no action taken.`);
    }
  }
}
