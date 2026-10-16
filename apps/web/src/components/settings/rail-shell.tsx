// SPDX-License-Identifier: Apache-2.0

/** Header and titled group shared by the settings and catalogue rails: they must stay pixel-identical. */
import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@appstrate/ui/cn";
import { SidebarGroup, SidebarGroupLabel } from "@appstrate/ui/components/sidebar";

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
    <SidebarGroup
      className={cn("px-3 py-3", separated && "border-t-sidebar-border border-t")}
      {...rest}
    >
      <SidebarGroupLabel className="mb-0.5">{title}</SidebarGroupLabel>
      {children}
    </SidebarGroup>
  );
}
