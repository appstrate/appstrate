// SPDX-License-Identifier: Apache-2.0

import * as React from "react";
import { ScrollArea as ScrollAreaPrimitive } from "@base-ui/react/scroll-area";

import { cn } from "../cn.ts";

function ScrollArea({
  className,
  children,
  viewportProps,
  ...props
}: Omit<ScrollAreaPrimitive.Root.Props, "className"> & {
  className?: string;
  viewportProps?: Pick<React.ComponentProps<"div">, "ref" | "onScroll">;
}) {
  return (
    <ScrollAreaPrimitive.Root className={cn("relative overflow-hidden", className)} {...props}>
      <ScrollAreaPrimitive.Viewport
        className="h-full w-full rounded-[inherit] outline-none"
        {...viewportProps}
      >
        {children}
      </ScrollAreaPrimitive.Viewport>
      <ScrollBar />
      <ScrollAreaPrimitive.Corner />
    </ScrollAreaPrimitive.Root>
  );
}

function ScrollBar({
  className,
  orientation = "vertical",
  ...props
}: Omit<ScrollAreaPrimitive.Scrollbar.Props, "className"> & { className?: string }) {
  return (
    <ScrollAreaPrimitive.Scrollbar
      orientation={orientation}
      className={cn(
        "flex touch-none transition-colors select-none",
        orientation === "vertical" && "h-full w-2.5 border-l border-l-transparent p-[1px]",
        orientation === "horizontal" && "h-2.5 flex-col border-t border-t-transparent p-[1px]",
        className,
      )}
      {...props}
    >
      <ScrollAreaPrimitive.Thumb className="bg-border relative flex-1 rounded-full" />
    </ScrollAreaPrimitive.Scrollbar>
  );
}

export { ScrollArea, ScrollBar };
