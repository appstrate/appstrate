// SPDX-License-Identifier: Apache-2.0

import type { ReactNode } from "react";
import { TargetArrow, TargetLink, type ActionTarget } from "./action-target";

const className =
  "text-primary hover:bg-muted/40 focus-visible:ring-ring group flex min-h-9 w-full cursor-pointer items-center justify-start border-t px-4 py-2 text-left text-xs font-normal transition-colors outline-none focus-visible:ring-2 focus-visible:ring-inset";

/** One quiet, full-width footer action for operational summary cards. */
export function OverviewCardAction({
  target,
  children,
}: {
  target: ActionTarget;
  children: ReactNode;
}) {
  return (
    <TargetLink target={target} className={className}>
      <span>{children}</span>
      <TargetArrow className="text-muted-foreground/45 ml-auto size-3.5 opacity-70 group-hover:opacity-100 group-focus-visible:opacity-100" />
    </TargetLink>
  );
}
