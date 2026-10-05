// SPDX-License-Identifier: Apache-2.0

import { useRef, useState, type ReactNode } from "react";
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
 * keyboard focus, on tap (a tooltip never opens on touch by itself), and as
 * text a screen reader reads when it lands on the span. `null` renders the
 * control bare.
 */
export function DisabledReasonTooltip({
  reason,
  children,
}: {
  reason: string | null | undefined;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  // Radix closes a tooltip on click, right after our own handler in the same
  // dispatch. A tap is the only gesture touch has, so that one close is ignored.
  const tapping = useRef(false);
  if (!reason) return children;
  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip
        open={open}
        onOpenChange={(next) => {
          if (next || !tapping.current) setOpen(next);
        }}
      >
        <TooltipTrigger asChild>
          <span
            tabIndex={0}
            className="relative inline-flex"
            onClick={() => {
              tapping.current = true;
              queueMicrotask(() => {
                tapping.current = false;
              });
              setOpen(true);
            }}
          >
            {children}
            <span className="sr-only">{reason}</span>
          </span>
        </TooltipTrigger>
        <TooltipContent className="max-w-xs">{reason}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
