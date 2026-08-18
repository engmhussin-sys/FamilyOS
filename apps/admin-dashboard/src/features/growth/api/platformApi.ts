import { adminGet, adminQuery as query } from '../../../shared/lib/adminHttp';
import type { CountryCode, CountryScope } from './types';
import { PLATFORM_SCOPE } from './types';

/**
 * The two platform-admin endpoints OUTSIDE `/admin/growth/*` that share the
 * same `InternalAdminGuard`, and therefore the same operator key:
 *
 *   GET /analytics/dashboard-metrics
 *     apps/backend/src/modules/analytics/presentation/controllers/analytics.controller.ts:107
 *   GET /system/notifications/analytics
 *     apps/backend/src/modules/notification-engine/presentation/controllers/notification-analytics.controller.ts:59
 *
 * Both were read from the controllers, not from a document. Every field below
 * exists in the backend's own response type; nothing here is anticipated.
 */

/**
 * Transcribed from `IDashboardMetrics`
 * (`src/modules/analytics/domain/analytics.types.ts:25`).
 *
 * PLATFORM-WIDE, ALL MARKETS, and it has no country parameter at all — the
 * service counts `family` and `device` rows with no country predicate. That
 * is why the panel rendering it is labelled as a platform total and is NOT
 * placed inside a country column: a total shown under «مصر» would be read as
 * Egypt's, and it is not.
 *
 * "Active" here means a device whose `lastSeenAt` is inside 7 days — a device
 * heartbeat, not a person. So it answers "active families", and cannot answer
 * "active parents" or "active children"; those stay declared gaps.
 */
export interface PlatformDashboardMetrics {
  totalFamilies: number;
  activeFamiliesLast7Days: number;
  totalDevices: number;
  activeDevicesLast7Days: number;
  /**
   * DELIBERATELY NOT RENDERED. The service converts a null (no trial has
   * resolved yet) into `0` before it leaves the backend — see the comment in
   * `DashboardMetricsService.getMetrics`. A 0 that might mean "unmeasured" is
   * exactly the number this dashboard refuses to print, and the honest
   * per-country `TRIAL_CONVERSION_RATE` KPI from `/admin/growth/kpis` says
   * `null` properly. The field is kept in the type so the reason is visible
   * at the place someone would otherwise reach for it.
   */
  trialConversionRate: number;
  supportRequestCountLast7Days: number;
}

export function fetchPlatformDashboardMetrics(): Promise<PlatformDashboardMetrics> {
  return adminGet<PlatformDashboardMetrics>('/analytics/dashboard-metrics');
}

/**
 * Transcribed from `DecisionAnalyticsReport`
 * (`src/modules/notifications/application/ports/notification-decision.repository.port.ts:88`).
 *
 * Counts and type names only — the endpoint returns no title, no body, no
 * child id and no family id, by design, and this client asks for nothing
 * else.
 */
export interface NotificationDecisionAnalytics {
  total: number;
  decidedSend: number;
  decidedDefer: number;
  decidedSuppress: number;
  delivered: number;
  outcomeSuppressed: number;
  duplicates: number;
  fatigueBlocked: number;
  deliveryFailures: number;
  aiRewritten: number;
  aiFailed: number;
  opened: number;
  notificationRows: number;
  averageScore: number;
  suppressionRate: number;
  duplicateRate: number;
  aiRewriteRate: number;
  openRate: number;
  /** Already `null` server-side when it cannot be measured — this product has
   * no deep-link attribution, so «acted» is honestly absent rather than 0. */
  actionRate: number | null;
  topTypes: Array<{ type: string; total: number; suppressed: number }>;
}

/**
 * The window is capped at 92 days server-side (`MAX_RANGE_DAYS`), and a
 * longer one is rejected with 400 — the callers here never ask for more than
 * a quarter.
 *
 * `country` is sent ONLY for a real market. At the platform scope the
 * parameter is omitted entirely rather than sent as `**`, which the route
 * would reject as a non-ISO code.
 */
export function fetchNotificationAnalytics(args: {
  countryCode: CountryScope;
  from: string;
  to: string;
}): Promise<NotificationDecisionAnalytics> {
  const country = args.countryCode === PLATFORM_SCOPE ? undefined : (args.countryCode as CountryCode);
  return adminGet<NotificationDecisionAnalytics>(
    `/system/notifications/analytics${query({
      // TWO ROUTES, TWO DATE CONTRACTS, and they are not interchangeable:
      // `/admin/growth/*` parses a full ISO instant, while this route runs
      // `isBusinessDate` and answers 400 to anything that is not
      // `YYYY-MM-DD`. The shared `DateRange` carries instants, so it is
      // narrowed here rather than at the call site — one place, so no future
      // caller has to remember.
      from: businessDate(args.from),
      to: businessDate(args.to),
      country,
    })}`,
  );
}

function businessDate(instant: string): string {
  return instant.slice(0, 10);
}
