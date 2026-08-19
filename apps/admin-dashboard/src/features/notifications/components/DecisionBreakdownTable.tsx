import { useTranslation } from '../../../shared/i18n/LocaleProvider';
import { formatCount } from '../../growth/lib/format';
import { VizTable } from '../../growth/components/viz/ChartFrame';
import { UnmeasuredValue } from './UnmeasuredValue';
import type { DecisionBucket } from '../api/decisionBreakdownApi';

/**
 * ONE SLICE OF THE DECISION LEDGER, AS A TABLE.
 *
 * A table and not a chart, deliberately. Every column here is a COUNT and the
 * question is always «which bucket, and by how much» — a reader who has to
 * estimate a bar against an axis to answer that is worse off than one reading
 * the number. `ChartFrame` exists for the series that genuinely are shapes;
 * this borrows only its `VizTable`, so the column rhythm, the tabular figures
 * and the RTL-safe `text-start` are identical to every other table here.
 *
 * THE BUCKET COLUMN IS `dir="ltr"`, always. Its values are the backend's own
 * closed-vocabulary names — `DOMAIN_EVENT`, `REWARD_GRANTED_PARENT`,
 * `rule-based`, `2025-11-20` — and an operator triaging an incident needs the
 * EXACT identifier they will grep for, not a translation of it. Rendering a
 * Latin token inside an RTL paragraph without `dir` is how `REWARD_GRANTED_1`
 * ends up displayed as `1_REWARD_GRANTED`.
 */
export function DecisionBreakdownTable({
  title,
  hint,
  bucketHeader,
  buckets,
  /** TRUE when the server cut this list at its top-N cap. The remainder was
   * never returned, so it is UNMEASURED — printing a zero for it would invent
   * the very number the cap withheld. */
  truncated = false,
  truncationReason,
}: {
  title: string;
  hint: string;
  bucketHeader: string;
  buckets: DecisionBucket[];
  truncated?: boolean;
  truncationReason?: string;
}) {
  const { t, locale } = useTranslation();

  const headers = [
    bucketHeader,
    t('notifications.decisions.column.total'),
    t('notifications.decisions.column.sent'),
    t('notifications.decisions.column.deferred'),
    t('notifications.decisions.column.suppressed'),
    t('notifications.decisions.column.delivered'),
    t('notifications.decisions.column.errors'),
  ];

  return (
    <section className="rounded-card border border-sand-200 bg-white p-5 shadow-quiet">
      <header className="mb-3">
        <h3 className="font-display text-base text-ink">{title}</h3>
        <p className="mt-1 text-sm text-ink-soft">{hint}</p>
      </header>

      {buckets.length === 0 ? (
        // A slice with no rows inside a window that HAS rows is possible
        // (filter by audience and the other audience's table empties), so the
        // per-table empty is a sentence, never an empty `<tbody>` that reads
        // as a broken render.
        <p className="rounded-card border border-dashed border-sand-200 bg-sand-50/60 px-4 py-3 text-sm text-ink-soft">
          {t('notifications.decisions.sliceEmpty')}
        </p>
      ) : (
        <VizTable headers={headers}>
          {buckets.map((row) => (
            <tr key={row.bucket} className="border-b border-sand-100">
              <td className="px-3 py-2 font-mono text-xs text-ink" dir="ltr">
                {row.bucket}
              </td>
              <td className="px-3 py-2 font-medium">{formatCount(locale, row.total)}</td>
              <td className="px-3 py-2">{formatCount(locale, row.decidedSend)}</td>
              <td className="px-3 py-2">{formatCount(locale, row.decidedDefer)}</td>
              <td className="px-3 py-2">{formatCount(locale, row.decidedSuppress)}</td>
              <td className="px-3 py-2">{formatCount(locale, row.delivered)}</td>
              {/* The one column an operator scans first during an incident, so
                  a non-zero value is tinted rather than left to be found. */}
              <td className={`px-3 py-2 ${row.deliveryErrors > 0 ? 'font-medium text-brick-600' : ''}`}>
                {formatCount(locale, row.deliveryErrors)}
              </td>
            </tr>
          ))}

          {truncated && (
            <tr className="border-b border-sand-100 bg-sand-50/60">
              <td className="px-3 py-2 text-xs text-ink-soft">
                {t('notifications.decisions.remainder')}
              </td>
              {/* SIX unmeasured cells, not six zeros. The server returned the
                  top N and stopped; nobody counted the tail, so nobody may
                  print a number for it. */}
              {Array.from({ length: 6 }).map((_, index) => (
                <td key={index} className="px-3 py-2">
                  <UnmeasuredValue
                    reason={truncationReason ?? t('notifications.decisions.remainderWhy')}
                  />
                </td>
              ))}
            </tr>
          )}
        </VizTable>
      )}
    </section>
  );
}
