import {
  BadRequestException,
  Controller,
  HttpCode,
  InternalServerErrorException,
  Param,
  Post,
  Req,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';

import { PaymentWebhookService } from '../../application/services/payment-webhook.service';
import { SystemRoute } from '../../../../common/tenancy/system-route.decorator';
import type { PaymentProviderValue } from '../../domain/billing.types';

/**
 * PHASE D — ONE PUBLIC WEBHOOK SURFACE FOR EVERY PROVIDER.
 *
 * `POST /webhooks/payments/:provider`
 *
 * Deliberately UNAUTHENTICATED in the session sense — Apple, Google, Paymob,
 * Fawry and Moyasar are server-to-server callers with no user token. The
 * security control is SIGNATURE VERIFICATION inside
 * `PaymentWebhookService.ingest`, which runs before the payload is parsed and
 * before anything is written to a business table. Same posture, and the same
 * reasoning, as the Sprint 8 `StripeWebhookController` beside it — which is
 * left untouched, because Stripe's two handled events still work and breaking
 * them would buy nothing.
 *
 * ==================== WHY THE RAW BODY, EXPLICITLY ====================
 *
 * `req.rawBody` — the EXACT BYTES — not `req.body`. Every signature scheme
 * here (Apple's JWS, Paymob's HMAC-SHA512, Fawry's SHA-256) is computed over
 * bytes. `JSON.parse` followed by `JSON.stringify` re-orders keys and
 * normalises whitespace, and a signature check over a re-serialised object
 * fails for genuine callbacks — after which somebody "fixes" it by removing
 * the check. Requiring the raw body is what prevents that whole story.
 *
 * ======================= WHAT THE STATUS CODES MEAN =======================
 *
 *  200 — signed, deduped, and either applied or deliberately not modelled.
 *        Includes DUPLICATE: Q17 requires an immediate 200 with no
 *        reprocessing, because anything else makes the provider retry a
 *        redelivery forever.
 *  400 — the signature did not verify. The provider SHOULD stop retrying, and
 *        the response deliberately does not say WHY, so it cannot be used as
 *        an oracle for constructing a valid signature.
 *  500 — signed and genuine, and we failed to apply it. The provider SHOULD
 *        retry, and the retry will find the dedupe row and take the
 *        no-op path while the reconciliation job picks up the FAILED row.
 */
@Controller('webhooks/payments')
export class PaymentWebhookController {
  constructor(private readonly webhooks: PaymentWebhookService) {}

  @Post(':provider')
  @HttpCode(200)
  @SystemRoute(
    'BILLING_WEBHOOK',
    'Payment providers are server-to-server callers with no session; the family is resolved from the payload only AFTER the provider signature has been verified inside PaymentWebhookService.ingest.',
  )
  // Public endpoints in this codebase are rate-limited as defence in depth even
  // when a cryptographic control is the real one. 300/min accommodates a
  // provider replaying a backlog after an outage without becoming an
  // amplification target.
  @Throttle({ default: { limit: 300, ttl: 60_000 } })
  async handle(
    @Param('provider') providerParam: string,
    @Req() req: RawBodyRequest<Request>,
  ): Promise<{ received: boolean; outcome: string }> {
    const provider = normaliseProvider(providerParam);
    if (!provider) {
      throw new BadRequestException(`Unknown payment provider "${providerParam}".`);
    }
    if (!req.rawBody) {
      throw new BadRequestException('Missing raw request body — required for signature verification.');
    }

    const result = await this.webhooks.ingest(provider, {
      rawBody: req.rawBody.toString('utf8'),
      headers: req.headers as Record<string, string | undefined>,
    });

    if (result.outcome === 'REJECTED_SIGNATURE') {
      throw new BadRequestException('Invalid webhook signature.');
    }
    if (!result.acknowledged) {
      throw new InternalServerErrorException('Webhook could not be processed; please retry.');
    }
    return { received: true, outcome: result.outcome };
  }
}

/**
 * The URL segment is closed to a known set. An unknown segment is a 400 rather
 * than an attempt to look up an adapter that does not exist — the difference
 * between a diagnosable typo and a 500 with a stack trace.
 */
const PROVIDER_ROUTES: Readonly<Record<string, PaymentProviderValue>> = {
  apple: 'APPLE_IAP',
  google: 'GOOGLE_PLAY',
  paymob: 'PAYMOB',
  fawry: 'FAWRY',
  moyasar: 'MOYASAR',
};

function normaliseProvider(segment: string): PaymentProviderValue | null {
  return PROVIDER_ROUTES[segment.toLowerCase()] ?? null;
}
