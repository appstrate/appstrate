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
import { PanelLeft, Search } from "lucide-react";
import { NavUser } from "@/components/nav-user";
import { OrgSwitcher } from "@/components/org-switcher";
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
import { useSidebar } from "@appstrate/ui/components/sidebar-context";

export function ShellSidebar({
  children,
  contentClassName,
}: {
  /** The product's navigation — the ONLY part that differs between products. */
  children: ReactNode;
  contentClassName?: string;
}) {
  const { state } = useSidebar();
  const collapsed = state === "collapsed";

  return (
    <Sidebar collapsible="icon">
      {/* Head: the brand cell with the product name, and beside it the two
          controls that act on the whole shell (search, collapse) — the Mistral
          arrangement. Under it, at the width of the navigation, the context the
          navigation applies to. */}
      <SidebarHeader className="border-sidebar-border gap-1 border-b px-2 py-2">
        <div className="flex h-8 items-center gap-1">
          <ProductSwitcher />
          {!collapsed && (
            <>
              {/* Not wired to anything yet: there is no global search in the
                  app. Present so the arrangement can be judged; it is disabled
                  rather than inert so nobody wonders why nothing happens. */}
              <button
                type="button"
                disabled
                title="Recherche globale (à brancher)"
                aria-label="Rechercher"
                className="text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground shrink-0 rounded-md p-1.5 disabled:opacity-40"
              >
                <Search className="size-4" />
              </button>
              <SidebarTrigger className="text-muted-foreground size-7 shrink-0">
                <PanelLeft className="size-4" />
              </SidebarTrigger>
            </>
          )}
        </div>
        <OrgSwitcher variant="row" />
      </SidebarHeader>
      <SidebarContent className={cn("gap-0", contentClassName)}>{children}</SidebarContent>
      {/* Foot: what is ABOUT the workspace, then who you are. No credits gauge —
          a permanent progress bar spends attention every second on a number
          consulted every few weeks; it belongs behind the Usage row. */}
      <SidebarFooter className="gap-0 p-0">
        <SidebarMeta />
        <div className="border-sidebar-border border-t p-2">
          {collapsed ? <SidebarTrigger className="mb-1" /> : null}
          <NavUser variant="row" />
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
        </div>
      </div>
    </header>
  );
}
