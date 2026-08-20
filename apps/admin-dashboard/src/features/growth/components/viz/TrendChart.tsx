import { useState } from 'react';
import { CHROME, MARK } from '../../lib/vizTokens';
import type { VizMode } from '../../lib/useVizMode';

/**
 * Trend over time. One axis, always: two measures of different scale get
 * two charts or an index to a common base, never two y-scales on one plot
 * (the single most misleading chart there is).
 *
 * Ships the hover layer by default — a crosshair plus a tooltip — because an
 * SVG chart *is* interactive and a value that only exists in a tooltip is a
 * value that is gated. Every number here is also in the frame's table view.
 */

export interface TrendSeries {
  id: string;
  label: string;
  color: string;
  points: Array<{ x: string; y: number | null }>;
}

const HEIGHT = 180;
const AXIS_BAND = 26;
const WIDTH = 460;

interface TrendChartProps {
  series: TrendSeries[];
  mode: VizMode;
  formatValue: (v: number | null) => string;
  ariaLabel: string;
  isRtl: boolean;
}

export function TrendChart({ series, mode, formatValue, ariaLabel, isRtl }: TrendChartProps) {
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);

  const length = Math.max(...series.map((s) => s.points.length), 0);
  if (length === 0) return null;

  const allY = series.flatMap((s) => s.points.map((p) => p.y)).filter((v): v is number => v !== null);
  const max = allY.length > 0 ? Math.max(...allY) : 1;
  const min = 0; // Bar/line charts start at zero; a truncated axis exaggerates change.

  const xAt = (index: number) => {
    const raw = length === 1 ? WIDTH / 2 : (index / (length - 1)) * WIDTH;
    return isRtl ? WIDTH - raw : raw;
  };
  const yAt = (value: number) => HEIGHT - ((value - min) / (max - min || 1)) * HEIGHT;

  const labels = series[0]?.points.map((p) => p.x) ?? [];

  return (
    <div className="relative">
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT + AXIS_BAND}`}
        width="100%"
        height={HEIGHT + AXIS_BAND}
        role="img"
        aria-label={ariaLabel}
        style={{ direction: 'ltr' }}
        onMouseLeave={() => setHoverIndex(null)}
      >
        {[0.25, 0.5, 0.75, 1].map((fraction) => (
          <line
            key={fraction}
            x1={0}
            x2={WIDTH}
            y1={HEIGHT - HEIGHT * fraction}
            y2={HEIGHT - HEIGHT * fraction}
            stroke={CHROME.grid[mode]}
            strokeWidth={MARK.gridWidth}
          />
        ))}
        <line x1={0} x2={WIDTH} y1={HEIGHT} y2={HEIGHT} stroke={CHROME.axis[mode]} strokeWidth={1} />

        {series.map((s) => {
          const d = s.points
            .map((p, i) => (p.y === null ? null : `${i === 0 ? 'M' : 'L'} ${xAt(i)} ${yAt(p.y)}`))
            .filter(Boolean)
            .join(' ');
          return (
            <g key={s.id}>
              <path d={d} fill="none" stroke={s.color} strokeWidth={MARK.lineWidth} strokeLinejoin="round" strokeLinecap="round" />
              {/* End marker with a 2px surface ring, so it stays legible
                  where two series cross. */}
              {(() => {
                const lastIndex = [...s.points].map((p, i) => (p.y === null ? -1 : i)).filter((i) => i >= 0).pop();
                if (lastIndex === undefined) return null;
                const value = s.points[lastIndex].y;
                if (value === null) return null;
                return (
                  <circle
                    cx={xAt(lastIndex)}
                    cy={yAt(value)}
                    r={MARK.markerRadius}
                    fill={s.color}
                    stroke={CHROME.surface[mode]}
                    strokeWidth={MARK.surfaceGap}
                  />
                );
              })()}
            </g>
          );
        })}

        {/* Hit targets wider than the marks — 24px minimum, not a pinpoint. */}
        {labels.map((label, index) => (
          <rect
            key={label}
            x={xAt(index) - WIDTH / Math.max(length, 1) / 2}
            y={0}
            width={WIDTH / Math.max(length, 1)}
            height={HEIGHT}
            fill="transparent"
            onMouseEnter={() => setHoverIndex(index)}
            onFocus={() => setHoverIndex(index)}
            tabIndex={0}
            role="button"
            aria-label={label}
          />
        ))}

        {hoverIndex !== null && (
          <line
            x1={xAt(hoverIndex)}
            x2={xAt(hoverIndex)}
            y1={0}
            y2={HEIGHT}
            stroke={CHROME.axis[mode]}
            strokeWidth={1}
          />
        )}

        {labels.length > 0 && (
          <>
            <text x={xAt(0)} y={HEIGHT + 16} textAnchor="middle" fontSize={10} fill={CHROME.inkMuted[mode]}>
              {labels[0]}
            </text>
            <text
              x={xAt(labels.length - 1)}
              y={HEIGHT + 16}
              textAnchor="middle"
              fontSize={10}
              fill={CHROME.inkMuted[mode]}
            >
              {labels[labels.length - 1]}
            </text>
          </>
        )}
      </svg>

      {hoverIndex !== null && (
        <div
          role="tooltip"
          className="pointer-events-none absolute top-2 rounded-card border border-sand-200 bg-white px-3 py-2 text-xs shadow-quiet"
          style={{ insetInlineStart: `${(hoverIndex / Math.max(length - 1, 1)) * 80 + 5}%` }}
        >
          <p className="font-medium text-ink">{labels[hoverIndex]}</p>
          {series.map((s) => (
            <p key={s.id} className="mt-0.5 flex items-center gap-2 text-ink-soft">
              <span
                aria-hidden="true"
                className="inline-block h-2 w-2 rounded-full"
                style={{ backgroundColor: s.color }}
              />
              {s.label}: {formatValue(s.points[hoverIndex]?.y ?? null)}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}
