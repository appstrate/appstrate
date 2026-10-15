// SPDX-License-Identifier: Apache-2.0

import { Loader2Icon } from "lucide-react";

import { cn } from "../cn.ts";

/**
 * Decorative unless named: without an `aria-label` it is hidden from assistive
 * technology, so a spinner inside a button leaves the button's name alone. With
 * one, it is a `status` announcing that label.
 */
function Spinner({ className, ...props }: React.ComponentProps<"svg">) {
  return (
    <Loader2Icon
      {...(props["aria-label"] ? { role: "status" } : { "aria-hidden": true })}
      className={cn("size-4 animate-spin", className)}
      {...props}
    />
  );
}

export { Spinner };
