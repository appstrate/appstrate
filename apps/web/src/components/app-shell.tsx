// SPDX-License-Identifier: Apache-2.0

import { lazy, Suspense, useEffect, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { LibraryBig, Menu, PanelLeft, Plus, Settings, type LucideIcon } from "lucide-react";
import { useTranslation } from "react-i18next";
import { NavOrg } from "@/components/nav-org";
import { NavUser } from "@/components/nav-user";
import { OrgSwitcher } from "@/components/org-switcher";
import { NotificationBell } from "@/components/notification-bell";
import { CountBadge } from "@/components/count-badge";
import { ProductTabs } from "@/components/product-tabs";
import { HeaderSlotOutlet } from "@/components/shell-header-slots";
import { ShellBreadcrumb } from "@/components/shell-breadcrumb";
import { SidebarCredits } from "@/components/sidebar-credits";
import { useUnreadCount } from "@/hooks/use-notifications";
import { useOverlayPath } from "@/lib/modal-route";
import { useCanReach, useReachReady } from "@/hooks/use-can-reach";
import { usePendingShares } from "@/hooks/use-pending-offers";
import { catalogueHref } from "@/lib/catalogue-link";
import { overlayIntent, preloadOverlaysWhenIdle } from "@/lib/overlay-chunks";
import { isSettingsPath, isUnder, SETTINGS_INDEX } from "@/lib/route-access";
import { cn } from "@appstrate/ui/cn";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSkeleton,
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

/**
 * The conversation list's shape, drawn while its permissions and chunk load:
 * the "new conversation" row (the chat's primary action, so it is real, not
 * grey) above a group of row skeletons — what `ChatConversationList` draws.
 */
function ChatSidebarSkeleton() {
  const { t } = useTranslation("chat");
  return (
    <>
      <SidebarGroup className="pb-0">
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton disabled tooltip={t("threads.new")}>
              <Plus />
              <span>{t("threads.new")}</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarGroup>
      <SidebarGroup className="min-h-0 flex-1 group-data-[collapsible=icon]:hidden">
        <SidebarGroupLabel>{t("threads.title")}</SidebarGroupLabel>
        <SidebarMenu>
          {Array.from({ length: 5 }, (_, i) => (
            <SidebarMenuItem key={i}>
              <SidebarMenuSkeleton />
            </SidebarMenuItem>
          ))}
        </SidebarMenu>
      </SidebarGroup>
    </>
  );
}

/** A footer entry opening an overlay; on screen already, it is a plain current-page marker. */
function OverlayEntry({
  to,
  active,
  icon: Icon,
  label,
  children,
}: {
  to: string;
  active: boolean;
  icon: LucideIcon;
  label: string;
  children?: ReactNode;
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
      {children}
    </SidebarMenuItem>
  );
}

/**
 * The shell's sidebar: one frame, filled with the navigation of the product on screen. The
 * frame stays mounted across a product switch; only its content changes.
 */
export function AppSidebar({ product }: { product: "studio" | "chat" }) {
  const { t } = useTranslation();
  // The catalogue is drawn only when its route admits the caller (`ROUTE_ACCESS`).
  const canReach = useCanReach();
  const ready = useReachReady();
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
      <SidebarContent className={cn("gap-0", product === "chat" && "overflow-hidden")}>
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
          {/* With shares waiting, the entry opens ON them. */}
          <OverlayEntry
            to={catalogueTo}
            active={catalogueActive}
            icon={LibraryBig}
            label={t("nav.catalogue")}
          >
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
          </OverlayEntry>
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
  const { data: unreadCount } = useUnreadCount();
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
            {(unreadCount ?? 0) > 0 && (
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
