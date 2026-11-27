// SPDX-License-Identifier: Apache-2.0

import * as React from "react";
import { Link, useNavigate, type To } from "react-router-dom";
import type { LucideIcon } from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@appstrate/ui/components/tabs";
import { cn } from "@appstrate/ui/cn";
import { ShellHeaderTabs } from "@/components/shell-header-slots";
import { INTEGRATED_TABLE_SURFACE } from "@/lib/table-surface";

export interface DetailTab<T extends string> {
  value: T;
  label: string;
  /** Drawn by the header's tab bar only (`HeaderTabBar`). */
  icon?: LucideIcon;
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

/**
 * Underlined tabs, `end` at the far right (a search, a filter): the tab list of
 * `HeaderTabBar`, and of a page with no shell header of its own (an overlay's)
 * once it draws the band's rule under it. Needs a `<DetailTabs>` above.
 */
export function UnderlineTabList<T extends string>({
  tabs,
  end,
}: {
  tabs: readonly DetailTab<T>[];
  end?: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-4">
      {/* The dashboard's recent agents row fades the same way: shadcn's
          scroll-driven `scroll-fade-x`, on the edge that hides tabs only. */}
      <div className="no-scrollbar scroll-fade-x min-w-0 overflow-x-auto">
        <TabsList variant="line" className="h-11 w-max justify-start gap-1 md:gap-2">
          {tabs.map(({ value, label, icon: Icon }) => (
            <TabsTrigger
              key={value}
              value={value}
              className="hover:text-foreground h-full gap-2 rounded-none border-b-2 border-transparent px-2.5 py-0 max-sm:px-2 md:px-3"
            >
              {Icon && <Icon className="size-4 shrink-0" aria-hidden />}
              {label}
            </TabsTrigger>
          ))}
        </TabsList>
      </div>
      {end && <div className="flex shrink-0 items-center gap-2">{end}</div>}
    </div>
  );
}

/**
 * The tab bar of a page whose title block is in the shell header (`DetailBar`):
 * `UnderlineTabList`, portalled to the header, where the band's own rule runs
 * under it. Must render inside the page's `DetailTabs`: the portal keeps the
 * tabs' context.
 */
export function HeaderTabBar<T extends string>({
  tabs,
  end,
}: {
  tabs: readonly DetailTab<T>[];
  end?: React.ReactNode;
}) {
  return (
    <ShellHeaderTabs>
      <UnderlineTabList tabs={tabs} end={end} />
    </ShellHeaderTabs>
  );
}

/**
 * One tab's content, laid on the page: its blocks (tables, sections, notices) draw
 * their own surfaces, so a wrapping card would only nest them. `framed` is for a
 * two-pane surface (a settings rail beside its section) whose frame is the surface.
 */
export function DetailTabPanel({
  value,
  framed,
  children,
}: {
  value: string;
  framed?: boolean;
  children: React.ReactNode;
}) {
  return (
    <TabsContent
      value={value}
      className={cn("mt-0", framed && "bg-card overflow-hidden rounded-lg border")}
      {...(framed ? INTEGRATED_TABLE_SURFACE : {})}
    >
      {children}
    </TabsContent>
  );
}

export interface CollectionTabOption<T extends string> {
  value: T;
  label: string;
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
  hrefOf,
}: {
  value: T;
  options: CollectionTabOption<T>[];
  /** Names the tab list for screen readers. */
  label: string;
  /** Absent when `hrefOf` is given: the parts are then addresses. */
  onChange?: (value: T) => void;
  /** Draws each part as a link to its own address, for a split the router owns beyond one param. */
  hrefOf?: (value: T) => To;
}) {
  const navigate = useNavigate();
  return (
    <Tabs
      value={value}
      // A link tab is activated by arrow keys as well: follow it like a click.
      onValueChange={(next) => (hrefOf ? void navigate(hrefOf(next as T)) : onChange?.(next as T))}
    >
      <TabsList aria-label={label} className="h-8 shrink-0 p-0.5">
        {options.map((option) => (
          <TabsTrigger
            key={option.value}
            value={option.value}
            {...(hrefOf && {
              render: <Link to={hrefOf(option.value)} />,
              nativeButton: false,
            })}
            className="h-7 px-2.5 text-sm"
          >
            {option.label}
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  );
}
