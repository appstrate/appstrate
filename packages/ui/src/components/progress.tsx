// SPDX-License-Identifier: Apache-2.0

import { Progress as ProgressPrimitive } from "@base-ui/react/progress";

import { cn } from "../cn.ts";

/** The indicator's width is the primitive's own (`value` over `max`). */
function Progress({
  className,
  indicatorClassName,
  max = 100,
  ...props
}: Omit<ProgressPrimitive.Root.Props, "className"> & {
  className?: string;
  indicatorClassName?: string;
}) {
  return (
    <ProgressPrimitive.Root
      max={max}
      className={cn("bg-muted relative h-2 w-full overflow-hidden rounded-full", className)}
      {...props}
    >
      <ProgressPrimitive.Track className="block h-full w-full">
        <ProgressPrimitive.Indicator
          className={cn("bg-primary block h-full transition-all", indicatorClassName)}
        />
      </ProgressPrimitive.Track>
    </ProgressPrimitive.Root>
  );
}

export { Progress };
