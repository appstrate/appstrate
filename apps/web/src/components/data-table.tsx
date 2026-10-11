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
 * - **Collection columns drop with their track, on the TABLE's width, but only
 *   the ones that are READ.** A column declares the room it needs (`tier`), and
 *   its cell AND its track go together or the row keeps a gap where the column
 *   was. A column that carries a control (`control: true`: a select, a switch,
 *   a button, an action link) has no tier and is never dropped, because a
 *   person who cannot see the control cannot act: when the table no longer
 *   fits it scrolls sideways instead, its name column and its row end (« … »)
 *   held in place (`sticky`) so the row stays named and its actions stay in
 *   reach. Settings is the exception because its static rows have no detail
 *   destination: there every fact remains rendered and the complete track
 *   scrolls horizontally when it does not fit. All treatments use the declared
 *   track FLOOR (`minmax(120px,1fr)`, never `minmax(0,…)`), because a `0`
 *   minimum tells the browser it may take the column away entirely, and it
 *   does.
 * - **Every column but the row end is resizable.** A handle on the right edge
 *   of the head drags the column, a double-click fits it to its longest
 *   content, the arrow keys nudge it. The width is the person's, kept per table
 *   in `stores/column-widths-store.ts`, and never goes below the track's floor.
 */

import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { cn } from "@appstrate/ui/cn";
import { useIsMobile } from "@appstrate/ui/use-mobile";
import { ScrollArea, ScrollBar } from "@appstrate/ui/components/scroll-area";
import { Skeleton } from "@appstrate/ui/components/skeleton";
import { collectionVerdict, type CollectionState } from "./collection";
import { ErrorState } from "./page-states";
import { useColumnWidths, type ColumnWidths } from "../stores/column-widths-store";

type DataColumnWidth = `${number}px` | `minmax(${number}px,${number}fr)`;

interface DataColumnBase<T> {
  /** Stable handle, independent of the label — a column set is a list of these. */
  id: string;
  /** Column head, already translated. Also the label the column menu lists. */
  header: string;
  /** Drawn instead of `header` when the head is a control rather than a word. */
  headerNode?: ReactNode;
  /** Grid track: `"88px"` for a fixed column, `"minmax(100px,1fr)"` for an elastic one with a measurable floor. */
  width: DataColumnWidth;
  /** Numbers, durations and dates read against the right edge. */
  align?: "end";
  cell: (row: T) => ReactNode;
}

/**
 * What a column IS decides whether it may leave: a READ column (text, a badge,
 * a date) may wait for room, a CONTROL column may not.
 */
type DataColumnNature =
  | {
      /**
       * The column holds something to act on: a select, a switch, a tick, a
       * button, a link that does something. It is never hidden for lack of
       * room (the table scrolls instead) and it never carries the row's link,
       * since a link wrapped around a tick navigates instead of ticking. The
       * type forbids a `tier` here, and `column-tiers.test.tsx` checks it again
       * on every real column set.
       */
      control: true;
      tier?: never;
    }
  | {
      control?: false;
      /**
       * How much room a READ column needs, and therefore when it appears in a
       * tiered collection. Unset is the row's identity, always drawn. `2` waits
       * for a 36rem table, `3` for a 56rem one. Settings renders all tiers and
       * scrolls their complete floor. `column-tiers.test.tsx` checks the
       * arithmetic.
       */
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
  /**
   * What the row's link is called. Needed because the link lives in the FIRST
   * cell: left to itself it would be announced as "#131", which names nothing.
   */
  rowLabel?: (row: T) => string;
  /** Router state to carry, e.g. a run number the destination can show before it loads. */
  rowState?: (row: T) => unknown;
  /** Pinned above the first row, inside the frame (e.g. a scheduled next run). */
  banner?: ReactNode;
  /** Names the table for screen readers (never drawn) and keys the widths its reader gave the columns. */
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
 * The column that says WHICH row this is: the first one read and always drawn.
 * A tick or a select before it is not the row's name.
 */
function isIdentity<T>(column: DataColumn<T>): boolean {
  return !column.tier && !column.control;
}

/** The row's end (« … »): no head to name it, so nothing to drag, hide or list. */
function isRowEnd<T>(column: DataColumn<T>): boolean {
  return !column.header && !column.headerNode;
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
  const requiredId = columns.find((column) => isIdentity(column) && column.header)?.id;
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
  const requiredId = columns.find((column) => isIdentity(column) && column.header)?.id;
  return columns.filter(
    (column) => column.id === requiredId || !column.header || !hidden.includes(column.id),
  );
}

const SKELETON_ROWS = 3;
/** Nobody needs a column wider than this; it also bounds a fit-to-content on a long value. */
const MAX_COLUMN_WIDTH = 720;
/**
 * The share of the table's width that must stay free to scroll beside the held
 * columns. Below it the strip in between is too narrow to read, and the whole
 * table scrolls as one instead.
 */
const MIN_SCROLLING_SHARE = 0.5;
/** One arrow press on a resize handle; Shift triples it. */
const KEY_STEP = 16;

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

function trackFloor(width: DataColumnWidth): number {
  const fixed = /^(\d+(?:\.\d+)?)px$/.exec(width);
  if (fixed) return Number(fixed[1]);
  const elastic = /^minmax\((\d+(?:\.\d+)?)px,/.exec(width);
  if (elastic) return Number(elastic[1]);
  throw new Error(`DataTable cannot read the floor of track ${width}`);
}

function isFixed(width: DataColumnWidth): boolean {
  return /^\d+(?:\.\d+)?px$/.test(width);
}

/** What a person can drag: every column with a head, bar the fixed-size ticks and buttons. */
function isResizable<T>(column: DataColumn<T>): boolean {
  return !isRowEnd(column) && !(column.control && isFixed(column.width));
}

/** The width a column is given: the person's choice, never under the track's floor. */
function widthOf<T>(column: DataColumn<T>, widths: ColumnWidths): number {
  return Math.max(widths[column.id] ?? 0, trackFloor(column.width));
}

function trackOf<T>(column: DataColumn<T>, widths: ColumnWidths): string {
  return widths[column.id] ? `${widthOf(column, widths)}px` : column.width;
}

function trackList<T>(columns: DataColumn<T>[], widths: ColumnWidths): string {
  return columns.map((c) => trackOf(c, widths)).join(" ");
}

/** The least room a set of columns takes: their floors, plus the gaps and padding of the grid. */
function floorOf<T>(columns: DataColumn<T>[], widths: ColumnWidths, space: number): string {
  const tracks = columns.reduce(
    (sum, column) => sum + (widths[column.id] ? widthOf(column, widths) : trackFloor(column.width)),
    0,
  );
  return `${tracks + space * (columns.length + 1)}px`;
}

/**
 * Which columns are held in place when the table scrolls sideways, and where.
 *
 * The start holds the row's name (and the ticks before it, if any, whose fixed
 * width lets the name sit just after them); the end holds the row's « … ». A
 * name that other READ columns precede is not held: their tier hides them on a
 * narrow table, so there is no stable offset to hold it at.
 */
type Stick = { side: "start"; index: number; offset: number; last: boolean } | { side: "end" };

function stickyColumns<T>(columns: DataColumn<T>[]): Map<string, Stick> {
  const held = new Map<string, Stick>();
  const identity = columns.findIndex(isIdentity);
  if (identity >= 0) {
    const lead = columns.slice(0, identity);
    if (lead.every((c) => c.control && isFixed(c.width))) {
      let offset = 0;
      [...lead, columns[identity]!].forEach((column, index) => {
        held.set(column.id, { side: "start", index, offset, last: index === lead.length });
        offset += trackFloor(column.width);
      });
    }
  }
  const end = columns[columns.length - 1];
  if (end && isRowEnd(end) && !end.tier) held.set(end.id, { side: "end" });
  return held;
}

/**
 * A held column grows into the gap before it (a negative margin, given back as
 * padding) so the content that scrolls behind it does not show in the gutter,
 * between it and the held column before it, or at the row's edge. `--dt-space`
 * is the grid's gap and padding at the current width.
 */
function stickStyle(stick: Stick): CSSProperties {
  if (stick.side === "end") {
    return { right: 0, marginRight: "calc(var(--dt-space) * -1)", paddingRight: "var(--dt-space)" };
  }
  return {
    left: `calc(var(--dt-space) * ${stick.index} + ${stick.offset}px)`,
    marginLeft: "calc(var(--dt-space) * -1)",
    paddingLeft: "var(--dt-space)",
  };
}

/**
 * A held cell hides what scrolls under it, so it is opaque, as tall as the
 * row (the row's own padding given back) and above the raised controls (`z-10`)
 * of the cells that pass behind. `pointer-events-none`
 * on the cell and back on its content leaves the cell's empty part to the
 * row's own link underneath.
 */
const HELD_BODY =
  "sticky z-20 -my-2 self-stretch bg-(--dt-surface) py-2 pointer-events-none [&>*]:pointer-events-auto";
const HELD_HEAD = "sticky z-20 bg-(--dt-surface)";
/** Held columns that would leave no room to scroll in are let go (`data-data-table-unheld`). */
const HELD_RELEASED = "[[data-data-table-unheld]_&]:static";
const HELD_HOVER = "group-hover/row:bg-(--dt-surface-hover)";
const HELD_START_EDGE =
  "[[data-scrolled-start]_&]:shadow-[4px_0_6px_-4px_rgb(0_0_0/0.18),1px_0_0_var(--color-border)]";
const HELD_END_EDGE =
  "[[data-scrolled-end]_&]:shadow-[-4px_0_6px_-4px_rgb(0_0_0/0.18),-1px_0_0_var(--color-border)]";

function heldClass(stick: Stick | undefined, body: boolean, hover: boolean): string | undefined {
  if (!stick) return undefined;
  return cn(
    body ? HELD_BODY : HELD_HEAD,
    HELD_RELEASED,
    body && hover && HELD_HOVER,
    stick.side === "end" ? HELD_END_EDGE : stick.last && HELD_START_EDGE,
  );
}

/**
 * How wide a column has to be to show its longest value whole: the head and
 * every cell drawn, measured at their natural width (a truncated element
 * reports the width it would have untruncated through `scrollWidth`).
 */
function contentWidth(frame: HTMLElement, id: string): number {
  let widest = 0;
  const cells = frame.querySelectorAll<HTMLElement>(`[data-data-table-column="${CSS.escape(id)}"]`);
  for (const cell of cells) {
    const box = cell.getBoundingClientRect();
    // Hidden by its tier: nothing to measure.
    if (box.width === 0) continue;
    const origin = box.left + parseFloat(getComputedStyle(cell).paddingLeft);
    // The cell itself is as wide as the column is now: only what it holds is measured.
    for (const el of cell.querySelectorAll<HTMLElement>("*")) {
      // The handle is not content, and the head's wrapper is as wide as the column by design.
      if (el.closest("[data-data-table-handle]") || el.hasAttribute("data-data-table-head-wrapper"))
        continue;
      const rect = el.getBoundingClientRect();
      widest = Math.max(widest, rect.left - origin + Math.max(rect.width, el.scrollWidth || 0));
    }
  }
  // The cell's own padding was taken out of the origin; the rounding is given back.
  return Math.ceil(widest) + 1;
}

/**
 * The drag handle on a column head's right edge, centred in the gap between
 * two columns. A pointer drags it, a double-click (or Enter) fits the column
 * to its content, the arrow keys nudge it: it is a `separator` that can be
 * focused, the pattern for a splitter.
 */
function ResizeHandle({
  name,
  floor,
  onResize,
  onFit,
}: {
  name: string;
  floor: number;
  /** `commit` is false while the pointer is still down. */
  onResize: (width: number, commit: boolean) => void;
  onFit: () => void;
}) {
  const { t } = useTranslation("common");
  const drag = useRef<{ x: number; width: number; last: number } | null>(null);
  const [now, setNow] = useState<number>();
  const clamp = (width: number) => Math.min(MAX_COLUMN_WIDTH, Math.max(floor, Math.round(width)));
  // The column's own width: a held head carries the row's padding as its own, which is not the track's.
  const headWidth = (el: HTMLElement) => {
    const head = el.parentElement;
    if (!head) return floor;
    const style = getComputedStyle(head);
    return (
      head.getBoundingClientRect().width -
      parseFloat(style.paddingLeft) -
      parseFloat(style.paddingRight)
    );
  };
  const apply = (width: number, commit: boolean) => {
    const next = clamp(width);
    setNow(next);
    onResize(next, commit);
    return next;
  };

  const onPointerDown = (e: PointerEvent<HTMLElement>) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const width = headWidth(e.currentTarget);
    drag.current = { x: e.clientX, width, last: width };
  };
  const onPointerMove = (e: PointerEvent<HTMLElement>) => {
    const start = drag.current;
    if (!start) return;
    start.last = apply(start.width + e.clientX - start.x, false);
  };
  const onPointerEnd = () => {
    const start = drag.current;
    drag.current = null;
    // A plain click, or the first half of a double-click, moves nothing.
    if (start && start.last !== start.width) onResize(start.last, true);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    const step = (e.shiftKey ? 3 : 1) * KEY_STEP;
    if (e.key === "Enter") onFit();
    else if (e.key === "ArrowLeft") apply(headWidth(e.currentTarget) - step, true);
    else if (e.key === "ArrowRight") apply(headWidth(e.currentTarget) + step, true);
    else return;
    e.preventDefault();
  };

  return (
    <span
      role="separator"
      aria-orientation="vertical"
      aria-label={t("table.resizeColumn", { column: name })}
      aria-valuemin={floor}
      aria-valuemax={MAX_COLUMN_WIDTH}
      aria-valuenow={now}
      tabIndex={0}
      data-data-table-handle
      onFocus={(e) => setNow(clamp(headWidth(e.currentTarget)))}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerEnd}
      onPointerCancel={onPointerEnd}
      onDoubleClick={onFit}
      onKeyDown={onKeyDown}
      style={{ right: "calc(var(--dt-space) / -2)", width: "var(--dt-space)" }}
      className="group/handle absolute inset-y-0 z-30 flex cursor-col-resize touch-none items-center justify-center outline-none select-none"
    >
      <span className="bg-border group-hover/handle:bg-primary group-focus-visible/handle:bg-primary group-focus-visible/handle:ring-ring h-4 w-px transition-colors group-hover/handle:w-0.5 group-focus-visible/handle:w-0.5 group-focus-visible/handle:ring-2" />
    </span>
  );
}

export function DataTable<T>({
  columns,
  rows,
  rowKey,
  rowHref,
  rowAction,
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
  const frameRef = useRef<HTMLDivElement>(null);
  const tableRef = useRef<HTMLTableElement>(null);
  // The widths the reader chose, and the one being dragged until it is let go.
  // A phone has its own widths: a name column a person widened on a desktop
  // would otherwise fill the phone's whole width, and the column held in place
  // would hide everything that scrolls under it.
  const stored = useColumnWidths(useIsMobile() ? `${label}:mobile` : label);
  const [dragged, setDragged] = useState<ColumnWidths>({});
  const widths: ColumnWidths = { ...stored.widths, ...dragged };
  const resize = (id: string, width: number, commit: boolean) => {
    if (commit) {
      stored.set(id, width);
      setDragged({});
    } else {
      setDragged({ [id]: width });
    }
  };

  // Which edge of the table has more to scroll to, so the held columns can say
  // there is something behind them. Attributes rather than state: a scroll
  // must not render a table.
  useEffect(() => {
    const frame = frameRef.current;
    const viewport = frame?.querySelector<HTMLElement>("[data-radix-scroll-area-viewport]");
    if (!frame || !viewport) return;
    const update = () => {
      // Held columns that take most of the width leave a strip too narrow to
      // read (a name, a tick and a « … » on a phone or in a side panel):
      // release them and let the whole table scroll.
      const heldWidth = Array.from(
        frame.querySelectorAll<HTMLElement>("thead [data-data-table-held]"),
      ).reduce((sum, head) => sum + head.getBoundingClientRect().width, 0);
      frame.toggleAttribute(
        "data-data-table-unheld",
        heldWidth > viewport.clientWidth * (1 - MIN_SCROLLING_SHARE),
      );
      frame.toggleAttribute("data-scrolled-start", viewport.scrollLeft > 0);
      frame.toggleAttribute(
        "data-scrolled-end",
        viewport.scrollLeft + viewport.clientWidth < viewport.scrollWidth - 1,
      );
    };
    update();
    viewport.addEventListener("scroll", update, { passive: true });
    const observer = new ResizeObserver(update);
    observer.observe(viewport);
    if (tableRef.current) observer.observe(tableRef.current);
    return () => {
      viewport.removeEventListener("scroll", update);
      observer.disconnect();
    };
  }, [verdict, stored.widths]);

  // Three templates, one per tier: narrow keeps only the columns that carry the
  // row's identity (and every control), and each step up adds the ones the
  // width can now hold.
  const tierOne = columns.filter((c) => !c.tier);
  const tierTwo = columns.filter((c) => !c.tier || c.tier === 2);
  const tracks = {
    "--dt-cols": trackList(tierOne, widths),
    "--dt-cols-2": trackList(tierTwo, widths),
    "--dt-cols-3": trackList(columns, widths),
    // What the table needs at each tier: under it, it scrolls sideways.
    "--dt-floor": floorOf(tierOne, widths, 12),
    "--dt-floor-2": floorOf(tierTwo, widths, 16),
    "--dt-full-floor": floorOf(columns, widths, 16),
  } as CSSProperties;
  const held = stickyColumns(columns);

  // The link goes in the first column of tier one, not in column zero: a run
  // list leads with `#131`, which is a tier-two column, so a link parked there
  // would leave the row unclickable on a phone. A control column is skipped
  // too — the catalogue leads with a tick, and a tick inside a link navigates.
  const linkColumn = columns.findIndex(isIdentity);

  const rowGrid =
    columnMode === "scroll"
      ? "grid items-center gap-(--dt-space) px-(--dt-space) [--dt-space:1rem] [grid-template-columns:var(--dt-cols-3)]"
      : "grid items-center gap-(--dt-space) px-(--dt-space) [--dt-space:0.75rem] [grid-template-columns:var(--dt-cols)] @xl/table:[--dt-space:1rem] @xl/table:[grid-template-columns:var(--dt-cols-2)] @4xl/table:[grid-template-columns:var(--dt-cols-3)]";

  const frameClass = cn(
    "@container/table overflow-hidden",
    surface === "integrated"
      ? "bg-transparent [--dt-surface:var(--color-background)]"
      : "bg-card rounded-lg border shadow-sm [--dt-surface:var(--color-card)] [[data-settings-table-surface=integrated]_&]:rounded-none [[data-settings-table-surface=integrated]_&]:border-0 [[data-settings-table-surface=integrated]_&]:bg-transparent [[data-settings-table-surface=integrated]_&]:shadow-none",
    "[--dt-surface-hover:color-mix(in_oklab,var(--color-muted)_50%,var(--dt-surface))]",
  );

  // A failure always draws something, whether or not the caller wrote the
  // sentence — it used to be folded into `empty` at every call site, which is
  // how a 500 could read as "no runs".
  if (verdict === "error" || verdict === "empty") {
    return (
      <div data-data-table-frame className={frameClass}>
        {verdict === "error" ? (state.error ?? <ErrorState compact />) : state.empty}
      </div>
    );
  }

  return (
    <div ref={frameRef} data-data-table-frame className={frameClass}>
      <ScrollArea data-data-table-scroll>
        <table
          ref={tableRef}
          role="table"
          aria-label={label}
          data-data-table-column-mode={columnMode}
          className={cn(
            "block w-full text-sm",
            columnMode === "scroll"
              ? "min-w-(--dt-full-floor)"
              : "min-w-(--dt-floor) @xl/table:min-w-(--dt-floor-2) @4xl/table:min-w-(--dt-full-floor)",
          )}
          style={tracks}
        >
          <thead role="rowgroup" className={showHeader ? "block" : "sr-only"}>
            <tr
              role="row"
              data-data-table-row
              className={cn(rowGrid, "border-border h-10 border-y")}
            >
              {columns.map((col) => {
                const stick = held.get(col.id);
                return (
                  <th
                    role="columnheader"
                    key={col.id}
                    data-data-table-column={col.id}
                    data-data-table-tier={col.tier}
                    data-data-table-held={stick ? "" : undefined}
                    style={stick && stickStyle(stick)}
                    className={cn(
                      "text-muted-foreground min-w-0 self-stretch text-[0.68rem] font-semibold tracking-[0.05em] uppercase",
                      col.align === "end" ? "text-right" : "text-left",
                      columnMode === "tiered" && tierClass(col, "block"),
                      heldClass(stick, false, false),
                    )}
                  >
                    {/* The handle's anchor: the head itself is not positioned
                      when its column is held and then let go. */}
                    <div
                      data-data-table-head-wrapper
                      className={cn(
                        "relative flex h-full min-w-0 items-center",
                        col.align === "end" && "justify-end",
                      )}
                    >
                      <span className="block min-w-0 truncate">{col.headerNode ?? col.header}</span>
                      {showHeader && isResizable(col) && (
                        <ResizeHandle
                          name={col.header}
                          floor={trackFloor(col.width)}
                          onResize={(width, commit) => resize(col.id, width, commit)}
                          onFit={() => {
                            const frame = frameRef.current;
                            if (frame)
                              resize(
                                col.id,
                                Math.min(
                                  MAX_COLUMN_WIDTH,
                                  Math.max(trackFloor(col.width), contentWidth(frame, col.id)),
                                ),
                                true,
                              );
                          }}
                        />
                      )}
                    </div>
                  </th>
                );
              })}
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
                  const interactive = Boolean(href || rowAction);
                  return (
                    <tr
                      role="row"
                      key={rowKey(row)}
                      data-data-table-row
                      className={cn(
                        rowGrid,
                        "group/row border-border/60 relative min-h-12 border-b py-2 last:border-b-0",
                        interactive && "hover:bg-muted/50 transition-colors",
                      )}
                    >
                      {/* The row is a target as a whole. The cover is the row's, not
                        the first cell's: a held cell is `sticky`, which makes it the
                        containing block of anything absolute inside it, so a link
                        stretched from there would cover that one cell. The real,
                        named, focusable link is the one in the first cell; this
                        one only catches the click and the middle-click. */}
                      {href ? (
                        <td role="presentation" className="absolute inset-0 block p-0">
                          <Link
                            to={href}
                            state={rowState?.(row)}
                            tabIndex={-1}
                            aria-hidden
                            className="block size-full"
                          />
                        </td>
                      ) : rowAction ? (
                        <td role="presentation" className="absolute inset-0 block p-0">
                          <button
                            type="button"
                            aria-label={rowLabel?.(row) ?? rowKey(row)}
                            onClick={() => rowAction(row)}
                            className="focus-visible:outline-ring absolute inset-0 cursor-pointer rounded-none bg-transparent p-0 hover:bg-transparent focus-visible:outline-2 focus-visible:-outline-offset-2"
                          />
                        </td>
                      ) : null}
                      {columns.map((col, i) => {
                        const stick = held.get(col.id);
                        return (
                          <td
                            role="cell"
                            key={col.id}
                            data-data-table-column={col.id}
                            data-data-table-tier={col.tier}
                            style={stick && stickStyle(stick)}
                            className={cn(
                              "flex min-w-0 items-center gap-1.5",
                              col.align === "end" && "justify-end",
                              columnMode === "tiered" && tierClass(col, "flex"),
                              heldClass(stick, true, interactive),
                            )}
                          >
                            {i === linkColumn && href ? (
                              <Link
                                to={href}
                                state={rowState?.(row)}
                                aria-label={rowLabel?.(row)}
                                className="flex min-w-0 items-center gap-1.5"
                              >
                                {col.cell(row)}
                              </Link>
                            ) : (
                              col.cell(row)
                            )}
                          </td>
                        );
                      })}
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
