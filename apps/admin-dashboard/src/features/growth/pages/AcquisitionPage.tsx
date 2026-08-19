import { useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from '../../../shared/i18n/LocaleProvider';
import { COUNTRY_CODES, type CountryCode, type CreateCampaignInput } from '../api/types';
import { useCampaigns, useCatalogue, useChannels } from '../api/useGrowthQueries';
import { composeChannelEconomics, type ChannelEconomicsRow } from '../api/adapters';
import { createCampaign } from '../api/growthApi';
import { COUNTRY_CURRENCY, formatCount, formatMoneyMinor, formatRate, formatRatio, NO_DATA } from '../lib/format';
import { rangeFor, type RangePreset } from '../lib/range';
import { CATEGORICAL, DE_EMPHASIS, MARK, CHROME, ALL_PAIRS_SERIES_CAP } from '../lib/vizTokens';
import { useVizMode } from '../lib/useVizMode';
import { ChartFrame, VizTable } from '../components/viz/ChartFrame';
import { roundedBar } from '../components/viz/FunnelChart';
import { AsyncBoundary, ChartSkeleton, ComposedFromNote, RefetchingOverlay } from '../../../shared/components/AsyncState';
import { FilterBar, GrowthPageHeader } from '../components/FilterBar';
import { CampaignForm } from '../components/CampaignForm';

/**
 * Acquisition.
 *
 * What it answers: "which channel and which campaign actually produced a
 * paying family, and what did that family cost."
 *
 * Form choice: horizontal bars for the channel comparison. Channels are
 * NOMINAL — swapping their order changes nothing — so they are one series
 * in slot 1's teal, NOT a value ramp. Colouring each bar darker-where-bigger
 * would double-encode the bar length and burn the identity channel on
 * information the bar already shows.
 *
 * Beyond the top three channels the tail folds into "Other" in the
 * de-emphasis grey rather than growing new hues; the table view carries
 * every row regardless.
 */
export function AcquisitionPage() {
  const { t, locale, isRtl } = useTranslation();
  const mode = useVizMode();
  const queryClient = useQueryClient();

  const [country, setCountry] = useState<CountryCode>('EG');
  const [range, setRange] = useState<RangePreset>('last30');
  const window = useMemo(() => rangeFor(range), [range]);

  const channels = useChannels(country, window);
  const campaigns = useCampaigns(country);
  const catalogue = useCatalogue();

  const economics = composeChannelEconomics(channels.data ?? [], campaigns.data ?? [], country);
  const currency = COUNTRY_CURRENCY[country];

  const create = useMutation({
    mutationFn: (input: CreateCampaignInput) => createCampaign(input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['growth', 'campaigns'] }),
  });

  const ranked = [...economics.data].sort((a, b) => b.registrations - a.registrations);
  const max = Math.max(...ranked.map((r) => r.registrations), 1);

  return (
    <div>
      <GrowthPageHeader title={t('growth.acquisition.title')} subtitle={t('growth.acquisition.subtitle')} />
      <FilterBar
        country={country}
        onCountryChange={(scope) => setCountry((COUNTRY_CODES as readonly string[]).includes(scope) ? (scope as CountryCode) : country)}
        range={range}
        onRangeChange={setRange}
        // Spend and CAC are money, and money has no meaning at the platform
        // scope, so this view does not offer it.
        allowPlatformScope={false}
      />

      <AsyncBoundary
        isLoading={channels.isLoading || campaigns.isLoading}
        error={channels.error ?? campaigns.error}
        isEmpty={ranked.length === 0}
        onRetry={() => {
          void channels.refetch();
          void campaigns.refetch();
        }}
        skeleton={<ChartSkeleton height={260} />}
      >
        <RefetchingOverlay isFetching={channels.isFetching || campaigns.isFetching}>
          <ChartFrame
            mode={mode}
            title={`${t('growth.acquisition.byChannel')} · ${t(`growth.country.${country}`)} · ${currency}`}
            subtitle={t('growth.acquisition.spendUnattributed')}
            table={<ChannelTable rows={ranked} country={country} />}
            footnote={<ComposedFromNote endpoints={economics.composedFrom} />}
          >
            {() => (
              <svg
                viewBox={`0 0 300 ${ranked.length * 34 + 8}`}
                width="100%"
                height={ranked.length * 34 + 8}
                role="img"
                aria-label={t('growth.acquisition.byChannel')}
                style={{ direction: 'ltr' }}
              >
                {ranked.map((row, index) => {
                  const y = index * 34 + 4;
                  const length = (row.registrations / max) * 150;
                  // Colour follows the entity, not the rank: the top three
                  // channels keep slot 1's teal and the tail is grey. A
                  // filter that removes one does not repaint the rest.
                  const color = index < ALL_PAIRS_SERIES_CAP ? CATEGORICAL[0][mode] : DE_EMPHASIS[mode];
                  const barX = isRtl ? 260 - length : 110;
                  return (
                    <g key={row.channel}>
                      <text
                        x={isRtl ? 294 : 6}
                        y={y + 14}
                        textAnchor={isRtl ? 'end' : 'start'}
                        fontSize={11}
                        fill={CHROME.inkSecondary[mode]}
                      >
                        {t(`growth.channel.${row.channel}`)}
                      </text>
                      <path
                        d={roundedBar(barX, y, length, MARK.maxBarThickness - 6, MARK.barRadius, isRtl ? 'start' : 'end')}
                        fill={color}
                      >
                        <title>{`${t(`growth.channel.${row.channel}`)}: ${formatCount(locale, row.registrations)}`}</title>
                      </path>
                      <text
                        x={isRtl ? barX - 6 : barX + length + 6}
                        y={y + 14}
                        textAnchor={isRtl ? 'end' : 'start'}
                        fontSize={10}
                        fontWeight={600}
                        fill={CHROME.inkPrimary[mode]}
                      >
                        {formatCount(locale, row.registrations, true)}
                      </text>
                    </g>
                  );
                })}
              </svg>
            )}
          </ChartFrame>
        </RefetchingOverlay>
      </AsyncBoundary>

      <section className="mt-6">
        <h3 className="mb-3 font-display text-base text-ink">{t('growth.acquisition.byCampaign')}</h3>
        <AsyncBoundary
          isLoading={campaigns.isLoading}
          error={campaigns.error}
          isEmpty={(campaigns.data ?? []).length === 0}
          onRetry={() => void campaigns.refetch()}
          skeleton={<ChartSkeleton height={200} />}
        >
          <div className="overflow-x-auto rounded-card border border-sand-200 bg-white p-4 shadow-quiet">
            <VizTable
              headers={[
                t('growth.acquisition.campaignName'),
                t('growth.filter.channel'),
                t('growth.acquisition.budget'),
                t('growth.acquisition.spend'),
                t('growth.acquisition.installs'),
                t('growth.acquisition.registrations'),
                t('growth.acquisition.paidUsers'),
                t('growth.kpi.CAC'),
                t('growth.kpi.ROAS'),
                t('growth.acquisition.budgetUtilisation'),
              ]}
            >
              {(campaigns.data ?? []).map((campaign) => {
                const cac = campaign.kpis.find((k) => k.kpi === 'CAC');
                const roas = campaign.kpis.find((k) => k.kpi === 'ROAS');
                return (
                  <tr key={campaign.id} className="border-b border-sand-100">
                    <td className="px-3 py-2">{campaign.name}</td>
                    <td className="px-3 py-2">{t(`growth.channel.${campaign.channel}`)}</td>
                    <td className="px-3 py-2">
                      {formatMoneyMinor(locale, campaign.budgetMinor, campaign.currencyCode, campaign.countryCode, {
                        compact: true,
                      })}
                    </td>
                    <td className="px-3 py-2">
                      {formatMoneyMinor(locale, campaign.spendMinor, campaign.currencyCode, campaign.countryCode, {
                        compact: true,
                      })}
                    </td>
                    <td className="px-3 py-2">{formatCount(locale, campaign.installs)}</td>
                    <td className="px-3 py-2">{formatCount(locale, campaign.registrations)}</td>
                    <td className="px-3 py-2">{formatCount(locale, campaign.paidUsers)}</td>
                    <td className="px-3 py-2">
                      {formatMoneyMinor(locale, cac?.value ?? null, campaign.currencyCode, campaign.countryCode)}
                    </td>
                    <td className="px-3 py-2">{formatRatio(locale, roas?.value ?? null)}</td>
                    <td className="px-3 py-2">{formatRate(locale, campaign.budgetUtilisation)}</td>
                  </tr>
                );
              })}
            </VizTable>
          </div>
        </AsyncBoundary>
      </section>

      <section className="mt-6">
        <CampaignForm
          country={country}
          channels={catalogue.data?.channels ?? []}
          isSaving={create.isPending}
          onSubmit={(input) => create.mutate(input)}
        />
      </section>
    </div>
  );
}

function ChannelTable({ rows, country }: { rows: ChannelEconomicsRow[]; country: CountryCode }) {
  const { t, locale } = useTranslation();

  return (
    <VizTable
      headers={[
        t('growth.filter.channel'),
        t('growth.acquisition.spend'),
        t('growth.acquisition.installs'),
        t('growth.acquisition.registrations'),
        t('growth.acquisition.paidUsers'),
        t('growth.kpi.CONVERSION_RATE'),
        t('growth.kpi.CAC'),
        t('growth.kpi.ROAS'),
      ]}
    >
      {rows.map((row) => (
        <tr key={row.channel} className="border-b border-sand-100">
          <td className="px-3 py-2">{t(`growth.channel.${row.channel}`)}</td>
          <td className="px-3 py-2">
            {row.spendUnattributed ? (
              <span className="text-xs text-ink-soft">{NO_DATA}</span>
            ) : (
              formatMoneyMinor(locale, row.spendMinor, row.currencyCode, country, { compact: true })
            )}
          </td>
          <td className="px-3 py-2">{formatCount(locale, row.installs)}</td>
          <td className="px-3 py-2">{formatCount(locale, row.registrations)}</td>
          <td className="px-3 py-2">{formatCount(locale, row.paid)}</td>
          <td className="px-3 py-2">{formatRate(locale, row.conversion)}</td>
          <td className="px-3 py-2">{formatMoneyMinor(locale, row.cacMinor, row.currencyCode, country)}</td>
          <td className="px-3 py-2">{formatRatio(locale, row.roas)}</td>
        </tr>
      ))}
    </VizTable>
  );
}
