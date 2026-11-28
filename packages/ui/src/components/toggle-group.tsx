// SPDX-License-Identifier: Apache-2.0

import * as React from "react";
import { Toggle as TogglePrimitive } from "@base-ui/react/toggle";
import { ToggleGroup as ToggleGroupPrimitive } from "@base-ui/react/toggle-group";
import { type VariantProps } from "class-variance-authority";

import { cn } from "../cn.ts";
import type { WithClassName } from "./primitive-props.ts";
import { toggleVariants } from "./toggle.tsx";

const ToggleGroupContext = React.createContext<VariantProps<typeof toggleVariants>>({
  size: "default",
  variant: "default",
});

/** The pressed values are an array, one entry at most unless `multiple`. */
function ToggleGroup<Value extends string = string>({
  className,
  variant,
  size,
  children,
  ...props
}: WithClassName<ToggleGroupPrimitive.Props<Value>> & VariantProps<typeof toggleVariants>) {
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

function ToggleGroupItem<Value extends string = string>({
  className,
  variant,
  size,
  ...props
}: WithClassName<TogglePrimitive.Props<Value>> & VariantProps<typeof toggleVariants>) {
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
