// SPDX-License-Identifier: Apache-2.0

import type { ComponentProps, ReactNode } from "react";
import { cn } from "@appstrate/ui/cn";
import { Checkbox } from "@appstrate/ui/components/checkbox";

/** A shadcn `Checkbox` with its label and description, the label targeting the box. */
export function CheckboxField({
  id,
  label,
  description,
  className,
  disabled,
  ...props
}: Omit<ComponentProps<typeof Checkbox>, "id"> & {
  id: string;
  label: ReactNode;
  description?: ReactNode;
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
