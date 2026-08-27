// SPDX-License-Identifier: Apache-2.0

import * as React from "react";
import { TabsList, TabsTrigger } from "@appstrate/ui/components/tabs";
import { cn } from "@appstrate/ui/cn";

/**
 * Secondary navigation inside one Agent detail surface.
 *
 * It deliberately keeps the Radix keyboard and focus model from the shared
 * shadcn primitive while using a flat, underlined grammar that cannot be
 * confused with the filled primary Agent tabs.
 */
export function AgentLocalTabsList({
  className,
  ...props
}: React.ComponentPropsWithoutRef<typeof TabsList>) {
  return (
    <div className="max-w-full overflow-x-auto">
      <TabsList
        className={cn(
          "border-border h-11 w-max min-w-full justify-start gap-5 rounded-none border-b bg-transparent p-0 px-4",
          className,
        )}
        {...props}
      />
    </div>
  );
}

export function AgentLocalTabsTrigger({
  className,
  ...props
}: React.ComponentPropsWithoutRef<typeof TabsTrigger>) {
  return (
    <TabsTrigger
      className={cn(
        "text-muted-foreground data-[state=active]:text-foreground data-[state=active]:border-primary h-11 rounded-none border-x-0 border-t-0 border-b-2 border-transparent bg-transparent px-0 py-0 shadow-none data-[state=active]:bg-transparent data-[state=active]:shadow-none",
        className,
      )}
      {...props}
    />
  );
}

/** Visual boundary between operational and construction destinations. */
export function AgentLocalTabsSeparator() {
  return (
    <span
      aria-hidden="true"
      className="bg-border mx-0.5 h-4 w-px shrink-0 self-center"
    />
  );
}
