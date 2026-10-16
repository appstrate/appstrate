// SPDX-License-Identifier: Apache-2.0

import type { CSSProperties, ReactNode } from "react";
import { Link } from "react-router-dom";
import { cn } from "@appstrate/ui/cn";
import { Button } from "@appstrate/ui/components/button";
import { Skeleton } from "@appstrate/ui/components/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@appstrate/ui/components/table";
import { collectionVerdict, type CollectionState } from "./collection";
import { ErrorState } from "./page-states";
import { isIdentityColumn } from "../lib/column-visibility";

interface DataColumnBase<T> {
  /** Stable handle, independent of the label — a column set is a list of these. */
  id: string;
  /** Column head, already translated. Also the label the column menu lists. */
  header: string;
  /** Drawn instead of `header` when the head is a control rather than a word. */
  headerNode?: ReactNode;
  /** Pixels. A fixed column is exactly this wide; an `elastic` one is never narrower. */
  width: number;
  /** Takes its share of the room the fixed columns leave. */
  elastic?: boolean;
  /** Numbers, durations and dates read against the right edge. */
  align?: "end";
  cell: (row: T) => ReactNode;
}

/**
 * What a column IS decides whether it may leave: a READ column (text, a badge,
 * a date) may wait for room, a CONTROL column may not. `column-tiers.test.tsx`
 * checks every real column set.
 */
type DataColumnNature =
  | {
      /** Holds something to act on; never hidden, never carries the row's link. */
      control: true;
      tier?: never;
    }
  | {
      control?: false;
      /** Unset is the row's identity, always drawn. `2` waits for a 36rem table, `3` for a 56rem one. */
      tier?: 2 | 3;
    };

export type DataColumn<T> = DataColumnBase<T> & DataColumnNature;

interface DataTableProps<T> extends CollectionState {
  columns: DataColumn<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  /** Where the row leads. A row without one is rendered static. */
  rowHref?: (row: T) => string | undefined;
  /** Open an in-place detail. Navigation must keep using rowHref. */
  rowAction?: (row: T) => void;
  /** A row for which `rowAction` does not apply stays static (a built-in, a locked space). */
  rowActionable?: (row: T) => boolean;
  /** What the row's link is called; left alone it would be announced as its first cell ("#131"). */
  rowLabel?: (row: T) => string;
  /** Router state to carry, e.g. a run number the destination can show before it loads. */
  rowState?: (row: T) => unknown;
  /** Pinned above the first row, inside the frame (e.g. a scheduled next run). */
  banner?: ReactNode;
  /** Names the table for screen readers (never drawn). */
  label: string;
  /** Read columns wait for room by `tier`; otherwise every column is drawn and the table scrolls. */
  tiered?: boolean;
  /** Remove the second frame when the table already lives on a white surface. */
  surface?: "framed" | "integrated";
}

/** The row's end (« … »): no head to name it. */
function isRowEnd<T>(column: DataColumn<T>): boolean {
  return !column.header && !column.headerNode;
}

const SKELETON_ROWS = 3;

/** Written out rather than interpolated: Tailwind reads class names as literals. */
function tierClass<T>(column: DataColumn<T>): string | undefined {
  if (column.tier === 2) return "hidden @xl/table:table-cell";
  if (column.tier === 3) return "hidden @4xl/table:table-cell";
  return undefined;
}

const floorOf = <T,>(columns: DataColumn<T>[]) =>
  `${columns.reduce((sum, c) => sum + c.width, 0)}px`;

/**
 * Which columns stay in place when the table scrolls sideways: the row's name
 * (with the fixed ticks before it) and the row's « … ». A name that other READ
 * columns precede is not held: their tier hides them on a narrow table, so
 * there is no stable offset to hold it at.
 */
type Hold = { side: "start"; left: number } | { side: "end" };

function heldColumns<T>(columns: DataColumn<T>[]): Map<string, Hold> {
  const held = new Map<string, Hold>();
  const identity = columns.findIndex(isIdentityColumn);
  if (identity >= 0 && columns.slice(0, identity).every((c) => c.control && !c.elastic)) {
    let left = 0;
    for (const column of columns.slice(0, identity + 1)) {
      held.set(column.id, { side: "start", left });
      left += column.width;
    }
  }
  const end = columns[columns.length - 1];
  if (end && isRowEnd(end) && !end.tier) held.set(end.id, { side: "end" });
  return held;
}

function holdStyle(hold: Hold): CSSProperties {
  return hold.side === "end" ? { right: 0 } : { left: hold.left };
}

/** Opaque, so what scrolls behind it stays hidden; it follows the row's hover colour. */
const HELD = "sticky z-20 bg-(--dt-surface)";
const HELD_HOVER = "group-hover/row:bg-(--dt-surface-hover)";
/** A held body cell paints over the row's collapsed border: it draws the border itself. */
const HELD_RULE =
  "shadow-[inset_0_-1px_0_color-mix(in_oklab,var(--color-border)_60%,transparent)] group-last/row:shadow-none";

export function DataTable<T>({
  columns,
  rows,
  rowKey,
  rowHref,
  rowAction,
  rowActionable,
  rowLabel,
  rowState,
  banner,
  label,
  tiered = false,
  surface = "framed",
  ...state
}: DataTableProps<T>) {
  const verdict = collectionVerdict(state, rows.length);

  const frameClass = cn(
    "@container/table overflow-hidden",
    surface === "integrated"
      ? "bg-transparent [--dt-surface:var(--color-background)]"
      : "bg-card rounded-lg border [--dt-surface:var(--color-card)] [[data-settings-table-surface=integrated]_&]:rounded-none [[data-settings-table-surface=integrated]_&]:border-0 [[data-settings-table-surface=integrated]_&]:bg-transparent",
    "[--dt-surface-hover:color-mix(in_oklab,var(--color-muted)_50%,var(--dt-surface))]",
  );

  // A failure always draws something, whether or not the caller wrote the
  // sentence: folded into `empty` at the call site, a 500 would read as
  // "no runs".
  if (verdict === "error" || verdict === "empty") {
    return (
      <div className={frameClass}>
        {verdict === "error"
          ? (state.error ?? <ErrorState error={state.failure} compact />)
          : state.empty}
      </div>
    );
  }

  const held = heldColumns(columns);
  // The link goes in the first identity column, not in column zero: a run list
  // leads with `#131`, a tier-two column that a phone does not draw, and a
  // catalogue leads with a tick, which a link would turn into navigation.
  const linkColumn = columns.findIndex(isIdentityColumn);
  // The least room the table needs at each tier: under it, it scrolls sideways.
  const floors = {
    "--dt-floor": floorOf(tiered ? columns.filter((c) => !c.tier) : columns),
    "--dt-floor-2": floorOf(tiered ? columns.filter((c) => !c.tier || c.tier === 2) : columns),
    "--dt-floor-3": floorOf(columns),
  } as CSSProperties;
  const cellClass = (column: DataColumn<T>) => cn(tiered && tierClass(column), "px-3");
  const heldClass = (hold: Hold | undefined, body: boolean, hover = false) =>
    hold && cn(HELD, body && HELD_RULE, hover && HELD_HOVER);

  return (
    <div className={frameClass}>
      <Table
        aria-label={label}
        style={floors}
        className={cn(
          "table-fixed",
          tiered
            ? "min-w-(--dt-floor) @xl/table:min-w-(--dt-floor-2) @4xl/table:min-w-(--dt-floor-3)"
            : "min-w-(--dt-floor-3)",
        )}
      >
        <TableHeader>
          <TableRow className="border-border h-10 border-y hover:bg-transparent">
            {columns.map((column) => {
              const hold = held.get(column.id);
              return (
                <TableHead
                  key={column.id}
                  data-column={column.id}
                  style={{
                    ...(column.elastic ? undefined : { width: column.width }),
                    ...(hold && holdStyle(hold)),
                  }}
                  className={cn(
                    cellClass(column),
                    "text-muted-foreground h-10 truncate text-[0.68rem] font-semibold tracking-[0.05em] uppercase",
                    column.align === "end" ? "text-right" : "text-left",
                    heldClass(hold, false),
                  )}
                >
                  {column.headerNode ?? column.header}
                </TableHead>
              );
            })}
          </TableRow>
        </TableHeader>
        <TableBody>
          {banner && (
            <TableRow className="border-border/60 hover:bg-transparent">
              <TableCell colSpan={columns.length}>{banner}</TableCell>
            </TableRow>
          )}
          {verdict === "loading"
            ? Array.from({ length: SKELETON_ROWS }, (_, i) => (
                <TableRow
                  key={i}
                  aria-hidden
                  className="border-border/60 h-12 hover:bg-transparent"
                >
                  {columns.map((column) => (
                    <TableCell key={column.id} className={cellClass(column)}>
                      <Skeleton className="h-3.5 w-full" />
                    </TableCell>
                  ))}
                </TableRow>
              ))
            : rows.map((row) => {
                const href = rowHref?.(row);
                const action = rowAction && (rowActionable?.(row) ?? true) ? rowAction : undefined;
                return (
                  <TableRow
                    key={rowKey(row)}
                    className="group/row border-border/60 h-12 hover:bg-(--dt-surface-hover)"
                  >
                    {columns.map((column, i) => {
                      const hold = held.get(column.id);
                      const content = (
                        <div
                          className={cn(
                            "flex min-w-0 items-center gap-1.5",
                            column.align === "end" && "justify-end",
                          )}
                        >
                          {column.cell(row)}
                        </div>
                      );
                      return (
                        <TableCell
                          key={column.id}
                          data-column={column.id}
                          style={hold && holdStyle(hold)}
                          className={cn(cellClass(column), "py-2", heldClass(hold, true, true))}
                        >
                          {i === linkColumn && href ? (
                            <Link
                              to={href}
                              state={rowState?.(row)}
                              aria-label={rowLabel?.(row)}
                              className="focus-visible:outline-ring block min-w-0 rounded-sm hover:underline focus-visible:outline-2"
                            >
                              {content}
                            </Link>
                          ) : i === linkColumn && action ? (
                            <Button
                              type="button"
                              variant="link"
                              className="text-foreground h-auto max-w-full justify-start p-0 text-left font-normal whitespace-normal"
                              aria-label={rowLabel?.(row) ?? rowKey(row)}
                              onClick={() => action(row)}
                            >
                              {content}
                            </Button>
                          ) : (
                            content
                          )}
                        </TableCell>
                      );
                    })}
                  </TableRow>
                );
              })}
        </TableBody>
      </Table>
    </div>
  );
}
