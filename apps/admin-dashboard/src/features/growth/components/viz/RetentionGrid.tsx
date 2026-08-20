import { CHROME, ORDINAL_TEAL } from '../../lib/vizTokens';
import type { VizMode } from '../../lib/useVizMode';
import { NO_DATA } from '../../lib/format';

/**
 * Retention as a grid.
 *
 * The cell's job is magnitude, so the colour job is SEQUENTIAL: one hue,
 * light→dark, from the validated ordinal teal ramp. No rainbow, and no
 * categorical hue doing double duty.
 *
 * The cell value is written INSIDE the cell in every case, so the encoding
 * is never colour-only on a continuous scale — and a `null` cell carries no
 * colour at all and reads `—`. That is the load-bearing behaviour here: a
 * 45-day-old cohort has no D90 number, and painting its cell the "0%" end
 * of the ramp would invent a catastrophic retention figure out of a cohort
 * that is simply too young to have one.
 */

export interface RetentionCell {
  label: string;
  value: number | null;
}

export interface RetentionRow {
  label: string;
  /** Optional context shown under the row label (cohort size, country). */
  sublabel?: string;
  cells: RetentionCell[];
}

interface RetentionGridProps {
  rows: RetentionRow[];
  columnLabels: string[];
  mode: VizMode;
  formatValue: (v: number | null) => string;
  ariaLabel: string;
}

/** Buckets a rate onto the four validated steps. Deliberately four, not a
 * continuous interpolation: past ~7 classes adjacent bins blur, and four
 * bins keep every step distinguishable from its neighbour. */
export function retentionStep(value: number | null): number | null {
  if (value === null) return null;
  if (value < 0.15) return 0;
  if (value < 0.3) return 1;
  if (value < 0.5) return 2;
  return 3;
}

export function RetentionGrid({ rows, columnLabels, mode, formatValue, ariaLabel }: RetentionGridProps) {
  const ramp = ORDINAL_TEAL[mode];

  return (
    <table className="w-full border-separate border-spacing-0.5 text-sm" aria-label={ariaLabel}>
      <thead>
        <tr>
          <th scope="col" className="px-2 py-1 text-start text-xs font-medium text-ink-soft" />
          {columnLabels.map((label) => (
            <th key={label} scope="col" className="px-2 py-1 text-center text-xs font-medium text-ink-soft">
              {label}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.label}>
            <th scope="row" className="px-2 py-1 text-start text-xs font-normal">
              <span className="block font-medium text-ink">{row.label}</span>
              {row.sublabel && <span className="block text-ink-soft">{row.sublabel}</span>}
            </th>
            {row.cells.map((cell) => {
              const step = retentionStep(cell.value);
              const background = step === null ? 'transparent' : ramp[step];
              // Label colour picked by the fill's luminance so it always
              // clears contrast — the one place text may sit on a data fill.
              const onFill = step === null ? CHROME.inkMuted[mode] : step >= 2 ? '#FFFFFF' : CHROME.inkPrimary.light;

              return (
                <td
                  key={cell.label}
                  className="rounded px-2 py-2 text-center [font-variant-numeric:tabular-nums]"
                  style={{
                    backgroundColor: background,
                    color: onFill,
                    border: step === null ? `1px dashed ${CHROME.grid[mode]}` : 'none',
                  }}
                  title={`${row.label} · ${cell.label}`}
                >
                  {cell.value === null ? NO_DATA : formatValue(cell.value)}
                </td>
              );
            })}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
