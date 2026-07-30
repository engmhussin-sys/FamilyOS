import { Injectable, Logger } from '@nestjs/common';

import { PrivacyFilter } from './privacy-filter';
import { SelfHostedAnalyticsAdapter } from '../infrastructure/adapters/self-hosted-analytics.adapter';
import { PostHogAdapter } from '../infrastructure/adapters/posthog.adapter';
import type { IAnalyticsEventInput } from '../domain/analytics.types';

/**
 * Analytics Core's Event Collector. The self-hosted adapter is always
 * called \u2014 that's the source of truth Funnel/Retention/Dashboard
 * Metrics query. The optional external adapter (PostHog today) is
 * additionally notified but its failure/absence never blocks ingestion
 * (see PostHogAdapter's own no-op-when-unconfigured behavior).
 */
@Injectable()
export class EventCollectorService {
  private readonly logger = new Logger(EventCollectorService.name);

  constructor(
    private readonly privacyFilter: PrivacyFilter,
    private readonly selfHostedAdapter: SelfHostedAnalyticsAdapter,
    private readonly postHogAdapter: PostHogAdapter,
  ) {}

  async track(event: IAnalyticsEventInput): Promise<void> {
    const sanitized: IAnalyticsEventInput = {
      ...event,
      payload: this.privacyFilter.sanitize(event.payload),
    };

    await this.selfHostedAdapter.track(sanitized);

    try {
      await this.postHogAdapter.track(sanitized);
    } catch (err) {
      this.logger.warn('Optional external analytics provider failed \u2014 event already captured self-hosted', err instanceof Error ? err.message : err);
    }
  }
}
