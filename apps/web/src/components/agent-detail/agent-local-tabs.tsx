// SPDX-License-Identifier: Apache-2.0

import * as React from "react";
import { TabsList, TabsTrigger } from "@appstrate/ui/components/tabs";
import { cn } from "@appstrate/ui/cn";

/** Stock shadcn tabs, tighter on a phone, with horizontal overflow when they still do not fit. */
export function DetailTabsList({
  className,
  ...props
}: React.ComponentPropsWithoutRef<typeof TabsList>) {
  return (
    <div className="max-w-full overflow-x-auto">
      <TabsList className={cn("w-max justify-start", className)} {...props} />
    </div>
  );
}

export function DetailTabsTrigger({
  className,
  ...props
}: React.ComponentPropsWithoutRef<typeof TabsTrigger>) {
  return <TabsTrigger className={cn("max-sm:px-2", className)} {...props} />;
}
