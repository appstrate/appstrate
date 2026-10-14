// SPDX-License-Identifier: Apache-2.0

import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "@appstrate/ui/cn";

/** Shared two-pane frame for the Agent file and configuration destinations. */
interface AgentDetailSplitProps extends HTMLAttributes<HTMLDivElement> {
  rail: ReactNode;
  railClassName?: string;
}

export function AgentDetailSplit({
  rail,
  children,
  className,
  railClassName,
  ...props
}: AgentDetailSplitProps) {
  return (
    <div
      {...props}
      className={cn(
        "grid min-h-[610px] grid-cols-[14rem_minmax(0,1fr)] max-md:grid-cols-1",
        className,
      )}
    >
      <aside
        className={cn("bg-card min-w-0 border-r max-md:border-r-0 max-md:border-b", railClassName)}
      >
        {rail}
      </aside>
      <div className="min-w-0">{children}</div>
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
