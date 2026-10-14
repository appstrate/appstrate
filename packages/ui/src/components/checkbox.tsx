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
 * A checkbox with its label and an optional line under it. Both lines sit in
 * the `<label>`, so the whole text toggles the box.
 */
function CheckboxField({
  id,
  label,
  description,
  className,
  disabled,
  ...props
}: Omit<React.ComponentPropsWithoutRef<typeof CheckboxPrimitive.Root>, "id"> & {
  id: string;
  label: React.ReactNode;
  description?: React.ReactNode;
}) {
  return (
    <div className={cn("flex items-start gap-2", className)}>
      <Checkbox id={id} className="mt-0.5" disabled={disabled} {...props} />
      <label
        htmlFor={id}
        className={cn(
          "grid gap-1 leading-none",
          disabled ? "cursor-not-allowed opacity-70" : "cursor-pointer",
        )}
      >
        <span className="text-sm font-medium">{label}</span>
        {description && <span className="text-muted-foreground text-xs">{description}</span>}
      </label>
    </div>
  );
}

export { Checkbox, CheckboxField };
