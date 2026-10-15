// SPDX-License-Identifier: Apache-2.0

/**
 * The cells every `DataTable` column set draws, so a muted line, a date, a
 * dash or a list of names looks the same in every table. A cell with a
 * `title` is raised above the row's link (`relative z-10`, see `data-table.tsx`):
 * otherwise the row swallows the hover that shows it.
 */

import type { ReactNode } from "react";
import { cn } from "@appstrate/ui/cn";
import { formatDateField } from "../lib/format-date";

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
