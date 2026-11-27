// SPDX-License-Identifier: Apache-2.0

import { Checkbox as CheckboxPrimitive } from "@base-ui/react/checkbox";
import { Check } from "lucide-react";

import { cn } from "../cn.ts";

/** A native `<button>`, for the sibling `<label htmlFor>` the call sites use (see `Switch`). */
function Checkbox({
  className,
  ...props
}: Omit<CheckboxPrimitive.Root.Props, "className" | "render" | "nativeButton"> & {
  className?: string;
}) {
  return (
    <CheckboxPrimitive.Root
      nativeButton
      render={<button type="button" />}
      className={cn(
        "peer border-primary ring-offset-background focus-visible:ring-ring data-checked:bg-primary data-checked:text-primary-foreground grid h-4 w-4 shrink-0 place-content-center rounded-sm border focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    >
      <CheckboxPrimitive.Indicator className="grid place-content-center text-current">
        <Check className="h-4 w-4" />
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
}

export { Checkbox };
