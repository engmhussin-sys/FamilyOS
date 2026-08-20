export interface IAnalyticsEventInput {
  familyId?: string;
  userId?: string;
  sessionId: string;
  eventName: string;
  payload?: Record<string, unknown>;
  /**
   * PHASE F (`F6-004`, closing `PF-E-004`) — THE CAUSE, so a redelivered domain
   * message counts once.
   *
   * Set ONLY by producers that HAVE a durable cause — today that is
   * `GrowthDomainEventBridge`, which passes `domain_events.id`. Absent for the
   * open `POST /analytics/track` surface, where there is no cause and
   * at-least-once is the correct semantics: two page views really are two page
   * views.
   *
   * OPTIONAL RATHER THAN REQUIRED, deliberately. Making it required would force
   * every ad-hoc caller to invent a value, and an invented idempotency key is
   * worse than none — it either collides (silently dropping real events) or is
   * random (deduplicating nothing while claiming to).
   */
  sourceEventId?: string;
}

export interface IDashboardMetrics {
  totalFamilies: number;
  activeFamiliesLast7Days: number;
  totalDevices: number;
  activeDevicesLast7Days: number;
  trialConversionRate: number;
  /** CLOSES A REAL GAP (proactive business review): the support
   * module's read side was added, but nothing surfaced its queue
   * depth alongside the other growth/health metrics an internal team
   * would check in the same place. Named "last 7 days," not "open" —
   * SupportRequest deliberately has no status/resolved concept (see
   * its own schema docstring), so "open" would be a claim this data
   * can't actually support. */
  supportRequestCountLast7Days: number;
}

/** Optional external analytics adapter \u2014 mirrors the payment-provider
 * pattern exactly: business logic (EventCollectorService, funnel/retention
 * engines) never imports a concrete adapter, only this interface. The
 * self-hosted adapter (writing to AnalyticsEvent) is the real default;
 * PostHog/Mixpanel are additive mirrors, not replacements \u2014 losing them
 * loses nothing this product depends on internally. */
export interface IAnalyticsProviderAdapter {
  readonly providerName: string;
  track(event: IAnalyticsEventInput): Promise<void>;
}

export const ANALYTICS_PROVIDER = Symbol('ANALYTICS_PROVIDER');
