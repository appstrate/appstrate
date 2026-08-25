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
import { Link, useLocation } from "react-router-dom";
import { Menu, PanelLeft, Search, Settings } from "lucide-react";
import { useTranslation } from "react-i18next";
import { NavUser } from "@/components/nav-user";
import { OrgSwitcher } from "@/components/org-switcher";
import { NotificationBell } from "@/components/notification-bell";
import { ProductTabs } from "@/components/product-tabs";
import { ShellBreadcrumb } from "@/components/shell-breadcrumb";
import { openAsModal } from "@/lib/modal-route";
import { cn } from "@appstrate/ui/cn";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
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
  const { t } = useTranslation();
  const location = useLocation();
  // The page route tree deliberately renders the modal's background location.
  // The address bar is therefore the source of truth for this one global
  // destination while settings are open.
  const settingsActive =
    window.location.pathname.startsWith("/org-settings") ||
    window.location.pathname.startsWith("/workspace-settings") ||
    window.location.pathname.startsWith("/preferences");

  return (
    <Sidebar collapsible="icon">
      {/* Head: the brand cell alone, at the header's height and closed by the
          header's own rule — the two lines meet across the shell instead of
          nearly meeting. Beside the product name, the two controls that act on
          the whole shell: search and collapse. */}
      <SidebarHeader className="border-sidebar-border h-header justify-center border-b px-2 py-0">
        <OrgSwitcher variant="brand" />
      </SidebarHeader>
      {/* Below the header's rule, the products. No second rule: the tabs are
          their own enclosure, and a line under them would cut the column into
          more pieces than it has ideas. More air above than below, so the tabs
          read as the head of the navigation rather than as a tail of the rule
          they sit under. */}
      <div className="px-2 pt-4 pb-1 group-data-[collapsible=icon]:px-0">
        <ProductTabs />
      </div>
      <SidebarContent className={cn("gap-0", contentClassName)}>{children}</SidebarContent>
      {/* Settings is a permanent global destination, not only an action hidden
          inside the context switcher. It sits above the user boundary and
          represents the settings overlay as the active destination. */}
      <SidebarFooter className="gap-0 p-0">
        <SidebarMenu className="px-2 pb-2">
          <SidebarMenuItem>
            <SidebarMenuButton asChild isActive={settingsActive} tooltip={t("nav.settings")}>
              {settingsActive ? (
                <button type="button">
                  <Settings />
                  <span>{t("nav.settings")}</span>
                </button>
              ) : (
                <Link to="/org-settings" state={openAsModal(location)}>
                  <Settings />
                  <span>{t("nav.settings")}</span>
                </Link>
              )}
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
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
  const { isMobile, openMobile } = useSidebar();

  return (
    <header
      className={cn(
        "bg-canvas md:h-header sticky top-0 z-20 flex shrink-0 flex-col border-b md:flex-row md:items-center",
        isMobile && openMobile && "invisible",
      )}
    >
      <div
        className={cn(
          "px-gutter h-header flex w-full shrink-0 items-center gap-2 border-b border-b-black/5 md:border-b-0",
          !fullBleed && "max-w-page mx-auto",
        )}
      >
        {/* Mobile-only trigger — desktop collapse lives in the sidebar */}
        <SidebarTrigger className="-ml-5 size-11 shrink-0 rounded-l-none md:hidden">
          <Menu className="size-4" />
        </SidebarTrigger>
        <div className="flex min-w-0 flex-1 md:hidden">
          <OrgSwitcher variant="mobile" />
        </div>
        <div className="hidden min-w-0 flex-1 md:flex">
          <ShellBreadcrumb />
        </div>
        {/* The page's own actions, then the two utilities that are global but
            not personal: search and notifications. They sit here rather than in
            the sidebar because the sidebar answers "where am I" and these two
            answer "what is new" and "find me something" — and because a header
            holding only a trail is a header holding nothing. */}
        <div className="flex shrink-0 items-center gap-1">
          {actions}
          {/* Not wired to anything yet: there is no global search in the app.
              Present so the arrangement can be judged; disabled rather than
              inert so nobody wonders why nothing happens. */}
          <button
            type="button"
            disabled
            title="Recherche globale (à brancher)"
            aria-label="Rechercher"
            // `p-0` is not decoration: the base layer gives every `button`
            // `px-3 py-1.5`, which leaves an 18px icon 8px of room in a 32px
            // box and squashes it. Same reset the notification bell carries.
            className="text-muted-foreground hover:bg-accent hover:text-foreground inline-flex size-8 shrink-0 items-center justify-center rounded-md p-0 disabled:opacity-40"
          >
            <Search size={18} />
          </button>
          <NotificationBell />
        </div>
      </div>
      <div className="px-gutter flex h-10 w-full shrink-0 items-center md:hidden">
        <ShellBreadcrumb />
      </div>
    </header>
  );
}
