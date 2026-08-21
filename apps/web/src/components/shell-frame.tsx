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
      {/* Head: the brand cell alone, at the header's height and closed by the
          header's own rule — the two lines meet across the shell instead of
          nearly meeting. Beside the product name, the two controls that act on
          the whole shell: search and collapse. */}
      <SidebarHeader className="border-sidebar-border h-header justify-center border-b px-2 py-0">
        <div className="flex items-center gap-1">
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
              <NotificationBell />
            </>
          )}
        </div>
      </SidebarHeader>
      {/* Below the rule, the context the navigation applies to. */}
      <div className="flex flex-col gap-1 px-2 pt-2 group-data-[collapsible=icon]:px-0">
        <OrgSwitcher variant="row" />
        {/* The bell rides in the brand cell, beside the search — except in the
            rail, where that cell holds the mark alone and it drops here, under
            the org avatar. It never disappears: the unread count is the one
            thing in this column that changes on its own. */}
        {collapsed && <NotificationBell />}
      </div>
      <SidebarContent className={cn("gap-0", contentClassName)}>{children}</SidebarContent>
      {/* Foot: who you are, and nothing else. Usage and Settings left it — both
          configure the org, and the org's own switcher already carries them
          (the gear on the row you are in, the settings link under the panel).
          A row that repeats what the control above it offers is a row that
          teaches the control is not enough. */}
      <SidebarFooter className="gap-0 p-0">
        {/* Who you are, and the collapse beside it — the control that changes
            the column's width sits at the end of the column, not in the head
            where it competed with the product name. */}
        <div className="border-sidebar-border flex items-center gap-1 border-t p-2 group-data-[collapsible=icon]:flex-col">
          <div className="min-w-0 flex-1 group-data-[collapsible=icon]:flex-none">
            <NavUser variant="row" />
          </div>
          <SidebarTrigger className="text-muted-foreground size-7 shrink-0">
            <PanelLeft className="size-4" />
          </SidebarTrigger>
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
        {actions ? <div className="flex shrink-0 items-center gap-1">{actions}</div> : null}
      </div>
    </header>
  );
}
