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
 * - **Every column the reader keeps is drawn, at every width.** A table too wide
 *   for its container scrolls sideways; the width never hides a column on its
 *   own. Which columns show is the reader's call, made in the column menu.
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
import { identityColumnIndex } from "../lib/column-visibility";
import { useColumnWidths } from "../stores/column-widths-store";

export interface DataColumn<T> {
  /** Stable handle, independent of the label — a column set is a list of these. */
  id: string;
  /** Column head, already translated. Also the label the column menu lists. */
  header: string;
  /** Drawn instead of `header` when the head is a control rather than a word. */
  headerNode?: ReactNode;
  /**
   * A column whose cells say what they are (a status badge) needs no word above
   * them: the head stays for screen readers and the column menu, but is not drawn.
   */
  hideHeader?: true;
  /** Pixels. A fixed column is exactly this wide; an `elastic` one is never narrower. */
  width: number;
  /**
   * Pixels, while the table is narrower than 32rem (`@lg`), for a cell that
   * collapses there — a compact status badge turns into its icon at that same
   * width. A width the reader chose applies at every width.
   */
  narrowWidth?: number;
  /** Takes its share of the room the fixed columns leave. */
  elastic?: boolean;
  /** Numbers, durations and dates read against the right edge. */
  align?: "end";
  cell: (row: T) => ReactNode;
  /**
   * Holds something to act on (a select, a switch, a tick, a button), as opposed
   * to a READ column (text, a badge, a date). Never carries the row's link; the
   * first read column names the row, unless another is marked `identity`.
   */
  control?: boolean;
  /** Names the row though a read column precedes it (a run's status before the run). */
  identity?: true;
}

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
  /** Remove the second frame when the table already lives on a white surface. */
  surface?: "framed" | "integrated";
}

/** The row's end (« … »): no head to name it. */
function isRowEnd<T>(column: DataColumn<T>): boolean {
  return !column.header && !column.headerNode;
}

const SKELETON_ROWS = 3;

/** A column's width while the table is narrower than 32rem. */
const narrowOf = <T,>(column: DataColumn<T>) => column.narrowWidth ?? column.width;

const px = (value: number) => `${value}px`;
const floorOf = <T,>(columns: DataColumn<T>[], width: (c: DataColumn<T>) => number) =>
  px(columns.reduce((sum, c) => sum + width(c), 0));

/**
 * A size that changes at a 32rem table: two custom properties, the class switching between them
 * (`holdClass`, `widthClass` — Tailwind reads class names as literals).
 */
function responsive(name: string, wide: number, narrow: number): CSSProperties {
  return { [`--dt-${name}`]: px(wide), [`--dt-${name}-narrow`]: px(narrow) };
}

/**
 * Which columns stay in place when the table scrolls sideways: the row's name
 * (with the fixed-width columns before it) and the row's « … ». A name that an
 * elastic column precedes is not held: there is no stable offset to hold it at.
 */
type Hold = { side: "start"; left: number; narrowLeft: number } | { side: "end" };

function heldColumns<T>(columns: DataColumn<T>[]): Map<string, Hold> {
  const held = new Map<string, Hold>();
  const identity = identityColumnIndex(columns);
  if (identity >= 0 && columns.slice(0, identity).every((c) => !c.elastic)) {
    let left = 0;
    let narrowLeft = 0;
    for (const column of columns.slice(0, identity + 1)) {
      held.set(column.id, { side: "start", left, narrowLeft });
      left += column.width;
      narrowLeft += narrowOf(column);
    }
  }
  const end = columns[columns.length - 1];
  if (end && isRowEnd(end)) held.set(end.id, { side: "end" });
  return held;
}

function holdStyle(hold: Hold): CSSProperties {
  if (hold.side === "end") return { right: 0 };
  return hold.left === hold.narrowLeft
    ? { left: hold.left }
    : responsive("left", hold.left, hold.narrowLeft);
}

function holdClass(hold: Hold): string | undefined {
  return hold.side === "start" && hold.left !== hold.narrowLeft
    ? "left-(--dt-left-narrow) @lg/table:left-(--dt-left)"
    : undefined;
}

/** A fixed column's width, switching at a 32rem table when it declares a narrower one. */
function widthStyle<T>(column: DataColumn<T>): CSSProperties | undefined {
  if (column.elastic) return undefined;
  return column.width === narrowOf(column)
    ? { width: column.width }
    : responsive("w", column.width, narrowOf(column));
}

function widthClass<T>(column: DataColumn<T>): string | undefined {
  return !column.elastic && column.width !== narrowOf(column)
    ? "w-(--dt-w-narrow) @lg/table:w-(--dt-w)"
    : undefined;
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
    return width
      ? { ...column, width: Math.max(width, column.width), narrowWidth: undefined, elastic: false }
      : column;
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
  // The link goes in the identity column, not in column zero: a run list leads
  // with its status, and a catalogue with a tick, which a link would turn into
  // navigation.
  const linkColumn = identityColumnIndex(columns);
  // The cover sits in the first cell that is not held: a `sticky` cell would be its containing
  // block. A static cell leaves the row (`relative`) as the block it stretches over. When every
  // column is held it falls back to the first one: it then covers that cell only, the row's own
  // click does the rest.
  const coverColumn = Math.max(
    0,
    columns.findIndex((c) => !held.has(c.id)),
  );
  // The least room the table needs: under it, it scrolls sideways.
  const floor = {
    "--dt-floor": floorOf(columns, (c) => c.width),
    "--dt-floor-narrow": floorOf(columns, narrowOf),
  } as CSSProperties;
  // An end-aligned column keeps clear of the resize handle: its text sits a little in from the edge.
  const cellClass = (column: DataColumn<T>) => cn("px-3", column.align === "end" && "pr-5");
  const heldClass = (hold: Hold | undefined, hover = false) =>
    hold && cn(HELD, holdClass(hold), hover && HELD_HOVER);

  return (
    <div className={frameClass}>
      <Table
        aria-label={label}
        style={floor}
        className="min-w-(--dt-floor-narrow) table-fixed @lg/table:min-w-(--dt-floor)"
      >
        <TableHeader>
          <TableRow className={cn("border-border h-10 hover:bg-transparent", headTopRule)}>
            {columns.map((column) => {
              const hold = held.get(column.id);
              return (
                <TableHead
                  key={column.id}
                  data-column={column.id}
                  style={{ ...widthStyle(column), ...(hold && holdStyle(hold)) }}
                  className={cn(
                    cellClass(column),
                    widthClass(column),
                    !hold && "relative",
                    "text-muted-foreground h-10 truncate text-[0.68rem] font-semibold tracking-[0.05em] uppercase",
                    column.align === "end" ? "text-right" : "text-left",
                    heldClass(hold),
                  )}
                >
                  {column.headerNode ??
                    (column.hideHeader ? (
                      <span className="sr-only">{column.header}</span>
                    ) : (
                      column.header
                    ))}
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
