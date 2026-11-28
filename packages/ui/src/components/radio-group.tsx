// SPDX-License-Identifier: Apache-2.0

import { Radio as RadioPrimitive } from "@base-ui/react/radio";
import { RadioGroup as RadioGroupPrimitive } from "@base-ui/react/radio-group";
import { Circle } from "lucide-react";

import { cn } from "../cn.ts";
import type { WithClassName } from "./primitive-props.ts";

function RadioGroup({ className, ...props }: WithClassName<RadioGroupPrimitive.Props>) {
  return <RadioGroupPrimitive className={cn("grid gap-2", className)} {...props} />;
}

/** A native `<button>`, for the sibling `<label htmlFor>` the call sites use (see `Switch`). */
function RadioGroupItem({
  className,
  ...props
}: WithClassName<Omit<RadioPrimitive.Root.Props, "render" | "nativeButton">>) {
  return (
    <RadioPrimitive.Root
      nativeButton
      render={<button type="button" />}
      className={cn(
        "border-primary text-primary ring-offset-background focus-visible:ring-ring aspect-square h-4 w-4 rounded-full border focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    >
      <RadioPrimitive.Indicator className="flex items-center justify-center">
        <Circle className="h-2.5 w-2.5 fill-current text-current" />
      </RadioPrimitive.Indicator>
    </RadioPrimitive.Root>
  );
}

export { RadioGroup, RadioGroupItem };
