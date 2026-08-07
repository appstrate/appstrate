// SPDX-License-Identifier: Apache-2.0

import * as React from "react";
import * as TabsPrimitive from "@radix-ui/react-tabs";
import { MoreHorizontal } from "lucide-react";
import { cn } from "../cn.ts";
import { partitionTabs } from "../lib/tab-overflow.ts";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "./dropdown-menu";

/** Pill chrome. Carried by the list itself when not collapsing, by the wrapper when it is. */
const PILL_CLASS =
  "bg-muted text-muted-foreground inline-flex h-9 items-center justify-center rounded-lg p-1";

/** Horizontal padding of the pill (`p-1` on both sides), excluded from the strip's budget. */
const PILL_PADDING_X = 8;

// `shrink-0`: a trigger keeps its natural width inside the strip. Without it a
// visible set that is momentarily too wide (a resize the observer has not
// reported yet) squeezes the boxes and overlaps their labels.
const TRIGGER_CLASS =
  "ring-offset-background focus-visible:ring-ring data-[state=active]:bg-background data-[state=active]:text-foreground inline-flex shrink-0 items-center justify-center rounded-md px-3 py-1 text-sm font-medium whitespace-nowrap transition-all focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50 data-[state=active]:shadow";

/** Same box as a trigger (h-7 == py-1 + text-sm line box), so the pill height never changes. */
const OVERFLOW_TRIGGER_CLASS =
  "ring-offset-background focus-visible:ring-ring hover:text-foreground text-muted-foreground inline-flex h-7 shrink-0 items-center justify-center rounded-md px-2 transition-all focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none";

/**
 * The selected value, mirrored out of Radix.
 *
 * Radix does not expose its Tabs context, and the overflow menu has to be able
 * to read the active value (it must never be collapsed) and to change it (the
 * menu selects a tab that is not in the DOM). Mirroring here means the two
 * behaviours work for controlled *and* uncontrolled call sites without every
 * page having to pass the value down twice.
 */
const TabsValueContext = React.createContext<{
  value: string | undefined;
  setValue: (value: string) => void;
} | null>(null);

const Tabs = React.forwardRef<
  React.ComponentRef<typeof TabsPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Root>
>(({ value, defaultValue, onValueChange, ...props }, ref) => {
  const [uncontrolled, setUncontrolled] = React.useState(defaultValue);
  const current = value ?? uncontrolled;

  const setValue = React.useCallback(
    (next: string) => {
      // Only track internally when the call site is uncontrolled — otherwise the
      // parent's state is the single source of truth and mirroring it would just
      // cost a render.
      if (value === undefined) setUncontrolled(next);
      onValueChange?.(next);
    },
    [value, onValueChange],
  );

  const context = React.useMemo(() => ({ value: current, setValue }), [current, setValue]);

  return (
    <TabsValueContext.Provider value={context}>
      {/* Always controlled from here: an uncontrolled call site still needs the
          overflow menu to be able to switch tabs, which Radix's internal state
          does not allow from the outside. */}
      <TabsPrimitive.Root ref={ref} value={current ?? ""} onValueChange={setValue} {...props} />
    </TabsValueContext.Provider>
  );
});
Tabs.displayName = TabsPrimitive.Root.displayName;

interface TabsListProps extends React.ComponentPropsWithoutRef<typeof TabsPrimitive.List> {
  /**
   * Collapse the triggers that do not fit into a trailing overflow menu so the
   * bar always occupies exactly one row. Opt in only for a parent-sized tab bar
   * whose children are plain `TabsTrigger` elements.
   *
   * Two hard preconditions:
   *
   * 1. **The bar's container must be sized by its parent, not by its content.**
   *    A block-level parent (the usual case — a `Tabs` root in normal flow) is
   *    fine. A *content-sized* parent is not: as a flex item with the default
   *    `flex-basis: auto`, the wrapper's width is the pill's max-content width,
   *    which is the output of this very partition. Collapsing then shrinks the
   *    measured width, which collapses further — the loop terminates at one
   *    visible tab no matter how much room there was, and logs
   *    `ResizeObserver loop completed with undelivered notifications` along the
   *    way. Same for a grid track sized `auto`/`min-content`, or any ancestor
   *    that shrink-wraps before the bar. Use a scroll affordance there instead.
   * 2. **The children must be plain `TabsTrigger` elements.** Measurement reads
   *    each child's own `children`/`className` into a ghost copy, so a trigger
   *    wrapped in another component (a tooltip, say) measures the wrapper.
   *
   * Fixed-width strips (a `grid-cols-*` segmented control) fail (1) implicitly:
   * their rendered widths have nothing to do with their natural ones.
   */
  collapse?: boolean;
  /** Accessible name for the "…" overflow trigger. `@appstrate/ui` has no i18n. */
  overflowLabel?: string;
}

const TabsList = React.forwardRef<React.ComponentRef<typeof TabsPrimitive.List>, TabsListProps>(
  ({ className, collapse = false, overflowLabel, ...props }, ref) => {
    if (!collapse) {
      return <TabsPrimitive.List ref={ref} className={cn(PILL_CLASS, className)} {...props} />;
    }
    return (
      <CollapsingTabsList
        listRef={ref}
        className={className}
        overflowLabel={overflowLabel}
        {...props}
      />
    );
  },
);
TabsList.displayName = TabsPrimitive.List.displayName;

interface Metrics {
  containerWidth: number;
  itemWidths: number[];
  overflowWidth: number;
}

const EMPTY_METRICS: Metrics = { containerWidth: 0, itemWidths: [], overflowWidth: 0 };

function sameMetrics(a: Metrics, b: Metrics): boolean {
  return (
    a.containerWidth === b.containerWidth &&
    a.overflowWidth === b.overflowWidth &&
    a.itemWidths.length === b.itemWidths.length &&
    a.itemWidths.every((width, index) => width === b.itemWidths[index])
  );
}

type TriggerElement = React.ReactElement<{
  value?: string;
  className?: string;
  children?: React.ReactNode;
}>;

function CollapsingTabsList({
  listRef,
  className,
  children,
  overflowLabel = "More tabs",
  ...props
}: Omit<TabsListProps, "collapse"> & {
  listRef: React.Ref<React.ComponentRef<typeof TabsPrimitive.List>>;
}) {
  const containerRef = React.useRef<HTMLDivElement>(null);
  const ghostRef = React.useRef<HTMLDivElement>(null);
  const [metrics, setMetrics] = React.useState<Metrics>(EMPTY_METRICS);
  const tabsValue = React.useContext(TabsValueContext);

  const items = React.useMemo(
    () => React.Children.toArray(children).filter(React.isValidElement) as TriggerElement[],
    [children],
  );

  const itemCount = items.length;

  // Measure the ghost copy, never the live list: the live list is the one that
  // was already truncated, so reading it would feed the partition its own output
  // and oscillate. Triggers are `whitespace-nowrap`, so ghost widths are stable.
  //
  // Subpixel widths (`getBoundingClientRect`, not `offsetWidth`): where the bar
  // sits in a shrink-to-fit parent the container width IS the sum of the item
  // widths, and rounding each item independently would make that sum exceed the
  // container and collapse a bar that fits.
  React.useEffect(() => {
    const container = containerRef.current;
    const ghost = ghostRef.current;
    if (!container || !ghost || typeof ResizeObserver === "undefined") return;

    const observer = new ResizeObserver(() => {
      const ghostItems = Array.from(ghost.children) as HTMLElement[];
      // The ghost row is the items plus the overflow trigger. Anything else means
      // this callback is racing a child-count change — skip it, the effect will
      // re-subscribe against the new row.
      if (ghostItems.length !== itemCount + 1) return;
      const overflowGhost = ghostItems[ghostItems.length - 1];
      const next: Metrics = {
        containerWidth: Math.max(0, container.getBoundingClientRect().width - PILL_PADDING_X),
        itemWidths: ghostItems.slice(0, -1).map((element) => element.getBoundingClientRect().width),
        overflowWidth: overflowGhost ? overflowGhost.getBoundingClientRect().width : 0,
      };
      setMetrics((previous) => (sameMetrics(previous, next) ? previous : next));
    });

    observer.observe(container);
    // Observe each item too: a label can change width (i18n bundle load, a count
    // badge) without changing the ghost row's own size.
    for (const element of Array.from(ghost.children)) observer.observe(element);
    return () => observer.disconnect();
  }, [itemCount]);

  const activeValue = tabsValue?.value;
  const activeIndex =
    activeValue === undefined ? -1 : items.findIndex((item) => item.props.value === activeValue);

  const layout = React.useMemo(() => {
    // Measurements can lag a child-count change by one render; until they line
    // up, render the full bar rather than partition against stale widths.
    if (metrics.itemWidths.length !== items.length) {
      return { visible: items.map((_, index) => index), hidden: [] as number[] };
    }
    return partitionTabs({
      itemWidths: metrics.itemWidths,
      containerWidth: metrics.containerWidth,
      overflowWidth: metrics.overflowWidth,
      activeIndex,
    });
  }, [metrics, items, activeIndex]);

  return (
    <div ref={containerRef} className={cn("relative min-w-0", className)}>
      {/* Ghost strip: out of flow, clipped, invisible, inert. Only used for
          measurement.

          The zero-sized `overflow-hidden` host is load-bearing, not decoration.
          `visibility: hidden` removes the row from *painting* only — the boxes
          keep their full `w-max` width in layout and still count toward the
          containing block's scrollable overflow area. Left unclipped, the
          container reports a `scrollWidth` of the whole uncollapsed strip and
          the ghost's boxes lie across the content area past the viewport edge;
          any `overflow-y: auto` ancestor between the bar and the viewport
          computes `overflow-x` to `auto` and turns that into a real horizontal
          scrollbar over the entire page content.

          Clipping is a paint-time operation, so `getBoundingClientRect()` on
          the clipped descendants still returns their true laid-out widths and
          the measurement below is unaffected — while the host contributes zero
          overflow of its own. `invisible` stays on the row on top of the clip:
          it also keeps the ghost out of forced-colors and print rendering, and
          out of any future `overflow: visible` regression on the host. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute top-0 left-0 h-0 w-0 overflow-hidden"
      >
        <div ref={ghostRef} className="invisible flex w-max flex-nowrap">
          {items.map((item, index) => (
            <span key={item.key ?? index} className={cn(TRIGGER_CLASS, item.props.className)}>
              {item.props.children}
            </span>
          ))}
          <span className={OVERFLOW_TRIGGER_CLASS}>
            <MoreHorizontal className="size-4" aria-hidden="true" />
          </span>
        </div>
      </div>

      {/* The pill wraps the list and the overflow trigger side by side: a
          `role="tablist"` may only contain tabs, and the "…" button is a menu
          button, so it must stay outside the Radix list. */}
      <div className={cn(PILL_CLASS, "max-w-full")}>
        <TabsPrimitive.List ref={listRef} className="flex min-w-0 items-center" {...props}>
          {layout.visible.map((index) => items[index])}
        </TabsPrimitive.List>

        {layout.hidden.length > 0 && (
          <DropdownMenu>
            <DropdownMenuTrigger
              className={OVERFLOW_TRIGGER_CLASS}
              aria-label={overflowLabel}
              title={overflowLabel}
            >
              <MoreHorizontal className="size-4" aria-hidden="true" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {/* A radio group so the current tab reads as selected. In practice
                  the active tab is never hidden, so nothing is checked — the
                  semantics only surface if the value matches no rendered tab. */}
              <DropdownMenuRadioGroup
                value={tabsValue?.value ?? ""}
                onValueChange={(value) => tabsValue?.setValue(value)}
              >
                {layout.hidden.map((index) => {
                  const item = items[index];
                  const value = item?.props.value;
                  if (!item || value === undefined) return null;
                  return (
                    <DropdownMenuRadioItem key={value} value={value}>
                      {item.props.children}
                    </DropdownMenuRadioItem>
                  );
                })}
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
    </div>
  );
}

const TabsTrigger = React.forwardRef<
  React.ComponentRef<typeof TabsPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.Trigger ref={ref} className={cn(TRIGGER_CLASS, className)} {...props} />
));
TabsTrigger.displayName = TabsPrimitive.Trigger.displayName;

const TabsContent = React.forwardRef<
  React.ComponentRef<typeof TabsPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Content>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.Content
    ref={ref}
    className={cn(
      "ring-offset-background focus-visible:ring-ring mt-2 focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none",
      className,
    )}
    {...props}
  />
));
TabsContent.displayName = TabsPrimitive.Content.displayName;

export { Tabs, TabsList, TabsTrigger, TabsContent };
export type { TabsListProps };
