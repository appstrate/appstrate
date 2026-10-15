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

import { useEffect, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { LibraryBig, Menu, PanelLeft, Settings } from "lucide-react";
import { useTranslation } from "react-i18next";
import { NavUser } from "@/components/nav-user";
import { OrgSwitcher } from "@/components/org-switcher";
import { NotificationBell } from "@/components/notification-bell";
import { CountBadge } from "@/components/count-badge";
import { useUnreadCount } from "@/hooks/use-notifications";
import { ProductTabs } from "@/components/product-tabs";
import { HeaderSlotOutlet } from "@/components/shell-header-slots";
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
  // Two organization-wide destinations: settings, which always hold the
  // caller's own account, and the catalogue, drawn when its route admits the
  // caller (`ROUTE_ACCESS`).
  const canReach = useCanReach();
  const pendingShares = usePendingShares();
  const overlayPath = useOverlayPath() ?? "";
  const settingsActive = isSettingsPath(overlayPath);
  const catalogueActive = isUnder(overlayPath, "/catalogue");
  const catalogueReachable = canReach("/catalogue");
  const catalogueTo = pendingShares.href ?? catalogueHref("agent");
  // The two entries below are always on screen, so their overlays' code is
  // fetched ahead of any click (`lib/overlay-chunks.ts`).
  useEffect(
    () =>
      preloadOverlaysWhenIdle(
        catalogueReachable ? [SETTINGS_ENTRY, "/catalogue"] : [SETTINGS_ENTRY],
      ),
    [catalogueReachable],
  );

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
        <SidebarMenu className="px-2 pb-2" hidden={!catalogueReachable}>
          <SidebarMenuItem>
            <SidebarMenuButton asChild isActive={catalogueActive}>
              {/* Where you are is not a control: nothing to click. */}
              {catalogueActive ? (
                <span aria-current="page">
                  <LibraryBig />
                  <span>{t("nav.catalogue")}</span>
                </span>
              ) : (
                <Link
                  // With shares waiting, the entry opens ON them: the count is a
                  // promise, and the first click keeps it.
                  to={catalogueTo}
                  {...overlayIntent(catalogueTo)}
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
        {/* Who you are, and nothing else: the collapse control is in the head. */}
        <div className="border-sidebar-border border-t p-2">
          <NavUser variant="row" />
        </div>
      </SidebarFooter>
    </Sidebar>
  );
}

export function ShellHeader() {
  const { isMobile, openMobile, state } = useSidebar();
  const { data: unreadCount } = useUnreadCount();
  const collapsed = !isMobile && state === "collapsed";

  return (
    // One band, up to three rows. A grid so the title block, which the phone
    // draws under the navigation row and the desktop beside it, is ONE element:
    // the left cell is `display: contents` on a phone, and its children
    // place themselves. `group/header` lets the cells below ask whether a page has
    // filled the lead slot (`has-[[data-header-lead]:not(:empty)]`). Its rule is
    // an inset shadow, not a border: a border would add a pixel to rows that
    // are exactly `--spacing-header`, the height the sidebar's brand cell shares.
    // A phone draws one row (burger, trail, controls, bell); a page with a title
    // block adds that block and its tabs under it, in the same band.
    <header
      className={cn(
        "bg-canvas group/header sticky top-0 z-20 grid shrink-0 grid-cols-[minmax(0,1fr)_auto] shadow-[inset_0_-1px_0_0_var(--color-border)]",
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
          "pl-gutter md:min-h-header col-start-1 row-start-1 max-md:contents md:flex md:min-w-0 md:items-center md:gap-2 md:group-has-[[data-header-lead]:not(:empty)]/header:min-h-16.5 md:group-has-[[data-header-lead]:not(:empty)]/header:pt-5",
          collapsed && "md:pl-2",
        )}
      >
        <div className="h-header pl-gutter col-start-1 row-start-1 flex min-w-0 items-center gap-2 max-md:group-has-[[data-header-lead]:not(:empty)]/header:h-12 md:contents">
          {/* Mobile-only trigger: on desktop the collapse lives in the sidebar */}
          <SidebarTrigger className="-ml-5 size-11 shrink-0 rounded-l-none md:hidden">
            <Menu className="size-4" />
          </SidebarTrigger>
          {/* Desktop, collapsed: nothing of the sidebar is left on screen, so its
              way back is here. A click pins it open again. It carries the unread
              dot the hidden Runs entry cannot show. */}
          {collapsed && (
            <SidebarTrigger className="relative hidden size-8 shrink-0 md:inline-flex">
              <Menu className="size-4" />
              {(unreadCount ?? 0) > 0 && (
                <span className="ring-canvas bg-destructive pointer-events-none absolute top-1 right-1 size-2 rounded-full ring-2" />
              )}
            </SidebarTrigger>
          )}
          {/* The phone's one row holds the burger, then EITHER the page's trail
              OR (where there is none) the organization, then the controls and
              the bell. A detail page's title block is drawn under it
              instead, so both yield: the sidebar still holds the organization. */}
          <div className="flex min-w-0 flex-1 group-has-[[data-header-lead]:not(:empty)]/header:hidden group-has-[[data-trail]:not(:empty)]/header:hidden md:hidden">
            <OrgSwitcher variant="mobile" />
          </div>
          <div className="flex min-w-0 flex-1 items-center group-has-[[data-header-lead]:not(:empty)]/header:hidden">
            <ShellBreadcrumb />
          </div>
        </div>
        {/* The title block of a page that draws one (a detail page), else the
            trail. Both sit in the same cell and only one is ever shown: the
            trail yields as soon as the slot holds something. */}
        <HeaderSlotOutlet
          slot="lead"
          data-header-lead
          className="px-gutter flex min-w-0 items-center py-1.5 empty:hidden max-md:col-span-2 max-md:row-start-2 max-md:py-1 md:flex-1 md:px-0 md:py-0"
        />
      </div>
      {/* The page's own actions, then the one utility that is global but not
          personal: notifications. It sits here rather than in the sidebar
          because the sidebar answers "where am I" and this answers "what is
          new" — and because a header holding only a trail is a header holding
          nothing. */}
      <div className="px-gutter h-header md:min-h-header col-start-2 row-start-1 flex shrink-0 items-center gap-1 max-md:group-has-[[data-header-lead]:not(:empty)]/header:h-12 md:h-auto md:pl-2 md:group-has-[[data-header-lead]:not(:empty)]/header:pt-5">
        <HeaderSlotOutlet slot="actions" className="flex items-center gap-1 empty:hidden" />
        <NotificationBell />
      </div>
      {/* The page's tabs: the same band, closed by the header's own rule. */}
      <HeaderSlotOutlet slot="tabs" className="px-gutter col-span-2 empty:hidden" />
    </header>
  );
}
