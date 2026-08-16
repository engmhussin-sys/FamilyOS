import { useId, useState, type ReactNode } from 'react';
import { useTranslation } from '../../../../shared/i18n/LocaleProvider';
import { CHROME, MARK } from '../../lib/vizTokens';
import type { VizMode } from '../../lib/useVizMode';

/**
 * The shell every chart in this product sits in: title, subtitle, a legend
 * that is always present for two or more series, and a table view.
 *
 * The table view is not a nicety. Two of the palette's slots WARN on
 * contrast against the light surface (amber at 2.68:1), and the dataviz
 * rule is that a contrast WARN is not dismissable — it obligates a relief
 * channel. Visible direct labels plus this table are that channel, so the
 * toggle is part of the chart's accessibility contract, not a feature.
 */

export interface LegendEntry {
  label: string;
  color: string | null;
  /** Rendered instead of a filled swatch — carries the identity for a
   * reader who cannot use hue at all. */
  glyph?: string;
  fillStyle?: 'solid' | 'outline' | 'hatched';
  hint?: string;
}

interface ChartFrameProps {
  title: string;
  subtitle?: string;
  legend?: LegendEntry[];
  /** The WCAG-clean twin. Every value on the chart is reachable here. */
  table: ReactNode;
  children: (patternIds: PatternIds) => ReactNode;
  mode: VizMode;
  footnote?: ReactNode;
}

export interface PatternIds {
  /** 45° hatch, used for FORECAST fills and EXTERNAL_REPORTED funnel steps. */
  hatch: (color: string) => string;
  defs: ReactNode;
  registerHatch: (color: string) => void;
}

/**
 * The texture channel. One directional fill at 45° only (its 135° mirror is
 * reserved for a second textured series, which no chart here needs yet),
 * inked tone-on-tone in the fill's own colour. It is not decorative and it
 * is not on by default — it appears only where a mark's meaning is
 * "assumption" or "externally reported", which is precisely the case the
 * skill reserves texture for.
 */
function useHatchPatterns(): PatternIds {
  const baseId = useId().replace(/:/g, '');
  const [colors, setColors] = useState<string[]>([]);

  const key = (color: string) => `${baseId}-hatch-${color.replace('#', '')}`;

  return {
    hatch: (color: string) => `url(#${key(color)})`,
    registerHatch: (color: string) => {
      setColors((prev) => (prev.includes(color) ? prev : [...prev, color]));
    },
    defs: (
      <defs>
        {colors.map((color) => (
          <pattern
            key={color}
            id={key(color)}
            patternUnits="userSpaceOnUse"
            width={6}
            height={6}
            patternTransform="rotate(45)"
          >
            <rect width={6} height={6} fill={color} fillOpacity={0.18} />
            <line x1={0} y1={0} x2={0} y2={6} stroke={color} strokeWidth={2.5} />
          </pattern>
        ))}
      </defs>
    ),
  };
}

export function ChartFrame({ title, subtitle, legend, table, children, mode, footnote }: ChartFrameProps) {
  const { t } = useTranslation();
  const [showTable, setShowTable] = useState(false);
  const patterns = useHatchPatterns();

  return (
    <section
      className="rounded-card border border-sand-200 bg-white p-6 shadow-quiet"
      style={{ backgroundColor: CHROME.surface[mode] }}
    >
      <header className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="font-display text-base" style={{ color: CHROME.inkPrimary[mode] }}>
            {title}
          </h3>
          {subtitle && (
            <p className="mt-1 max-w-2xl text-sm" style={{ color: CHROME.inkSecondary[mode] }}>
              {subtitle}
            </p>
          )}
        </div>
        <button
          type="button"
          onClick={() => setShowTable((v) => !v)}
          aria-pressed={showTable}
          className="rounded-card border border-sand-200 px-3 py-1.5 text-xs font-medium text-ink-soft hover:bg-sand-100"
        >
          {showTable ? t('growth.state.chartView') : t('growth.state.tableView')}
        </button>
      </header>

      {/* A legend is always present for two or more series — identity is
          never left to colour-matching alone. One series gets none: the
          title already names it. */}
      {legend && legend.length >= 2 && (
        <ul className="mb-4 flex flex-wrap gap-x-5 gap-y-2">
          {legend.map((entry) => (
            <li key={entry.label} className="flex items-center gap-2 text-xs" title={entry.hint}>
              <LegendSwatch entry={entry} mode={mode} />
              <span style={{ color: CHROME.inkSecondary[mode] }}>{entry.label}</span>
            </li>
          ))}
        </ul>
      )}

      {showTable ? <div className="overflow-x-auto">{table}</div> : children(patterns)}

      {footnote && (
        <p className="mt-4 text-xs" style={{ color: CHROME.inkMuted[mode] }}>
          {footnote}
        </p>
      )}
    </section>
  );
}

function LegendSwatch({ entry, mode }: { entry: LegendEntry; mode: VizMode }) {
  const style = entry.fillStyle ?? 'solid';
  const color = entry.color ?? CHROME.inkSecondary[mode];

  return (
    <span className="flex items-center gap-1.5" aria-hidden="true">
      <svg width={14} height={14} viewBox="0 0 14 14" role="presentation">
        {style === 'solid' && <rect x={0} y={3} width={14} height={8} rx={MARK.barRadius} fill={color} />}
        {style === 'outline' && (
          <rect
            x={0.75}
            y={3}
            width={12.5}
            height={8}
            rx={MARK.barRadius}
            fill="none"
            stroke={color}
            strokeWidth={1.5}
            strokeDasharray="3 2"
          />
        )}
        {style === 'hatched' && (
          <>
            <rect x={0.75} y={3} width={12.5} height={8} rx={MARK.barRadius} fill={color} fillOpacity={0.18} />
            <path d="M1 11 L5 3 M5 11 L9 3 M9 11 L13 3" stroke={color} strokeWidth={1.5} />
          </>
        )}
      </svg>
      {entry.glyph && <span style={{ color: CHROME.inkMuted[mode] }}>{entry.glyph}</span>}
    </span>
  );
}

/** The table twin's shared styling, so every chart's table looks the same. */
export function VizTable({ headers, children }: { headers: string[]; children: ReactNode }) {
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="border-b border-sand-200 text-start text-xs text-ink-soft">
          {headers.map((h) => (
            <th key={h} scope="col" className="px-3 py-2 text-start font-medium">
              {h}
            </th>
          ))}
        </tr>
      </thead>
      {/* tabular-nums here and NOT on the stat tiles: columns of numbers
          must align vertically; a large standalone figure looks loose with
          equal-width digits. */}
      <tbody className="[font-variant-numeric:tabular-nums]">{children}</tbody>
    </table>
  );
}
