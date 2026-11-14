// SPDX-License-Identifier: Apache-2.0

/**
 * The two pieces every skeleton is built from when it must stand exactly where
 * its content will: a line of text and a badge, each sized by the SAME classes
 * as the real one, so the font, not a guessed pixel height, makes the box.
 */

import { Badge } from "@appstrate/ui/components/badge";
import { cn } from "@appstrate/ui/cn";

/**
 * A line of text on its way, as tall as the real one: `className` carries the
 * real line's typography and margin (so the line box is the font's) plus the
 * bar's width.
 */
export function SkeletonLine({
  className,
  inline,
}: {
  className: string;
  /**
   * The classes of an inline element the real text sits in (a `font-mono` id in a
   * sans line): its own font metrics grow the line box, so the placeholder's must too.
   */
  inline?: string;
}) {
  // Spans, so the line may sit wherever its text would (a `<p>`, a `<dd>`, an inline label).
  return (
    <span className={cn("relative block", className)}>
      {inline ? <span className={inline}>{"\u00a0"}</span> : "\u00a0"}
      <span className="bg-muted absolute inset-x-0 inset-y-[20%] animate-pulse rounded-md" />
    </span>
  );
}

/** A badge on its way: the real badge box, emptied — `className` carries the real badge's classes. */
export function SkeletonBadge({ className }: { className?: string }) {
  return (
    <Badge variant="outline" className={cn(className, "bg-muted animate-pulse border-transparent")}>
      {"\u00a0"}
    </Badge>
  );
}
