// SPDX-License-Identifier: Apache-2.0

/**
 * The sidebar frame and header every product's shell is built from: what surrounds the
 * navigation is written ONCE here, and each product passes only its own navigation.
 */

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Link } from "react-router-dom";
import { LibraryBig, Menu, PanelLeft, Settings } from "lucide-react";
import { useTranslation } from "react-i18next";
import { NavUser } from "@/components/nav-user";
import { OrgSwitcher } from "@/components/org-switcher";
import { NotificationBell } from "@/components/notification-bell";
import { CountBadge } from "@/components/count-badge";
import { useUnreadCount } from "@/hooks/use-notifications";
import { ProductTabs } from "@/components/product-tabs";
import { ShellBreadcrumb } from "@/components/shell-breadcrumb";
import { useOverlayPath } from "@/lib/modal-route";
import { useCanReach } from "@/hooks/use-can-reach";
import { usePendingShares } from "@/hooks/use-pending-offers";
import { catalogueHref } from "@/lib/catalogue-link";
import { overlayIntent, preloadOverlaysWhenIdle } from "@/lib/overlay-chunks";
import { isSettingsPath, isUnder, SETTINGS_INDEX } from "@/lib/route-access";
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
  useSidebar,
} from "@appstrate/ui/components/sidebar";

/** Where a page's header controls land: the shell stays mounted, so pages portal into this slot (`ShellHeaderActions`) and the controls leave with the page. */
const HeaderActionsSlot = createContext<HTMLElement | null>(null);
const SetHeaderActionsSlot = createContext<((node: HTMLElement | null) => void) | null>(null);

/** Raised once by the layout, around both the header and the page it frames. */
export function ShellFrameProvider({ children }: { children: ReactNode }) {
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  return (
    <SetHeaderActionsSlot.Provider value={setSlot}>
      <HeaderActionsSlot.Provider value={slot}>{children}</HeaderActionsSlot.Provider>
    </SetHeaderActionsSlot.Provider>
  );
}

/** A page's controls for the header's right end, left of the notification bell. */
export function ShellHeaderActions({ children }: { children: ReactNode }) {
  const slot = useContext(HeaderActionsSlot);
  return slot ? createPortal(children, slot) : null;
}

/** Where the sidebar's settings entry lands: the organization scope's index. */
const SETTINGS_ENTRY = SETTINGS_INDEX.organization;

export function ShellSidebar({
  children,
  contentClassName,
}: {
  /** The product's navigation — the ONLY part that differs between products. */
  children: ReactNode;
  contentClassName?: string;
}) {
  const { t } = useTranslation();
  // The catalogue is drawn only when its route admits the caller (`ROUTE_ACCESS`).
  const canReach = useCanReach();
  const pendingShares = usePendingShares();
  const overlayPath = useOverlayPath() ?? "";
  const settingsActive = isSettingsPath(overlayPath);
  const catalogueActive = isUnder(overlayPath, "/catalogue");
  const catalogueReachable = canReach("/catalogue");
  const catalogueTo = pendingShares.href ?? catalogueHref("agent");
  // Always on screen, so their overlays' code is fetched ahead of any click (`lib/overlay-chunks.ts`).
  useEffect(
    () =>
      preloadOverlaysWhenIdle(
        catalogueReachable ? [SETTINGS_ENTRY, "/catalogue"] : [SETTINGS_ENTRY],
      ),
    [catalogueReachable],
  );

  return (
    <Sidebar>
      {/* The brand cell sits at the header's height so the two rules meet across the shell. The
          collapse shows while the pointer is on the sidebar or on focus (`group` is its root). */}
      <SidebarHeader className="border-sidebar-border h-header flex-row items-center gap-1 border-b px-2 py-0">
        <div className="min-w-0 flex-1">
          <OrgSwitcher variant="brand" />
        </div>
        <SidebarTrigger className="text-muted-foreground hidden size-7 shrink-0 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 md:inline-flex">
          <PanelLeft className="size-4" />
        </SidebarTrigger>
      </SidebarHeader>
      <div className="px-2 pt-4 pb-1">
        <ProductTabs />
      </div>
      <SidebarContent className={cn("gap-0", contentClassName)}>{children}</SidebarContent>
      <SidebarFooter className="gap-0 p-0">
        <SidebarMenu className="px-2 pb-2" hidden={!catalogueReachable}>
          <SidebarMenuItem>
            <SidebarMenuButton asChild isActive={catalogueActive}>
              {catalogueActive ? (
                <span aria-current="page">
                  <LibraryBig />
                  <span>{t("nav.catalogue")}</span>
                </span>
              ) : (
                <Link
                  // With shares waiting, the entry opens ON them.
                  to={catalogueTo}
                  {...overlayIntent(catalogueTo)}
                >
                  <LibraryBig />
                  <span>{t("nav.catalogue")}</span>
                </Link>
              )}
            </SidebarMenuButton>
            {/* The share route notifies a PERSON, not a team space: without this badge an offer to a team goes unseen. */}
            {pendingShares.count > 0 && (
              <SidebarMenuBadge>
                <CountBadge
                  count={pendingShares.count}
                  label={t("catalogue.pendingOffers", { count: pendingShares.count })}
                  tone="primary"
                />
              </SidebarMenuBadge>
            )}
          </SidebarMenuItem>
        </SidebarMenu>
        <SidebarMenu className="px-2 pb-2">
          <SidebarMenuItem>
            <SidebarMenuButton asChild isActive={settingsActive}>
              {settingsActive ? (
                <span aria-current="page">
                  <Settings />
                  <span>{t("nav.settings")}</span>
                </span>
              ) : (
                <Link to={SETTINGS_ENTRY} {...overlayIntent(SETTINGS_ENTRY)}>
                  <Settings />
                  <span>{t("nav.settings")}</span>
                </Link>
              )}
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
        <div className="border-sidebar-border border-t p-2">
          <NavUser variant="row" />
        </div>
      </SidebarFooter>
    </Sidebar>
  );
}

export function ShellHeader() {
  const setActionsSlot = useContext(SetHeaderActionsSlot);
  const { isMobile, openMobile, state } = useSidebar();
  const { data: unreadCount } = useUnreadCount();
  const collapsed = !isMobile && state === "collapsed";

  return (
    <header
      className={cn(
        "bg-canvas md:h-header sticky top-0 z-20 flex shrink-0 flex-col border-b md:flex-row md:items-center",
        isMobile && openMobile && "invisible",
      )}
    >
      {/* Edge to edge, not centred on the page column. Collapsed, the left inset is the sidebar's own (`px-2`). */}
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
        {/* Desktop, collapsed: the sidebar's way back, carrying the unread dot the hidden Runs entry cannot show. */}
        {collapsed && (
          <SidebarTrigger className="relative hidden size-8 shrink-0 md:inline-flex">
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
        <div className="flex shrink-0 items-center gap-1">
          <div ref={setActionsSlot} className="flex items-center gap-1 empty:hidden" />
          <NotificationBell />
        </div>
      </div>
      <div className="px-gutter flex h-10 w-full shrink-0 items-center md:hidden">
        <ShellBreadcrumb />
      </div>
    </header>
  );
}
