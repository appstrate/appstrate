// SPDX-License-Identifier: Apache-2.0

import * as React from "react";
import * as ScrollAreaPrimitive from "@radix-ui/react-scroll-area";

import { cn } from "../cn.ts";

const ScrollArea = React.forwardRef<
  React.ElementRef<typeof ScrollAreaPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof ScrollAreaPrimitive.Root> & {
    viewportProps?: Pick<
      React.ComponentPropsWithRef<typeof ScrollAreaPrimitive.Viewport>,
      "ref" | "onScroll"
    >;
  }
>(({ className, children, viewportProps, ...props }, ref) => (
  <ScrollAreaPrimitive.Root
    ref={ref}
    className={cn("relative overflow-hidden", className)}
    {...props}
  >
    <ScrollAreaPrimitive.Viewport className="h-full w-full rounded-[inherit]" {...viewportProps}>
      {children}
    </ScrollAreaPrimitive.Viewport>
    <ScrollBar />
    <ScrollAreaPrimitive.Corner />
  </ScrollAreaPrimitive.Root>
));
ScrollArea.displayName = ScrollAreaPrimitive.Root.displayName;

const ScrollBar = React.forwardRef<
  React.ElementRef<typeof ScrollAreaPrimitive.ScrollAreaScrollbar>,
  React.ComponentPropsWithoutRef<typeof ScrollAreaPrimitive.ScrollAreaScrollbar>
>(({ className, orientation = "vertical", ...props }, ref) => (
  <ScrollAreaPrimitive.ScrollAreaScrollbar
    ref={ref}
    orientation={orientation}
    className={cn(
      "flex touch-none transition-colors select-none",
      orientation === "vertical" && "h-full w-2.5 border-l border-l-transparent p-[1px]",
      orientation === "horizontal" && "h-2.5 flex-col border-t border-t-transparent p-[1px]",
      className,
    )}
    {...props}
  >
    <ScrollAreaPrimitive.ScrollAreaThumb className="bg-border relative flex-1 rounded-full" />
  </ScrollAreaPrimitive.ScrollAreaScrollbar>
));
ScrollBar.displayName = ScrollAreaPrimitive.ScrollAreaScrollbar.displayName;

/**
 * The two pieces `ScrollArea` assembles, for a scroll it cannot assemble: a viewport another
 * library renders (the chat's thread, whose viewport is assistant-ui's), or a bar placed against a
 * wider box than its viewport (the chat's, at the window's edge past the side panel). Under a root,
 * a viewport and a `ScrollBar` anywhere in it.
 */
const ScrollAreaRoot = ScrollAreaPrimitive.Root;
const ScrollAreaViewport = ScrollAreaPrimitive.Viewport;

export { ScrollArea, ScrollAreaRoot, ScrollAreaViewport, ScrollBar };
