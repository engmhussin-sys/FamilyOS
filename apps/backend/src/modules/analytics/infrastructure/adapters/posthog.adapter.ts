import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { IAnalyticsEventInput, IAnalyticsProviderAdapter } from '../../domain/analytics.types';

/** Real interface implementation, honest about needing `POSTHOG_API_KEY`
 * \u2014 same posture as `StripeAdapter`. Never the sole event sink: this
 * is additive to `SelfHostedAnalyticsAdapter`, never a replacement for it. */
@Injectable()
export class PostHogAdapter implements IAnalyticsProviderAdapter {
  readonly providerName = 'POSTHOG';

  constructor(private readonly configService: ConfigService) {}

  async track(_event: IAnalyticsEventInput): Promise<void> {
    const apiKey = this.configService.get<string>('POSTHOG_API_KEY');
    if (!apiKey) {
      // Silently no-ops rather than throwing \u2014 unlike payment adapters
      // (where an unconfigured provider must block a charge), a missing
      // analytics provider should never break the product; the
      // self-hosted adapter already captured the event.
      return;
    }
    // Real integration point, pending POSTHOG_API_KEY + the `posthog-node` package.
  }
}
