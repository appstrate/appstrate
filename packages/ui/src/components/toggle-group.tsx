// SPDX-License-Identifier: Apache-2.0

import * as React from "react";
import { Toggle as TogglePrimitive } from "@base-ui/react/toggle";
import { ToggleGroup as ToggleGroupPrimitive } from "@base-ui/react/toggle-group";
import { type VariantProps } from "class-variance-authority";

import { cn } from "../cn.ts";
import { toggleVariants } from "./toggle.tsx";

const ToggleGroupContext = React.createContext<VariantProps<typeof toggleVariants>>({
  size: "default",
  variant: "default",
});

/** The pressed values are an array, one entry at most unless `multiple`. */
function ToggleGroup({
  className,
  variant,
  size,
  children,
  ...props
}: Omit<ToggleGroupPrimitive.Props, "className"> &
  VariantProps<typeof toggleVariants> & { className?: string }) {
  return (
    <ToggleGroupPrimitive
      className={cn("flex items-center justify-center gap-1", className)}
      {...props}
    >
      <ToggleGroupContext.Provider value={{ variant, size }}>
        {children}
      </ToggleGroupContext.Provider>
    </ToggleGroupPrimitive>
  );
}

function ToggleGroupItem({
  className,
  variant,
  size,
  ...props
}: Omit<TogglePrimitive.Props, "className"> &
  VariantProps<typeof toggleVariants> & { className?: string }) {
  const context = React.useContext(ToggleGroupContext);
  return (
    <TogglePrimitive
      className={cn(
        toggleVariants({ variant: context.variant || variant, size: context.size || size }),
        className,
      )}
      {...props}
    />
  );
}

export { ToggleGroup, ToggleGroupItem };
