// SPDX-License-Identifier: Apache-2.0

import { Loader2 } from "lucide-react";
import { cn } from "../cn.ts";

export function Spinner({ className, label }: { className?: string; label?: string }) {
  return (
    <Loader2
      className={cn("h-4 w-4 animate-spin", className)}
      {...(label ? { role: "status", "aria-label": label } : { "aria-hidden": true })}
    />
  );
}
