// SPDX-License-Identifier: Apache-2.0

import { Loader2Icon } from "lucide-react";

import { cn } from "../cn.ts";

function Spinner({ className, ...props }: React.ComponentProps<"svg">) {
  return (
    <Loader2Icon
      role="status"
      aria-label="Loading"
      className={cn("size-4 animate-spin", className)}
      {...props}
    />
  );
}

export { Spinner };
