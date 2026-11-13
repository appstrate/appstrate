// SPDX-License-Identifier: Apache-2.0

/**
 * The cells every `DataTable` column set draws, so a muted line, a date, a
 * dash or a list of names looks the same in every table. A cell with a
 * `title` is raised above the row's link (`relative z-10`, see `data-table.tsx`):
 * otherwise the row swallows the hover that shows it.
 */

import type { ReactNode } from "react";
import { cn } from "@appstrate/ui/cn";
import { Skeleton } from "@appstrate/ui/components/skeleton";
import { formatDateField } from "../lib/format-date";
import { SkeletonLine } from "./skeleton-line";

/** One truncated line: muted `text-xs` by default, the row's name when `strong`. */
export function CellText({
  children,
  title,
  strong = false,
  mono = false,
  className,
}: {
  children: ReactNode;
  /** Full text on hover. */
  title?: string;
  strong?: boolean;
  mono?: boolean;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "block truncate",
        strong ? "text-foreground text-sm font-medium" : "text-muted-foreground text-xs",
        mono && "font-mono",
        title && "relative z-10",
        className,
      )}
      title={title}
    >
      {children}
    </span>
  );
}

/** The one way a cell says "nothing here". */
export function CellEmpty() {
  return <span className="text-muted-foreground/50">—</span>;
}

/** A date, or the dash. Its column carries `align: "end"`. */
export function CellDate({
  value,
  granularity = "datetime",
  timeZone,
}: {
  value: string | Date | number | null | undefined;
  granularity?: "date" | "datetime";
  /** The zone the date is named in (a schedule's own), the reader's when unset. */
  timeZone?: string | null;
}) {
  if (value === null || value === undefined) return <CellEmpty />;
  return <CellText>{formatDateField(value, granularity, timeZone)}</CellText>;
}

/** Names joined on one line, the whole list on hover; the dash when there is none. */
export function CellList({ items }: { items: readonly string[] }) {
  if (items.length === 0) return <CellEmpty />;
  const text = items.join(", ");
  return <CellText title={text}>{text}</CellText>;
}

/**
 * A cell while its rows load (`DataColumn.placeholder`): an optional icon tile
 * (`icon` carries the real tile's size and radius), then `CellText`'s lines — the
 * row's name over a muted line with `twoLines`, else one muted line.
 */
export function CellPlaceholder({
  icon,
  twoLines = false,
  width = "w-3/4",
}: {
  icon?: string;
  twoLines?: boolean;
  width?: string;
}) {
  const lines = twoLines ? (
    <div className="flex min-w-0 flex-1 flex-col">
      <SkeletonLine className="w-32 max-w-full text-sm font-medium" />
      <SkeletonLine className="w-48 max-w-full text-xs" />
    </div>
  ) : (
    <SkeletonLine className={cn("max-w-full text-xs", width)} />
  );
  if (!icon) return lines;
  return (
    <div className="flex min-w-0 flex-1 items-center gap-3">
      <Skeleton className={cn("shrink-0", icon)} />
      {lines}
    </div>
  );
}
