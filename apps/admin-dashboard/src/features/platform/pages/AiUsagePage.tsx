import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';

import { useTranslation } from '../../../shared/i18n/LocaleProvider';
import { AsyncBoundary, GapBlock } from '../../../shared/components/AsyncState';
import { DataTable } from '../../../shared/components/DataTable';

import { aiUsageApi } from '../api/platformRuntimeApi';

/**
 * ===========================================================================
 * WHAT THE MODEL COSTS — with the boundary of the measurement stated.
 * ===========================================================================
 *
 * `GET /ai-core/usage-summary` has been behind the operator key since AI cost
 * tracking landed, and nothing has called it. It rolls `ai_usage_logs` into
 * calls, tokens and dollars over a window, broken down by the feature that
 * spent them.
 *
 * ── THE TWO THINGS THIS NUMBER IS NOT ──────────────────────────────────
 *
 *   IT IS NOT PER-FAMILY, and it cannot be. `AiUsageTrackingService.record`
 *   omits `familyId` from the row it writes, so every row in the table has
 *   `family_id IS NULL`. Any per-household attribution on this screen would be
 *   invented. (The same omission makes `AiBudgetService.status()` a
 *   platform-wide sum wearing a per-family label — a real defect, filed, not
 *   papered over here.)
 *
 *   IT IS NOT TOTAL SPEND. The table has no column for latency, provider,
 *   refusal or failure, and `record()` is reached only on the SUCCESS path. A
 *   call that timed out, was refused by the safety layer, or fell through to
 *   the deterministic template writes NO ROW AT ALL. So this figure is «what
 *   succeeded cost», and the failures are not a smaller number here — they are
 *   absent from the table.
 *
 * Both are declared as gaps beneath the figures rather than silently narrowing
 * the heading, because an operator reading «AI cost» is entitled to know which
 * calls it counted.
 *
 * ── AND THE PRICES ARE A TABLE IN CODE ─────────────────────────────────
 *
 * `AiCostCalculator` holds per-model rates as constants and charges an unknown
 * model at Sonnet's rate. The dollars below are therefore an ESTIMATE derived
 * from token counts, which is why the backend named the column
 * `estimatedCostMicroCents` and why this page repeats the word.
 */

const NO_FAMILY_ATTRIBUTION_GAP = {
  proposedEndpoint: 'ai_usage_logs.family_id — written by AiUsageTrackingService.record',
  reasonKey: 'aiUsage.gapFamilyReason',
};

const NO_FAILURE_RECORD_GAP = {
  proposedEndpoint: 'ai_usage_logs.{latencyMs, provider, outcome} — a row per attempt, not per success',
  reasonKey: 'aiUsage.gapFailureReason',
};

const WINDOWS = [7, 30, 90] as const;

export function AiUsagePage() {
  const { t } = useTranslation();
  const [windowDays, setWindowDays] = useState<number>(30);

  const summary = useQuery({
    queryKey: ['platform-ai-usage', windowDays],
    queryFn: () => aiUsageApi.summary(windowDays),
  });

  const byFeature = Object.entries(summary.data?.byFeature ?? {}).map(([feature, value]) => ({
    feature,
    calls: value.calls,
    costUsd: value.costUsd,
  }));

  return (
    <section>
      <header>
        <h1>{t('aiUsage.title')}</h1>
        <p>{t('aiUsage.intro')}</p>
      </header>

      <fieldset className="mt-4">
        <legend className="text-sm text-ink-soft">{t('aiUsage.window')}</legend>
        <div className="mt-2 flex gap-2">
          {WINDOWS.map((days) => (
            <label key={days} className="flex items-center gap-1.5 text-sm">
              <input
                type="radio"
                name="ai-usage-window"
                checked={windowDays === days}
                onChange={() => setWindowDays(days)}
              />
              {t('aiUsage.days', { days: String(days) })}
            </label>
          ))}
        </div>
      </fieldset>

      <AsyncBoundary
        isLoading={summary.isLoading}
        error={summary.isError ? (summary.error as Error) : null}
        onRetry={() => summary.refetch()}
      >
        <section className="mt-6">
          <h2>{t('aiUsage.totals')}</h2>
          <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <div className="rounded-card border border-sand-200 bg-white p-4">
              <dt className="text-sm text-ink-soft">{t('aiUsage.calls')}</dt>
              <dd className="mt-1 text-2xl tabular-nums">{summary.data?.totalCalls ?? 0}</dd>
            </div>
            <div className="rounded-card border border-sand-200 bg-white p-4">
              <dt className="text-sm text-ink-soft">{t('aiUsage.inputTokens')}</dt>
              <dd className="mt-1 text-2xl tabular-nums">
                {(summary.data?.totalInputTokens ?? 0).toLocaleString()}
              </dd>
            </div>
            <div className="rounded-card border border-sand-200 bg-white p-4">
              <dt className="text-sm text-ink-soft">{t('aiUsage.outputTokens')}</dt>
              <dd className="mt-1 text-2xl tabular-nums">
                {(summary.data?.totalOutputTokens ?? 0).toLocaleString()}
              </dd>
            </div>
            <div className="rounded-card border border-sand-200 bg-white p-4">
              <dt className="text-sm text-ink-soft">{t('aiUsage.estimatedCost')}</dt>
              {/* Four decimals and the word "estimated", both deliberate: this
                  is a token count multiplied by a constant, not an invoice. */}
              <dd className="mt-1 text-2xl tabular-nums" dir="ltr">
                ${(summary.data?.totalCostUsd ?? 0).toFixed(4)}
              </dd>
            </div>
          </dl>
        </section>

        <section className="mt-8">
          <h2>{t('aiUsage.byFeature')}</h2>
          <AsyncBoundary
            isLoading={false}
            error={null}
            isEmpty={byFeature.length === 0}
            emptyHint={t('aiUsage.noUsage')}
          >
            <DataTable
              caption={t('aiUsage.byFeature')}
              columns={[
                {
                  key: 'feature',
                  header: t('aiUsage.feature'),
                  // `unattributed` is the backend's own bucket for a call whose
                  // sourceFeature was never set — shown as itself, not folded
                  // into a neighbour.
                  cell: (row) => row.feature,
                  ltr: true,
                },
                { key: 'calls', header: t('aiUsage.calls'), cell: (row) => row.calls, numeric: true },
                {
                  key: 'costUsd',
                  header: t('aiUsage.estimatedCost'),
                  cell: (row) => `$${row.costUsd.toFixed(4)}`,
                  numeric: true,
                  ltr: true,
                },
              ]}
              rows={byFeature}
              rowKey={(row) => row.feature}
            />
          </AsyncBoundary>
        </section>
      </AsyncBoundary>

      <section className="mt-8">
        <h2>{t('aiUsage.notMeasured')}</h2>
        <div className="grid gap-3">
          <GapBlock gap={NO_FAILURE_RECORD_GAP} />
          <GapBlock gap={NO_FAMILY_ATTRIBUTION_GAP} />
        </div>
      </section>
    </section>
  );
}
