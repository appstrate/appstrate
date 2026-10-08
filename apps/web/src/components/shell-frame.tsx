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
import { LibraryBig, Menu, PanelLeft, Search, Settings } from "lucide-react";
import { useTranslation } from "react-i18next";
import { NavUser } from "@/components/nav-user";
import { OrgSwitcher } from "@/components/org-switcher";
import { NotificationBell } from "@/components/notification-bell";
import { useUnreadCount } from "@/hooks/use-notifications";
import { ProductTabs } from "@/components/product-tabs";
import { ShellBreadcrumb } from "@/components/shell-breadcrumb";
import { openAsModal } from "@/lib/modal-route";
import { useCatalogueKinds } from "@/hooks/use-catalogue-kinds";
import { usePendingOfferCount, usePendingSharesHref } from "@/hooks/use-pending-offers";
import { catalogueHref } from "@/lib/catalogue-link";
import { useSettingsSections } from "@/pages/settings/use-settings-sections";
import { cn } from "@appstrate/ui/cn";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuBadge,
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
  // Two organisation-wide destinations, and each is drawn only when it holds
  // something: settings when its own rail lists an entry for this caller, the
  // catalogue when there is a kind of package they may activate.
  const settingsSections = useSettingsSections();
  const catalogueKinds = useCatalogueKinds();
  const pendingOffers = usePendingOfferCount();
  const pendingHref = usePendingSharesHref();
  // The page route tree deliberately renders the modal's background location.
  // The address bar is therefore the source of truth for this one global
  // destination while settings are open.
  const settingsActive =
    window.location.pathname.startsWith("/org-settings") ||
    window.location.pathname.startsWith("/workspace-settings") ||
    window.location.pathname.startsWith("/preferences");
  const catalogueActive = window.location.pathname.startsWith("/catalogue");

  return (
    <Sidebar>
      {/* Head: the brand cell, at the header's height and closed by the
          header's own rule — the two lines meet across the shell instead of
          nearly meeting. Beside it, the collapse: where the header's burger
          brings the sidebar back, so both gestures happen in one corner. It
          shows while the pointer is anywhere on the sidebar, or on focus
          (Notion's way; `group` is the sidebar's own root), so at rest the
          head is the workspace's name alone. */}
      <SidebarHeader className="border-sidebar-border h-header flex-row items-center gap-1 border-b px-2 py-0">
        <div className="min-w-0 flex-1">
          <OrgSwitcher variant="brand" />
        </div>
        <SidebarTrigger className="text-muted-foreground hidden size-7 shrink-0 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 md:inline-flex">
          <PanelLeft className="size-4" />
        </SidebarTrigger>
      </SidebarHeader>
      {/* Below the header's rule, the products. No second rule: the tabs are
          their own enclosure, and a line under them would cut the column into
          more pieces than it has ideas. More air above than below, so the tabs
          read as the head of the navigation rather than as a tail of the rule
          they sit under. */}
      <div className="px-2 pt-4 pb-1">
        <ProductTabs />
      </div>
      <SidebarContent className={cn("gap-0", contentClassName)}>{children}</SidebarContent>
      {/* Settings is a permanent global destination, not only an action hidden
          inside the context switcher. It sits above the user boundary and
          represents the settings overlay as the active destination. */}
      <SidebarFooter className="gap-0 p-0">
        <SidebarMenu className="px-2 pb-2" hidden={catalogueKinds.length === 0}>
          <SidebarMenuItem>
            <SidebarMenuButton asChild isActive={catalogueActive} tooltip={t("nav.catalogue")}>
              {catalogueActive ? (
                <button type="button">
                  <LibraryBig />
                  <span>{t("nav.catalogue")}</span>
                </button>
              ) : (
                <Link
                  // With shares waiting, the entry opens ON them: the count is a
                  // promise, and the first click keeps it (one rule, in
                  // `usePendingSharesHref`).
                  to={pendingHref ?? catalogueHref(catalogueKinds[0] ?? "agent")}
                  state={openAsModal(location)}
                >
                  <LibraryBig />
                  <span>{t("nav.catalogue")}</span>
                </Link>
              )}
            </SidebarMenuButton>
            {/* Packages offered to a space this caller reaches and switched on
                by nobody. The share route notifies a PERSON and says nothing
                when the target is a team space, so without this an offer to the
                team is visible only to whoever thinks to go and look. */}
            {pendingOffers > 0 && (
              <SidebarMenuBadge>
                <span
                  className="bg-primary text-primary-foreground flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[0.6rem] leading-none font-medium"
                  aria-label={t("catalogue.pendingOffers", { count: pendingOffers })}
                >
                  {pendingOffers > 99 ? "99+" : pendingOffers}
                </span>
              </SidebarMenuBadge>
            )}
          </SidebarMenuItem>
        </SidebarMenu>
        {/* Gated on what the surface actually holds: the rail decides. A caller
            whose settings rail lists nothing has no settings to open. */}
        <SidebarMenu className="px-2 pb-2" hidden={settingsSections.length === 0}>
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
        {/* Who you are, and nothing else: the collapse moved to the head. */}
        <div className="border-sidebar-border border-t p-2">
          <NavUser variant="row" />
        </div>
      </SidebarFooter>
    </Sidebar>
  );
}

export function ShellHeader({
  actions,
}: {
  /** Page-owned controls, left of the notification bell. */
  actions?: ReactNode;
}) {
  const { isMobile, openMobile, state, setPeeking } = useSidebar();
  const { data: unreadCount } = useUnreadCount();
  const collapsed = !isMobile && state === "collapsed";

  return (
    <header
      className={cn(
        "bg-canvas md:h-header sticky top-0 z-20 flex shrink-0 flex-col border-b md:flex-row md:items-center",
        isMobile && openMobile && "invisible",
      )}
    >
      {/* Edge to edge, never centred on the page width: the header belongs to
          the shell, not to the page column, so its two ends sit at the shell's
          two edges whatever the screen's width. Collapsed, the left inset is
          the sidebar's own (`px-2`), so the burger stands where the brand cell
          stood and its icon over the navigation's icons. */}
      <div
        className={cn(
          "px-gutter h-header flex w-full shrink-0 items-center gap-2 border-b border-b-black/5 md:border-b-0",
          collapsed && "md:pl-2",
        )}
      >
        {/* Mobile-only trigger: on desktop the collapse lives in the sidebar */}
        <SidebarTrigger className="-ml-5 size-11 shrink-0 rounded-l-none md:hidden">
          <Menu className="size-4" />
        </SidebarTrigger>
        {/* Desktop, collapsed: nothing of the sidebar is left on screen, so its
            way back is here. Hovering slides it over the page (as the screen's
            left edge does), a click pins it open again. It carries the unread
            dot the hidden Runs entry cannot show. */}
        {collapsed && (
          <SidebarTrigger
            data-sidebar="peek-trigger"
            className="relative hidden size-8 shrink-0 md:inline-flex"
            onPointerEnter={() => setPeeking(true)}
          >
            <Menu className="size-4" />
            {(unreadCount ?? 0) > 0 && (
              <span className="ring-canvas bg-destructive pointer-events-none absolute top-1 right-1 size-2 rounded-full ring-2" />
            )}
          </SidebarTrigger>
        )}
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
