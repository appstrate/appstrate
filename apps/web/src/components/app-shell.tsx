// SPDX-License-Identifier: Apache-2.0

import { lazy, Suspense, useEffect } from "react";
import { Link, useLocation } from "react-router-dom";
import { LibraryBig, Menu, PanelLeft, Settings, type LucideIcon } from "lucide-react";
import { useTranslation } from "react-i18next";
import { NavOrg } from "@/components/nav-org";
import { NavUser } from "@/components/nav-user";
import { OrgSwitcher } from "@/components/org-switcher";
import { NotificationBell } from "@/components/notification-bell";
import { ProductTabs } from "@/components/product-tabs";
import { HeaderSlotOutlet } from "@/components/shell-header-slots";
import { ShellBreadcrumb } from "@/components/shell-breadcrumb";
import { ChatSidebarSkeleton } from "@/components/loading-skeletons";
import { SidebarCredits } from "@/components/sidebar-credits";
import { useUnreadRunCount } from "@/hooks/use-run-reads";
import { useOverlayPath } from "@/lib/modal-route";
import { useCanReach, useReachReady } from "@/hooks/use-can-reach";
import { useOverviewMode } from "@/hooks/use-overview-mode";
import { catalogueHref } from "@/lib/catalogue-link";
import { overlayIntent, preloadOverlaysWhenIdle } from "@/lib/overlay-chunks";
import { isSettingsPath, isUnder, SETTINGS_INDEX } from "@/lib/route-access";
import { KEYBOARD_VIEWPORT_CLASS } from "@appstrate/ui/use-keyboard-viewport";
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
  useSidebar,
} from "@appstrate/ui/components/sidebar";

/** Where the sidebar's settings entry lands: the organization scope's index. */
const SETTINGS_ENTRY = SETTINGS_INDEX.organization;

// The chat's list ships with the chat module's UI, out of the entry chunk; it
// loads INSIDE the frame, so the frame never blanks while it does.
const ChatSidebar = lazy(() =>
  import("../modules/chat/chat-sidebar").then((m) => ({ default: m.ChatSidebar })),
);

/** A footer entry opening an overlay; on screen already, it is a plain current-page marker. */
function OverlayEntry({
  to,
  active,
  icon: Icon,
  label,
}: {
  to: string;
  active: boolean;
  icon: LucideIcon;
  label: string;
}) {
  const content = (
    <>
      <Icon />
      <span>{label}</span>
    </>
  );
  return (
    <SidebarMenuItem>
      <SidebarMenuButton asChild isActive={active}>
        {active ? (
          <span aria-current="page">{content}</span>
        ) : (
          <Link to={to} {...overlayIntent(to)}>
            {content}
          </Link>
        )}
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

/**
 * The shell's sidebar: one frame, filled with the navigation of the product on screen. The
 * frame stays mounted across a product switch; only its content changes.
 */
export function AppSidebar({ product }: { product: "studio" | "chat" }) {
  const { t } = useTranslation();
  // On a phone the navigation is a sheet over the page: once a link has taken the user somewhere,
  // the sheet would only hide where they went. Desktop keeps its own, remembered, open state.
  const { setOpenMobile } = useSidebar();
  const { pathname, search } = useLocation();
  useEffect(() => setOpenMobile(false), [pathname, search, setOpenMobile]);
  // The catalogue is drawn only when its route admits the caller (`ROUTE_ACCESS`). It names no
  // space, so « Tous les espaces » opens it as it is: its add menu picks the space per package.
  const canReach = useCanReach();
  const ready = useReachReady();
  const overlayPath = useOverlayPath() ?? "";
  const settingsActive = isSettingsPath(overlayPath);
  const catalogueActive = isUnder(overlayPath, "/catalogue");
  const catalogueReachable = canReach("/catalogue");
  // Always on screen, so their overlays' code is fetched ahead of any click (`lib/overlay-chunks.ts`).
  useEffect(
    () =>
      preloadOverlaysWhenIdle(
        catalogueReachable ? [SETTINGS_ENTRY, "/catalogue"] : [SETTINGS_ENTRY],
      ),
    [catalogueReachable],
  );

  return (
    <Sidebar
      className={product === "chat" ? `overflow-y-auto ${KEYBOARD_VIEWPORT_CLASS}` : undefined}
    >
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
      <ProductTabs />
      {/* Leave room for a search field and its results. In a short viewport the whole sidebar
          can scroll to the navigation below the list. */}
      <SidebarContent className={cn("gap-0", product === "chat" && "min-h-64 overflow-hidden")}>
        {product === "chat" ? (
          // A refused chat route says so in the page; the list would only fetch what the caller cannot read.
          !ready ? (
            <ChatSidebarSkeleton />
          ) : (
            canReach("/chat") && (
              <Suspense fallback={<ChatSidebarSkeleton />}>
                <ChatSidebar />
              </Suspense>
            )
          )
        ) : (
          <>
            <NavOrg />
            <SidebarCredits />
          </>
        )}
      </SidebarContent>
      <SidebarFooter className="gap-0 p-0">
        <SidebarMenu className="px-2 pb-2" hidden={!catalogueReachable}>
          <OverlayEntry
            to={catalogueHref("agent")}
            active={catalogueActive}
            icon={LibraryBig}
            label={t("nav.catalogue")}
          />
        </SidebarMenu>
        <SidebarMenu className="px-2 pb-2">
          <OverlayEntry
            to={SETTINGS_ENTRY}
            active={settingsActive}
            icon={Settings}
            label={t("nav.settings")}
          />
        </SidebarMenu>
        <div className="border-sidebar-border border-t p-2">
          <NavUser variant="row" />
        </div>
      </SidebarFooter>
    </Sidebar>
  );
}

export function ShellHeader() {
  const { isMobile, openMobile, state } = useSidebar();
  // The Runs entry's own count (`NavOrg`): the working space's, or every reached space's.
  const { on: overview } = useOverviewMode();
  const unreadRuns = useUnreadRunCount({ spanning: overview });
  const collapsed = !isMobile && state === "collapsed";

  return (
    // One band, up to three rows, on a three-column grid. Row one is the same on
    // every page: the burger, the trail, the page's controls and the bell. A page
    // with a title block (a detail page) adds its identity in row two, takes its
    // controls down there (right end), and adds its tabs in row three.
    // `group/header` lets the cells ask whether a page has filled the lead slot
    // (`has-[[data-header-lead]:not(:empty)]`). The band's rule is an inset
    // shadow, not a border: a border would add a pixel to rows that are exactly
    // `--spacing-header`, the height the sidebar's brand cell shares.
    <header
      className={cn(
        "bg-canvas group/header sticky top-0 z-20 grid shrink-0 grid-cols-[minmax(0,1fr)_auto_auto] shadow-[inset_0_-1px_0_0_var(--color-border)]",
        isMobile && openMobile && "invisible",
      )}
    >
      {/* Edge to edge, never centred on the page width: the header belongs to
          the shell, not to the page column. With a title block, the trail runs
          over the controls' column too: they are in row two, and must not
          squeeze it. Collapsed, the left inset is the
          sidebar's own (`px-2`), so the burger stands where the brand cell
          stood and its icon over the navigation's icons. */}
      <div
        className={cn(
          "h-header pl-gutter col-start-1 row-start-1 flex min-w-0 items-center gap-2 group-has-[[data-header-lead]:not(:empty)]/header:col-span-2",
          collapsed && "md:pl-2",
        )}
      >
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
            {unreadRuns > 0 && (
              <span className="ring-canvas bg-destructive pointer-events-none absolute top-1 right-1 size-2 rounded-full ring-2" />
            )}
          </SidebarTrigger>
        )}
        {/* On a phone, the page's trail, or (where there is none) the
            organization: the sidebar is closed, so the header names it. */}
        <div className="flex min-w-0 flex-1 group-has-[[data-trail]:not(:empty)]/header:hidden md:hidden">
          <OrgSwitcher variant="mobile" />
        </div>
        <div className="flex min-w-0 flex-1 items-center">
          <ShellBreadcrumb />
        </div>
      </div>
      {/* The page's title block, under the trail. */}
      <HeaderSlotOutlet
        slot="lead"
        data-header-lead
        className="px-gutter col-start-1 row-start-2 flex min-w-0 items-center py-2 empty:hidden"
      />
      {/* The page's own actions: in row one, left of the bell, and for a page
          with a title block in row two, at its right end, level with the title. */}
      <HeaderSlotOutlet
        slot="actions"
        className="group-has-[[data-header-lead]:not(:empty)]/header:pr-gutter col-start-2 row-start-1 flex items-center gap-1 pl-2 group-has-[[data-header-lead]:not(:empty)]/header:col-span-2 group-has-[[data-header-lead]:not(:empty)]/header:row-start-2 group-has-[[data-header-lead]:not(:empty)]/header:justify-self-end empty:hidden"
      />
      {/* The one utility that is global but not personal: notifications. It
          sits here rather than in the sidebar because the sidebar answers
          "where am I" and this answers "what is new". Same place on every page. */}
      <div className="px-gutter h-header col-start-3 row-start-1 flex shrink-0 items-center md:pl-2">
        <NotificationBell />
      </div>
      {/* The page's tabs: the same band, closed by the header's own rule. */}
      <HeaderSlotOutlet slot="tabs" className="px-gutter col-span-3 empty:hidden" />
    </header>
  );
}
