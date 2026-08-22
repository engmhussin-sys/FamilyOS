import type { ReactNode } from 'react';

/**
 * ===========================================================================
 * ONE TABLE, SO SEVEN SCREENS DO NOT WRITE SEVEN.
 * ===========================================================================
 *
 * Before this file every operator page hand-rolled `<table>` markup, and the
 * copies had already drifted: some had `scope="col"` on their headers and some
 * did not, none of them wrapped in a horizontal scroll container, and a
 * fourteen-column job table would therefore have pushed the whole page
 * sideways on a laptop. A table is the single most repeated shape on an
 * operations dashboard; repeating it by hand is how the accessible version and
 * the inaccessible version end up side by side.
 *
 * ── WHAT IT DELIBERATELY DOES NOT DO ───────────────────────────────────
 *
 * No sorting, no filtering, no pagination, no row selection. Every one of
 * those is a decision about DATA, and the data here is bounded and ordered by
 * the backend: `GET /system/jobs` returns eight rows in registry order,
 * `GET /system/jobs/runs` is newest-first and capped at 500 by the controller.
 * A client-side sort over a server-capped page is a control that silently
 * lies — it reorders the fifty rows that happened to arrive, and reads as
 * having reordered the history.
 *
 * ── THE SCROLL CONTAINER IS THE POINT ──────────────────────────────────
 *
 * `overflow-x-auto` sits on the wrapper, never on the page. Wide content
 * scrolls inside its own box; the document body never scrolls sideways. And
 * the container is bordered so the operator can see there is more table than
 * viewport — an invisible scroll region is a column nobody knows exists.
 */

export interface DataTableColumn<TRow> {
  /** Stable identity for React and for the `<th>`; never rendered. */
  key: string;
  /** Already translated by the caller — this component owns no copy. */
  header: string;
  /** Cell body. Return `null` for genuinely absent, never an invented `0`. */
  cell: (row: TRow) => ReactNode;
  /**
   * Machine-shaped values (ids, ISO timestamps, error text, job names) are
   * rendered LTR inside an RTL page, because a UUID reversed by bidi is a UUID
   * an operator cannot paste into a ticket.
   */
  ltr?: boolean;
  /** Numeric alignment for count columns. */
  numeric?: boolean;
}

interface DataTableProps<TRow> {
  /** Names the table for a screen reader. Required: an unlabelled table in a
   * page of four tables is four identical landmarks. */
  caption: string;
  columns: ReadonlyArray<DataTableColumn<TRow>>;
  rows: readonly TRow[];
  rowKey: (row: TRow) => string;
  /** Applied to `<tr>`; used to mark an alerting or disabled row. */
  rowClassName?: (row: TRow) => string | undefined;
}

export function DataTable<TRow>({ caption, columns, rows, rowKey, rowClassName }: DataTableProps<TRow>) {
  return (
    <div className="overflow-x-auto rounded-card border border-sand-200 bg-white shadow-quiet">
      <table className="w-full min-w-max border-collapse text-sm">
        {/* Visually hidden rather than absent: the caption is what a screen
            reader announces when the cursor enters the table, and a page with
            four tables needs four different announcements. */}
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr className="border-b border-sand-200 bg-sand-50/70">
            {columns.map((column) => (
              <th
                key={column.key}
                scope="col"
                className={`px-3 py-2.5 font-medium text-ink-soft ${
                  column.numeric ? 'text-end tabular-nums' : 'text-start'
                }`}
              >
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={rowKey(row)} className={`border-b border-sand-200/60 last:border-0 ${rowClassName?.(row) ?? ''}`}>
              {columns.map((column) => (
                <td
                  key={column.key}
                  dir={column.ltr ? 'ltr' : undefined}
                  className={`px-3 py-2.5 align-top ${
                    column.numeric ? 'text-end tabular-nums' : 'text-start'
                  } ${column.ltr ? 'font-mono text-xs' : ''}`}
                >
                  {column.cell(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
