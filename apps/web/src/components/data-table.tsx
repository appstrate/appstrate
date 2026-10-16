// SPDX-License-Identifier: Apache-2.0

/**
 * One table, many column sets: a caller describes its columns and nothing else,
 * so the head band, the row rhythm, the hover, the loading placeholder and the
 * empty state are written once.
 *
 * - **The row is a link, not an `onClick`.** Middle-click, ⌘-click and "copy
 *   link address" are how a run gets opened in a second tab. A cover link
 *   stretches over the whole row (`tr` is `relative`) and the named, focusable
 *   link lives in the first identity cell. THE PRICE: the cover paints over the
 *   other cells, so anything that answers to the pointer — a button, or a
 *   `title` a truncated cell needs readable — has to be RAISED above it
 *   (`relative z-10`) or the row swallows the hover with the click.
 * - **A column that is READ may wait for room, one that is a CONTROL may not.**
 *   With `tiered`, a column declaring a `tier` is drawn only once the table is
 *   wide enough (`2`: 36rem, `3`: 56rem). A control column (a select, a switch,
 *   a button, an action link) has no tier and is never dropped: a person who
 *   cannot see the control cannot act. Without `tiered` every column is drawn and
 *   the table scrolls sideways.
 * - **Columns resize.** Drag the edge of a head, double-click to give the column back its
 *   declared width. The width is the reader's, kept per table (its `label`) and never goes
 *   below the column's declared width. Fixed-size controls and the row's end have no handle.
 * - **The row's name and its « … » stay in place when the table scrolls**
 *   (`sticky`), so a row is always named and its actions in reach.
 */

import { useRef, useState, type CSSProperties, type MouseEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate } from "react-router-dom";
import { cn } from "@appstrate/ui/cn";
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
import { useColumnWidths } from "../stores/column-widths-store";

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
  /** Stable preference key, independent of the translated accessible label. */
  tableId: string;
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
const HELD_HOVER = "transition-colors group-hover/row:bg-(--dt-surface-hover)";

/** What answers a click by itself: a click on it is its own, not the row's. */
const OWN_CLICK =
  'a,button,input,select,textarea,label,summary,[role="button"],[role="menuitem"],[role="checkbox"],[role="switch"],[role="combobox"],[role="radio"],[role="tab"],[tabindex]:not([tabindex="-1"])';

/**
 * A raised element sits above the row's cover and takes the click meant for the row: a name
 * kept readable (its `title`), or a held cell. Whatever is not a control hands the click over.
 * A plain click only (a modifier is the link's own business), on what is inside the row (a menu
 * portal bubbles through React, not through the DOM).
 */
function handOver(e: MouseEvent<HTMLElement>, open: () => void) {
  const target = e.target as Element;
  if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  if (!e.currentTarget.contains(target) || target.closest(OWN_CLICK)) return;
  open();
}

const MAX_COLUMN_WIDTH = 720;

/** What a reader can drag: a column with a head, bar the fixed-size ticks and buttons. */
function isResizable<T>(column: DataColumn<T>): boolean {
  return Boolean(column.header || column.headerNode) && !(column.control && !column.elastic);
}

/** The drag handle on a head's right edge; its parent is the head, whose width is the column's. */
function ResizeHandle({
  name,
  floor,
  onResize,
  onCommit,
  onReset,
}: {
  name: string;
  floor: number;
  /** While the pointer is down. */
  onResize: (width: number) => void;
  onCommit: (width: number) => void;
  onReset: () => void;
}) {
  const { t } = useTranslation("common");
  const drag = useRef<{ x: number; width: number; last: number } | null>(null);
  const end = () => {
    const start = drag.current;
    drag.current = null;
    if (start && start.last !== start.width) onCommit(start.last);
  };
  return (
    <span
      role="separator"
      aria-orientation="vertical"
      aria-label={t("table.resizeColumn", { column: name })}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        const width = e.currentTarget.parentElement!.getBoundingClientRect().width;
        drag.current = { x: e.clientX, width, last: width };
      }}
      onPointerMove={(e) => {
        const start = drag.current;
        if (!start) return;
        start.last = Math.min(
          MAX_COLUMN_WIDTH,
          Math.max(floor, Math.round(start.width + e.clientX - start.x)),
        );
        onResize(start.last);
      }}
      onPointerUp={end}
      onPointerCancel={end}
      onDoubleClick={onReset}
      className="after:bg-border hover:after:bg-primary absolute inset-y-0 right-0 z-30 w-2 cursor-col-resize touch-none select-none after:absolute after:inset-y-2 after:right-0 after:w-px"
    />
  );
}

export function DataTable<T>({
  tableId,
  columns: declared,
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
  const navigate = useNavigate();
  // The width the reader chose, and the one being dragged until it is let go. A column given a
  // width stops sharing the room: it is exactly that wide.
  const stored = useColumnWidths(tableId);
  const [dragged, setDragged] = useState<{ id: string; width: number } | null>(null);
  const columns = declared.map((column) => {
    const width = dragged?.id === column.id ? dragged.width : stored.widths[column.id];
    return width ? { ...column, width: Math.max(width, column.width), elastic: false } : column;
  });
  const open = (row: T, href: string | undefined) => {
    if (href) navigate(href, { state: rowState?.(row) });
    else if (rowAction && (rowActionable?.(row) ?? true)) rowAction(row);
  };

  const frameClass = cn(
    "@container/table overflow-hidden",
    surface === "integrated"
      ? "bg-transparent [--dt-surface:var(--color-background)]"
      : "bg-card rounded-lg border [--dt-surface:var(--color-card)] [[data-settings-table-surface=integrated]_&]:rounded-none [[data-settings-table-surface=integrated]_&]:border-0 [[data-settings-table-surface=integrated]_&]:bg-transparent",
    "[--dt-surface-hover:color-mix(in_oklab,var(--color-muted)_50%,var(--dt-surface))]",
  );

  // The frame's border is the head's top rule; only a frameless table (an integrated surface, or
  // one inside an integrated settings section) draws its own, or the head would stack two lines.
  const headTopRule =
    surface === "integrated" ? "border-t" : "[[data-settings-table-surface=integrated]_&]:border-t";

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
  // The cover sits in the first cell that is neither held nor tiered: a `sticky` cell would
  // be its containing block, and a cell that may be hidden takes it with it. A static cell
  // leaves the row (`relative`) as the block it stretches over. When every drawn column is held
  // it falls back to the first one: it then covers that cell only, the row's own click does the rest.
  const coverable = columns.filter((c) => !c.tier);
  const coverColumn = columns.indexOf((coverable.find((c) => !held.has(c.id)) ?? coverable[0])!);
  // The least room the table needs at each tier: under it, it scrolls sideways.
  const floors = {
    "--dt-floor": floorOf(tiered ? columns.filter((c) => !c.tier) : columns),
    "--dt-floor-2": floorOf(tiered ? columns.filter((c) => !c.tier || c.tier === 2) : columns),
    "--dt-floor-3": floorOf(columns),
  } as CSSProperties;
  // An end-aligned column keeps clear of the resize handle: its text sits a little in from the edge.
  const cellClass = (column: DataColumn<T>) =>
    cn(tiered && tierClass(column), "px-3", column.align === "end" && "pr-5");
  const heldClass = (hold: Hold | undefined, hover = false) =>
    hold && cn(HELD, hover && HELD_HOVER);

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
          <TableRow className={cn("border-border h-10 hover:bg-transparent", headTopRule)}>
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
                    !hold && "relative",
                    "text-muted-foreground h-10 truncate text-[0.68rem] font-semibold tracking-[0.05em] uppercase",
                    column.align === "end" ? "text-right" : "text-left",
                    heldClass(hold),
                  )}
                >
                  {column.headerNode ?? column.header}
                  {isResizable(column) && (
                    <ResizeHandle
                      name={column.header}
                      floor={declared.find((c) => c.id === column.id)!.width}
                      onResize={(width) => setDragged({ id: column.id, width })}
                      onCommit={(width) => {
                        stored.set(column.id, width);
                        setDragged(null);
                      }}
                      onReset={() => stored.set(column.id, null)}
                    />
                  )}
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
                const interactive = Boolean(href || action);
                return (
                  <TableRow
                    key={rowKey(row)}
                    className={cn(
                      "group/row border-border/60 relative h-12",
                      interactive
                        ? "cursor-pointer hover:bg-(--dt-surface-hover)"
                        : "hover:bg-transparent",
                    )}
                    onClick={interactive ? (e) => handOver(e, () => open(row, href)) : undefined}
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
                          className={cn(cellClass(column), "py-2", heldClass(hold, interactive))}
                        >
                          {i === coverColumn && href && (
                            <Link
                              to={href}
                              state={rowState?.(row)}
                              tabIndex={-1}
                              aria-hidden
                              className="absolute inset-0"
                            />
                          )}
                          {i === coverColumn && !href && action && (
                            <button
                              type="button"
                              aria-label={rowLabel?.(row) ?? rowKey(row)}
                              onClick={() => action(row)}
                              className="focus-visible:outline-ring absolute inset-0 cursor-pointer rounded-none bg-transparent p-0 hover:bg-transparent focus-visible:outline-2 focus-visible:-outline-offset-2"
                            />
                          )}
                          {i === linkColumn && href ? (
                            <Link
                              to={href}
                              state={rowState?.(row)}
                              aria-label={rowLabel?.(row)}
                              className="relative block min-w-0"
                            >
                              {content}
                            </Link>
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
