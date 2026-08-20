import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import {
  fetchAlerts,
  fetchCampaigns,
  fetchCatalogue,
  fetchChannels,
  fetchDaily,
  fetchForecast,
  fetchFunnel,
  fetchKpis,
  fetchQuarterly,
  fetchSettings,
} from './growthApi';
import {
  fetchNotificationAnalytics,
  fetchPlatformDashboardMetrics,
  type NotificationDecisionAnalytics,
  type PlatformDashboardMetrics,
} from './platformApi';
import type {
  Campaign,
  Channel,
  ChannelRow,
  CountryCode,
  CountryScope,
  DailyMetricRow,
  ForecastScenarioRow,
  FunnelResponse,
  GrowthAlert,
  GrowthCatalogue,
  GrowthSetting,
  KpiSnapshot,
  QuarterlyRow,
} from './types';
import type { DateRange } from '../lib/range';

/**
 * Query keys are structured `['growth', <resource>, ...scope]` so a country
 * or window change invalidates exactly the panels it should and nothing
 * else. Refetches hold the previous render (see `RefetchingOverlay`) instead
 * of flashing a skeleton.
 */

/** Definitions only, no tenant data — cached hard, as the contract invites. */
export function useCatalogue(): UseQueryResult<GrowthCatalogue> {
  return useQuery({
    queryKey: ['growth', 'catalogue'],
    queryFn: fetchCatalogue,
    staleTime: 1000 * 60 * 60,
    gcTime: 1000 * 60 * 60 * 24,
  });
}

export function useKpis(country: CountryScope): UseQueryResult<KpiSnapshot> {
  return useQuery({
    queryKey: ['growth', 'kpis', country],
    queryFn: () => fetchKpis(country),
  });
}

export function useDaily(country: CountryScope, range: DateRange): UseQueryResult<DailyMetricRow[]> {
  return useQuery({
    queryKey: ['growth', 'daily', country, range.from, range.to],
    queryFn: () => fetchDaily(country, range.from, range.to),
  });
}

export function useFunnel(
  country: CountryScope,
  range: DateRange,
  channel?: Channel,
): UseQueryResult<FunnelResponse> {
  return useQuery({
    queryKey: ['growth', 'funnel', country, range.from, range.to, channel ?? 'ALL'],
    queryFn: () => fetchFunnel({ countryCode: country, from: range.from, to: range.to, channel }),
  });
}

export function useChannels(country: CountryScope, range: DateRange): UseQueryResult<ChannelRow[]> {
  return useQuery({
    queryKey: ['growth', 'channels', country, range.from, range.to],
    queryFn: () => fetchChannels(country, range.from, range.to),
  });
}

export function useCampaigns(country: CountryScope): UseQueryResult<Campaign[]> {
  return useQuery({
    queryKey: ['growth', 'campaigns', country],
    queryFn: () => fetchCampaigns(country),
  });
}

export function useForecast(country: CountryCode, months = 12): UseQueryResult<ForecastScenarioRow[]> {
  return useQuery({
    queryKey: ['growth', 'forecast', country, months],
    queryFn: () => fetchForecast(country, months),
  });
}

export function useQuarterly(country: CountryCode, year: number): UseQueryResult<QuarterlyRow[]> {
  return useQuery({
    queryKey: ['growth', 'quarterly', country, year],
    queryFn: () => fetchQuarterly(country, year),
  });
}

export function useAlerts(): UseQueryResult<GrowthAlert[]> {
  return useQuery({
    queryKey: ['growth', 'alerts', 'unacknowledged'],
    queryFn: () => fetchAlerts(false, 50),
  });
}

/**
 * Platform growth configuration — including the three `pilot.*` keys the
 * controlled-pilot gate reads (`pilot.enabled`, `pilot.countries`,
 * `pilot.cohortId`). Configuration, not tenant data, so it caches for a
 * while; it is still re-read on every unlock because the gate drops the
 * cache when the key is discarded.
 */
export function useGrowthSettings(): UseQueryResult<GrowthSetting[]> {
  return useQuery({
    queryKey: ['growth', 'settings'],
    queryFn: fetchSettings,
    staleTime: 1000 * 60 * 5,
  });
}

/**
 * PLATFORM-WIDE totals, all markets at once — the endpoint takes no country.
 * Keyed under `['platform', …]` rather than `['growth', …]` because it is a
 * different backend module with a different scope, and because a country
 * filter change must NOT invalidate it (there is nothing there to filter).
 */
export function usePlatformMetrics(): UseQueryResult<PlatformDashboardMetrics> {
  return useQuery({
    queryKey: ['platform', 'dashboard-metrics'],
    queryFn: fetchPlatformDashboardMetrics,
  });
}

/** Notification decisions for one market and one window. */
export function useNotificationAnalytics(
  country: CountryScope,
  range: DateRange,
): UseQueryResult<NotificationDecisionAnalytics> {
  return useQuery({
    queryKey: ['platform', 'notification-analytics', country, range.from, range.to],
    queryFn: () => fetchNotificationAnalytics({ countryCode: country, from: range.from, to: range.to }),
  });
}
