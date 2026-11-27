// SPDX-License-Identifier: Apache-2.0

import * as React from "react";
import { Tabs as TabsPrimitive } from "@base-ui/react/tabs";

import { cn } from "../cn.ts";

type TabsListVariant = "default" | "line";

/** Base UI also takes a `(state) => string` class; these wrappers merge theirs, so a string only. */
type WithClassName<P> = Omit<P, "className"> & { className?: string };

function Tabs(props: React.ComponentProps<typeof TabsPrimitive.Root>) {
  return <TabsPrimitive.Root data-slot="tabs" {...props} />;
}

/**
 * The active tab is marked by ONE indicator that slides between tabs (Base UI measures the active
 * tab into `--active-tab-*`): a raised pill on the muted track (`default`), or a rule under the
 * tab (`line`). The list is its own stacking context, so the indicator paints over the track and
 * under the labels.
 *
 * Arrow keys select as they move, like a native tab list: a tab whose selection navigates relies
 * on it (`CollectionTabs`).
 */
function TabsList({
  className,
  variant = "default",
  activateOnFocus = true,
  children,
  ...props
}: WithClassName<React.ComponentProps<typeof TabsPrimitive.List>> & { variant?: TabsListVariant }) {
  return (
    <TabsPrimitive.List
      data-slot="tabs-list"
      data-variant={variant}
      activateOnFocus={activateOnFocus}
      className={cn(
        "group/tabs-list text-muted-foreground relative isolate inline-flex items-center justify-center",
        variant === "default" && "bg-muted h-10 rounded-md p-1",
        className,
      )}
      {...props}
    >
      {children}
      <TabsPrimitive.Indicator
        data-slot="tabs-indicator"
        className={cn(
          "absolute left-0 -z-10 w-(--active-tab-width) translate-x-(--active-tab-left) transition-[translate,width,height] duration-200 ease-out motion-reduce:transition-none",
          variant === "default" &&
            "bg-background top-0 h-(--active-tab-height) translate-y-(--active-tab-top) rounded-sm shadow-sm",
          variant === "line" && "bg-primary bottom-0 h-0.5",
        )}
      />
    </TabsPrimitive.List>
  );
}

function TabsTrigger({
  className,
  ...props
}: WithClassName<React.ComponentProps<typeof TabsPrimitive.Tab>>) {
  return (
    <TabsPrimitive.Tab
      data-slot="tabs-trigger"
      className={cn(
        "ring-offset-background focus-visible:ring-ring hover:text-foreground data-active:text-foreground inline-flex items-center justify-center rounded-sm px-3 py-1.5 text-sm font-medium whitespace-nowrap transition-colors group-data-[variant=line]/tabs-list:rounded-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none data-disabled:pointer-events-none data-disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
}

function TabsContent({
  className,
  ...props
}: WithClassName<React.ComponentProps<typeof TabsPrimitive.Panel>>) {
  return (
    <TabsPrimitive.Panel
      data-slot="tabs-content"
      className={cn(
        "ring-offset-background focus-visible:ring-ring mt-2 focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none",
        className,
      )}
      {...props}
    />
  );
}

export { Tabs, TabsList, TabsTrigger, TabsContent };
