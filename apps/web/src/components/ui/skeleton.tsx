// SPDX-License-Identifier: Apache-2.0

import { cn } from "@/lib/utils";

function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("bg-muted animate-pulse rounded-md", className)} {...props} />;
}

export { Skeleton };
