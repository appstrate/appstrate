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

/** Stock shadcn tabs, tighter on a phone; when they still do not fit they scroll, with a fade on the hidden edge. */
function DetailTabsList(props: Omit<React.ComponentPropsWithoutRef<typeof TabsList>, "className">) {
  const { ref, edge } = useScrollEdges();
  return (
    <div ref={ref} className={cn("max-w-full overflow-x-auto", FADE_EDGE[edge])}>
      <TabsList className="mt-6 mb-3 w-max justify-start" {...props} />
    </div>
  );
}

function DetailTabsTrigger({
  className,
  ...props
}: React.ComponentPropsWithoutRef<typeof TabsTrigger>) {
  return <TabsTrigger className={cn("max-sm:px-2", className)} {...props} />;
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

/** The tab bar of `tabs`. */
export function DetailTabBar<T extends string>({ tabs }: { tabs: readonly DetailTab<T>[] }) {
  return (
    <DetailTabsList>
      {tabs.map((tab) => (
        <DetailTabsTrigger key={tab.value} value={tab.value}>
          {tab.label}
        </DetailTabsTrigger>
      ))}
    </DetailTabsList>
  );
}

/**
 * The tab bar of a page whose title block is in the shell header (`DetailBar`):
 * underlined tabs on the band's own rule, `end` at the far right (a search, a
 * filter). Must render inside the page's `DetailTabs`: it is portalled to the
 * header, and the portal keeps the tabs' context.
 */
export function HeaderTabBar<T extends string>({
  tabs,
  end,
}: {
  tabs: readonly DetailTab<T>[];
  end?: React.ReactNode;
}) {
  const { ref, edge } = useScrollEdges();
  return (
    <ShellHeaderTabs>
      <div className="flex items-center justify-between gap-4">
        <div
          ref={ref}
          className={cn(
            "-mb-px min-w-0 [scrollbar-width:none] overflow-x-auto [&::-webkit-scrollbar]:hidden",
            FADE_EDGE[edge],
          )}
        >
          <TabsList className="h-11 w-max justify-start gap-1 rounded-none bg-transparent p-0">
            {tabs.map(({ value, label, icon: Icon }) => (
              <TabsTrigger
                key={value}
                value={value}
                className="text-muted-foreground hover:text-foreground data-[state=active]:border-primary data-[state=active]:text-foreground h-full gap-2 rounded-none border-b-2 border-transparent px-2.5 py-0 data-[state=active]:bg-transparent data-[state=active]:shadow-none max-sm:px-2"
              >
                {Icon && <Icon className="size-4 shrink-0" aria-hidden />}
                {label}
              </TabsTrigger>
            ))}
          </TabsList>
        </div>
        {end && <div className="flex shrink-0 items-center gap-2">{end}</div>}
      </div>
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
