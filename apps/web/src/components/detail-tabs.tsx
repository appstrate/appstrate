// SPDX-License-Identifier: Apache-2.0

import * as React from "react";
import type { LucideIcon } from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@appstrate/ui/components/tabs";
import { cn } from "@appstrate/ui/cn";
import { ShellHeaderTabs } from "@/components/shell-header-slots";

/** The fade is drawn on the edge that hides tabs, nothing when they all fit. */
const FADE_EDGE = {
  none: "",
  start: "[mask-image:linear-gradient(to_right,transparent,#000_2rem)]",
  end: "[mask-image:linear-gradient(to_right,#000_calc(100%-2rem),transparent)]",
  both: "[mask-image:linear-gradient(to_right,transparent,#000_2rem,#000_calc(100%-2rem),transparent)]",
} as const;

function useScrollEdges() {
  const ref = React.useRef<HTMLDivElement>(null);
  const [edge, setEdge] = React.useState<keyof typeof FADE_EDGE>("none");

  React.useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const hiddenStart = el.scrollLeft > 1;
      const hiddenEnd = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
      setEdge(
        hiddenStart && hiddenEnd ? "both" : hiddenStart ? "start" : hiddenEnd ? "end" : "none",
      );
    };
    measure();
    el.addEventListener("scroll", measure, { passive: true });
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    if (el.firstElementChild) observer.observe(el.firstElementChild);
    return () => {
      el.removeEventListener("scroll", measure);
      observer.disconnect();
    };
  }, []);

  return { ref, edge };
}

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
  const { ref, edge } = useScrollEdges();
  return (
    <div className="flex items-center justify-between gap-4">
      <div
        ref={ref}
        className={cn(
          "min-w-0 [scrollbar-width:none] overflow-x-auto [&::-webkit-scrollbar]:hidden",
          FADE_EDGE[edge],
        )}
      >
        <TabsList className="h-11 w-max justify-start gap-1 rounded-none bg-transparent p-0 md:gap-2">
          {tabs.map(({ value, label, icon: Icon }) => (
            <TabsTrigger
              key={value}
              value={value}
              className="text-muted-foreground hover:text-foreground data-[state=active]:border-primary data-[state=active]:text-foreground h-full gap-2 rounded-none border-b-2 border-transparent px-2.5 py-0 data-[state=active]:bg-transparent data-[state=active]:shadow-none max-sm:px-2 md:px-3"
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
