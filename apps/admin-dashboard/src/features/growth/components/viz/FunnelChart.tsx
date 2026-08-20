import { useTranslation } from '../../../../shared/i18n/LocaleProvider';
import { formatCount, formatRate, NO_DATA } from '../../lib/format';
import { CATEGORICAL, CHROME, FUNNEL_SOURCE, MARK, STATUS } from '../../lib/vizTokens';
import type { VizMode } from '../../lib/useVizMode';
import type { FunnelStepRow } from '../../api/types';
import type { PatternIds } from './ChartFrame';

/**
 * The funnel.
 *
 * Form choice: horizontal bars, because the eleven step names are long
 * Arabic labels that would collide as column ticks, and because the reader's
 * job is "compare magnitude down an ordered sequence" — bar length carries
 * that, so colour is free to do the other job the contract demands.
 *
 * Colour therefore does exactly ONE job here: `source`. All bars are the
 * same teal (one series, so no legend box would be needed for identity),
 * and the `source` axis is carried by texture + opacity + a glyph:
 *
 *   DOMAIN_TABLE       solid, full        a row the server wrote
 *   ANALYTICS_EVENT    solid, 0.72        a client event we received
 *   EXTERNAL_REPORTED  45° hatch, 0.60    an ad platform counting itself
 *
 * That last row is the contract's §2 requirement made visual. Drawing a
 * TikTok impression counter at the weight of a `payment_transactions` row
 * is lying by formatting, and hue alone would not survive greyscale.
 */

const ROW_HEIGHT = 46;
const LABEL_WIDTH = 132;
const VALUE_GUTTER = 96;

interface FunnelChartProps {
  steps: FunnelStepRow[];
  mode: VizMode;
  patterns: PatternIds;
  /** The step the whole product hangs on. Highlighted, not merely present. */
  activationStep: FunnelStepRow['step'];
  isRtl: boolean;
}

export function FunnelChart({ steps, mode, patterns, activationStep, isRtl }: FunnelChartProps) {
  const { t, locale } = useTranslation();
  const max = Math.max(...steps.map((s) => s.count), 1);
  const height = steps.length * ROW_HEIGHT + 8;
  const plotWidth = 100; // percentage-based; the SVG scales with its container

  return (
    <svg
      viewBox={`0 0 ${LABEL_WIDTH + plotWidth + VALUE_GUTTER} ${height}`}
      width="100%"
      height={height}
      role="img"
      aria-label={t('growth.funnel.title')}
      style={{ direction: 'ltr' }}
    >
      {patterns.defs}
      {steps.map((step, index) => {
        const previous = index > 0 ? steps[index - 1] : null;
        const barLength = (step.count / max) * plotWidth;
        const y = index * ROW_HEIGHT + 4;
        const source = FUNNEL_SOURCE[step.source];
        const isActivation = step.step === activationStep;
        const teal = CATEGORICAL[0][mode];

        // The 2px surface gap is what separates touching bars — never a
        // stroke. Bars are capped, never filling their band.
        const barHeight = Math.min(MARK.maxBarThickness, ROW_HEIGHT - MARK.surfaceGap * 2 - 14);

        if (source.fillStyle === 'hatched') patterns.registerHatch(teal);

        // In RTL the label sits on the right and the bar grows leftward.
        // The SVG itself stays LTR so the geometry is one coordinate system.
        const labelX = isRtl ? LABEL_WIDTH + plotWidth + VALUE_GUTTER - 6 : 6;
        const barX = isRtl ? LABEL_WIDTH + plotWidth - barLength : LABEL_WIDTH;
        const valueX = isRtl ? LABEL_WIDTH - 8 : LABEL_WIDTH + barLength + 8;

        const dropOff = previous && previous.count > 0 ? previous.count - step.count : null;

        return (
          <g key={step.step}>
            {isActivation && (
              <rect
                x={0}
                y={y - 3}
                width={LABEL_WIDTH + plotWidth + VALUE_GUTTER}
                height={ROW_HEIGHT}
                fill={STATUS.good[mode]}
                fillOpacity={0.08}
                rx={6}
              />
            )}

            <text
              x={labelX}
              y={y + barHeight / 2 + 4}
              textAnchor={isRtl ? 'end' : 'start'}
              fontSize={11}
              fill={CHROME.inkSecondary[mode]}
            >
              {source.glyph} {t(`growth.funnel.step.${step.step}`)}
            </text>

            {/* 4px rounded data-end, square at the baseline. Rendered as a
                path so only the growing end is rounded — in RTL that is the
                left end, in LTR the right. */}
            <path
              d={roundedBar(barX, y, barLength, barHeight, MARK.barRadius, isRtl ? 'start' : 'end')}
              fill={source.fillStyle === 'hatched' ? patterns.hatch(teal) : teal}
              fillOpacity={source.fillStyle === 'hatched' ? 1 : source.opacity}
            >
              <title>
                {`${t(`growth.funnel.step.${step.step}`)} — ${formatCount(locale, step.count)} · ${t(
                  source.labelKey,
                )}`}
              </title>
            </path>

            {/* Direct label at the tip. Selective by construction: this chart
                has one value per row, so labelling every row is the axis,
                not a flood of point labels. */}
            <text
              x={valueX}
              y={y + barHeight / 2 + 4}
              textAnchor={isRtl ? 'end' : 'start'}
              fontSize={11}
              fontWeight={600}
              fill={CHROME.inkPrimary[mode]}
            >
              {formatCount(locale, step.count, true)}
            </text>

            <text
              x={valueX}
              y={y + barHeight / 2 + 16}
              textAnchor={isRtl ? 'end' : 'start'}
              fontSize={9}
              fill={dropOff && dropOff > 0 ? STATUS.serious[mode] : CHROME.inkMuted[mode]}
            >
              {step.stepConversion === null
                ? NO_DATA
                : `${formatRate(locale, step.stepConversion)}${
                    dropOff !== null ? ` · −${formatCount(locale, dropOff, true)}` : ''
                  }`}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

/**
 * A bar with only its data-end rounded and its baseline end square. The
 * skill's spec: 4px rounded data-end, square at the baseline. A fully
 * rounded rect detaches the bar from its baseline and reads as a pill.
 */
export function roundedBar(x: number, y: number, width: number, height: number, radius: number, end: 'start' | 'end'): string {
  const r = Math.max(0, Math.min(radius, width, height / 2));
  if (width <= 0) return '';
  if (end === 'end') {
    return [
      `M ${x} ${y}`,
      `H ${x + width - r}`,
      `Q ${x + width} ${y} ${x + width} ${y + r}`,
      `V ${y + height - r}`,
      `Q ${x + width} ${y + height} ${x + width - r} ${y + height}`,
      `H ${x}`,
      'Z',
    ].join(' ');
  }
  return [
    `M ${x + width} ${y}`,
    `H ${x + r}`,
    `Q ${x} ${y} ${x} ${y + r}`,
    `V ${y + height - r}`,
    `Q ${x} ${y + height} ${x + r} ${y + height}`,
    `H ${x + width}`,
    'Z',
  ].join(' ');
}
