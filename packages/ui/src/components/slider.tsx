// SPDX-License-Identifier: Apache-2.0

import { Slider as SliderPrimitive } from "@base-ui/react/slider";

import { cn } from "../cn.ts";

function Slider({
  className,
  ...props
}: Omit<SliderPrimitive.Root.Props, "className"> & { className?: string }) {
  return (
    <SliderPrimitive.Root
      className={cn("relative w-full touch-none select-none", className)}
      {...props}
    >
      <SliderPrimitive.Control className="flex w-full items-center py-1">
        <SliderPrimitive.Track className="bg-secondary relative h-2 w-full grow overflow-hidden rounded-full">
          <SliderPrimitive.Indicator className="bg-primary h-full" />
        </SliderPrimitive.Track>
        <SliderPrimitive.Thumb className="border-primary bg-background ring-offset-background has-focus-visible:ring-ring block h-5 w-5 rounded-full border-2 transition-colors has-focus-visible:ring-2 has-focus-visible:ring-offset-2 data-disabled:pointer-events-none data-disabled:opacity-50" />
      </SliderPrimitive.Control>
    </SliderPrimitive.Root>
  );
}

export { Slider };
