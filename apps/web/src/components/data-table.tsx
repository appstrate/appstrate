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
 *   and the browser keeps every behaviour a link has. THE PRICE: that overlay
 *   paints over the other cells, so anything that answers to the pointer —
 *   a button, or just a `title` a truncated cell needs to stay readable — has
 *   to be RAISED above it (`relative z-10`) or the row swallows the hover with
 *   the click. Raise the titled element itself, not its cell: the dead zone is
 *   then the size of the text rather than the size of the column.
 * - **Collection columns drop with their track, on the TABLE's width.** A
 *   column declares the room it needs (`tier`), and its cell AND its track go
 *   together or the row keeps a gap where the column was. Settings is the
 *   exception because its static rows have no detail destination: there every
 *   fact remains rendered and the complete track scrolls horizontally when it
 *   does not fit. Both treatments use the declared track FLOOR
 *   (`minmax(120px,1fr)`, never `minmax(0,…)`), because a `0` minimum tells the
 *   browser it may take the column away entirely, and it does.
 */

import type { CSSProperties, ReactNode } from "react";
import { Link } from "react-router-dom";
import { cn } from "@appstrate/ui/cn";
import { ScrollArea, ScrollBar } from "@appstrate/ui/components/scroll-area";
import { Skeleton } from "@appstrate/ui/components/skeleton";
import { collectionVerdict, type CollectionState } from "./collection";
import { ErrorState } from "./page-states";

export type DataColumnWidth = `${number}px` | `minmax(${number}px,${number}fr)`;

export interface DataColumn<T> {
  /** Stable handle, independent of the label — a column set is a list of these. */
  id: string;
  /** Column head, already translated. */
  header: string;
  /** Grid track: `"88px"` for a fixed column, `"minmax(100px,1fr)"` for an elastic one with a measurable floor. */
  width: DataColumnWidth;
  /** Numbers, durations and dates read against the right edge. */
  align?: "end";
  /**
   * How much room the column needs, and therefore when it appears in a tiered
   * collection. Unset is the row's identity, always drawn. `2` waits for a
   * 36rem table, `3` for a 56rem one. Settings renders all tiers and scrolls
   * their complete floor. `column-tiers.test.tsx` checks the arithmetic.
   */
  tier?: 2 | 3;
  cell: (row: T) => ReactNode;
}

interface DataTableProps<T> extends CollectionState {
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
  /** Pinned above the first row, inside the frame (e.g. a scheduled next run). */
  banner?: ReactNode;
  /** Names the table for screen readers; never drawn. */
  label: string;
  /**
   * `tiered` keeps the compact collection treatment. `scroll` makes the
   * reader's selected columns authoritative and preserves every selected fact
   * behind horizontal overflow when the table becomes narrow.
   */
  columnMode?: "tiered" | "scroll";
  /** Remove the second frame when the table already lives on a white surface. */
  surface?: "framed" | "integrated";
  /** Compact embedded lists may keep semantic headers without drawing a header band. */
  showHeader?: boolean;
}

/**
 * The columns a reader may hide, and the menu spec that goes with them.
 *
 * A column with no header cannot be named in a menu (the actions column), so it
 * is never offered — and never hidden either.
 */
export function columnMenu<T>(
  columns: DataColumn<T>[],
  visibility: { hidden: string[]; toggle: (id: string) => void },
) {
  const requiredId = columns.find((column) => !column.tier && column.header)?.id;
  return {
    options: columns
      .filter((column) => column.header)
      .map((column) => ({
        id: column.id,
        label: column.header,
        required: column.id === requiredId,
      })),
    hidden: visibility.hidden,
    onToggle: visibility.toggle,
  };
}

/** What is left once the reader's hidden columns are taken out. */
export function visibleColumns<T>(columns: DataColumn<T>[], hidden: string[]): DataColumn<T>[] {
  const requiredId = columns.find((column) => !column.tier && column.header)?.id;
  return columns.filter(
    (column) => column.id === requiredId || !column.header || !hidden.includes(column.id),
  );
}

const SKELETON_ROWS = 3;

/**
 * When a column's cell is drawn. Written out rather than interpolated because
 * Tailwind reads these class names as literals in the source.
 */
function tierClass<T>(col: DataColumn<T>, display: "block" | "flex"): string | undefined {
  if (col.tier === 2)
    return display === "block" ? "hidden @xl/table:block" : "hidden @xl/table:flex";
  if (col.tier === 3)
    return display === "block" ? "hidden @4xl/table:block" : "hidden @4xl/table:flex";
  return undefined;
}

function trackList<T>(columns: DataColumn<T>[]): string {
  return columns.map((c) => c.width).join(" ");
}

function trackFloor(width: DataColumnWidth): number {
  const fixed = /^(\d+(?:\.\d+)?)px$/.exec(width);
  if (fixed) return Number(fixed[1]);
  const elastic = /^minmax\((\d+(?:\.\d+)?)px,/.exec(width);
  if (elastic) return Number(elastic[1]);
  throw new Error(`DataTable cannot read the floor of track ${width}`);
}

function fullColumnFloor<T>(columns: DataColumn<T>[]): string {
  const wideSpacing = 16;
  const tracks = columns.reduce((sum, column) => sum + trackFloor(column.width), 0);
  return `${tracks + wideSpacing * (columns.length + 1)}px`;
}

export function DataTable<T>({
  columns,
  rows,
  rowKey,
  rowHref,
  rowLabel,
  rowState,
  banner,
  label,
  columnMode = "tiered",
  surface = "framed",
  showHeader = true,
  ...state
}: DataTableProps<T>) {
  // The order lives in `collection.ts`, shared with the card grid: a caller
  // hands either body the same props and gets the same answer.
  const verdict = collectionVerdict(state, rows.length);
  const isLoading = verdict === "loading";
  // Three templates, one per tier: narrow keeps only the columns that carry the
  // row's identity, and each step up adds the ones the width can now hold.
  const tracks = {
    "--dt-cols": trackList(columns.filter((c) => !c.tier)),
    "--dt-cols-2": trackList(columns.filter((c) => !c.tier || c.tier === 2)),
    "--dt-cols-3": trackList(columns),
    "--dt-full-floor": fullColumnFloor(columns),
  } as CSSProperties;

  // The link goes in the first column of tier one, not in column zero: a run
  // list leads with `#131`, which is a tier-two column, so a link parked there
  // would leave the row unclickable on a phone.
  const linkColumn = columns.findIndex((c) => !c.tier);

  const rowGrid =
    columnMode === "scroll"
      ? "grid items-center gap-4 px-4 [grid-template-columns:var(--dt-cols-3)]"
      : "grid items-center gap-3 px-3 [grid-template-columns:var(--dt-cols)] @xl/table:gap-4 @xl/table:px-4 @xl/table:[grid-template-columns:var(--dt-cols-2)] @4xl/table:[grid-template-columns:var(--dt-cols-3)]";

  // A failure always draws something, whether or not the caller wrote the
  // sentence — it used to be folded into `empty` at every call site, which is
  // how a 500 could read as "no runs".
  if (verdict === "error" || verdict === "empty") {
    return (
      <div
        data-data-table-frame
        className={cn(
          "@container/table overflow-hidden",
          surface === "integrated"
            ? "bg-transparent"
            : "bg-card rounded-lg border shadow-sm [[data-settings-table-surface=integrated]_&]:rounded-none [[data-settings-table-surface=integrated]_&]:border-0 [[data-settings-table-surface=integrated]_&]:bg-transparent [[data-settings-table-surface=integrated]_&]:shadow-none",
        )}
      >
        {verdict === "error" ? (state.error ?? <ErrorState compact />) : state.empty}
      </div>
    );
  }

  return (
    <div
      data-data-table-frame
      className={cn(
        "@container/table overflow-hidden",
        surface === "integrated"
          ? "bg-transparent"
          : "bg-card rounded-lg border shadow-sm [[data-settings-table-surface=integrated]_&]:rounded-none [[data-settings-table-surface=integrated]_&]:border-0 [[data-settings-table-surface=integrated]_&]:bg-transparent [[data-settings-table-surface=integrated]_&]:shadow-none",
      )}
    >
      <ScrollArea data-data-table-scroll>
        <table
          role="table"
          aria-label={label}
          data-data-table-column-mode={columnMode}
          className={cn(
            "block w-full text-sm",
            columnMode === "scroll" && "min-w-(--dt-full-floor)",
          )}
          style={tracks}
        >
          <thead role="rowgroup" className={showHeader ? "block" : "sr-only"}>
            <tr
              role="row"
              data-data-table-row
              className={cn(rowGrid, "border-border h-10 border-b")}
            >
              {columns.map((col) => (
                <th
                  role="columnheader"
                  key={col.id}
                  data-data-table-column={col.id}
                  data-data-table-tier={col.tier}
                  className={cn(
                    "text-muted-foreground min-w-0 truncate text-[0.68rem] font-semibold tracking-[0.05em] uppercase",
                    col.align === "end" ? "text-right" : "text-left",
                    columnMode === "tiered" && tierClass(col, "block"),
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
                    data-data-table-row
                    className={cn(rowGrid, "border-border/60 h-12 border-b last:border-b-0")}
                  >
                    {columns.map((col) => (
                      <td
                        role="cell"
                        key={col.id}
                        data-data-table-column={col.id}
                        data-data-table-tier={col.tier}
                        className={cn(
                          "min-w-0",
                          columnMode === "tiered" && tierClass(col, "block"),
                        )}
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
                      data-data-table-row
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
                          data-data-table-column={col.id}
                          data-data-table-tier={col.tier}
                          className={cn(
                            "flex min-w-0 items-center gap-1.5",
                            col.align === "end" && "justify-end",
                            columnMode === "tiered" && tierClass(col, "flex"),
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
        <ScrollBar orientation="horizontal" />
      </ScrollArea>
    </div>
  );
}
