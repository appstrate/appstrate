// SPDX-License-Identifier: Apache-2.0

/**
 * The one line the thread draws for what the assistant does besides writing: the loading line, an
 * activity group's header, and each step under it (a reasoning, a tool call). No box: a 16px lead
 * slot on the text column's edge, a label, what follows it, a chevron when it opens something.
 * Every line has the same height, so one replacing another moves nothing.
 */

import * as React from "react";
import { ChevronRightIcon, XIcon } from "lucide-react";
import { cn } from "@appstrate/ui/cn";

/**
 * The room around a line that stands in the message's flow (the loading line, a group).
 * `isolate`: what the host draws on a step (a space's tile) layers inside the block, not over
 * the sticky composer the block scrolls behind.
 */
export const ACTIVITY_BLOCK_CLASS = "isolate my-1";

/** A thumb's height on touch, a compact row under a mouse. */
const LINE_CLASS =
  "text-muted-foreground desktop-pointer:h-8 flex h-10 min-w-0 items-center gap-2 text-sm";

/** A fixed slot: the spark, a glyph or an icon swap in it without moving the label. */
export function ActivityLead({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <span
      className={cn("flex size-4 shrink-0 items-center justify-center [&_svg]:size-4", className)}
    >
      {children}
    </span>
  );
}

export function ActivityLine({
  lead,
  className,
  children,
  ...rest
}: React.HTMLAttributes<HTMLDivElement> & { lead: React.ReactNode }) {
  return (
    <div {...rest} className={cn(LINE_CLASS, className)}>
      <ActivityLead>{lead}</ActivityLead>
      {children}
    </div>
  );
}

/** The line's disclosure: text that darkens under the pointer, no surface of its own. */
export const ActivityTrigger = React.forwardRef<
  HTMLButtonElement,
  React.ButtonHTMLAttributes<HTMLButtonElement>
>(function ActivityTrigger({ className, type = "button", ...props }, ref) {
  return (
    <button
      ref={ref}
      type={type}
      className={cn(
        "group hover:text-foreground ring-offset-background focus-visible:ring-ring duration-fast ease-surface flex h-full min-w-0 items-center gap-1.5 rounded-sm text-left font-normal transition-colors focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none",
        className,
      )}
      {...props}
    />
  );
});

/** Turns with its trigger's `data-state`. */
export function ActivityChevron() {
  return (
    <ChevronRightIcon
      aria-hidden
      className="duration-fast ease-surface size-3.5 shrink-0 transition-transform group-data-[state=open]:rotate-90"
    />
  );
}

/**
 * The small red cross of a failed call, the only red its row keeps. Given a `label` it is an image
 * named by it; without one it is decorative, beside a text that already says the failure.
 */
export function FailedGlyph({ label }: { label?: string }) {
  return (
    <span
      {...(label ? { role: "img", "aria-label": label } : { "aria-hidden": true })}
      className="text-destructive shrink-0"
    >
      <XIcon className="size-3.5" />
    </span>
  );
}

/** A label, shimmering while what it names is in progress (`.shimmer-text`, still under reduced motion). */
export function ActivityLabel({
  active = false,
  className,
  children,
}: {
  active?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <span className={cn("min-w-0 truncate", active && "shimmer-text", className)}>{children}</span>
  );
}

/**
 * What a line names precisely (an operation, a path, an id), in monospace after its label. In a
 * narrow line it gives way first (`shrink-100`): it truncates before its label does.
 */
export function ActivityId({ children }: { children: React.ReactNode }) {
  return <code className="min-w-0 shrink-100 truncate text-xs">{children}</code>;
}

/** The steps under a header: a rule under its lead slot, their own slots under its label. */
export function ActivityRail({ children }: { children: React.ReactNode }) {
  return <div className="border-border ml-2 border-l pl-[15px]">{children}</div>;
}

/** What opens under a step, aligned on its label. */
export const ACTIVITY_DETAIL_CLASS = "pb-2 pl-6";

/** A line's disclosure, opening and closing. */
export const ACTIVITY_CONTENT_CLASS =
  "duration-base ease-surface motion-safe:data-[state=open]:animate-collapsible-down motion-safe:data-[state=closed]:animate-collapsible-up overflow-hidden";
