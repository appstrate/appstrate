// SPDX-License-Identifier: Apache-2.0

import * as React from "react";
import * as CheckboxPrimitive from "@radix-ui/react-checkbox";
import { Check } from "lucide-react";
import { cn } from "../cn.ts";

const Checkbox = React.forwardRef<
  React.ComponentRef<typeof CheckboxPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof CheckboxPrimitive.Root>
>(({ className, ...props }, ref) => (
  <CheckboxPrimitive.Root
    ref={ref}
    className={cn(
      "peer border-input focus-visible:ring-ring data-[state=checked]:border-foreground data-[state=checked]:bg-foreground data-[state=checked]:text-background data-[state=indeterminate]:bg-foreground data-[state=indeterminate]:text-background h-4 w-4 shrink-0 rounded-sm border focus-visible:ring-1 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50",
      className,
    )}
    {...props}
  >
    <CheckboxPrimitive.Indicator className={cn("flex items-center justify-center text-current")}>
      <Check className="h-4 w-4" />
    </CheckboxPrimitive.Indicator>
  </CheckboxPrimitive.Root>
));
Checkbox.displayName = CheckboxPrimitive.Root.displayName;

/**
 * A checkbox with its label and an optional line under it. The label is the
 * hit area, so the whole sentence toggles the box.
 */
function CheckboxField({
  id,
  label,
  description,
  className,
  ...props
}: Omit<React.ComponentPropsWithoutRef<typeof CheckboxPrimitive.Root>, "id"> & {
  id: string;
  label: React.ReactNode;
  description?: React.ReactNode;
}) {
  return (
    <div className={cn("flex items-start gap-2", className)}>
      <Checkbox id={id} className="mt-0.5" {...props} />
      <div className="grid gap-1 leading-none">
        <label
          htmlFor={id}
          className="text-sm font-medium peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
        >
          {label}
        </label>
        {description && <p className="text-muted-foreground text-xs">{description}</p>}
      </div>
    </div>
  );
}

export { Checkbox, CheckboxField };
