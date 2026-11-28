// SPDX-License-Identifier: Apache-2.0

/**
 * A run on two lines, wherever it is drawn: the thread's run card and, later, the context panel.
 * Presentational: everything comes by props, so it reads no chat host and no assistant-ui state.
 * The lead is the agent's 32px tile with the run's state on a badge at its corner; line 1 the
 * name, then what follows it on the right; line 2 what the run says. Both lines have a fixed
 * height, so nothing that arrives later (the badge, the logos, the duration, a new line) moves
 * the block.
 */

import * as React from "react";
import { cn } from "@appstrate/ui/cn";

export type RunLineProps = Omit<React.HTMLAttributes<HTMLDivElement>, "children"> & {
  /** The agent's tile, drawn in a 32px slot. */
  tile: React.ReactNode;
  /** The run's state: an icon, drawn at 12px on a 16px disc of the card's colour at the tile's corner. */
  badge?: React.ReactNode;
  name: React.ReactNode;
  /** What follows the name on the right (logos, a space, a duration, a link), each `shrink-0`. */
  trailing?: React.ReactNode;
  /**
   * Line 2, muted. Its children share one grid cell and truncate, so a keyed line swapping for
   * the next can animate in over it without changing the height.
   */
  sub: React.ReactNode;
};

export function RunLine({ tile, badge, name, trailing, sub, className, ...root }: RunLineProps) {
  return (
    <div {...root} className={cn("flex min-w-0 items-center gap-3", className)}>
      <span className="relative flex shrink-0">
        <span className="flex size-8 items-center justify-center overflow-hidden rounded-lg">
          {tile}
        </span>
        {badge ? (
          <span className="bg-card absolute -right-1 -bottom-1 flex size-4 items-center justify-center rounded-full [&_svg]:size-3">
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
        <div className="text-muted-foreground grid h-4 min-w-0 text-xs leading-4 *:col-start-1 *:row-start-1 *:truncate">
          {sub}
        </div>
      </div>
    </div>
  );
}
