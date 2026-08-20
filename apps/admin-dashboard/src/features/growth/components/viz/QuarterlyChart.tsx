import { useTranslation } from '../../../../shared/i18n/LocaleProvider';
import { CHROME, MARK, PROVENANCE } from '../../lib/vizTokens';
import type { VizMode } from '../../lib/useVizMode';
import type { QuarterlyRow } from '../../api/types';
import type { PatternIds } from './ChartFrame';

/** A column with a rounded cap and a square baseline. */
export function roundedColumn(x: number, baseline: number, width: number, height: number, radius: number): string {
  if (height <= 0) return '';
  const r = Math.max(0, Math.min(radius, width / 2, height));
  const top = baseline - height;
  return [
    `M ${x} ${baseline}`,
    `V ${top + r}`,
    `Q ${x} ${top} ${x + r} ${top}`,
    `H ${x + width - r}`,
    `Q ${x + width} ${top} ${x + width} ${top + r}`,
    `V ${baseline}`,
    'Z',
  ].join(' ');
}

/**
 * Target vs actual vs forecast, per quarter — the chart the whole
 * "an assumption must never read as a fact" requirement lands on.
 *
 * The three are separated by FORM before they are separated by colour:
 *
 *   ACTUAL    a solid filled column. It is the only solid fill on the plot.
 *   FORECAST  a column filled with a 45° hatch and outlined with a dashed
 *             stroke. At a glance it is visibly *not* a solid bar; in
 *             greyscale it is still visibly not a solid bar.
 *   TARGET    NOT a column at all. A dashed reference rule laid across the
 *             quarter's band with a triangular notch at its end — the
 *             visual grammar of a threshold, not of a measurement.
 *
 * That last decision is the important one. Drawing the target as a third
 * bar invites the reader to compare three bars and forget which one nobody
 * measured. Drawing it as a rule makes "actual against a commitment" the
 * only reading available.
 *
 * One axis. There is deliberately no second y-scale here: a quarter's
 * revenue and its churn rate are different measures and get different
 * charts, never two scales on one plot.
 */

const PLOT_HEIGHT = 190;
const AXIS_BAND = 34;
const COLUMN_CAP = MARK.maxBarThickness;

interface QuarterlyChartProps {
  /** Rows for ONE metric, ordered by quarter. */
  rows: QuarterlyRow[];
  mode: VizMode;
  patterns: PatternIds;
  formatValue: (value: number | null) => string;
  isRtl: boolean;
}

export function QuarterlyChart({ rows, mode, patterns, formatValue, isRtl }: QuarterlyChartProps) {
  const { t } = useTranslation();

  const values = rows.flatMap((r) => [r.actual, r.forecast, r.target]).filter((v): v is number => v !== null);
  const max = values.length > 0 ? Math.max(...values) : 1;
  const scale = (v: number) => (v / max) * PLOT_HEIGHT;

  const width = 340;
  const bandWidth = width / Math.max(rows.length, 1);
  const forecastColor = PROVENANCE.FORECAST.color?.[mode] ?? CHROME.inkSecondary[mode];
  const actualColor = PROVENANCE.ACTUAL.color?.[mode] ?? CHROME.inkPrimary[mode];
  patterns.registerHatch(forecastColor);

  const ordered = isRtl ? [...rows].reverse() : rows;

  return (
    <svg
      viewBox={`0 0 ${width} ${PLOT_HEIGHT + AXIS_BAND}`}
      width="100%"
      height={PLOT_HEIGHT + AXIS_BAND}
      role="img"
      aria-label={t('growth.forecast.title')}
      style={{ direction: 'ltr' }}
    >
      {patterns.defs}

      {/* Hairline, solid, one step off the surface. Never dashed — a dashed
          line on THIS dashboard means "projection", a reserved meaning. */}
      {[0.25, 0.5, 0.75, 1].map((fraction) => (
        <line
          key={fraction}
          x1={0}
          x2={width}
          y1={PLOT_HEIGHT - PLOT_HEIGHT * fraction}
          y2={PLOT_HEIGHT - PLOT_HEIGHT * fraction}
          stroke={CHROME.grid[mode]}
          strokeWidth={MARK.gridWidth}
        />
      ))}
      <line x1={0} x2={width} y1={PLOT_HEIGHT} y2={PLOT_HEIGHT} stroke={CHROME.axis[mode]} strokeWidth={1} />

      {ordered.map((row, index) => {
        const bandStart = index * bandWidth;
        const center = bandStart + bandWidth / 2;
        // Two columns per band with a 2px surface gap between them.
        const columnWidth = Math.min(COLUMN_CAP, bandWidth / 2 - MARK.surfaceGap * 2);
        const actualX = center - columnWidth - MARK.surfaceGap / 2;
        const forecastX = center + MARK.surfaceGap / 2;

        const actualHeight = row.actual === null ? 0 : scale(row.actual);
        const forecastHeight = row.forecast === null ? 0 : scale(row.forecast);
        const targetY = row.target === null ? null : PLOT_HEIGHT - scale(row.target);

        return (
          <g key={`${row.metric}-${row.quarter}`}>
            {/* ACTUAL: the only solid fill on the plot. `roundedBar` keeps
                the cap rounded and the baseline square — a fully rounded
                rect detaches the column from its baseline and reads as a
                pill. */}
            {row.actual !== null && (
              <path
                d={roundedColumn(actualX, PLOT_HEIGHT, columnWidth, actualHeight, MARK.barRadius)}
                fill={actualColor}
              >
                <title>{`${t('growth.provenance.actual')}: ${formatValue(row.actual)}`}</title>
              </path>
            )}

            {row.forecast !== null && (
              <path
                d={roundedColumn(forecastX, PLOT_HEIGHT, columnWidth, forecastHeight, MARK.barRadius)}
                fill={patterns.hatch(forecastColor)}
                stroke={forecastColor}
                strokeWidth={1.5}
                strokeDasharray={PROVENANCE.FORECAST.strokeDasharray ?? undefined}
              >
                <title>{`${t('growth.provenance.forecast')}: ${formatValue(row.forecast)}`}</title>
              </path>
            )}

            {/* TARGET: a rule, not a bar. Dashed, in ink rather than in a
                series colour, with a notch so it reads as a threshold even
                where it happens to graze a column's cap. */}
            {targetY !== null && (
              <g>
                <line
                  x1={bandStart + 4}
                  x2={bandStart + bandWidth - 4}
                  y1={targetY}
                  y2={targetY}
                  stroke={CHROME.inkSecondary[mode]}
                  strokeWidth={2}
                  strokeDasharray={PROVENANCE.TARGET.strokeDasharray ?? undefined}
                />
                <path
                  d={`M ${bandStart + bandWidth - 4} ${targetY} l -6 -4 v 8 z`}
                  fill={CHROME.inkSecondary[mode]}
                />
                <title>{`${t('growth.provenance.target')}: ${formatValue(row.target)}`}</title>
              </g>
            )}

            <text
              x={center}
              y={PLOT_HEIGHT + 16}
              textAnchor="middle"
              fontSize={11}
              fill={CHROME.inkSecondary[mode]}
            >
              Q{row.quarter}
            </text>
            <text x={center} y={PLOT_HEIGHT + 29} textAnchor="middle" fontSize={9} fill={CHROME.inkMuted[mode]}>
              {row.attainment === null ? '' : `${Math.round(row.attainment * 100)}%`}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
