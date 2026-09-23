// SPDX-License-Identifier: Apache-2.0

/**
 * The two pieces every panel rail is made of: its header, and a titled group
 * of rows.
 *
 * Written once because a second panel exists. The settings overlay and the
 * catalogue are the same surface with different contents, and a rail that is
 * "nearly the settings rail" reads as a bug — a heading one pixel taller, a
 * separator missing, and the two stop being the same object.
 */
import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@appstrate/ui/cn";

export function RailHeader({ icon: Icon, title }: { icon: LucideIcon; title: string }) {
  return (
    <div className="border-sidebar-border flex min-h-14 items-center gap-2 border-b pr-1.5 pl-4 text-sm font-semibold">
      <Icon className="text-muted-foreground size-4" />
      {title}
    </div>
  );
}

export function RailGroup({
  title,
  separated = false,
  children,
  ...rest
}: {
  title: string;
  /** A rule above: a second group is a change of scope, not a continuation. */
  separated?: boolean;
  children: ReactNode;
} & Record<`data-${string}`, string | undefined>) {
  return (
    <section className={cn("px-3 py-3", separated && "border-t-sidebar-border border-t")} {...rest}>
      <div
        data-settings-scope-title
        // The main navigation's group label (shadcn `SidebarGroupLabel`:
        // sentence case, `text-xs font-medium`, muted) rather than a spaced
        // uppercase of the rails' own: one way of titling a group of rows.
        className="text-sidebar-foreground/70 mb-0.5 flex h-8 items-center px-2 text-xs font-medium"
      >
        {title}
      </div>
      {children}
    </section>
  );
}
