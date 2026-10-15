// SPDX-License-Identifier: Apache-2.0

import * as React from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@appstrate/ui/components/tabs";
import { ScrollArea, ScrollBar } from "@appstrate/ui/components/scroll-area";
import { cn } from "@appstrate/ui/cn";

export interface DetailTab<T extends string> {
  value: T;
  label: string;
}

/** The tabs root of a detail page; the header, the tab bar and the panels all live inside it. */
export function DetailTabs<T extends string>({
  value,
  onChange,
  children,
}: {
  value: T;
  onChange: (value: T) => void;
  children: React.ReactNode;
}) {
  return (
    <Tabs value={value} onValueChange={(next) => onChange(next as T)}>
      {children}
    </Tabs>
  );
}

/** The tab bar of `tabs`: tighter on a phone, and scrolling sideways when they still do not fit. */
export function DetailTabBar<T extends string>({ tabs }: { tabs: readonly DetailTab<T>[] }) {
  return (
    <ScrollArea type="auto" className="mt-6 mb-3 max-w-full">
      <TabsList className="w-max justify-start">
        {tabs.map((tab) => (
          <TabsTrigger key={tab.value} value={tab.value} className="max-sm:px-2">
            {tab.label}
          </TabsTrigger>
        ))}
      </TabsList>
      <ScrollBar orientation="horizontal" />
    </ScrollArea>
  );
}

/** One tab's card; `flush` for content that draws its own padding. */
export function DetailTabPanel({
  value,
  flush,
  children,
}: {
  value: string;
  flush?: boolean;
  children: React.ReactNode;
}) {
  return (
    <TabsContent
      value={value}
      className={cn("bg-card mt-0 overflow-hidden rounded-lg border shadow-sm", !flush && "p-6")}
    >
      {children}
    </TabsContent>
  );
}

export interface CollectionTabOption<T extends string> {
  value: T;
  label: string;
  /** How many the part holds, when the screen knows. */
  count?: number;
}

/**
 * Tabs that split ONE collection into parts (organization and space roles, remote and local
 * integrations), unlike the tabs of a detail page, which move between views of one object.
 * They sit at the head of a list's bar, on the line of its search and at its height.
 */
export function CollectionTabs<T extends string>({
  value,
  options,
  label,
  onChange,
}: {
  value: T;
  options: CollectionTabOption<T>[];
  /** Names the tab list for screen readers. */
  label: string;
  onChange: (value: T) => void;
}) {
  return (
    <Tabs value={value} onValueChange={(next) => onChange(next as T)}>
      <TabsList aria-label={label} className="h-8 shrink-0 p-0.5">
        {options.map((option) => (
          <TabsTrigger key={option.value} value={option.value} className="h-7 px-2.5 text-sm">
            {option.label}
            {option.count !== undefined && (
              <span className="text-muted-foreground ml-1.5 text-xs tabular-nums">
                {option.count}
              </span>
            )}
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  );
}
