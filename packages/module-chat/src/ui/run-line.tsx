// SPDX-License-Identifier: Apache-2.0

/**
 * A run on two lines, wherever it is drawn: the thread's run card and the context panel's Runs tab.
 * Presentational: everything comes by props, so it reads no chat host and no assistant-ui state.
 * The lead is the agent's 32px tile with the run's state on a badge at its corner; line 1 the
 * name, then what follows it on the right; line 2 what the run says, then its `meta` when given.
 * Both lines have a fixed height, so nothing that arrives later (the badge, the logos, the
 * duration, a new line) moves the block.
 */

import * as React from "react";
import { cn } from "@appstrate/ui/cn";

export type RunLineProps = Omit<React.HTMLAttributes<HTMLDivElement>, "children"> & {
  /** The agent's tile, drawn in a 32px slot. */
  tile: React.ReactNode;
  /** The run's state: an icon, drawn at 12px on a 16px disc at the tile's corner. */
  badge?: React.ReactNode;
  /** The badge disc's fill, the colour of the surface it sits on; the card's by default. */
  badgeClassName?: string;
  name: React.ReactNode;
  /** What follows the name on the right (logos, a space, a duration, a link), each `shrink-0`. */
  trailing?: React.ReactNode;
  /**
   * Line 2, muted. Its children share one grid cell and truncate, so a keyed line swapping for
   * the next can animate in over it without changing the height.
   */
  sub: React.ReactNode;
  /**
   * What follows line 2 on its left, muted, each `shrink-0` (a duration, logos, a space). Line 2
   * then holds the room of a short state (20 characters) and fills what is left, so a new log line
   * never resizes the block.
   */
  meta?: React.ReactNode;
};

const SUB_CLASS =
  "text-muted-foreground grid h-4 min-w-0 text-xs leading-4 *:col-start-1 *:row-start-1 *:truncate";

export function RunLine({
  tile,
  badge,
  badgeClassName = "bg-card",
  name,
  trailing,
  sub,
  meta,
  className,
  ...root
}: RunLineProps) {
  return (
    <div {...root} className={cn("flex min-w-0 items-center gap-3", className)}>
      <span className="relative flex shrink-0">
        <span className="flex size-8 items-center justify-center overflow-hidden rounded-lg">
          {tile}
        </span>
        {badge ? (
          <span
            className={cn(
              "absolute -right-1 -bottom-1 flex size-4 items-center justify-center rounded-full [&_svg]:size-3",
              badgeClassName,
            )}
          >
            {badge}
          </span>
        ) : null}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex h-5 min-w-0 items-center gap-2">
          <span className="min-w-0 truncate text-sm font-medium">{name}</span>
          {trailing ? (
            <span className="ml-auto flex shrink-0 items-center gap-2">{trailing}</span>
          ) : null}
        </div>
        {meta ? (
          <div className="flex h-4 min-w-0 items-center gap-2">
            <div className={cn(SUB_CLASS, "min-w-[20ch] flex-1 [contain:inline-size]")}>{sub}</div>
            <span className="text-muted-foreground flex shrink-0 items-center gap-2 text-xs">
              {meta}
            </span>
          </div>
        ) : (
          <div className={SUB_CLASS}>{sub}</div>
        )}
      </div>
    </div>
  );
}
