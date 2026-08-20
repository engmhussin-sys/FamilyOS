import { describe, expect, it } from 'vitest';
import {
  ALL_GAPS,
  activeChildrenGap,
  composeChannelEconomics,
  composeExecutiveCounts,
  composeReferralSummary,
  fetchCohortRetention,
  fetchProductAiMetrics,
  fetchRefunds,
  pickKpi,
} from '@/features/growth/api/adapters';
import type { Campaign, ChannelRow, DailyMetricRow, KpiSnapshot } from '@/features/growth/api/types';

function dailyRow(overrides: Partial<DailyMetricRow> = {}): DailyMetricRow {
  return {
    businessDate: '2026-08-15',
    countryCode: 'EG',
    currencyCode: 'EGP',
    reportingTimeZone: 'Africa/Cairo',
    dau: 1200,
    wau: 4000,
    mau: 9000,
    newRegistrations: 310,
    activations: 96,
    childrenAdded: 280,
    devicesPaired: 190,
    trialsStarted: 120,
    trialsResolved: 88,
    trialsConverted: 26,
    newPaidFamilies: 26,
    payingFamilies: 940,
    activePaidSubscriptions: 940,
    churnedPaidSubscriptions: 56,
    paymentSuccessCount: 31,
    paymentFailureCount: 4,
    referralsQualified: 3,
    netRevenueMinor: 486762,
    mrrMinor: 14758800,
    medianTimeToValueMinutes: 150,
    ...overrides,
  };
}

describe('the adapter layer never invents a number', () => {
  describe('composeExecutiveCounts', () => {
    it('sums FLOWS across the window', () => {
      const result = composeExecutiveCounts([
        dailyRow({ businessDate: '2026-08-14', newRegistrations: 100 }),
        dailyRow({ businessDate: '2026-08-15', newRegistrations: 310 }),
      ]);
      expect(result.data.newRegistrations).toBe(410);
    });

    it('reads STOCKS off the latest row — summing them would count a family once per day', () => {
      const result = composeExecutiveCounts([
        dailyRow({ businessDate: '2026-08-14', payingFamilies: 900 }),
        dailyRow({ businessDate: '2026-08-15', payingFamilies: 940 }),
      ]);
      expect(result.data.payingFamilies).toBe(940);
      expect(result.data.payingFamilies).not.toBe(1840);
    });

    it('orders by business date rather than trusting the response order', () => {
      const result = composeExecutiveCounts([
        dailyRow({ businessDate: '2026-08-15', payingFamilies: 940 }),
        dailyRow({ businessDate: '2026-08-14', payingFamilies: 900 }),
      ]);
      expect(result.data.payingFamilies).toBe(940);
    });

    it('returns nulls — not zeros — for an empty window', () => {
      const result = composeExecutiveCounts([]);
      expect(result.data.newRegistrations).toBeNull();
      expect(result.data.payingFamilies).toBeNull();
      expect(result.data.netRevenueMinor).toBeNull();
    });

    it('returns null when every row in the window is itself null for that field', () => {
      const result = composeExecutiveCounts([dailyRow({ activations: null }), dailyRow({ activations: null })]);
      expect(result.data.activations).toBeNull();
    });

    it('names the endpoint it was composed from, so nothing looks authoritative that is not', () => {
      expect(composeExecutiveCounts([]).composedFrom).toEqual(['GET /admin/growth/daily']);
    });
  });

  describe('composeChannelEconomics', () => {
    const channels: ChannelRow[] = [
      { channel: 'TIKTOK', registrations: 3100, paid: 310, conversion: 0.1 },
      { channel: 'ORGANIC', registrations: 900, paid: 60, conversion: 0.0667 },
    ];

    const campaign: Campaign = {
      id: 'c1',
      name: 'ramadan-2026',
      channel: 'TIKTOK',
      countryCode: 'EG',
      currencyCode: 'EGP',
      startsAt: '2026-03-01T00:00:00.000Z',
      endsAt: '2026-04-01T00:00:00.000Z',
      isActive: true,
      budgetMinor: 5000000,
      targetUsers: 10000,
      targetPaidUsers: 1000,
      spendMinor: 4820000,
      impressions: 1200000,
      clicks: 62000,
      visits: 48000,
      leads: 0,
      budgetUtilisation: 0.964,
      installs: 9600,
      registrations: 3100,
      paidUsers: 310,
      netRevenueMinor: 4867620,
      kpis: [],
      targetAttainment: { users: 0.31, paidUsers: 0.31 },
    };

    it('derives CAC as spend over PAID users, not over registrations', () => {
      const result = composeChannelEconomics(channels, [campaign], 'EG');
      const tiktok = result.data.find((r) => r.channel === 'TIKTOK');
      // 4,820,000 / 310 = 15,548 — a tenth of what dividing by registrations
      // would have shown, which is the reassuring direction.
      expect(tiktok?.cacMinor).toBe(15548);
    });

    it('derives ROAS as revenue over spend', () => {
      const result = composeChannelEconomics(channels, [campaign], 'EG');
      expect(result.data.find((r) => r.channel === 'TIKTOK')?.roas).toBeCloseTo(1.0099, 3);
    });

    it('marks a channel with no campaign as UNATTRIBUTED rather than free', () => {
      const result = composeChannelEconomics(channels, [campaign], 'EG');
      const organic = result.data.find((r) => r.channel === 'ORGANIC');
      expect(organic?.spendUnattributed).toBe(true);
      expect(organic?.spendMinor).toBeNull();
      // The failure this guards: 0 spend would make organic's CAC read as
      // "free" rather than "we did not measure it".
      expect(organic?.cacMinor).toBeNull();
    });

    it('does not attribute another country’s campaign spend to this country', () => {
      const saudiCampaign: Campaign = { ...campaign, id: 'c2', countryCode: 'SA', currencyCode: 'SAR' };
      const result = composeChannelEconomics(channels, [saudiCampaign], 'EG');
      // A SAR campaign contributing to an EGP CAC is the exact currency
      // mixing this dashboard exists to prevent.
      expect(result.data.find((r) => r.channel === 'TIKTOK')?.spendMinor).toBeNull();
    });
  });

  describe('composeReferralSummary', () => {
    it('reports the one referral figure an admin endpoint actually exposes', () => {
      const result = composeReferralSummary([dailyRow({ referralsQualified: 3 }), dailyRow({ referralsQualified: 5 })]);
      expect(result.data.qualified).toBe(8);
    });

    it('keeps the other five fields structurally null — they have no endpoint', () => {
      const result = composeReferralSummary([dailyRow()]);
      expect(result.data.codesIssued).toBeNull();
      expect(result.data.sent).toBeNull();
      expect(result.data.rewardsGranted).toBeNull();
      expect(result.data.fraudRejectionsByReason).toBeNull();
    });
  });

  describe('declared gaps carry no data field at all', () => {
    it.each([
      ['product/AI metrics', fetchProductAiMetrics],
      ['cohort retention', fetchCohortRetention],
      ['refunds', fetchRefunds],
      ['active children', activeChildrenGap],
    ])('%s reports MISSING with a proposed contract', (_label, adapter) => {
      const result = adapter();
      expect(result.kind).toBe('MISSING');
      expect(result.gap.proposedEndpoint.length).toBeGreaterThan(0);
      expect(result.gap.reasonKey.startsWith('growth.gap.')).toBe(true);
      // No numbers can leak out of a MISSING result — there is no field
      // for one to sit in.
      expect(result).not.toHaveProperty('data');
    });

    it('every declared gap has an i18n reason key in both locales', async () => {
      const { translate } = await import('@/shared/i18n/localizationEngine');
      for (const gap of ALL_GAPS) {
        expect(translate('ar', gap.reasonKey)).not.toBe(gap.reasonKey);
        expect(translate('en', gap.reasonKey)).not.toBe(gap.reasonKey);
      }
    });
  });

  describe('pickKpi', () => {
    const snapshot: KpiSnapshot = {
      countryCode: 'EG',
      currencyCode: 'EGP',
      businessDate: '2026-08-16',
      reportingTimeZone: 'Africa/Cairo',
      values: [
        { kpi: 'DAU', provenance: 'ACTUAL', value: 1200, currencyCode: null, kind: 'COUNT' },
        { kpi: 'RETENTION_D90', provenance: 'ACTUAL', value: null, currencyCode: null, kind: 'RATE' },
      ],
    };

    it('finds a KPI without depending on the backend’s ordering', () => {
      expect(pickKpi(snapshot, 'RETENTION_D90')?.value).toBeNull();
    });

    it('returns undefined — not a fabricated row — for a KPI the snapshot does not carry', () => {
      expect(pickKpi(snapshot, 'ARPPU')).toBeUndefined();
    });

    it('tolerates an absent snapshot while a query is still in flight', () => {
      expect(pickKpi(undefined, 'DAU')).toBeUndefined();
    });
  });
});
