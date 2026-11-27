// SPDX-License-Identifier: Apache-2.0

import { lazy, Suspense, useEffect } from "react";
import { Link, useLocation } from "react-router-dom";
import { LibraryBig, Menu, PanelLeft, Settings, X, type LucideIcon } from "lucide-react";
import { useTranslation } from "react-i18next";
import { NavOrg } from "@/components/nav-org";
import { NavUser } from "@/components/nav-user";
import { OrgSpaceTile, OrgSwitcher } from "@/components/org-switcher";
import { useContextNames } from "@/hooks/use-context-names";
import { NotificationBell } from "@/components/notification-bell";
import { ProductTabs } from "@/components/product-tabs";
import { HeaderSlotOutlet } from "@/components/shell-header-slots";
import { Button } from "@appstrate/ui/components/button";
import { ShellBreadcrumb } from "@/components/shell-breadcrumb";
import { ChatSidebarSkeleton } from "@/components/loading-skeletons";
import { SidebarCredits } from "@/components/sidebar-credits";
import { SidebarTips } from "@/components/sidebar-tips";
import { useUnreadRunCount } from "@/hooks/use-run-reads";
import { useUnreadCount } from "@/hooks/use-notifications";
import { useOverlayPath } from "@/lib/modal-route";
import { useCanReach, useReachReady } from "@/hooks/use-can-reach";
import { useOverviewMode } from "@/hooks/use-overview-mode";
import { catalogueHref } from "@/lib/catalogue-link";
import { overlayIntent, preloadOverlaysWhenIdle } from "@/lib/overlay-chunks";
import { isUnder, SETTINGS_INDEX } from "@/lib/route-access";
import { settingsSurfaceFromPath } from "@/lib/settings-surface";
import { keepsDrawerOpen } from "@/lib/drawer-navigation";
import { KEYBOARD_VIEWPORT_CLASS } from "@appstrate/ui/use-keyboard-viewport";
import { cn } from "@appstrate/ui/cn";
import { PanelResizeHandle } from "@/components/panel-resize";
import {
  CHAT_SIDEBAR_WIDTH,
  chatSidebarMaxWidth,
  clampChatSidebarWidth,
  useChatSidebarWidthStore,
} from "@/stores/sidebar-store";
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

/** The sidebar's frame, which its resize handle controls. */
const APP_SIDEBAR_ID = "app-sidebar";

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
  // the sheet would only hide where they went, unless it was a product tab, which only swaps the
  // sheet's content (`lib/drawer-navigation.ts`). Desktop keeps its own, remembered, open state.
  const { setOpenMobile, isMobile } = useSidebar();
  const { key, state } = useLocation();
  useEffect(() => {
    if (!keepsDrawerOpen(state)) setOpenMobile(false);
  }, [key, state, setOpenMobile]);
  // The catalogue is drawn only when its route admits the caller (`ROUTE_ACCESS`). It names no
  // space, so « Tous les espaces » opens it as it is: its add menu picks the space per package.
  const canReach = useCanReach();
  const ready = useReachReady();
  const overlayPath = useOverlayPath() ?? "";
  // Preferences is its own dialog: the Settings entry is not the one open there.
  const settingsActive = settingsSurfaceFromPath(overlayPath) === "settings";
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
    <Sidebar id={APP_SIDEBAR_ID} className={KEYBOARD_VIEWPORT_CLASS}>
      {/* The frame never scrolls: it is the resize handle's containing block, so the handle spans
          its whole height whatever the column below it scrolls to. */}
      {product === "chat" && <ChatSidebarResizeHandle />}
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        {/* The brand cell sits at the header's height so the two rules meet across the shell. The
          collapse shows while the pointer is on the sidebar or on focus (`group` is its root).
          On a phone the switcher takes its own width, its chevrons right after the names, and
          the bell and the close button stand at the row's end. */}
        <SidebarHeader className="border-sidebar-border h-header flex-row items-center gap-1 border-b px-2 py-0">
          <div className="min-w-0 flex-1">
            <OrgSwitcher />
          </div>
          {/* Below `md` the header has no room left for it: the bell is the drawer's. */}
          <NotificationBell className="md:hidden" />
          <SidebarTrigger className="text-muted-foreground hidden size-7 shrink-0 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 md:inline-flex">
            <PanelLeft className="size-4" />
          </SidebarTrigger>
          {/* The drawer is the whole screen on a phone: it closes from its own corner. */}
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="shrink-0 md:hidden"
            aria-label={t("btn.close")}
            data-testid="sidebar-close"
            onClick={() => setOpenMobile(false)}
          >
            <X className="size-5" aria-hidden="true" />
          </Button>
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
          {/* Desktop only: a phone's drawer keeps its whole height for the navigation. */}
          {!isMobile && <SidebarTips />}
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
      </div>
    </Sidebar>
  );
}

/**
 * The chat sidebar's edge, dragged to widen or narrow it on desktop: conversation titles are worth
 * the room. Remembered per browser; double-click resets it. A phone's drawer is the whole screen
 * and a collapsed sidebar is off screen: neither has an edge to drag.
 */
function ChatSidebarResizeHandle() {
  const { t } = useTranslation();
  const { isMobile, state } = useSidebar();
  const width = useChatSidebarWidthStore((store) => store.width);
  const setLive = useChatSidebarWidthStore((store) => store.setLive);
  const commit = useChatSidebarWidthStore((store) => store.commit);
  const setDragging = useChatSidebarWidthStore((store) => store.setDragging);
  if (isMobile || state === "collapsed") return null;
  // The window's width is read when used, not followed: the CSS width does that (`app.tsx`).
  const max = chatSidebarMaxWidth(window.innerWidth);
  return (
    <PanelResizeHandle
      edge="right"
      controls={APP_SIDEBAR_ID}
      label={t("nav.resizeSidebar")}
      width={Math.min(width ?? CHAT_SIDEBAR_WIDTH.default, max)}
      min={CHAT_SIDEBAR_WIDTH.min}
      max={max}
      clamp={(next) => clampChatSidebarWidth(next, chatSidebarMaxWidth(window.innerWidth))}
      onLive={setLive}
      onCommit={commit}
      onDraggingChange={setDragging}
    />
  );
}

/**
 * The one control that opens the sidebar while it is off screen (a phone, a collapsed desktop): a
 * burger, then the organization's avatar with the space's on its corner, no names; its accessible
 * name says them. It carries the unread dot of the Runs entry it hides, and on a phone that of the
 * bell, which the drawer holds there.
 */
function SidebarOpener({ className }: { className?: string }) {
  const { t } = useTranslation();
  const { toggleSidebar, isMobile, openMobile, state } = useSidebar();
  const { names } = useContextNames();
  // The Runs entry's own count (`NavOrg`): the working space's, or every reached space's.
  const { on: overview } = useOverviewMode();
  const unreadRuns = useUnreadRunCount({ spanning: overview });
  // The bell's own count (`NotificationBell`), only where the drawer holds the bell.
  const { data: notificationCount } = useUnreadCount({ spanning: overview });
  const unreadNotifications = isMobile ? (notificationCount ?? 0) : 0;
  let label = names ? t("nav.toggleSidebarIn", { current: names }) : t("nav.toggleSidebar");
  if (unreadRuns > 0) label = t("nav.toggleSidebarUnread", { label, count: unreadRuns });
  if (unreadNotifications > 0)
    label = t("nav.toggleSidebarNotifications", { label, count: unreadNotifications });
  return (
    <Button
      type="button"
      variant="ghost"
      data-testid="sidebar-opener"
      className={cn(
        "desktop-pointer:h-8 hover:text-foreground relative h-11 shrink-0 gap-2 px-2 hover:bg-transparent",
        className,
      )}
      aria-expanded={isMobile ? openMobile : state === "expanded"}
      aria-label={label}
      onClick={toggleSidebar}
    >
      <Menu className="size-5" aria-hidden="true" />
      <OrgSpaceTile ring="ring-canvas" />
      {(unreadRuns > 0 || unreadNotifications > 0) && (
        <span className="ring-canvas bg-destructive pointer-events-none absolute top-1 left-6 size-2 rounded-full ring-2" />
      )}
    </Button>
  );
}

export function ShellHeader() {
  const { isMobile, openMobile, state } = useSidebar();
  const collapsed = !isMobile && state === "collapsed";

  // One band, up to three rows, on a three-column grid. Row one is the same on
  // every page: the burger, the trail, the page's controls and, from `md` up,
  // the bell (below, the drawer holds it and the burger carries its dot). A page
  // with a title block (a detail page) adds its identity in row two, takes its
  // controls down there (right end), and adds its tabs in row three.
  // `group/header` lets the cells ask whether a page has filled the lead slot
  // (`has-[[data-header-lead]:not(:empty)]`). The band's rule is an inset
  // shadow, not a border: a border would add a pixel to rows that are exactly
  // `--spacing-header`, the height the sidebar's brand cell shares.
  return (
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
          sidebar's own (`px-2`), so the opener stands where the brand cell
          stood. */}
      <div
        className={cn(
          "h-header pl-gutter col-start-1 row-start-1 flex min-w-0 items-center gap-2 group-has-[[data-header-lead]:not(:empty)]/header:col-span-2",
          collapsed && "md:pl-2",
        )}
      >
        {/* Wherever the sidebar is off screen: a phone, or a collapsed desktop. */}
        <SidebarOpener className={cn("-ml-2", !collapsed && "md:hidden")} />
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
          "where am I" and this answers "what is new". Same place on every page.
          Below `md` the page's title needs the room: the bell moves to the
          drawer's first row and this cell is only the right gutter. */}
      <div className="pr-gutter h-header col-start-3 row-start-1 flex shrink-0 items-center md:pl-2">
        <NotificationBell className="max-md:hidden" />
      </div>
      {/* The page's tabs: the same band, closed by the header's own rule. */}
      <HeaderSlotOutlet slot="tabs" className="px-gutter col-span-3 empty:hidden" />
    </header>
  );
}
