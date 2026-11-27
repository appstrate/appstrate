// SPDX-License-Identifier: Apache-2.0

import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip";

import { cn } from "../cn.ts";

type TooltipContentProps = Omit<TooltipPrimitive.Popup.Props, "className"> &
  Pick<TooltipPrimitive.Positioner.Props, "side" | "sideOffset" | "align" | "alignOffset"> & {
    className?: string;
  };

const TooltipProvider = TooltipPrimitive.Provider;

const Tooltip = TooltipPrimitive.Root;

const TooltipTrigger = TooltipPrimitive.Trigger;

function TooltipContent({
  className,
  side,
  sideOffset = 4,
  align,
  alignOffset,
  ...props
}: TooltipContentProps) {
  // In a portal, like the popover and the menus: drawn inside its trigger's tree, a tooltip is
  // clipped by any scrolling or `overflow-hidden` ancestor (a carousel of cards, a table).
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Positioner
        side={side}
        sideOffset={sideOffset}
        align={align}
        alignOffset={alignOffset}
        className="z-50"
      >
        <TooltipPrimitive.Popup
          className={cn(
            "bg-popover text-popover-foreground data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 origin-(--transform-origin) overflow-hidden rounded-md border px-3 py-1.5 text-sm shadow-md",
            className,
          )}
          {...props}
        />
      </TooltipPrimitive.Positioner>
    </TooltipPrimitive.Portal>
  );
}

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider };
