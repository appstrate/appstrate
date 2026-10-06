// SPDX-License-Identifier: Apache-2.0

import type { ReactNode } from "react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@appstrate/ui/components/tooltip";

/**
 * Explains why a control is disabled. A disabled control fires no pointer
 * events: a focusable span carries the reason, as a tooltip (not on touch) and
 * as screen-reader text. `null` renders the control bare.
 */
export function DisabledReasonTooltip({
  reason,
  children,
}: {
  reason: string | null | undefined;
  children: ReactNode;
}) {
  if (!reason) return children;
  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span tabIndex={0} className="relative inline-flex">
            {children}
            <span className="sr-only">{reason}</span>
          </span>
        </TooltipTrigger>
        <TooltipContent className="max-w-xs">{reason}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
