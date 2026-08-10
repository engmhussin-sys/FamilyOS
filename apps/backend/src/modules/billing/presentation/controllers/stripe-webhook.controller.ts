import { BadRequestException, Controller, Headers, Post, Req } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';

import { StripeWebhookService } from '../../application/services/stripe-webhook.service';

/**
 * Follow-up to the master completeness audit — CLOSES A REAL GAP
 * confirmed genuinely missing. Deliberately public (no JwtAuthGuard)
 * — this receives server-to-server calls FROM Stripe, which has no
 * user session; the correct security control here is signature
 * verification (StripeWebhookService.verifySignature), not a bearer
 * token. Rate-limited anyway as defense-in-depth against abuse of a
 * public endpoint, matching this codebase's own established
 * discipline for other public endpoints (support submission,
 * campaign redemption).
 */
@Controller('webhooks/stripe')
export class StripeWebhookController {
  constructor(private readonly webhookService: StripeWebhookService) {}

  @Post()
  @Throttle({ default: { limit: 100, ttl: 60_000 } })
  async handleWebhook(@Req() req: RawBodyRequest<Request>, @Headers('stripe-signature') signature: string | undefined) {
    if (!req.rawBody) {
      throw new BadRequestException('Missing raw request body — required for signature verification.');
    }

    const isValid = this.webhookService.verifySignature(req.rawBody.toString('utf8'), signature);
    if (!isValid) {
      throw new BadRequestException('Invalid webhook signature.');
    }

    const event = JSON.parse(req.rawBody.toString('utf8'));
    await this.webhookService.handleEvent(event);

    return { received: true };
  }
}
