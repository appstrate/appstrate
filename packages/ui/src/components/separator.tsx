// SPDX-License-Identifier: Apache-2.0

import { Separator as SeparatorPrimitive } from "@base-ui/react/separator";

import { cn } from "../cn.ts";
import type { WithClassName } from "./primitive-props.ts";

function Separator({
  className,
  orientation = "horizontal",
  ...props
}: WithClassName<SeparatorPrimitive.Props>) {
  return (
    <SeparatorPrimitive
      orientation={orientation}
      className={cn(
        "bg-border shrink-0",
        orientation === "horizontal" ? "h-[1px] w-full" : "h-full w-[1px]",
        className,
      )}
      {...props}
    />
  );
}

export { Separator };
