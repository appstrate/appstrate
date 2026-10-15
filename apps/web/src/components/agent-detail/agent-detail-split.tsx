// SPDX-License-Identifier: Apache-2.0

import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "@appstrate/ui/cn";
import { PhoneNavigation } from "../phone-navigation";

/** Shared two-pane frame for the Agent file and configuration destinations. */
interface AgentDetailSplitProps extends HTMLAttributes<HTMLDivElement> {
  rail: ReactNode;
  railClassName?: string;
  /**
   * A rail of sections to pick from, named by this title: in a frame narrower
   * than 36rem it moves into a Menu sheet above the content instead of
   * stacking there in full. A rail that is the content's own outline (a file
   * tree) leaves it unset.
   */
  phoneMenu?: string;
}

export function AgentDetailSplit({
  rail,
  children,
  className,
  railClassName,
  phoneMenu,
  ...props
}: AgentDetailSplitProps) {
  // A rail of sections folds on the frame's width, not the window's: at a
  // tablet's 768px the app's sidebar is drawn too, and a 14rem rail beside it
  // left the content some 180px. A content outline (a file tree) keeps
  // stacking on a phone only.
  return (
    <div {...props} className={cn("@container/split", className)}>
      <div
        className={cn(
          "grid min-h-[610px] grid-cols-1",
          phoneMenu
            ? "@xl/split:grid-cols-[14rem_minmax(0,1fr)]"
            : "md:grid-cols-[14rem_minmax(0,1fr)]",
        )}
      >
        <aside
          className={cn(
            "bg-card min-w-0 border-b",
            phoneMenu
              ? "hidden @xl/split:block @xl/split:border-r @xl/split:border-b-0"
              : "md:border-r md:border-b-0",
            railClassName,
          )}
        >
          {rail}
        </aside>
        <div className="min-w-0">
          {phoneMenu && (
            <div className="p-4 pb-0 @xl/split:hidden">
              <PhoneNavigation title={phoneMenu} rail={rail} className="mb-0" />
            </div>
          )}
          {children}
        </div>
      </div>
    </div>
  );
}

/** Shared top band for both panes of a split Agent surface. */
export function AgentDetailPaneHeader({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      {...props}
      className={cn(
        "border-border flex h-14 min-h-14 shrink-0 items-center border-b px-3",
        className,
      )}
    />
  );
}
