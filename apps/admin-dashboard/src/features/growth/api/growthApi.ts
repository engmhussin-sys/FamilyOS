import { adminGet, adminPost, adminQuery as query } from '../../../shared/lib/adminHttp';
import type {
  Campaign,
  CampaignSpendInput,
  ChannelRow,
  CountryCode,
  CountryScope,
  CreateCampaignInput,
  CurrencyCode,
  DailyMetricRow,
  ForecastAssumptions,
  ForecastScenarioName,
  ForecastScenarioRow,
  FunnelResponse,
  GrowthAlert,
  GrowthCatalogue,
  GrowthSetting,
  KpiSnapshot,
  QuarterlyRow,
  TargetMetric,
  Channel,
} from './types';

/**
 * The `/admin/growth/*` client.
 *
 * Auth is `x-internal-admin-key` (contract §1), not the parent JWT. The key
 * is NOT a build-time env var any more — a browser bundle cannot keep a
 * shared secret, so the operator types it in at runtime and it lives in
 * memory only (`features/admin-key/adminKeyStore.ts` states the reasoning in
 * full). `adminGet`/`adminPost` attach the header, and turn a 401/403 into
 * "discard the key and ask again" rather than a retry loop against a
 * known-bad secret.
 *
 * Rejection is 401 without a key and 403 with the wrong role; both surface
 * as `ApiError` with the B3 envelope (`code` / `messageAr` / `requestId`)
 * intact and with no trace of the key in them.
 */

/** Definitions only — no tenant data at all, safe to cache hard. Its whole
 * point is that this dashboard does NOT hardcode the KPI list, the channel
 * list, the funnel order or an event name. */
export function fetchCatalogue(): Promise<GrowthCatalogue> {
  return adminGet<GrowthCatalogue>('/admin/growth/catalogue');
}

export function fetchKpis(countryCode: CountryScope, asOf?: string): Promise<KpiSnapshot> {
  return adminGet<KpiSnapshot>(`/admin/growth/kpis${query({ countryCode, asOf })}`);
}

export function fetchDaily(countryCode: CountryScope, from: string, to: string): Promise<DailyMetricRow[]> {
  return adminGet<DailyMetricRow[]>(`/admin/growth/daily${query({ countryCode, from, to })}`);
}

export function fetchFunnel(args: {
  countryCode: CountryScope;
  from: string;
  to: string;
  channel?: Channel;
  campaignId?: string;
}): Promise<FunnelResponse> {
  return adminGet<FunnelResponse>(`/admin/growth/funnel${query({ ...args })}`);
}

export function fetchChannels(countryCode: CountryScope, from: string, to: string): Promise<ChannelRow[]> {
  return adminGet<ChannelRow[]>(`/admin/growth/channels${query({ countryCode, from, to })}`);
}

export function fetchCampaigns(countryCode: CountryScope): Promise<Campaign[]> {
  return adminGet<Campaign[]>(`/admin/growth/campaigns${query({ countryCode })}`);
}

export function fetchCampaign(id: string): Promise<Campaign> {
  return adminGet<Campaign>(`/admin/growth/campaigns/${id}`);
}

export function createCampaign(input: CreateCampaignInput): Promise<{ id: string }> {
  return adminPost<{ id: string }>('/admin/growth/campaigns', input);
}

/** Idempotent on (campaign, businessDate): re-importing a day CORRECTS the
 * row rather than doubling the spend — and doubled spend would have halved
 * the reported CAC in the reassuring direction. */
export function recordCampaignSpend(id: string, input: CampaignSpendInput): Promise<{ ok: true }> {
  return adminPost<{ ok: true }>(`/admin/growth/campaigns/${id}/spend`, input);
}

export function fetchForecast(countryCode: CountryCode, months = 12): Promise<ForecastScenarioRow[]> {
  return adminGet<ForecastScenarioRow[]>(`/admin/growth/forecast${query({ countryCode, months })}`);
}

export function saveForecastScenario(input: {
  scenario: ForecastScenarioName;
  countryCode: CountryCode;
  currencyCode: CurrencyCode;
  assumptions: ForecastAssumptions;
}): Promise<{ ok: true }> {
  return adminPost<{ ok: true }>('/admin/growth/forecast/scenario', input);
}

/** 28 rows: 4 quarters × 7 metrics, each carrying target AND actual AND
 * forecast. There is no `value` field and there never will be. */
export function fetchQuarterly(countryCode: CountryCode, year: number): Promise<QuarterlyRow[]> {
  return adminGet<QuarterlyRow[]>(`/admin/growth/quarterly${query({ countryCode, year })}`);
}

export function saveQuarterlyTarget(input: {
  countryCode: CountryCode;
  year: number;
  quarter: number;
  metric: TargetMetric;
  targetValue: number;
  currencyCode: CurrencyCode | null;
  note?: string;
}): Promise<{ ok: true }> {
  return adminPost<{ ok: true }>('/admin/growth/quarterly/target', input);
}

export function fetchAlerts(acknowledged = false, limit = 50): Promise<GrowthAlert[]> {
  return adminGet<GrowthAlert[]>(`/admin/growth/alerts${query({ acknowledged: String(acknowledged), limit })}`);
}

export function acknowledgeAlert(id: string): Promise<{ ok: true }> {
  return adminPost<{ ok: true }>(`/admin/growth/alerts/${id}/acknowledge`, {});
}

export function fetchSettings(): Promise<GrowthSetting[]> {
  return adminGet<GrowthSetting[]>('/admin/growth/settings');
}

export function saveSetting(key: string, value: string | number | boolean): Promise<{ ok: true }> {
  return adminPost<{ ok: true }>('/admin/growth/settings', { key, value });
}
