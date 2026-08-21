// SPDX-License-Identifier: Apache-2.0

/**
 * The two pieces every product's shell is built from: the sidebar frame and the
 * header.
 *
 * Studio and the chat are different products with different navigations, and
 * they still have to read as one app — so what surrounds the navigation is
 * written ONCE, here, and each product passes only what is its own. When the
 * brand cell, the meta block or the header's right end changes, it changes in
 * both without anyone remembering to.
 */

import type { ReactNode } from "react";
import { NavUser } from "@/components/nav-user";
import { NotificationBell } from "@/components/notification-bell";
import { ProductSwitcher } from "@/components/product-switcher";
import { ShellBreadcrumb } from "@/components/shell-breadcrumb";
import { SidebarMeta } from "@/components/sidebar-meta";
import { cn } from "@appstrate/ui/cn";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarTrigger,
} from "@appstrate/ui/components/sidebar";

export function ShellSidebar({
  children,
  contentClassName,
}: {
  /** The product's navigation — the ONLY part that differs between products. */
  children: ReactNode;
  contentClassName?: string;
}) {
  return (
    <Sidebar collapsible="icon">
      <SidebarHeader className="border-sidebar-border h-header justify-center border-b">
        <ProductSwitcher />
      </SidebarHeader>
      <SidebarContent className={cn("gap-0", contentClassName)}>{children}</SidebarContent>
      {/* Foot of the sidebar: the meta rows, then the collapse control. No
          credits gauge — a permanent progress bar spends attention every second
          on a number that is consulted every few weeks. It belongs behind the
          Usage row, not in front of the navigation. The org/workspace switcher
          used to live here too and now opens the header trail. */}
      <SidebarFooter className="gap-0 p-0">
        <SidebarMeta />
        <div className="border-sidebar-border flex items-center justify-end border-t px-2 py-1.5">
          <SidebarTrigger />
        </div>
      </SidebarFooter>
    </Sidebar>
  );
}

export function ShellHeader({
  actions,
  fullBleed = false,
}: {
  /** Page-owned controls, left of the notification bell. */
  actions?: ReactNode;
  /**
   * Edge to edge instead of centred on the page width. For a surface that is
   * itself full-bleed: a header centred on 1300px over an edge-to-edge chat
   * would put the profile 300px short of the right edge it belongs to.
   */
  fullBleed?: boolean;
}) {
  return (
    <header className="bg-canvas h-header sticky top-0 z-20 flex shrink-0 items-center border-b">
      <div
        className={cn(
          "px-gutter flex w-full items-center gap-2",
          !fullBleed && "max-w-page mx-auto",
        )}
      >
        {/* Mobile-only trigger — desktop collapse lives in the sidebar */}
        <SidebarTrigger className="md:hidden" />
        <ShellBreadcrumb />
        <div className="flex shrink-0 items-center gap-1">
          {actions}
          <NotificationBell />
          <NavUser />
        </div>
      </div>
    </header>
  );
}
