// SPDX-License-Identifier: Apache-2.0

import * as React from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@appstrate/ui/components/tabs";
import { cn } from "@appstrate/ui/cn";

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
export function DetailTabsList(
  props: Omit<React.ComponentPropsWithoutRef<typeof TabsList>, "className">,
) {
  const { ref, edge } = useScrollEdges();
  return (
    <div ref={ref} className={cn("max-w-full overflow-x-auto", FADE_EDGE[edge])}>
      <TabsList className="mt-6 mb-3 w-max justify-start" {...props} />
    </div>
  );
}

export function DetailTabsTrigger({
  className,
  ...props
}: React.ComponentPropsWithoutRef<typeof TabsTrigger>) {
  return <TabsTrigger className={cn("max-sm:px-2", className)} {...props} />;
}

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
