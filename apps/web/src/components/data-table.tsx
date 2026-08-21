// SPDX-License-Identifier: Apache-2.0

/**
 * One table, many column sets.
 *
 * The reference design does not draw four list screens — it draws ONE table
 * (`.data-table`) and four column sets (`.dt-runs`, `.dt-agents`, `.dt-sched`,
 * `.dt-intg`). This is that table: a caller describes its columns and nothing
 * else, so the head band, the row rhythm, the hover, the loading placeholder,
 * the empty state and the breakpoint behaviour are written once and cannot
 * drift from one list to the next — which is exactly how the run list, the
 * agent list and the schedule list ended up three different-looking things.
 *
 * Three decisions worth knowing before changing it:
 *
 * - **Grid tracks, not table layout.** A column is declared as a grid track
 *   (`"88px"`, `"minmax(0,1.2fr)"`) because a run list wants a name that takes
 *   whatever is left beside a date that never moves, and `minmax(0,1fr)` says
 *   that in one value where `table-layout: fixed` needs percentages recomputed
 *   every time a column is added or dropped. The markup stays a real `<table>`
 *   — but overriding `display` on table elements DROPS their implicit ARIA
 *   roles in Chrome and Firefox, so every role is re-declared by hand. A
 *   grid-displayed table without them announces as a pile of divs.
 * - **The row is a link, not an `onClick`.** Middle-click, ⌘-click and "copy
 *   link address" are how a run gets opened in a second tab. So the link lives
 *   in the first cell and stretches over the row through `after:absolute
 *   after:inset-0`: the whole row is a target, one node per row is focusable,
 *   and the browser keeps every behaviour a link has. Anything interactive in
 *   another cell has to sit above that overlay (`relative z-10`) or the row
 *   swallows its clicks.
 * - **Secondary columns drop with their track.** `secondary: true` hides the
 *   cell AND removes the track below `md`; the two have to happen together or
 *   the row keeps a gap where the column was.
 */

import type { CSSProperties, ReactNode } from "react";
import { Link } from "react-router-dom";
import { cn } from "@appstrate/ui/cn";
import { Skeleton } from "@appstrate/ui/components/skeleton";

export interface DataColumn<T> {
  /** Stable handle, independent of the label — a column set is a list of these. */
  id: string;
  /** Column head, already translated. */
  header: string;
  /** Grid track: `"88px"` for a column that never moves, `"minmax(0,1fr)"` for one that gives. */
  width: string;
  /** Numbers, durations and dates read against the right edge. */
  align?: "end";
  /** Dropped, track and all, below `md`. */
  secondary?: boolean;
  cell: (row: T) => ReactNode;
}

interface DataTableProps<T> {
  columns: DataColumn<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  /** Where the row leads. A row without one is rendered static. */
  rowHref?: (row: T) => string | undefined;
  /**
   * What the row's link is called. Needed because the link lives in the FIRST
   * cell: left to itself it would be announced as "#131", which names nothing.
   */
  rowLabel?: (row: T) => string;
  /** Router state to carry, e.g. a run number the destination can show before it loads. */
  rowState?: (row: T) => unknown;
  isLoading?: boolean;
  /** Shown instead of the rows — and instead of the head, which labels nothing. */
  empty?: ReactNode;
  /** Pinned above the first row, inside the frame (e.g. a scheduled next run). */
  banner?: ReactNode;
  /** Names the table for screen readers; never drawn. */
  label: string;
}

const SKELETON_ROWS = 3;

function trackList<T>(columns: DataColumn<T>[]): string {
  return columns.map((c) => c.width).join(" ");
}

export function DataTable<T>({
  columns,
  rows,
  rowKey,
  rowHref,
  rowLabel,
  rowState,
  isLoading = false,
  empty,
  banner,
  label,
}: DataTableProps<T>) {
  // Two templates, one per breakpoint: narrow keeps only the columns that
  // carry the row's identity, `md` and up gets them all.
  const tracks = {
    "--dt-cols": trackList(columns.filter((c) => !c.secondary)),
    "--dt-cols-md": trackList(columns),
  } as CSSProperties;

  // The link goes in the first column that survives the narrow breakpoint, not
  // in column zero: a run list leads with `#131`, which is `secondary`, so a
  // link parked there would leave the row unclickable on a phone.
  const linkColumn = columns.findIndex((c) => !c.secondary);

  const rowGrid =
    "grid items-center gap-3 px-3 [grid-template-columns:var(--dt-cols)] md:gap-4 md:px-4 md:[grid-template-columns:var(--dt-cols-md)]";

  if (!isLoading && rows.length === 0 && empty) {
    return <div className="bg-card overflow-hidden rounded-lg border shadow-sm">{empty}</div>;
  }

  return (
    <div className="bg-card overflow-hidden rounded-lg border shadow-sm">
      <table role="table" aria-label={label} className="block w-full text-sm" style={tracks}>
        <thead role="rowgroup" className="block">
          <tr role="row" className={cn(rowGrid, "border-border h-10 border-b")}>
            {columns.map((col) => (
              <th
                role="columnheader"
                key={col.id}
                className={cn(
                  "text-muted-foreground min-w-0 truncate text-left text-[0.68rem] font-semibold tracking-[0.05em] uppercase",
                  col.align === "end" && "text-right",
                  col.secondary && "hidden md:block",
                )}
              >
                {col.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody role="rowgroup" className="block">
          {banner && (
            <tr role="row" className="border-border/60 block border-b">
              <td role="cell" className="block px-3 md:px-4">
                {banner}
              </td>
            </tr>
          )}
          {isLoading
            ? Array.from({ length: SKELETON_ROWS }, (_, i) => (
                <tr
                  role="row"
                  key={i}
                  aria-hidden
                  className={cn(rowGrid, "border-border/60 h-12 border-b last:border-b-0")}
                >
                  {columns.map((col) => (
                    <td
                      role="cell"
                      key={col.id}
                      className={cn("min-w-0", col.secondary && "hidden md:block")}
                    >
                      <Skeleton className="h-3.5 w-full" />
                    </td>
                  ))}
                </tr>
              ))
            : rows.map((row) => {
                const href = rowHref?.(row);
                return (
                  <tr
                    role="row"
                    key={rowKey(row)}
                    className={cn(
                      rowGrid,
                      "border-border/60 relative min-h-12 border-b py-2 last:border-b-0",
                      href && "hover:bg-muted/50 transition-colors",
                    )}
                  >
                    {columns.map((col, i) => (
                      <td
                        role="cell"
                        key={col.id}
                        className={cn(
                          "flex min-w-0 items-center gap-1.5",
                          col.align === "end" && "justify-end",
                          col.secondary && "hidden md:flex",
                        )}
                      >
                        {/* The link belongs to the first cell and covers the row
                            from there — see the note at the top of the file. */}
                        {i === linkColumn && href ? (
                          <Link
                            to={href}
                            state={rowState?.(row)}
                            aria-label={rowLabel?.(row)}
                            className="flex min-w-0 items-center gap-1.5 after:absolute after:inset-0"
                          >
                            {col.cell(row)}
                          </Link>
                        ) : (
                          col.cell(row)
                        )}
                      </td>
                    ))}
                  </tr>
                );
              })}
        </tbody>
      </table>
    </div>
  );
}
