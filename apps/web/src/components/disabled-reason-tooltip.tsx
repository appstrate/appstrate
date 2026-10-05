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
 * events and takes no focus, so a `title` on it reaches nobody but a mouse: a
 * focusable span carries the reason instead — as a tooltip on hover and on
 * keyboard focus, and as text a screen reader reads when it lands on the span.
 * A tap does not open it (a Radix tooltip never opens on touch). `null` renders
 * the control bare.
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
